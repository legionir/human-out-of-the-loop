/**
 * Phase 6 (WP-R-007): enforcement at the REAL call site.
 *
 * Schema validation and profile resolution are not authorization. Every tool
 * call and every side effect re-checks the effective policy here, at the point
 * where the action actually happens, and the effective policy can only ever be
 * the strictest intersection of Runtime, user/session, and profile:
 *
 *   - tools: intersection of every layer that declares a set; a missing layer
 *     never widens anything, and an empty result means "no tools";
 *   - budgets: per-dimension minimum (see `profile-budget.ts`);
 *   - approvals: the strictest policy wins, and an unknown policy is treated as
 *     strict rather than permissive;
 *   - a digest-bound plan approval is NOT a tool or side-effect authorization:
 *     it satisfies only the profile's own gate, and the Runtime must authorize
 *     the action independently.
 *
 * Denial is a terminal `security-denied` failure: it is never retried and never
 * routed by a profile's error policy.
 */
import { WorkflowNodeError } from './profile-kernel.js';
import { effectiveWorkflowBudget } from './profile-budget.js';
import type { WorkflowBudgetLimits } from './profile-budget.js';

export type WorkflowApprovalPolicy = 'runtime-default' | 'side-effects' | 'every-tool-call';

const APPROVAL_STRICTNESS: Record<WorkflowApprovalPolicy, number> = {
  'runtime-default': 0,
  'side-effects': 1,
  'every-tool-call': 2,
};

export interface EffectiveAccessPolicy {
  /** Explicitly permitted tool ids, sorted; an empty array permits no tools. */
  toolIds: string[];
  budget: Required<WorkflowBudgetLimits>;
  approvalPolicy: string;
  approvalStrictness: number;
  /** Reasons a layer was ignored or narrowed, for diagnostics. */
  notes: string[];
}

export interface AccessPolicyLayer {
  /** `undefined` means this layer declares no tool set (it cannot widen). */
  toolIds?: ReadonlyArray<string>;
  budget?: WorkflowBudgetLimits;
  approvalPolicy?: string;
}

/**
 * Intersect the layers. `knownToolUniverse` (when the runtime uses a wildcard)
 * must be supplied explicitly; otherwise a wildcard layer contributes nothing.
 */
export function narrowAccessPolicy(
  layers: ReadonlyArray<AccessPolicyLayer | undefined>,
  options: { knownToolUniverse?: ReadonlyArray<string> } = {},
): EffectiveAccessPolicy {
  const notes: string[] = [];
  let toolIds: Set<string> | undefined;
  let budget: WorkflowBudgetLimits | undefined;
  let approvalPolicy = 'runtime-default';
  let strictness = APPROVAL_STRICTNESS['runtime-default'];

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.toolIds) {
      const declared = [...layer.toolIds];
      const wildcard = declared.includes('*');
      const resolved = wildcard ? [...(options.knownToolUniverse ?? [])] : declared;
      if (wildcard && !options.knownToolUniverse) {
        notes.push('A layer requested every tool without a known tool universe; it contributes no tools.');
      }
      const next = new Set(resolved);
      toolIds = toolIds ? new Set([...toolIds].filter((tool) => next.has(tool))) : next;
    }
    // Per-dimension minimum: a later layer can only lower a cap, never raise it.
    budget = effectiveWorkflowBudget(budget, layer.budget);
    if (layer.approvalPolicy) {
      const rank = APPROVAL_STRICTNESS[layer.approvalPolicy as WorkflowApprovalPolicy];
      if (rank === undefined) {
        // An unknown policy is treated as strictly at least as strong as the strongest known one.
        if (1e9 > strictness) {
          strictness = 1e9;
          approvalPolicy = layer.approvalPolicy;
        }
        notes.push(`Unknown approval policy "${layer.approvalPolicy}" is treated as maximally strict.`);
      } else if (rank > strictness) {
        strictness = rank;
        approvalPolicy = layer.approvalPolicy;
      }
    }
  }

  return {
    toolIds: [...(toolIds ?? [])].sort(),
    budget: effectiveWorkflowBudget(budget),
    approvalPolicy,
    approvalStrictness: strictness,
    notes,
  };
}

/** Throws a terminal `security-denied` error instead of silently allowing a call. */
export function assertToolAccess(options: {
  nodeId: string;
  toolId: string;
  effectiveToolIds: ReadonlyArray<string>;
  runtimePermittedToolIds: ReadonlyArray<string>;
}): void {
  const { nodeId, toolId, effectiveToolIds, runtimePermittedToolIds } = options;
  const deny = (reason: string): never => {
    throw new WorkflowNodeError(reason, { category: 'security-denied', code: 'tool.denied', retryable: false });
  };
  if (!runtimePermittedToolIds.includes(toolId)) deny(`Tool "${toolId}" is not permitted by the Runtime`);
  if (!effectiveToolIds.includes(toolId)) deny(`Tool "${toolId}" is not in the effective tool set for node "${nodeId}"`);
  const outside = effectiveToolIds.filter((tool) => !runtimePermittedToolIds.includes(tool));
  if (outside.length > 0) {
    // A profile (or any other layer) produced a tool the Runtime does not permit.
    deny(`Effective tool set for node "${nodeId}" contains tools the Runtime does not permit: ${outside.join(', ')}`);
  }
}

/**
 * A side effect needs BOTH the Runtime's own authorization and, when the profile
 * requires it, an approval bound to the digest of the exact content. The plan
 * approval alone never satisfies this gate.
 */
export function assertSideEffectAuthorized(options: {
  nodeId: string;
  runtimeAuthorized: boolean;
  approvalRequired: boolean;
  approval?: { status: string; digest?: string; boundPort?: string };
  requiredDigest?: string;
}): void {
  const { nodeId, runtimeAuthorized, approvalRequired, approval, requiredDigest } = options;
  const deny = (reason: string, code: string): never => {
    throw new WorkflowNodeError(reason, { category: 'security-denied', code, retryable: false });
  };
  if (!runtimeAuthorized) {
    deny(`Runtime authorization is required before the effect of node "${nodeId}"`, 'effect.runtime-authorization-missing');
  }
  if (!approvalRequired) return;
  if (!approval || approval.status !== 'approved') {
    deny(`Node "${nodeId}" requires an approval bound to its content before the effect`, 'effect.approval-missing');
  }
  const approved = approval as { status: string; digest?: string; boundPort?: string };
  if (requiredDigest !== undefined && approved.digest !== requiredDigest) {
    deny(`The approval for node "${nodeId}" is bound to different content than the effect would act on`, 'effect.approval-digest-mismatch');
  }
}

export interface AuthoritySnapshot {
  toolIds: ReadonlyArray<string>;
  budget: WorkflowBudgetLimits;
  approvalStrictness: number;
}

/**
 * A resume — or a policy refresh — may never increase authority. Returns the
 * dimensions that widened, so a caller can refuse before doing any work.
 */
export function detectAuthorityIncrease(before: AuthoritySnapshot, after: AuthoritySnapshot): string[] {
  const increased: string[] = [];
  const beforeTools = new Set(before.toolIds);
  const addedTools = after.toolIds.filter((tool) => !beforeTools.has(tool));
  if (addedTools.length > 0) increased.push(`tools added: ${addedTools.sort().join(', ')}`);
  for (const dimension of ['maxNodeVisits', 'maxDurationSeconds', 'maxModelCalls', 'maxToolCalls'] as const) {
    const previous = before.budget[dimension];
    const next = after.budget[dimension];
    if (typeof previous === 'number' && typeof next === 'number' && next > previous) {
      increased.push(`${dimension} raised from ${previous} to ${next}`);
    }
  }
  if (after.approvalStrictness < before.approvalStrictness) {
    increased.push('approval policy weakened');
  }
  return increased;
}

/** Throws when a resume or policy refresh would grant more authority than before. */
export function assertNoAuthorityIncrease(before: AuthoritySnapshot, after: AuthoritySnapshot): void {
  const increased = detectAuthorityIncrease(before, after);
  if (increased.length > 0) {
    throw new WorkflowNodeError(`Refusing a policy change that would increase authority: ${increased.join('; ')}`, {
      category: 'security-denied', code: 'policy.authority-increase', retryable: false,
    });
  }
}
