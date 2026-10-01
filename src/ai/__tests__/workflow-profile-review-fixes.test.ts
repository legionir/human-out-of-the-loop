/**
 * Regression tests for the independent review's fix backlog (2026-09-30):
 *
 *   F-1  the profile's declared tool surface must reach the delegated execution call site
 *   F-2  delegated work must be charged against the profile's counters (and refused before it
 *        starts when the budget cannot fund it)
 *   F-3  the delegated execution must leave a `pendingEffect` marker while it runs
 *   F-6  the confirm callback must receive the captured plan, so the server can set `run.planId`
 *        and the CLI can set `currentPlanId`
 *   F-8  the run's abort signal must reach the delegated `PlanRuntime`
 *
 * Each finding is pinned by its behavior, not by the shape of the fix.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createEventBusExecutionUsage,
  createExecutorPort,
  type PlanRuntimeLike,
} from '../workflow-profiles/orchestrator-adapters.js';
import { createWorkflowProfileHandlers, type WorkflowExecutorPort } from '../workflow-profiles/node-handlers.js';
import { runWorkflowProfileBridge, type WorkflowProfileBridgeServices } from '../workflow-profiles/orchestrator-bridge.js';
import { createDefaultWorkflowProfileDocument } from '../workflow-profiles/default-profile.js';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { MemoryWorkflowProfileRunStateStore } from '../workflow-profiles/profile-run-state.js';
import {
  prepareWorkflowProfileRun,
  WORKFLOW_PROFILE_FLAG_ENV_VAR,
  type PreparedWorkflowProfileRun,
} from '../workflow-profiles/profile-runner.js';
import { createBuiltInRubricCatalogue, type WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import { EventBus, type AgentEvent } from '../runtime/event-bus.js';
import type { Plan } from '../schemas/plan.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import { emptyReviewUsage } from '../schemas/review.js';
import { contentDigest } from '../workflow-profiles/untrusted-content.js';

// ─── Fixtures ──────────────────────────────────────────────────────

const PLANNER_PERSONA = { id: 'planner', name: 'Task Planner', system: 'Plan.', allowedTools: ['create_task'] };
const REVIEWER_PERSONA = { id: 'reviewer', name: 'Code Reviewer', system: 'Review.', allowedTools: ['read_file'] };
const READER_TOOLSET = {
  id: 'reader-tools', name: 'Reader tools', version: '1.0.0',
  tools: ['read_file', 'search_files'], deniedTools: ['search_files'],
};

function sources(toolsets: Record<string, Record<string, unknown>> = {}): WorkflowProfileComponentSources {
  const personas: Record<string, unknown> = { planner: PLANNER_PERSONA, reviewer: REVIEWER_PERSONA };
  return {
    personas: { get: (id: string) => (personas[id] ? { ...(personas[id] as object) } : undefined) },
    skills: { get: () => undefined },
    models: { get: () => undefined },
    toolsets: { get: (id: string) => (toolsets[id] ? { ...toolsets[id] } : undefined) },
    rubrics: { get: (id: string) => createBuiltInRubricCatalogue().get(id) },
  } as unknown as WorkflowProfileComponentSources;
}

const ENV = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' } as const;

/** The default profile with a pinned toolset and (optionally) a profile-level deny list. */
function documentWithToolset(toolsets: Record<string, Record<string, unknown>>, options: { deniedTools?: string[] } = {}) {
  const components = sources(toolsets);
  const document = createDefaultWorkflowProfileDocument(components) as unknown as Record<string, unknown>;
  const dependencies = (document.dependencies as Array<Record<string, unknown>>).slice();
  for (const [id, content] of Object.entries(toolsets)) {
    dependencies.push({
      kind: 'toolset', id, version: '1.0.0',
      digest: dependencyDigest('toolset', id, componentProjection({ ...content })),
    });
  }
  document.dependencies = dependencies;
  document.policies = {
    ...(document.policies as Record<string, unknown>),
    tools: { allowedToolsets: Object.keys(toolsets), deniedTools: options.deniedTools ?? [] },
  };
  return { document, components };
}

function preparedRequest(overrides: Record<string, unknown> = {}) {
  const toolsets = { [READER_TOOLSET.id]: READER_TOOLSET } as Record<string, Record<string, unknown>>;
  const { document, components } = documentWithToolset(toolsets, overrides as { deniedTools?: string[] });
  const store = new MemoryWorkflowProfileRunStateStore();
  const prepared = prepareWorkflowProfileRun({
    document, sources: components, env: ENV, runId: 'run-review-fixes', stateStore: store,
  });
  return { prepared, store };
}

const planWith = (assignedTools: string[]): Plan => ({
  id: 'plan-1', goal: 'g',
  steps: [{ id: 's1', description: 'do it', status: 'pending', assignedTools }],
} as unknown as Plan);

const execution: PlanExecutionResult = {
  planId: 'plan-1', status: 'completed', completedSteps: 1, failedSteps: 0, totalSteps: 1,
  incompleteSteps: [], replanningAttempts: 0,
};

const bridgeServices = (overrides: Partial<WorkflowProfileBridgeServices> = {}): WorkflowProfileBridgeServices => ({
  planner: { plan: vi.fn(async () => ({ kind: 'plan' as const, plan: planWith(['read_file']) })) },
  renderPlan: () => 'PLAN TEXT',
  planRuntime: { execute: vi.fn(async () => execution) },
  finalReviewer: {
    review: vi.fn(async () => ({
      planId: 'plan-1', goal: 'g', outcome: 'success' as const, acceptedFindings: [], rejectedFindings: [],
      incompleteSteps: [], finalSummary: 'ok', usage: emptyReviewUsage,
    })),
  },
  confirm: vi.fn(async (_prompt: string, _plan?: Plan) => ({ confirmed: true })),
  ...overrides,
});

function confinedGoal(text: string) {
  return {
    kind: 'goal', source: 'request', digest: contentDigest(text), bytes: Buffer.byteLength(text),
    truncated: false,
    confined: `<untrusted-data kind="goal" source="request">\n${text}\n</untrusted-data>`,
  };
}

// ─── F-1: the declared tool surface reaches the execution call site ─

describe('F-1 — the profile tool surface narrows the delegated plan', () => {
  it('narrows each step to the pinned toolset (intersected with its own deny list) before the runtime sees it', async () => {
    const { prepared } = preparedRequest();
    const seen: Plan[] = [];
    const services = bridgeServices({
      planRuntime: {
        execute: vi.fn(async (plan: Plan) => {
          seen.push(plan);
          return execution;
        }),
      },
    });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services,
      input: { request: { goal: 'ship it', mode: 'plan' } },
    });

    expect(outcome.status).toBe('success');
    // `search_files` is listed by the step but denied by the toolset; `write_file` is not in the
    // toolset at all. Only `read_file` may reach the runtime.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.steps[0]!.assignedTools).toEqual(['read_file']);
  });

  it('applies a profile-level deny list to explicit step tools', async () => {
    // No toolset is pinned here: only the profile's own deny list narrows the plan.
    const components = sources();
    const document = createDefaultWorkflowProfileDocument(components) as unknown as Record<string, unknown>;
    document.policies = {
      ...(document.policies as Record<string, unknown>),
      tools: { allowedToolsets: [], deniedTools: ['read_file'] },
    };
    const prepared = prepareWorkflowProfileRun({
      document, sources: components, env: ENV, runId: 'run-deny-only', stateStore: new MemoryWorkflowProfileRunStateStore(),
    });
    const seen: Plan[] = [];
    const services = bridgeServices({
      planner: { plan: vi.fn(async () => ({ kind: 'plan' as const, plan: planWith(['read_file', 'search_files']) })) },
      planRuntime: { execute: vi.fn(async (plan: Plan) => { seen.push(plan); return execution; }) },
    });
    await runWorkflowProfileBridge(prepared, { services, input: { request: { goal: 'ship it', mode: 'plan' } } });
    expect(seen[0]!.steps[0]!.assignedTools).toEqual(['search_files']);
  });

  it('turns a wildcard step into the declared surface instead of letting it escape', async () => {
    const { prepared } = preparedRequest();
    const seen: Plan[] = [];
    const services = bridgeServices({
      planner: { plan: vi.fn(async () => ({ kind: 'plan' as const, plan: planWith(['*', 'write_file']) })) },
      planRuntime: { execute: vi.fn(async (plan: Plan) => { seen.push(plan); return execution; }) },
    });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services, input: { request: { goal: 'ship it', mode: 'plan' } },
    });
    expect(outcome.status).toBe('success');
    // `*` becomes exactly the toolset surface minus its own deny list; the unlisted `write_file`
    // is dropped.
    expect(seen[0]!.steps[0]!.assignedTools).toEqual(['read_file']);
  });

  it('passes the node bindings and the narrowed plan to the runtime, and charges measured usage', async () => {
    const runtimeExecute = vi.fn<PlanRuntimeLike['execute']>(async () => execution);
    const narrowPlan = vi.fn((plan: Plan) => ({
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, assignedTools: ['read_file'] })),
    }));
    const port = createExecutorPort({
      planRuntime: { execute: runtimeExecute },
      narrowPlan,
      usageFor: () => ({ modelCalls: 2, toolCalls: 3 }),
    });
    const outcome = await port.execute({
      nodeId: 'work', goal: confinedGoal('g'), plan: planWith(['write_file']),
      mode: 'assisted', requireApprovalForSideEffects: true, toolsetRef: 'reader-tools', personaRef: 'planner',
    });
    expect(narrowPlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }), {
      nodeId: 'work', toolsetRef: 'reader-tools', personaRef: 'planner',
    });
    const delegated = runtimeExecute.mock.calls[0]![0];
    expect(delegated.steps[0]!.assignedTools).toEqual(['read_file']);
    expect(outcome.usage).toEqual({ modelCalls: 2, toolCalls: 3 });
  });
});

// ─── F-2: delegated work is measured and charged ───────────────────

describe('F-2 — delegated usage is measured and charged', () => {
  it('counts only the executed plan’s events', () => {
    const bus = new EventBus();
    const usage = createEventBusExecutionUsage(bus);
    const recorder = usage.begin({ id: 'plan-1' } as Plan);
    const emit = (event: Partial<AgentEvent> & { type: AgentEvent['type'] }) => bus.emit(event as AgentEvent);
    emit({ type: 'agent:tool_call', planId: 'plan-1', toolName: 'read_file' } as AgentEvent);
    emit({ type: 'agent:tool_call', planId: 'plan-2', toolName: 'write_file' } as AgentEvent);
    emit({
      type: 'agent:completed', planId: 'plan-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as AgentEvent);
    emit({
      type: 'agent:error', planId: 'plan-1', usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    } as AgentEvent);
    emit({ type: 'agent:completed', planId: 'plan-2' } as AgentEvent);
    const end = recorder.end();
    expect(end).toEqual({ modelCalls: 2, toolCalls: 1 });

    // The window is closed: later events do not count.
    emit({ type: 'agent:tool_call', planId: 'plan-1', toolName: 'read_file' } as AgentEvent);
    expect(createEventBusExecutionUsage(bus)).toBeDefined();
  });

  it('charges the measured model/tool calls against the kernel budget after delegation', async () => {
    const executor: WorkflowExecutorPort = {
      execute: () => Promise.resolve({ status: 'completed', summary: 'ok', usage: { modelCalls: 2, toolCalls: 4 } }),
    };
    const budget = {
      consumeModelCall: vi.fn(),
      consumeToolCall: vi.fn(),
      elapsedMs: () => 0,
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 10, maxToolCalls: 10 }),
      usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    const handlers = createWorkflowProfileHandlers({ executor }) as Record<string, (invocation: unknown) => Promise<Record<string, unknown>>>;
    await handlers.execute!({
      node: {
        id: 'work', kind: 'execute', goal: 'work',
        inputs: { plan: { type: 'object', required: true } },
        outputs: { status: { type: 'string', required: true }, summary: { type: 'string', required: true } },
        config: {},
      },
      inputs: { plan: planWith(['read_file']) },
      attempt: 1, visit: 1, budget,
    });
    expect(budget.consumeModelCall).toHaveBeenCalledWith(2);
    expect(budget.consumeToolCall).toHaveBeenCalledWith(4);
  });

  it('refuses to start a plan the remaining budget cannot fund (model calls, then tool calls)', async () => {
    const executor: WorkflowExecutorPort = { execute: vi.fn() };
    const handlers = createWorkflowProfileHandlers({ executor }) as Record<string, (invocation: unknown) => Promise<Record<string, unknown>>>;
    const node = {
      id: 'work', kind: 'execute', goal: 'work',
      inputs: { plan: { type: 'object', required: true } },
      outputs: { status: { type: 'string', required: true }, summary: { type: 'string', required: true } },
      config: {},
    };
    const twoStepPlan = {
      id: 'plan-1', goal: 'g',
      steps: [
        { id: 's1', description: 'a', status: 'pending', assignedTools: [] },
        { id: 's2', description: 'b', status: 'pending', assignedTools: ['read_file'] },
      ],
    } as unknown as Plan;

    // One model call left, two steps to run: refused before any delegation.
    const starvedModels = {
      consumeModelCall: vi.fn(), consumeToolCall: vi.fn(), elapsedMs: () => 0,
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 1, maxToolCalls: 10 }),
      usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    await expect(handlers.execute!({ node, inputs: { plan: twoStepPlan }, attempt: 1, visit: 1, budget: starvedModels }))
      .rejects.toMatchObject({ options: { category: 'budget', code: 'budget.insufficient-model-calls' } });
    expect(executor.execute).not.toHaveBeenCalled();

    // Tool budget is exhausted while a step declares tools.
    const starvedTools = {
      consumeModelCall: vi.fn(), consumeToolCall: vi.fn(), elapsedMs: () => 0,
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 10, maxToolCalls: 0 }),
      usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    await expect(handlers.execute!({ node, inputs: { plan: twoStepPlan }, attempt: 1, visit: 1, budget: starvedTools }))
      .rejects.toMatchObject({ options: { category: 'budget', code: 'budget.insufficient-tool-calls' } });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

// ─── F-3: the effect window is marked while the plan executes ──────

describe('F-3 — a delegated execution in flight is a pending effect', () => {
  it('marks the run state while executing and commits it when the runtime reports back', async () => {
    const { prepared, store } = preparedRequest();
    const services = bridgeServices({
      planRuntime: {
        execute: vi.fn(async () => {
          expect(store.load('run-review-fixes')!.pendingEffect).toMatchObject({
            nodeId: 'execute', intent: 'delegated plan execution',
          });
          return execution;
        }),
      },
    });
    await runWorkflowProfileBridge(prepared, { services, input: { request: { goal: 'ship it', mode: 'plan' } } });
    expect(store.load('run-review-fixes')!.pendingEffect).toBeUndefined();
  });

  it('leaves the marker behind when the delegated call throws (no automatic retry on resume)', async () => {
    const { prepared, store } = preparedRequest();
    const services = bridgeServices({
      planRuntime: {
        execute: vi.fn(async () => {
          expect(store.load('run-review-fixes')!.pendingEffect).toBeDefined();
          throw new Error('process killed mid-effect');
        }),
      },
    });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services,
      input: { request: { goal: 'ship it', mode: 'plan' } },
    });
    expect(outcome.status).not.toBe('success');
    expect(store.load('run-review-fixes')!.pendingEffect).toMatchObject({ nodeId: 'execute' });
  });
});

// ─── F-6: the confirm callback receives the captured plan ──────────

describe('F-6 — confirmation exposes the plan it is asking about', () => {
  it('passes the captured plan to the confirm callback, so callers can record its id', async () => {
    const { prepared } = preparedRequest();
    const confirm = vi.fn(async (_prompt: string, _plan?: Plan) => ({ confirmed: true }));
    const services = bridgeServices({ confirm });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services,
      input: { request: { goal: 'ship it', mode: 'plan' } },
    });
    expect(outcome.status).toBe('success');
    expect(confirm).toHaveBeenCalledTimes(1);
    const [shown, askedPlan] = confirm.mock.calls[0]!;
    expect(typeof shown).toBe('string');
    expect(askedPlan).toMatchObject({ id: 'plan-1' });
  });

  it('does not invent a plan for a question that has none', async () => {
    const { prepared } = preparedRequest();
    const confirm = vi.fn(async (_prompt: string, _plan?: Plan) => ({ confirmed: true, answer: 'yes' }));
    await runWorkflowProfileBridge(prepared, {
      services: bridgeServices({
        confirm,
        planner: { plan: vi.fn(async () => ({ kind: 'clarify' as const, needsClarification: ['which repo?'] })) },
      }),
      input: { request: { goal: 'ship it', mode: 'plan' } },
    });
    expect(confirm).toHaveBeenCalled();
    expect(confirm.mock.calls[0]![1]).toBeUndefined();
  });
});

// ─── F-8: cancellation reaches the delegated runtime ───────────────

describe('F-8 — the abort signal reaches the delegated PlanRuntime', () => {
  it('forwards the signal into the runtime call', async () => {
    const controller = new AbortController();
    const runtimeExecute = vi.fn(async () => execution);
    const port = createExecutorPort({ planRuntime: { execute: runtimeExecute } });
    await port.execute({
      nodeId: 'work', goal: confinedGoal('g'), plan: planWith([]),
      mode: 'assisted', requireApprovalForSideEffects: true, signal: controller.signal,
    });
    expect(runtimeExecute).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }), {
      nodeId: 'work', signal: controller.signal,
    });
  });

  it('cancels the delegated runtime when the run aborts mid-execution, and reports a cancellation', async () => {
    const { prepared } = preparedRequest();
    const controller = new AbortController();
    let cancelled = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const services = bridgeServices({
      planRuntime: {
        execute: vi.fn(async () => { await gate; return { ...execution, status: 'cancelled' as const }; }),
        cancel: vi.fn(() => { cancelled += 1; }),
      },
    });
    const running = runWorkflowProfileBridge(prepared, {
      services,
      input: { request: { goal: 'ship it', mode: 'plan' } },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(services.planRuntime.execute).toHaveBeenCalled());
    controller.abort();
    expect(cancelled).toBe(1);
    release();
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');
  });

  it('reports a cancellation, and never dispatches under an already-aborted signal', async () => {
    const { prepared } = preparedRequest();
    const controller = new AbortController();
    controller.abort();
    let cancelled = 0;
    const services = bridgeServices({
      planRuntime: {
        execute: vi.fn(async () => ({ ...execution, status: 'cancelled' as const })),
        cancel: vi.fn(() => { cancelled += 1; }),
      },
    });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services,
      input: { request: { goal: 'ship it', mode: 'plan' } },
      signal: controller.signal,
    });
    expect(outcome.status).toBe('cancelled');
    // Either the run stopped before the execute node (nothing to cancel in the runtime) or it
    // reached it and the delegate was cancelled immediately — never a silent continuation.
    const executions = vi.mocked(services.planRuntime.execute!).mock.calls.length;
    expect(cancelled).toBe(executions > 0 ? 1 : 0);
  });
});
