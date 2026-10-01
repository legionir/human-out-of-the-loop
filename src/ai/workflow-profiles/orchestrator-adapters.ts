/**
 * Phase 5 (WP-R-006): adapters from the workflow handler ports to the services
 * HOOTL already has. Nothing here changes those services: the adapters translate
 * request/response shapes and map existing outcomes onto the profile's ports.
 *
 *   - planner  -> `Planner.plan()` (the existing planning/feasibility entry);
 *   - execute  -> `PlanRuntime.execute()` (the sole inner DAG scheduler, D-WP-008);
 *   - review   -> `FinalReviewer.review()` or `AcceptanceChecker` (step review);
 *   - approval -> the existing interaction/confirm callback.
 *
 * Every text field handed to these services is already confined as untrusted
 * data by the handler layer; the adapters never add policy of their own and never
 * loosen one. An approval decision is data: it is not a tool authorization, and
 * the runtime re-checks policy before any effect (Phase 6).
 */
import { formatPlanForUser, summarizePlan, type PlanSummary } from '../planning/plan-confirmation.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { Plan } from '../schemas/plan.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import type { Review } from '../schemas/review.js';
import type { RunMode } from '../modes.js';
import { WorkflowNodeError } from './profile-kernel.js';
import type {
  WorkflowApprovalOutcome,
  WorkflowApprovalPort,
  WorkflowApprovalRequest,
  WorkflowExecutorPort,
  WorkflowPlannerPort,
  WorkflowReviewerOutcome,
  WorkflowReviewerPort,
} from './node-handlers.js';

// ─── Narrow structural views of the existing services ─────────────

export interface PlannerLike {
  plan(request: string, usagePlanId?: string, modelId?: string, mode?: RunMode, abortSignal?: AbortSignal): Promise<{
    kind: 'plan' | 'answer' | 'clarify';
    plan?: unknown;
    answer?: string;
    needsClarification?: string[];
  }>;
}

export interface PlanRuntimeLike {
  /**
   * Execute the confirmed plan. `meta` carries the execute node and the run's abort signal when the
   * wiring provides them, so an implementation can mark the side-effect window and stop dispatching
   * new steps when the run is cancelled (F-3/F-8).
   */
  execute(plan: Plan, meta?: { nodeId?: string; signal?: AbortSignal }): Promise<PlanExecutionResult>;
  /**
   * Ask the delegated runtime to stop dispatching new steps (F-8). The wiring calls this when the
   * run's abort signal fires mid-execution; in-flight work finishes, nothing new starts.
   */
  cancel?(): void;
}

export interface FinalReviewerLike {
  review(plan: Plan, executionResult: PlanExecutionResult, modelId?: string): Promise<Review>;
}

export interface AcceptanceCheckerLike {
  checkStep(step: unknown, task: unknown, modelId?: string): Promise<{ accepted: boolean; reason: string; checkerError?: boolean }>;
}

export interface ConfirmCallbackLike {
  /**
   * `plan` is the captured plan the question is about, when the node has one (F-6): callers that
   * must remember which plan is being confirmed (server `run.planId`, CLI `currentPlanId`) read it
   * from this argument; callers that only need the rendered text ignore it.
   */
  (planText: string, plan?: Plan): Promise<{ confirmed: boolean; feedback?: string }>;
}

const DEFAULT_RENDER_PLAN = (plan: unknown): string => formatPlanForUser(summarizePlan(plan as Plan));

// ─── Planner ──────────────────────────────────────────────────────

export interface PlannerPortOptions {
  planner: PlannerLike;
  /** Renders the plan exactly as the user will see it (default: the CLI summary). */
  renderPlan?: (plan: unknown) => string;
  modelId?: string;
  mode?: RunMode;
}

export function createPlannerPort(options: PlannerPortOptions): WorkflowPlannerPort {
  const renderPlan = options.renderPlan ?? DEFAULT_RENDER_PLAN;
  return {
    async plan(request) {
      const prompt = request.context ? `${request.goal.confined}\n\n${request.context.confined}` : request.goal.confined;
      const result = await options.planner.plan(prompt, undefined, options.modelId, options.mode, request.signal);
      if (result.kind === 'answer') {
        return { kind: 'answer', answer: result.answer ?? '' };
      }
      if (result.kind === 'clarify') {
        return { kind: 'clarify', needsClarification: [...(result.needsClarification ?? [])] };
      }
      if (result.plan === undefined) {
        return { kind: 'clarify', needsClarification: [] };
      }
      return { kind: 'plan', plan: result.plan, planText: renderPlan(result.plan) };
    },
  };
}

// ─── Executor ─────────────────────────────────────────────────────

/**
 * F-2: measures what a delegated plan execution consumed, from the run's own events.
 * `begin` starts a measurement window; `end` closes it and returns the counted model/tool calls.
 */
export interface ExecutionUsageSource {
  begin(plan: Plan): { end(): { modelCalls: number; toolCalls: number } };
}

/**
 * Count what the delegated plan really consumed while it runs (F-2). One model call per completed or
 * failed agent run that reported usage, one tool call per `agent:tool_call`; only events carrying the
 * plan's own id are counted, so unrelated traffic can never inflate the profile's counters.
 */
export function createEventBusExecutionUsage(eventBus: EventBus): ExecutionUsageSource {
  return {
    begin(plan) {
      let modelCalls = 0;
      let toolCalls = 0;
      const unsubscribe = eventBus.subscribe('*', (event) => {
        if (event.planId !== plan.id) return;
        if (event.type === 'agent:tool_call') {
          toolCalls += 1;
          return;
        }
        if ((event.type === 'agent:completed' || event.type === 'agent:error') && event.usage) {
          modelCalls += 1;
        }
      });
      return {
        end: () => {
          unsubscribe();
          return { modelCalls, toolCalls };
        },
      };
    },
  };
}

export interface ExecutorPortOptions {
  planRuntime: PlanRuntimeLike;
  /**
   * Runtime-level execution gate (Phase 9 Step 1): called with the plan digest the execute node
   * received. Wiring refuses execution (a terminal `security-denied` failure) unless a granted
   * side-effect approval binds that digest, so no profile can drop the mandatory confirmation.
   */
  assertExecutable?: (planDigest: string | undefined) => void;
  /**
   * Measured usage of the delegated execution (F-2): the wiring counts what the run's own events
   * reported for this plan, so the profile's counters are charged with real numbers instead of
   * being skipped. Absent ⇒ no usage is reported (the counters stay a lower bound).
   */
  usageFor?: (plan: Plan) => { modelCalls?: number; toolCalls?: number } | undefined;
  /**
   * Narrowing of the plan the profile may execute (F-1): the wiring filters each step's tool list to
   * the profile's declared tool surface *before* the plan is handed to the runtime, so a pinned
   * toolset or a deny list is enforced at the real call site, not only in the authority snapshot.
   */
  narrowPlan?: (plan: Plan, request: { nodeId: string; toolsetRef?: string; personaRef?: string }) => Plan;
}

/** Map an existing `PlanExecutionResult` onto the execute node's ports. */
export function executorOutcomeFromResult(result: PlanExecutionResult, usage?: { modelCalls?: number; toolCalls?: number }): {
  status: 'completed' | 'failed' | 'partial';
  summary: string;
  artifacts?: unknown[];
  usage?: { modelCalls?: number; toolCalls?: number };
  failure?: { category: 'tool' | 'validation'; code: string; retryable: boolean };
} {
  const failed = result.failedSteps > 0 || result.incompleteSteps.length > 0;
  const status = result.status === 'completed' ? 'completed' : failed ? (result.completedSteps > 0 ? 'partial' : 'failed') : 'partial';
  const incomplete = result.incompleteSteps.map((step) => `${step.stepId}: ${step.reason}`).slice(0, 10);
  const summary = status === 'completed'
    ? `${result.completedSteps}/${result.totalSteps} steps completed`
    : `${result.completedSteps}/${result.totalSteps} steps completed; ${incomplete.length > 0 ? incomplete.join(' | ') : 'run did not complete'}`;
  return {
    status,
    summary,
    artifacts: result.incompleteSteps.map((step) => ({ ...step })),
    ...(usage && (usage.modelCalls || usage.toolCalls) ? { usage: { ...usage } } : {}),
    ...(status === 'failed'
      ? { failure: { category: 'tool' as const, code: 'execute.plan-failed', retryable: false } }
      : {}),
  };
}

export function createExecutorPort(options: ExecutorPortOptions): WorkflowExecutorPort {
  return {
    async execute(request) {
      if (request.plan === undefined) {
        throw new Error(`execute node "${request.nodeId}" requires a plan input`);
      }
      // Phase 9 Step 1: the runtime's own gate, independent of what the profile declares. A profile
      // cannot remove the mandatory human confirmation before a plan runs (Law 17), so the wiring
      // layer refuses execution unless a granted side-effect approval binds the very plan being
      // executed. The failure is a security denial: terminal, never routed or retried.
      options.assertExecutable?.(request.planDigest);
      // F-1: the plan the runtime receives is the profile's tool surface narrowed onto each step, so
      // a pinned toolset/deny list is enforced where the tools are actually handed out.
      const executed = options.narrowPlan
        ? options.narrowPlan(request.plan as Plan, {
          nodeId: request.nodeId,
          ...(request.toolsetRef ? { toolsetRef: request.toolsetRef } : {}),
          ...(request.personaRef ? { personaRef: request.personaRef } : {}),
        })
        : (request.plan as Plan);
      const result = await options.planRuntime.execute(executed, {
        nodeId: request.nodeId,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (result.status === 'cancelled' || result.status === 'cancelling') {
        // Cancellation is terminal and can never be routed or retried by a profile.
        throw new WorkflowNodeError('plan execution was cancelled', {
          category: 'cancelled', code: 'execute.cancelled', retryable: false,
        });
      }
      // F-2: charge what the delegated execution actually consumed, measured by the wiring.
      return executorOutcomeFromResult(result, options.usageFor?.(executed));
    },
  };
}

// ─── Reviewer ─────────────────────────────────────────────────────

const OUTCOME_DECISION: Record<'success' | 'partial-success' | 'failure', string> = {
  success: 'pass',
  'partial-success': 'revise',
  failure: 'reject',
};

export interface ReviewerPortOptions {
  finalReviewer?: FinalReviewerLike;
  acceptanceChecker?: AcceptanceCheckerLike;
  modelId?: string;
  /** Which part of the plan an acceptance-based review judges; defaults to its inputs. */
  stepSelector?: (inputs: Record<string, unknown>) => { step: unknown; task: unknown } | undefined;
}

/**
 * Decide between final review and step review:
 *   - when the node's content carries `execution`/`result` for a finished plan,
 *     the run is judged by `FinalReviewer` (the existing end-of-plan review);
 *   - otherwise, when a step/task pair is present, `AcceptanceChecker` judges it.
 * A cancelled run is a terminal cancellation, never a `reject` verdict.
 */
/**
 * Map a delegated final review onto the review node's decision contract.
 * `success` → `pass`, `partial-success` → `revise`, `failure` → `reject`; a cancelled run is a
 * terminal cancellation and is never converted into a routeable verdict.
 */
export function reviewerOutcomeFromReview(review: Review): WorkflowReviewerOutcome {
  if (review.outcome === 'cancelled') {
    throw new WorkflowNodeError(review.finalSummary || 'run cancelled', {
      category: 'cancelled', code: 'review.cancelled', retryable: false,
    });
  }
  return {
    decision: OUTCOME_DECISION[review.outcome],
    reason: review.finalSummary,
    findings: [...review.acceptedFindings, ...review.rejectedFindings],
  };
}

export function createReviewerPort(options: ReviewerPortOptions): WorkflowReviewerPort {
  return {
    async review(request): Promise<WorkflowReviewerOutcome> {
      const plan = request.raw.plan;
      const execution = request.raw.execution ?? request.raw.result;
      if (execution && options.finalReviewer) {
        // Typed delegation: the reviewer receives the real objects and renders them
        // itself; the confined copies above stay the only prompt-facing form.
        const review = await options.finalReviewer.review(
          (plan ?? {}) as Plan,
          execution as PlanExecutionResult,
          options.modelId,
        );
        return reviewerOutcomeFromReview(review);
      }
      if (options.acceptanceChecker && options.stepSelector) {
        const selected = options.stepSelector(request.raw as Record<string, unknown>);
        if (!selected) throw new Error(`review node "${request.nodeId}" has no step/task to judge`);
        const verdict = await options.acceptanceChecker.checkStep(selected.step, selected.task, options.modelId);
        if (verdict.checkerError) {
          throw new Error(`acceptance check failed: ${verdict.reason}`);
        }
        return { decision: verdict.accepted ? 'pass' : 'revise', reason: verdict.reason };
      }
      throw new Error(`review node "${request.nodeId}" has no reviewer wired for its inputs`);
    },
  };
}

// ─── Approval ─────────────────────────────────────────────────────

export interface ApprovalPortOptions {
  confirm: ConfirmCallbackLike;
  /** Renders the approval request shown to the user (default: prompt + shown content). */
  render?: (request: WorkflowApprovalRequest) => string;
  /** Label used for the digest line when the node binds content. */
  digestLabel?: string;
}

export const DEFAULT_APPROVAL_RENDER = (request: WorkflowApprovalRequest): string => {
  const shown = Object.values(request.show).map((entry) => entry.confined).join('\n');
  const binding = request.boundDigest ? `\nBound content digest (${request.boundPort}): ${request.boundDigest}` : '';
  return `${request.prompt}${shown ? `\n${shown}` : ''}${binding}`;
};

/**
 * Approval over the existing confirm/interaction callback.
 *
 * Text-based confirmations cannot attest a digest out of band: this adapter shows
 * the digest inside the same interaction and echoes it back on approval, so the
 * handler's equality check proves the decision belongs to the content the user
 * saw. A host whose approval can arrive out of band (web UI, resume) MUST provide
 * its own port that returns the digest it actually approved.
 */
export function createApprovalPort(options: ApprovalPortOptions): WorkflowApprovalPort {
  const render = options.render ?? DEFAULT_APPROVAL_RENDER;
  return {
    async request(request): Promise<WorkflowApprovalOutcome> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const confirmation = await Promise.race([
          options.confirm(render(request)),
          new Promise<never>((_resolve, reject) => {
            if (!request.timeoutSeconds) return;
            timer = setTimeout(() => reject(new Error('approval timed out')), request.timeoutSeconds * 1000);
          }),
        ]);
        if (!confirmation.confirmed) {
          return { status: 'denied', ...(confirmation.feedback ? { reason: confirmation.feedback } : {}) };
        }
        return {
          status: 'approved',
          ...(request.boundDigest ? { approvedDigest: request.boundDigest } : {}),
          ...(request.responseKind === 'text' ? { answer: confirmation.feedback ?? '' } : {}),
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'approval timed out') {
          return { status: 'expired', reason: 'approval timed out' };
        }
        return { status: 'cancelled', reason: error instanceof Error ? error.message : String(error) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
