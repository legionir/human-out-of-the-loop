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
  // Capture views: new objects, so the caller's services are never patched.
  const planRuntimeView: PlanRuntimeLike = {
    async execute(planArg: Plan): Promise<PlanExecutionResult> {
      const result = await services.planRuntime.execute(planArg);
      execution = result;
      return result;
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
          const port = createApprovalPort({ confirm: services.confirm });
          return {
            async request(approvalRequest: Parameters<typeof port.request>[0]) {
              const outcome = await port.request(approvalRequest);
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
