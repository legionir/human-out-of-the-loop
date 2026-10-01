/**
 * Phase 5 (WP-R-006): node handlers for the workflow kernel.
 *
 * This module is the ONLY place where a node kind is connected to a real
 * capability. It adds adapters; it never re-implements control flow, loop
 * bounds, or base security (Phase 4 owns those) and it never schedules plan
 * steps itself (PlanRuntime remains the sole inner DAG scheduler, D-WP-008).
 *
 * Trust boundary, from the very first dispatch:
 *   - every goal/description/persona/skill/fetched answer handed to a service is
 *     first confined with `confineUntrustedContent` (see `untrusted-content.ts`);
 *   - a profile's own service is injected, so a handler cannot reach a model or a
 *     tool the host did not wire; a missing service fails closed;
 *   - a handler never authorizes anything: an approval decision is data, and the
 *     injected executor/runtime re-checks Runtime policy at the real call site
 *     (Phase 6);
 *   - `condition` and `end` are computed inside the kernel from the validated
 *     contract (Phase 4 data-only evaluator and result declarations); they are
 *     deliberately absent here so no second implementation can drift;
 *   - an `approval` node passes through any input port it also declares as an
 *     output (the same rule a condition node follows), so a gated payload can
 *     reach the next node without being threaded around the gate.
 */
import { ABSENT, readPort } from './profile-predicate.js';
import { confineUntrustedContent, confineUntrustedRecord, contentDigest } from './untrusted-content.js';
import type { ConfinedUntrustedContent } from './untrusted-content.js';
import { WorkflowNodeError } from './profile-kernel.js';
import type { WorkflowBudgetHandle, WorkflowFailureCategory, WorkflowNodeHandler, WorkflowNodeInvocation } from './profile-kernel.js';
import type { Plan } from '../schemas/plan.js';
import type { WorkflowNode } from './profile-types.js';

// ─── Ports the host wires ─────────────────────────────────────────

export interface WorkflowPlannerRequest {
  nodeId: string;
  /** Confined goal text; the raw goal is never handed to the service. */
  goal: ConfinedUntrustedContent;
  context?: ConfinedUntrustedContent;
  mode: 'decompose' | 'direct';
  maxPlanItems?: number;
  personaRef?: string;
  toolsetRef?: string;
  modelProfileRef?: string;
  signal?: AbortSignal;
}

export type WorkflowPlannerOutcome =
  | { kind: 'plan'; plan: unknown; planText: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'clarify'; needsClarification: string[] };

export interface WorkflowPlannerPort {
  plan(request: WorkflowPlannerRequest): Promise<WorkflowPlannerOutcome>;
}

export interface WorkflowExecutorRequest {
  nodeId: string;
  goal: ConfinedUntrustedContent;
  plan?: unknown;
  planDigest?: string;
  mode: 'assisted' | 'autonomous';
  requireApprovalForSideEffects: boolean;
  personaRef?: string;
  skillRefs?: string[];
  toolsetRef?: string;
  modelProfileRef?: string;
  signal?: AbortSignal;
  /**
   * F-12: the kernel's live budget handle. The adapter turns it into the runtime's per-dispatch
   * guard, so the delegated execution stops before consuming beyond the profile's caps.
   */
  budget?: WorkflowBudgetHandle;
}

export interface WorkflowExecutorOutcome {
  status: 'completed' | 'failed' | 'partial';
  summary: string;
  taskId?: string;
  artifacts?: unknown[];
  /** Optional classification of a failure, so retry/route can use real categories. */
  failure?: { category: WorkflowFailureCategory; code: string; retryable?: boolean };
  /** Calls the delegation actually spent, charged to the run budget by the handler. */
  usage?: { modelCalls?: number; toolCalls?: number };
}

export interface WorkflowExecutorPort {
  execute(request: WorkflowExecutorRequest): Promise<WorkflowExecutorOutcome>;
}

export interface WorkflowReviewerRequest {
  nodeId: string;
  rubricRef: string;
  allowedDecisions: string[];
  /** Content under review, confined; the only form a prompt may show. */
  content: Record<string, ConfinedUntrustedContent>;
  /**
   * The same values in their typed form, for delegation to a service that needs
   * real objects (a plan, a task). Never paste these into a prompt unconfined.
   */
  raw: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface WorkflowReviewerOutcome {
  decision: string;
  reason: string;
  findings?: unknown[];
}

export interface WorkflowReviewerPort {
  review(request: WorkflowReviewerRequest): Promise<WorkflowReviewerOutcome>;
}

export interface WorkflowApprovalRequest {
  nodeId: string;
  prompt: string;
  approvalType: 'continue' | 'side-effect' | 'custom';
  responseKind: 'decision' | 'text';
  /** Input ports presented to the user, confined. */
  show: Record<string, ConfinedUntrustedContent>;
  /** Digest of the input port named by `bindsTo`, when the node binds one. */
  boundPort?: string;
  boundDigest?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export type WorkflowApprovalOutcome =
  | { status: 'approved'; approvedDigest?: string; decision?: Record<string, unknown>; answer?: string }
  | { status: 'denied' | 'expired' | 'cancelled'; reason?: string };

export interface WorkflowApprovalPort {
  request(request: WorkflowApprovalRequest): Promise<WorkflowApprovalOutcome>;
}

export interface WorkflowProfileHandlerServices {
  planner?: WorkflowPlannerPort;
  executor?: WorkflowExecutorPort;
  reviewer?: WorkflowReviewerPort;
  approvals?: WorkflowApprovalPort;
}

export interface WorkflowProfileHandlerOptions {
  /** Byte budget per confined block; defaults to `UNTRUSTED_DATA_MAX_BYTES`. */
  maxUntrustedBytes?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

const GOAL_INPUT_PORTS = ['goal', 'request', 'description', 'task'] as const;

/**
 * Fields the entry payload's `request` object carries (the bridge builds
 * `{ request: { goal, mode, sessionId } }`). A profile may map either the goal string itself or
 * the whole request object onto the planner/execute goal port; both must reach the node as the
 * user's request, exactly like the legacy path passes `userRequest` (Phase 9 finding H-2).
 */
const GOAL_OBJECT_FIELDS = ['goal', 'request', 'description', 'task', 'text'] as const;

/** The goal text of one input port value: the string itself, or a goal field of a request object. */
function goalText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const field of GOAL_OBJECT_FIELDS) {
    const inner = record[field];
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return undefined;
}

function stringInput(inputs: Readonly<Record<string, unknown>>): string | undefined {
  for (const name of GOAL_INPUT_PORTS) {
    const text = goalText(inputs[name]);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Project a handler result onto the node's declared output ports. A handler can
 * never widen a contract by emitting an undeclared port, and the required/type
 * check itself stays in the kernel (single enforcement point).
 */
function declaredOutputs(node: WorkflowNode, produced: Record<string, unknown>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const portName of Object.keys(node.outputs ?? {})) {
    if (!Object.hasOwn(produced, portName)) continue;
    const value = produced[portName];
    if (value === undefined) continue;
    outputs[portName] = value;
  }
  return outputs;
}

function failure(error: unknown, fallbackCode: string, fallbackCategory: WorkflowFailureCategory = 'handler'): WorkflowNodeError {
  if (error instanceof WorkflowNodeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowNodeError(`${fallbackCode}: ${message}`, { category: fallbackCategory, code: fallbackCode, retryable: false });
}

function confineRecord(
  record: Readonly<Record<string, unknown>>,
  options: { source: string; maxBytes?: number },
  code: string,
): Record<string, ConfinedUntrustedContent> {
  try {
    return confineUntrustedRecord(record, options);
  } catch (error) {
    // Content that cannot be represented as canonical JSON must never reach a prompt.
    throw new WorkflowNodeError(
      `${code}: ${error instanceof Error ? error.message : String(error)}`,
      { category: 'validation', code, retryable: false },
    );
  }
}

function serviceMissing(node: WorkflowNode, service: string): WorkflowNodeError {
  return new WorkflowNodeError(`No ${service} service is wired for node "${node.id}"`, {
    category: 'handler', code: `${service.toLowerCase()}.service-missing`, retryable: false,
  });
}

// ─── Handlers ─────────────────────────────────────────────────────

/**
 * `intake` maps the run's entry payload onto the node's declared output ports.
 * It reads the request/context the entry point already produced; it does not
 * invent values, and a missing required port is left to the kernel's single
 * output-contract check.
 */
function intakeHandler(node: WorkflowNode, inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const produced: Record<string, unknown> = {};
  for (const portName of Object.keys(node.outputs ?? {})) {
    const candidates = portName === 'request' ? GOAL_INPUT_PORTS : [portName];
    for (const candidate of candidates) {
      const value = readPort(inputs, `/${candidate}`);
      if (value !== ABSENT) {
        produced[portName] = value;
        break;
      }
    }
  }
  return produced;
}

export function createWorkflowProfileHandlers(
  services: WorkflowProfileHandlerServices,
  options: WorkflowProfileHandlerOptions = {},
): Partial<Record<WorkflowNode['kind'], WorkflowNodeHandler>> {
  const maxBytes = options.maxUntrustedBytes;
  const confine = (value: unknown, kind: string, source: string) => confineUntrustedContent(value, { kind, source, ...(maxBytes ? { maxBytes } : {}) });

  const intake: WorkflowNodeHandler = (invocation) => intakeHandler(invocation.node, invocation.inputs);

  const planner: WorkflowNodeHandler = async (invocation) => {
    const { node, inputs, signal } = invocation;
    if (!services.planner) throw serviceMissing(node, 'Planner');
    const goalText = stringInput(inputs) ?? node.goal;
    const goal = confine(goalText, 'goal', 'request');
    const context = Object.hasOwn(inputs, 'context') ? confine(inputs.context, 'context', 'request') : undefined;
    let outcome: WorkflowPlannerOutcome;
    try {
      // Planning is a model call: it is charged before the delegation happens, so a
      // run whose model budget is exhausted cannot make the call at all.
      invocation.budget.consumeModelCall();
      outcome = await services.planner.plan({
        nodeId: node.id,
        goal,
        ...(context ? { context } : {}),
        mode: node.config.mode === 'direct' ? 'direct' : 'decompose',
        ...(typeof node.config.maxPlanItems === 'number' ? { maxPlanItems: node.config.maxPlanItems } : {}),
        ...(node.bindings?.personaRef ? { personaRef: node.bindings.personaRef } : {}),
        ...(node.bindings?.toolsetRef ? { toolsetRef: node.bindings.toolsetRef } : {}),
        ...(node.bindings?.modelProfileRef ? { modelProfileRef: node.bindings.modelProfileRef } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw failure(error, 'planner.failed', 'provider');
    }
    const produced: Record<string, unknown> = { kind: outcome.kind };
    if (outcome.kind === 'plan') {
      produced.plan = outcome.plan;
      produced.planText = outcome.planText;
      // The digest binds an approval to exactly the plan text the user was shown.
      produced.planDigest = contentDigest(outcome.planText);
    } else if (outcome.kind === 'answer') {
      produced.answer = outcome.answer;
    } else {
      produced.needsClarification = outcome.needsClarification;
      produced.clarification = outcome.needsClarification.join('\n');
    }
    return declaredOutputs(node, produced);
  };

  const execute: WorkflowNodeHandler = async (invocation) => {
    const { node, inputs, signal } = invocation;
    if (!services.executor) throw serviceMissing(node, 'Executor');
    const goalText = stringInput(inputs) ?? node.goal;
    // F-2 (limits before consumption): the delegated plan executes outside the kernel, so the
    // kernel's per-node charge cannot see its calls. Refuse to start when the remaining budget
    // cannot fund even the minimum the plan needs — one model call per step, and any tool call at
    // all when a step declares tools but the tool budget is exhausted. The measured usage is
    // charged after execution (see `usageFor`), so the counters reflect reality either way.
    const plan = (inputs.plan ?? undefined) as Plan | undefined;
    const stepCount = Array.isArray(plan?.steps) ? plan.steps.length : 0;
    if (stepCount > 0) {
      const remaining = invocation.budget.remaining();
      if (remaining.maxModelCalls < stepCount) {
        throw new WorkflowNodeError(
          `The delegated plan needs at least ${stepCount} model call(s) (one per step) but the profile budget allows ${remaining.maxModelCalls}`,
          { category: 'budget', code: 'budget.insufficient-model-calls', retryable: false },
        );
      }
      const declaresTools = plan!.steps.some(
        (step): boolean => Array.isArray(step.assignedTools) && step.assignedTools.length > 0,
      );
      if (declaresTools && remaining.maxToolCalls === 0) {
        throw new WorkflowNodeError(
          'The delegated plan declares tools but the profile budget allows no tool call',
          { category: 'budget', code: 'budget.insufficient-tool-calls', retryable: false },
        );
      }
    }
    let outcome: WorkflowExecutorOutcome;
    try {
      outcome = await services.executor.execute({
        nodeId: node.id,
        goal: confine(goalText, 'goal', 'request'),
        ...(Object.hasOwn(inputs, 'plan') ? { plan: inputs.plan } : {}),
        ...(typeof inputs.planDigest === 'string' ? { planDigest: inputs.planDigest } : {}),
        mode: node.config.mode === 'autonomous' ? 'autonomous' : 'assisted',
        requireApprovalForSideEffects: node.config.requireApprovalForSideEffects !== false,
        ...(node.bindings?.personaRef ? { personaRef: node.bindings.personaRef } : {}),
        ...(node.bindings?.skillRefs ? { skillRefs: [...node.bindings.skillRefs] } : {}),
        ...(node.bindings?.toolsetRef ? { toolsetRef: node.bindings.toolsetRef } : {}),
        ...(node.bindings?.modelProfileRef ? { modelProfileRef: node.bindings.modelProfileRef } : {}),
        ...(signal ? { signal } : {}),
        budget: invocation.budget,
      });
    } catch (error) {
      throw failure(error, 'execute.failed', 'tool');
    }
    if (outcome.usage?.modelCalls) invocation.budget.consumeModelCall(outcome.usage.modelCalls);
    if (outcome.usage?.toolCalls) invocation.budget.consumeToolCall(outcome.usage.toolCalls);
    if (outcome.status === 'failed' && outcome.failure) {
      throw new WorkflowNodeError(outcome.summary, {
        category: outcome.failure.category,
        code: outcome.failure.code,
        retryable: outcome.failure.retryable === true,
      });
    }
    return declaredOutputs(node, {
      status: outcome.status,
      summary: outcome.summary,
      ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
      ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
    });
  };

  const review: WorkflowNodeHandler = async (invocation) => {
    const { node, inputs, signal } = invocation;
    if (!services.reviewer) throw serviceMissing(node, 'Reviewer');
    const allowedDecisions = Array.isArray(node.config.allowedDecisions) ? [...node.config.allowedDecisions] : ['pass', 'revise', 'reject'];
    let outcome: WorkflowReviewerOutcome;
    try {
      // Reviewing is a model call too.
      invocation.budget.consumeModelCall();
      outcome = await services.reviewer.review({
        nodeId: node.id,
        rubricRef: String(node.config.rubricRef),
        allowedDecisions,
        content: confineRecord(inputs, { source: 'run', ...(maxBytes ? { maxBytes } : {}) }, 'review.content-invalid'),
        raw: inputs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw failure(error, 'review.failed', 'provider');
    }
    if (typeof outcome.decision !== 'string' || !allowedDecisions.includes(outcome.decision)) {
      throw new WorkflowNodeError(
        `Review node "${node.id}" produced decision ${JSON.stringify(outcome.decision)} outside its allowed domain`,
        { category: 'validation', code: 'review.decision-invalid', retryable: false },
      );
    }
    return declaredOutputs(node, {
      decision: outcome.decision,
      reason: outcome.reason,
      ...(outcome.findings !== undefined ? { findings: outcome.findings } : {}),
    });
  };

  const approval: WorkflowNodeHandler = async (invocation) => {
    const { node, inputs, signal } = invocation;
    if (!services.approvals) throw serviceMissing(node, 'Approval');
    const bindsTo = typeof node.config.bindsTo === 'string' ? node.config.bindsTo : undefined;
    const boundValue = bindsTo ? readPort(inputs, `/${bindsTo}`) : ABSENT;
    if (bindsTo && boundValue === ABSENT) {
      throw new WorkflowNodeError(`Approval node "${node.id}" binds to input "${bindsTo}" but no value was produced`, {
        category: 'validation', code: 'approval.bound-input-missing', retryable: false,
      });
    }
    const showPorts = Array.isArray(node.config.show) ? node.config.show : [];
    // F-5: the approver must see what they are binding. The semantic validator refuses such a
    // profile at load time; this is the runtime boundary, so a document assembled in memory cannot
    // ask for a digest-bound approval of unseen content.
    if (bindsTo && !showPorts.includes(bindsTo)) {
      throw new WorkflowNodeError(`Approval node "${node.id}" binds to "${bindsTo}" without showing it; refusing to ask for approval of content the user cannot see`, {
        category: 'validation', code: 'approval.bound-content-not-shown', retryable: false,
      });
    }
    const shown: Record<string, unknown> = {};
    for (const portName of showPorts) {
      const value = readPort(inputs, `/${portName}`);
      if (value !== ABSENT) shown[portName] = value;
    }
    let outcome: WorkflowApprovalOutcome;
    try {
      outcome = await services.approvals.request({
        nodeId: node.id,
        prompt: String(node.config.prompt),
        approvalType: node.config.approvalType,
        responseKind: node.config.responseKind,
        show: confineRecord(shown, { source: 'approval', ...(maxBytes ? { maxBytes } : {}) }, 'approval.content-invalid'),
        ...(bindsTo ? { boundPort: bindsTo, boundDigest: contentDigest(boundValue) } : {}),
        ...(typeof node.config.timeoutSeconds === 'number' ? { timeoutSeconds: node.config.timeoutSeconds } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw failure(error, 'approval.failed', 'approval-denied');
    }
    if (outcome.status !== 'approved') {
      const code = outcome.status === 'denied' ? 'approval.denied' : outcome.status === 'expired' ? 'approval.expired' : 'approval.cancelled';
      const category: WorkflowFailureCategory = outcome.status === 'cancelled' ? 'cancelled' : 'approval-denied';
      throw new WorkflowNodeError(outcome.reason ?? `Approval ${outcome.status}`, { category, code, retryable: false });
    }
    if (bindsTo && outcome.approvedDigest !== contentDigest(boundValue)) {
      // The approved content is not the content being acted on: abort, never continue.
      throw new WorkflowNodeError(`Approval for "${bindsTo}" does not match the content it would authorize`, {
        category: 'approval-denied', code: 'approval.digest-mismatch', retryable: false,
      });
    }
    // Pass-through: an approval node may declare an input port (the plan it gates)
    // also as an output, exactly like a condition node, so the gated content can
    // flow to the next node without threading it around the gate.
    const passThrough: Record<string, unknown> = {};
    const responsePort = node.config.responseKind === 'text' ? 'answer' : 'decision';
    for (const portName of Object.keys(node.outputs ?? {})) {
      if (portName === responsePort) continue;
      const value = readPort(inputs, `/${portName}`);
      if (value !== ABSENT) passThrough[portName] = value;
    }
    if (node.config.responseKind === 'text') {
      return declaredOutputs(node, { ...passThrough, answer: outcome.answer ?? '' });
    }
    return declaredOutputs(node, {
      ...passThrough,
      decision: {
        status: 'approved',
        approved: true,
        ...(bindsTo ? { boundPort: bindsTo, digest: contentDigest(boundValue) } : {}),
        ...(outcome.decision ?? {}),
      },
    });
  };

  return { intake, planner, execute, review, approval };
}
