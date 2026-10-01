/**
 * Phase 6 (WP-R-007): the run budget contract.
 *
 * A budget is never additive. For every dimension the effective cap is the
 * STRICTEST of the Runtime cap, the user/session cap, and the profile's own
 * cap, and never above the schema maximum — so no layer, and no profile, can
 * raise or reset another layer's limit. Counters live for the whole run, are
 * part of the persisted run state, and are never reset by a resume.
 *
 * The kernel owns the counter arithmetic; handlers consume through the
 * `WorkflowBudget` handle it hands them, so a model/tool call cannot happen
 * outside the accounting. Exceeding a limit produces a terminal `budget`
 * failure (Phase 4's terminal categories), which no profile error policy can
 * retry or route. `onLimit` decides only the run's terminal status:
 *   - `fail`     → `failure`
 *   - `handoff`  → `handoff`
 *   - `ask-user` → `handoff` at a resumable pause point (`budget.awaiting-user`);
 *                  it never grants an approval and never bypasses policy, and a
 *                  host must declare pause support before such a profile starts.
 */

export interface WorkflowBudgetLimits {
  maxNodeVisits?: number;
  maxDurationSeconds?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
}

export interface WorkflowBudgetUsage {
  visits: number;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
}

/** Upper bounds the contract itself declares; nothing may exceed them. */
export const SCHEMA_BUDGET_MAXIMA: Required<WorkflowBudgetLimits> = Object.freeze({
  maxNodeVisits: 1000,
  maxDurationSeconds: 86_400,
  maxModelCalls: 10_000,
  maxToolCalls: 10_000,
});

export type WorkflowBudgetDimension = keyof WorkflowBudgetLimits;

/**
 * Strictest-of per dimension. Missing values fall back to the schema maximum, so
 * an active cap always exists and a caller can only lower it.
 */
export function effectiveWorkflowBudget(
  profileLimits: WorkflowBudgetLimits | undefined,
  ...layers: Array<WorkflowBudgetLimits | undefined>
): Required<WorkflowBudgetLimits> {
  const caps = { ...SCHEMA_BUDGET_MAXIMA };
  for (const layer of [profileLimits, ...layers]) {
    if (!layer) continue;
    for (const dimension of Object.keys(caps) as WorkflowBudgetDimension[]) {
      const value = layer[dimension];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        caps[dimension] = Math.min(caps[dimension], Math.trunc(value));
      }
    }
  }
  return Object.freeze(caps);
}

export type WorkflowLimitBehaviour = 'fail' | 'handoff' | 'ask-user';

/** The terminal status an exhausted run reports, per the profile's `onLimit`. */
export function limitRunStatus(behaviour: WorkflowLimitBehaviour | undefined): 'failure' | 'handoff' {
  return behaviour === 'handoff' || behaviour === 'ask-user' ? 'handoff' : 'failure';
}

export interface WorkflowBudgetViolation {
  code: 'budget.node-visits-exceeded' | 'budget.duration-exceeded' | 'budget.model-calls-exceeded' | 'budget.tool-calls-exceeded';
  dimension: WorkflowBudgetDimension;
  limit: number;
  used: number;
  message: string;
}

/**
 * Run-scoped budget. Constructed with the effective caps (and, on resume, the
 * counters already spent) so accounting continues instead of restarting.
 */
export class WorkflowBudget {
  readonly caps: Required<WorkflowBudgetLimits>;
  private readonly startedAtMs: number;
  private readonly initialElapsedMs: number;
  private used: WorkflowBudgetUsage;

  constructor(options: {
    caps: Required<WorkflowBudgetLimits>;
    now?: number;
    /** Counters carried over from a persisted run state on resume. */
    usage?: Partial<WorkflowBudgetUsage>;
    /** Elapsed run time already recorded before a resume. */
    elapsedMs?: number;
  }) {
    this.caps = options.caps;
    this.startedAtMs = options.now ?? Date.now();
    this.initialElapsedMs = Math.max(0, Math.trunc(options.usage?.durationMs ?? options.elapsedMs ?? 0));
    this.used = {
      visits: Math.max(0, Math.trunc(options.usage?.visits ?? 0)),
      durationMs: this.initialElapsedMs,
      modelCalls: Math.max(0, Math.trunc(options.usage?.modelCalls ?? 0)),
      toolCalls: Math.max(0, Math.trunc(options.usage?.toolCalls ?? 0)),
    };
  }

  /** Wall-clock elapsed time, including time carried over from before a resume. */
  elapsedMs(now: number = Date.now()): number {
    return this.initialElapsedMs + Math.max(0, now - this.startedAtMs);
  }

  usage(now: number = Date.now()): WorkflowBudgetUsage {
    return { ...this.used, durationMs: this.elapsedMs(now) };
  }

  remaining(now: number = Date.now()): Required<WorkflowBudgetLimits> {
    const usage = this.usage(now);
    return {
      maxNodeVisits: Math.max(0, this.caps.maxNodeVisits - usage.visits),
      maxDurationSeconds: Math.max(0, this.caps.maxDurationSeconds - Math.ceil(usage.durationMs / 1000)),
      maxModelCalls: Math.max(0, this.caps.maxModelCalls - usage.modelCalls),
      maxToolCalls: Math.max(0, this.caps.maxToolCalls - usage.toolCalls),
    };
  }

  private violation(dimension: WorkflowBudgetDimension, code: WorkflowBudgetViolation['code'], limit: number, used: number, what: string): WorkflowBudgetViolation {
    return { code, dimension, limit, used, message: `${what} budget exhausted: ${used} of ${limit} used` };
  }

  /** Count one node visit; returns a violation instead of throwing so the kernel finishes the run. */
  recordVisit(now: number = Date.now()): WorkflowBudgetViolation | undefined {
    if (this.used.visits + 1 > this.caps.maxNodeVisits) {
      return this.violation('maxNodeVisits', 'budget.node-visits-exceeded', this.caps.maxNodeVisits, this.used.visits, 'node visit');
    }
    this.used.visits += 1;
    const duration = this.checkDuration(now);
    return duration;
  }

  checkDuration(now: number = Date.now()): WorkflowBudgetViolation | undefined {
    const elapsed = this.elapsedMs(now);
    if (elapsed > this.caps.maxDurationSeconds * 1000) {
      return this.violation('maxDurationSeconds', 'budget.duration-exceeded', this.caps.maxDurationSeconds, Math.floor(elapsed / 1000), 'duration');
    }
    return undefined;
  }

  recordModelCall(count = 1, now: number = Date.now()): WorkflowBudgetViolation | undefined {
    return this.consume('maxModelCalls', 'budget.model-calls-exceeded', 'model call', 'modelCalls', count, now);
  }

  recordToolCall(count = 1, now: number = Date.now()): WorkflowBudgetViolation | undefined {
    return this.consume('maxToolCalls', 'budget.tool-calls-exceeded', 'tool call', 'toolCalls', count, now);
  }

  private consume(
    dimension: 'maxModelCalls' | 'maxToolCalls',
    code: WorkflowBudgetViolation['code'],
    what: string,
    field: 'modelCalls' | 'toolCalls',
    count: number,
    now: number,
  ): WorkflowBudgetViolation | undefined {
    const amount = Math.max(1, Math.trunc(count));
    if (this.used[field] + amount > this.caps[dimension]) {
      return this.violation(dimension, code, this.caps[dimension], this.used[field], what);
    }
    this.used[field] += amount;
    const duration = this.checkDuration(now);
    if (duration) return duration;
    return undefined;
  }
}
