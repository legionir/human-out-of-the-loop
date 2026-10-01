/**
 * Phase 7 Step 2 (WP-R-008): run one prepared Workflow Profile against the services
 * HOOTL already has, and hand the Orchestrator an outcome it can map onto its own
 * `OrchestratorResult`/interaction lifecycle.
 *
 * Deliberate boundaries (recorded in `docs/workflow-profiles/PHASE7_PARITY.md`):
 *  - the profile owns control flow only; planning, execution, acceptance, re-planning,
 *    rate limiting and the final review stay inside the delegated services;
 *  - plan/session persistence stays outside the profile: `onPlan` fires the moment the
 *    planner produced a plan, before anything executes, so the caller keeps writing its
 *    existing `PlanStore` record and session link;
 *  - model/tool usage accounting stays inside the services the Orchestrator built (their
 *    `onUsage` callbacks are wired at construction), so the profile path needs no second
 *    accounting path and cannot widen a budget;
 *  - a missing service fails closed (`*.service-missing` from the handler layer) — the
 *    bridge never substitutes a stub that could execute work without policy;
 *  - the caller's service objects are never mutated; capture wrappers are new objects.
 */
import {
  createApprovalPort,
  createExecutorPort,
  createPlannerPort,
  createReviewerPort,
  reviewerOutcomeFromReview,
  type AcceptanceCheckerLike,
  type ConfirmCallbackLike,
  type FinalReviewerLike,
  type PlannerLike,
  type PlanRuntimeLike,
  type ExecutionUsageSource,
  type PlanRuntimeExecutionMeta,
} from './orchestrator-adapters.js';
import { createWorkflowProfileHandlers, type WorkflowReviewerPort } from './node-handlers.js';
import { confineUntrustedContent } from './untrusted-content.js';
import { WorkflowNodeError } from './profile-kernel.js';
import type {
  WorkflowFailure,
  WorkflowKernelEvent,
  WorkflowRunStatus,
} from './profile-kernel.js';
import type { PreparedWorkflowProfileRun } from './profile-runner.js';
import type { Plan } from '../schemas/plan.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import type { Review } from '../schemas/review.js';
import type { RunMode } from '../modes.js';

/**
 * Thrown by the caller's `onPlan` hook when the plan cannot be executed (the
 * feasibility/cycle gate rejected it) — a `WorkflowNodeError` so the kernel reports it with
 * this exact code rather than wrapping it into a generic planner failure; the Orchestrator
 * maps it onto the same observable outcome the legacy path produces.
 */
export const PLAN_INFEASIBLE_CODE = 'plan.infeasible';

export class WorkflowProfilePlanInfeasibleError extends WorkflowNodeError {
  constructor(public readonly detail: string) {
    super(`The plan is not executable:\n${detail}`, {
      category: 'validation', code: PLAN_INFEASIBLE_CODE, retryable: false,
    });
    this.name = 'WorkflowProfilePlanInfeasibleError';
  }
}

export interface WorkflowProfileBridgeServices {
  /** The existing planner entry (planning + the feasibility/cycle gate behind it). */
  planner: PlannerLike;
  /** PlanRuntime: the sole inner-DAG scheduler (D-WP-008). */
  planRuntime: PlanRuntimeLike;
  finalReviewer?: FinalReviewerLike;
  acceptanceChecker?: AcceptanceCheckerLike;
  /** The existing interaction/confirm callback. Without it, approvals fail closed. */
  confirm?: ConfirmCallbackLike;
  /** Renders the plan exactly as the user will see it (default: the CLI summary). */
  renderPlan?: (plan: unknown) => string;
  modelId?: string;
  mode?: RunMode;
  /**
   * F-2: measures what the delegated plan execution actually consumed, from the run's own events.
   * `begin` is called immediately before the plan is handed to the runtime and `end` right after it
   * returns (or throws), so the counters are charged with real numbers.
   */
  executionUsage?: ExecutionUsageSource;
}

export interface WorkflowProfileBridgeOptions {
  services: WorkflowProfileBridgeServices;
  /** Entry payload for the intake node, e.g. `{ request: { goal, mode, sessionId } }`. */
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * Called as soon as the planner produced a plan, before any execution: the caller keeps
   * persisting the plan and the session link on its existing path.
   */
  onPlan?: (plan: Plan, planText: string) => void;
  onEvent?: (event: WorkflowKernelEvent) => void;
}

export interface WorkflowProfileBridgeOutcome {
  status: WorkflowRunStatus;
  failure?: WorkflowFailure;
  /** Nodes in visit order (the profile's observable control flow). */
  visited: readonly string[];
  plan?: Plan;
  planText?: string;
  /** The delegated execution result, when the execution node ran. */
  execution?: PlanExecutionResult;
  /** The delegated final review, when the review node ran. */
  review?: Review;
  /** The answer the planner produced, for the conversation branch. */
  answer?: string;
}

/**
 * F-1: the tool surface the profile itself declares for execution.
 *
 * Only the profile's *tool* declarations narrow a delegated plan: the toolsets it lists in
 * `policies.tools.allowedToolsets` (an empty list means "no narrowing", the documented default), the
 * toolset a node binds by id, and the always-subtracting `policies.tools.deniedTools`. Persona pins
 * are deliberately not part of this surface — a plan step runs under its own plan-step persona, so
 * using the profile's planner/reviewer personas here would strip every step's tools.
 *
 * `undefined` means "no narrowing at all"; a surface with no `allow` list applies the deny list only.
 */
interface DeclaredToolSurface {
  /** Positive allow-list. Absent ⇒ every step tool is kept unless denied. */
  readonly allow?: ReadonlyArray<string>;
  /** Tools that must never reach a step, whatever it declares. */
  readonly deny: ReadonlyArray<string>;
}

function declaredExecutionToolSurface(
  prepared: PreparedWorkflowProfileRun,
  request: { toolsetRef?: string },
): DeclaredToolSurface | undefined {
  const tools = (prepared.profile.policies as { tools?: { allowedToolsets?: string[]; deniedTools?: string[] } }).tools;
  const profileDenied = Array.isArray(tools?.deniedTools) ? tools!.deniedTools! : [];
  const bound = request.toolsetRef;
  const named = bound !== undefined ? [bound] : (Array.isArray(tools?.allowedToolsets) ? tools!.allowedToolsets! : []);
  if (bound === undefined && named.length === 0 && profileDenied.length === 0) return undefined;

  const byId = new Map(
    prepared.resolved.dependencies
      .filter((dependency) => dependency.kind === 'toolset')
      .map((dependency) => [dependency.id, dependency.content as { tools?: unknown; deniedTools?: unknown }]),
  );
  const deny = new Set<string>(profileDenied);
  const allow = new Set<string>();
  for (const id of named) {
    const content = byId.get(id);
    // A named toolset that did not resolve contributes nothing (fail closed): with an `allow` list
    // present that keeps the surface empty instead of silently permitting the un-narrowed runtime set.
    if (!content) continue;
    if (Array.isArray(content.tools)) for (const tool of content.tools) if (typeof tool === 'string') allow.add(tool);
    if (Array.isArray(content.deniedTools)) for (const tool of content.deniedTools) if (typeof tool === 'string') deny.add(tool);
  }
  return {
    ...(named.length > 0 ? { allow: Object.freeze([...allow].sort()) } : {}),
    deny: Object.freeze([...deny].sort()),
  };
}

/** F-1: filter every plan step's declared tools to the surface (order kept, duplicates dropped). */
function narrowPlanToToolSurface(plan: Plan, surface: DeclaredToolSurface): Plan {
  const allow = surface.allow ? new Set(surface.allow) : undefined;
  const deny = new Set(surface.deny);
  const steps = plan.steps.map((step) => {
    const declared = Array.isArray(step.assignedTools) ? step.assignedTools : [];
    const narrowed: string[] = [];
    for (const tool of declared) {
      if (tool === '*') {
        // `*` means "whatever the runtime permits". With a declared allow surface the effective set
        // is exactly that surface (minus denies); without one the wildcard cannot be enumerated at
        // this layer, so it stays a wildcard — the step persona and the runtime catalog still bound
        // it, and a profile that needs an exact surface pins a toolset.
        if (allow) {
          for (const id of surface.allow!) if (!deny.has(id) && !narrowed.includes(id)) narrowed.push(id);
        } else if (!narrowed.includes('*')) {
          narrowed.push('*');
        }
        continue;
      }
      if (deny.has(tool)) continue;
      if (allow && !allow.has(tool)) continue;
      if (!narrowed.includes(tool)) narrowed.push(tool);
    }
    return { ...step, assignedTools: narrowed };
  });
  return { ...plan, steps };
}

/** Run the prepared profile; the caller maps the outcome onto its own lifecycle. */
export async function runWorkflowProfileBridge(
  prepared: PreparedWorkflowProfileRun,
  options: WorkflowProfileBridgeOptions,
): Promise<WorkflowProfileBridgeOutcome> {
  const { services } = options;
  let plan: Plan | undefined;
  let planText: string | undefined;
  let execution: PlanExecutionResult | undefined;
  let review: Review | undefined;
  let answer: string | undefined;

  /**
   * The clarification round must reach the planner exactly as the legacy re-plan does:
   * `"<request>\n\nCLARIFICATIONS FROM USER:\nQ: …\nA: …"`. The questions come from the
   * planner's own clarify outcome and the answer from the text approval, so the bridge
   * rebuilds that block rather than forwarding the raw answer text.
   */
  let lastQuestions: string[] = [];
  const clarificationAnswer = { text: '' };

  const plannerPort = createPlannerPort({
    planner: services.planner,
    ...(services.renderPlan ? { renderPlan: services.renderPlan } : {}),
    ...(services.modelId ? { modelId: services.modelId } : {}),
    ...(services.mode ? { mode: services.mode } : {}),
  });
  // F-1: the profile's declared tool surface, per execute node, applied to the plan the runtime runs.
  const narrowFor = (request: { nodeId: string; toolsetRef?: string; personaRef?: string }): ((plan: Plan) => Plan) => {
    const surface = declaredExecutionToolSurface(prepared, request);
    return surface === undefined ? (plan: Plan) => plan : (plan: Plan) => narrowPlanToToolSurface(plan, surface);
  };

  // Capture views: new objects, so the caller's services are never patched.
  type ExecutionUsageRecorder = { end(): { modelCalls: number; toolCalls: number } };
  let usageRecorder: ExecutionUsageRecorder | undefined;
  let usageForPlan: { modelCalls: number; toolCalls: number } | undefined;
  const planRuntimeView: PlanRuntimeLike = {
    async execute(planArg: Plan, meta?: PlanRuntimeExecutionMeta): Promise<PlanExecutionResult> {
      // F-3: the delegated execution is the profile's side-effect window. The marker is persisted
      // BEFORE the runtime is called — where the security gate already passed — and cleared only
      // once the call reports back (a returned result, success or failed-partial, is a known
      // outcome). A process killed inside the window — or a call that throws — leaves a detectable
      // `pendingEffect`, and a resume refuses instead of repeating the work.
      prepared.recordEffectStart(meta?.nodeId ?? 'execute', 'delegated plan execution');
      // F-2: measure the window from the run's own events (see the Orchestrator's provider).
      usageRecorder = services.executionUsage?.begin(planArg);
      // F-8: the run's abort signal reaches the delegated runtime, which stops dispatching new
      // steps and cancels tasks already in flight before the loop reports `cancelled`.
      const signal = meta?.signal;
      const forwardCancel = (): void => services.planRuntime.cancel?.();
      if (signal) {
        if (signal.aborted) forwardCancel();
        else signal.addEventListener('abort', forwardCancel, { once: true });
      }
      let outcomeKnown = false;
      try {
        // F-11/F-12: the profile's guardrails are handed to the runtime unchanged; the wrapper only
        // adds the window/cancellation semantics around the call.
        const result = await services.planRuntime.execute(planArg, meta);
        execution = result;
        outcomeKnown = true;
        return result;
      } finally {
        signal?.removeEventListener('abort', forwardCancel);
        usageForPlan = usageRecorder?.end();
        usageRecorder = undefined;
        // A throw means the outcome of the side effect is unknown: the marker stays for the resume
        // gate to refuse an automatic retry (F-3), exactly like a killed process.
        if (outcomeKnown) prepared.recordEffectCommitted();
      }
    },
  };
  /**
   * The final review is a run-level judgement, so it is built here from the context the
   * bridge captured (the plan and the delegated execution result) rather than from the
   * review node's inputs — the profile hands the review node only the execution summary.
   * Without a final reviewer the port is absent and the handler fails closed.
   */
  const reviewerPort: WorkflowReviewerPort | undefined = services.finalReviewer
    ? {
      async review() {
        if (!plan || !execution) {
          throw new WorkflowNodeError('The review node ran without a completed plan to judge', {
            category: 'validation', code: 'review.no-execution', retryable: false,
          });
        }
        const value = await services.finalReviewer!.review(plan, execution, services.modelId);
        review = value;
        return reviewerOutcomeFromReview(value);
      },
    }
    : services.acceptanceChecker
      ? createReviewerPort({
        acceptanceChecker: services.acceptanceChecker,
        ...(services.modelId ? { modelId: services.modelId } : {}),
      })
      : undefined;

  /** Digests of the content a granted side-effect approval bound, for this run only. */
  const approvedPlanDigests = new Set<string>();

  const handlers = createWorkflowProfileHandlers({
    planner: {
      async plan(request) {
        const enriched = request.context && lastQuestions.length > 0
          ? {
            ...request,
            context: confineUntrustedContent(
              `CLARIFICATIONS FROM USER:\n${lastQuestions.map((question) => `Q: ${question}\nA: ${clarificationAnswer.text}`).join('\n')}`,
              { kind: 'context', source: 'request' },
            ),
          }
          : request;
        const outcome = await plannerPort.plan(enriched);
        if (outcome.kind === 'clarify') lastQuestions = [...outcome.needsClarification];
        if (outcome.kind === 'plan') {
          plan = outcome.plan as Plan;
          planText = outcome.planText;
          // Persistence is the caller's job and must happen before anything executes.
          options.onPlan?.(outcome.plan as Plan, outcome.planText);
        } else if (outcome.kind === 'answer') {
          answer = outcome.answer;
        }
        return outcome;
      },
    },
    executor: createExecutorPort({
      planRuntime: planRuntimeView,
      narrowPlan: (plan, request) => narrowFor(request)(plan),
      // F-11: the same surface, handed to the runtime so the skill fallback and any re-planned
      // step are bounded too (the plan-level narrowing cannot see either).
      toolSurfaceFor: (request) => declaredExecutionToolSurface(prepared, request),
      usageFor: (plan) => {
        void plan;
        return usageForPlan;
      },
      assertExecutable: (planDigest) => {
        if (typeof planDigest !== 'string' || !approvedPlanDigests.has(planDigest)) {
          throw new WorkflowNodeError(
            'Execution requires the confirmed plan: no granted side-effect approval binds this plan.',
            { category: 'security-denied', code: 'execute.approval-required', retryable: false },
          );
        }
      },
    }),
    ...(reviewerPort ? { reviewer: reviewerPort } : {}),
    ...(services.confirm
      ? {
        approvals: (() => {
          // F-6: the callback receives the captured plan (when there is one), so the caller can
          // record the plan it is asking about — the server sets `run.planId` from it and the CLI
          // sets `currentPlanId`, which is what makes `/api/plans/:id/confirm` and Ctrl-C work on
          // the profile path.
          const port = createApprovalPort({
            // `plan` is captured by the closure, not read when the port is built: the question is
            // asked after planning, so the callback must see the plan of this run.
            confirm: (prompt: string) => services.confirm!(prompt, plan),
          });
          return {
            async request(approvalRequest: Parameters<typeof port.request>[0]) {
              const outcome = await port.request(approvalRequest);
              // Audit trail only: the digest each decision bound is written to the run record,
              // but a resume re-runs the approval node and this set is per run() call, so a
              // recorded approval can never authorize a later attempt.
              prepared.recordApproval({
                nodeId: approvalRequest.nodeId,
                status: outcome.status,
                ...(approvalRequest.boundDigest ? { digest: approvalRequest.boundDigest } : {}),
                ...(approvalRequest.boundPort ? { boundPort: approvalRequest.boundPort } : {}),
              });
              if (approvalRequest.responseKind === 'text' && outcome.status === 'approved') {
                clarificationAnswer.text = outcome.answer ?? '';
              }
              // Only a granted side-effect approval whose bound digest matches is a licence to
              // execute; the port already verified the bound content, and the executor gate
              // compares the digest with the plan it is about to run.
              if (approvalRequest.approvalType === 'side-effect' && outcome.status === 'approved'
                && typeof approvalRequest.boundDigest === 'string') {
                approvedPlanDigests.add(approvalRequest.boundDigest);
              }
              return outcome;
            },
          };
        })(),
      }
      : {}),
  });

  const result = await prepared.run({
    input: options.input,
    handlers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  // The kernel reports a cancellation *category* on a failed node (`execute.cancelled`,
  // `approval.cancelled`) while reserving run status `cancelled` for the abort signal.
  // The wiring layer normalizes both onto the same observable status so the caller maps
  // exactly one cancellation outcome; the failure itself is still reported for diagnostics.
  const status: WorkflowRunStatus = result.status === 'failure' && result.terminalFailure?.category === 'cancelled'
    ? 'cancelled'
    : result.status;

  return {
    status,
    ...(result.terminalFailure ? { failure: result.terminalFailure } : {}),
    visited: result.nodeSequence,
    ...(plan ? { plan } : {}),
    ...(planText ? { planText } : {}),
    ...(execution ? { execution } : {}),
    ...(review ? { review } : {}),
    ...(answer ? { answer } : {}),
  };
}
