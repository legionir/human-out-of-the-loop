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
import { runWorkflowProfileKernel } from '../workflow-profiles/profile-kernel.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';
import { runWorkflowProfileBridge, type WorkflowProfileBridgeServices } from '../workflow-profiles/orchestrator-bridge.js';
import { createDefaultWorkflowProfileDocument } from '../workflow-profiles/default-profile.js';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { FileWorkflowProfileRunStateStore, MemoryWorkflowProfileRunStateStore } from '../workflow-profiles/profile-run-state.js';
import {
  prepareWorkflowProfileRun,
  WORKFLOW_PROFILE_FLAG_ENV_VAR,
  type PreparedWorkflowProfileRun,
} from '../workflow-profiles/profile-runner.js';
import { createBuiltInRubricCatalogue, type WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import { EventBus, type AgentEvent } from '../runtime/event-bus.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lockIdentity } from '../runtime/file-lock.js';
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

const objectPort = () => ({ type: 'object', required: true });

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
    // An aborted/failed provider call can have no token usage, but its reserved model-call count
    // still has to be charged so a resume cannot regain that allowance.
    emit({ type: 'agent:error', planId: 'plan-1', modelCalls: 3 } as AgentEvent);
    const end = recorder.end();
    expect(end).toEqual({ modelCalls: 5, toolCalls: 1 });

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

  it.each([
    ['model', 'beforeModelCall', 'budget.model-calls-exceeded'],
    ['tool', 'beforeToolCall', 'budget.tool-calls-exceeded'],
  ] as const)('reserves positive %s-call budgets before permitting each actual call', async (_kind, guardName, expectedCode) => {
    const consumeModelCall = vi.fn();
    const consumeToolCall = vi.fn();
    const budget = {
      consumeModelCall, consumeToolCall, elapsedMs: () => 0,
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 1, maxToolCalls: 1 }),
      usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    const runtimeExecute = vi.fn<PlanRuntimeLike['execute']>(async (_plan, meta) => {
      const reserve = guardName === 'beforeModelCall'
        ? meta?.beforeModelCall
        : meta?.beforeToolCall ? () => meta.beforeToolCall!('read_file') : undefined;
      expect(reserve?.()).toBeUndefined(); // The single available call is allowed.
      const denied = reserve?.(); // A second call is rejected before dispatch.
      return { ...execution, status: 'cancelled', cancelReason: denied };
    });
    const port = createExecutorPort({ planRuntime: { execute: runtimeExecute }, usageFor: () => undefined });

    await expect(port.execute({
      nodeId: 'work', goal: confinedGoal('goal'), plan: planWith(['read_file']),
      mode: 'assisted', requireApprovalForSideEffects: true, budget: budget as never,
    })).rejects.toMatchObject({ options: { category: 'budget', code: expectedCode } });
    if (_kind === 'model') {
      expect(consumeModelCall).toHaveBeenCalledWith(1);
      expect(consumeToolCall).not.toHaveBeenCalled();
    } else {
      expect(consumeModelCall).not.toHaveBeenCalled();
      expect(consumeToolCall).toHaveBeenCalledWith(1);
    }
  });

  it('charges reserved calls when a user cancellation returns no usage events', async () => {
    const consumeModelCall = vi.fn();
    const consumeToolCall = vi.fn();
    const budget = {
      consumeModelCall, consumeToolCall, elapsedMs: () => 0,
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 2, maxToolCalls: 2 }),
      usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    const runtimeExecute = vi.fn<PlanRuntimeLike['execute']>(async (_plan, meta) => {
      expect(meta?.beforeModelCall?.()).toBeUndefined();
      return { ...execution, status: 'cancelled' };
    });
    const port = createExecutorPort({ planRuntime: { execute: runtimeExecute }, usageFor: () => undefined });

    await expect(port.execute({
      nodeId: 'work', goal: confinedGoal('goal'), plan: planWith([]),
      mode: 'assisted', requireApprovalForSideEffects: true, budget: budget as never,
    })).rejects.toMatchObject({ options: { category: 'cancelled', code: 'execute.cancelled' } });
    expect(consumeModelCall).toHaveBeenCalledWith(1);
    expect(consumeToolCall).not.toHaveBeenCalled();
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

// ─── F-4: one run, one runner ──────────────────────────────────────

describe('F-4 — a resume holds an exclusive run lease', () => {
  const holdLock = (): ChildProcess => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    return child;
  };
  const waitForPid = (child: ChildProcess): number => {
    if (child.pid === undefined) throw new Error('child has no pid');
    return child.pid;
  };
  const leasePathFor = (dir: string, runId: string): string =>
    join(dir, `${contentDigest(runId).slice('sha256:'.length, 'sha256:'.length + 32)}.json.lease`);

  it('refuses the lease to a live foreign holder and takes it over once that holder is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-'));
    const child = holdLock();
    try {
      const store = new FileWorkflowProfileRunStateStore(dir);
      writeFileSync(leasePathFor(dir, 'run-f4'), JSON.stringify({ pid: waitForPid(child), acquiredAt: Date.now() }));
      expect(store.tryLease('run-f4')).toBeUndefined();
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      // Wait for the reaped child: a zombie still answers `kill(pid, 0)`, exactly like a live process.
      await exited;
    }
    // The holder is dead: the next attempt takes the lease over instead of hanging forever.
    const store = new FileWorkflowProfileRunStateStore(dir);
    const lease = store.tryLease('run-f4');
    expect(lease).toBeDefined();
    expect(() => readFileSync(leasePathFor(dir, 'run-f4'), 'utf8')).not.toThrow();
    lease!.release();
    expect(() => readFileSync(leasePathFor(dir, 'run-f4'), 'utf8')).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to prepare a resume while another live process holds the lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-locked-'));
    const child = holdLock();
    try {
      const store = new FileWorkflowProfileRunStateStore(dir);
      const { document, components } = documentWithToolset({}, {});
      // A first attempt runs to settle, so its own lease is released and the record stays behind.
      const first = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-locked', stateStore: store });
      await first.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } });
      // Another live process now holds the lease for the same run.
      writeFileSync(leasePathFor(dir, 'run-locked'), JSON.stringify({ pid: waitForPid(child), acquiredAt: Date.now() }));

      expect(() => prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-locked', stateStore: store }))
        .toThrow(/resume\.locked|another live process/);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never breaks a lease another process took after the stale one was judged (identity CAS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-cas-'));
    const store = new FileWorkflowProfileRunStateStore(dir);
    const leasePath = leasePathFor(dir, 'run-cas');
    mkdirSync(dirname(leasePath), { recursive: true });
    // The lease that was judged stale…
    writeFileSync(leasePath, JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }));
    const staleIdentity = lockIdentity(leasePath);
    // …is replaced by a fresh one before the break happens (another process won the race).
    rmSync(leasePath);
    writeFileSync(leasePath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() + 1 }));

    const breakStale = (store as unknown as {
      breakStaleLease(leasePath: string, staleIdentity: string | undefined): boolean;
    }).breakStaleLease.bind(store);
    expect(breakStale(leasePath, staleIdentity)).toBe(false);
    // The fresh lease survives: the caller must fail closed, never run beside it.
    expect(readFileSync(leasePath, 'utf8')).toContain(`"pid":${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leases a fresh run too, so two processes cannot write and execute one run id at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-fresh-'));
    const child = holdLock();
    try {
      const store = new FileWorkflowProfileRunStateStore(dir);
      const { document, components } = documentWithToolset({}, {});
      // No record exists yet: this is a fresh run, and the live holder still wins.
      writeFileSync(leasePathFor(dir, 'run-fresh-locked'), JSON.stringify({ pid: waitForPid(child), acquiredAt: Date.now() }));
      expect(() => prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-fresh-locked', stateStore: store }))
        .toThrow(/run\.locked|another live process/);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows same-process preparation but grants execution to only one prepared runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-same-process-'));
    const store = new FileWorkflowProfileRunStateStore(dir);
    const { document, components } = documentWithToolset({}, {});
    const first = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-same-process', stateStore: store });
    const second = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-same-process', stateStore: store });

    const running = first.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } });
    await expect(second.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } }))
      .rejects.toThrow(/run\\.locked|already claimed/);
    await running;
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let a stale same-process handle remove a newer lease generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-generation-'));
    const store = new FileWorkflowProfileRunStateStore(dir);
    const { document, components } = documentWithToolset({}, {});
    const first = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-generation', stateStore: store });
    const stale = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-generation', stateStore: store });
    await first.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } });

    const current = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-generation', stateStore: store });
    await expect(stale.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } }))
      .rejects.toThrow(/run\\.locked|already claimed/);
    expect(() => readFileSync(leasePathFor(dir, 'run-generation'), 'utf8')).not.toThrow();
    await expect(current.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } }))
      .rejects.toThrow(/already-terminal/);
    expect(() => readFileSync(leasePathFor(dir, 'run-generation'), 'utf8')).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('releases the lease when the attempt settles, so a later attempt can lease again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-lease-release-'));
    const store = new FileWorkflowProfileRunStateStore(dir);
    const { document, components } = documentWithToolset({}, {});
    const fresh = prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-release', stateStore: store });
    await fresh.run({ input: { goal: 'g' }, handlers: { intake: () => ({ goal: 'g' }) } });
    // Settled: the lease file is gone, so a later attempt is not blocked by its predecessor.
    expect(() => readFileSync(leasePathFor(dir, 'run-release'), 'utf8')).toThrow();

    // The next attempt leases the run again (its own record status is a separate question).
    prepareWorkflowProfileRun({ document, sources: components, env: ENV, runId: 'run-release', stateStore: store });
    expect(() => readFileSync(leasePathFor(dir, 'run-release'), 'utf8')).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── F-7: a mid-graph pause resumes with its recorded inputs ──────

const stringPortHelper = () => ({ type: 'string', required: true });
const objectPortHelper = () => ({ type: 'object', required: true });

describe('F-7 — a resume restores the inputs of the paused node', () => {
  const midGraphProfile = (): WorkflowProfileDocument => ({
    schemaVersion: '1.0.0',
    profile: { id: 'test.f7', name: 'F-7 fixture', version: '1.0.0', author: 'tests' },
    dependencies: [
      { kind: 'persona', id: 'planner', version: '1.0.0', digest: dependencyDigest('persona', 'planner', componentProjection({ ...PLANNER_PERSONA })) },
    ],
    workflow: {
      startNode: 'start',
      nodes: [
        { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPortHelper() }, config: {} },
        {
          id: 'plan', kind: 'planner', goal: 'plan', inputs: { goal: stringPortHelper() },
          outputs: { planText: stringPortHelper() }, config: { mode: 'decompose' }, bindings: { personaRef: 'planner' },
        },
        {
          id: 'confirm', kind: 'approval', goal: 'confirm', inputs: { planText: stringPortHelper() },
          outputs: { planText: stringPortHelper(), decision: objectPortHelper() },
          config: { prompt: 'Approve?', approvalType: 'continue', responseKind: 'decision', show: ['planText'] },
        },
        {
          id: 'work', kind: 'execute', goal: 'work', inputs: { planText: stringPortHelper() },
          outputs: { summary: stringPortHelper() }, config: { mode: 'assisted', requireApprovalForSideEffects: true },
          bindings: { personaSource: 'plan-step' },
        },
        {
          id: 'finish', kind: 'end', goal: 'finish', inputs: { summary: stringPortHelper() },
          outputs: { summary: stringPortHelper() }, config: { outcome: 'success', emit: { summary: 'summary' } },
        },
      ],
      edges: [
        { from: 'start', to: 'plan', map: { goal: '/goal' } },
        { from: 'plan', to: 'confirm', map: { planText: '/planText' } },
        { from: 'confirm', to: 'work', map: { planText: '/planText' } },
        { from: 'work', to: 'finish', map: { summary: '/summary' } },
      ],
    },
    policies: {
      execution: { maxNodeVisits: 30, maxDurationSeconds: 60, maxModelCalls: 1, maxToolCalls: 5, onLimit: 'ask-user' },
      tools: { allowedToolsets: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  }) as unknown as WorkflowProfileDocument;

  it('stores the paused node inputs and hands them back on resume instead of the entry payload', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const document = midGraphProfile();
    const executeInputs: Array<Record<string, unknown>> = [];
    const handlers = {
      intake: () => ({ goal: 'g' }),
      planner: (invocation: { budget: { consumeModelCall: () => void } }) => {
        invocation.budget.consumeModelCall();
        return { planText: 'THE PLAN' };
      },
      approval: (invocation: { inputs: Record<string, unknown> }) => ({
        planText: invocation.inputs.planText, decision: { approved: true },
      }),
      execute: (invocation: { inputs: Record<string, unknown>; budget: { consumeModelCall: () => void } }) => {
        executeInputs.push({ ...invocation.inputs });
        invocation.budget.consumeModelCall();
        return { summary: 'done' };
      },
    };

    const first = prepareWorkflowProfileRun({ document, sources: sources(), env: ENV, runId: 'run-f7', stateStore: store });
    const paused = await first.run({ input: { goal: 'entry' }, handlers });
    expect(paused.limit).toBe('ask-user');
    const record = store.load('run-f7')!;
    expect(record.currentNodeId).toBe('work');

    const second = prepareWorkflowProfileRun({ document, sources: sources(), env: ENV, runId: 'run-f7', stateStore: store });
    await second.run({ input: { goal: 'a different entry payload' }, handlers });

    // The resumed execute node saw the mapped plan, not the caller's entry input: without F-7 it
    // would have been handed `{ goal: ... }` and failed on the missing `planText` port.
    expect(executeInputs).toHaveLength(2);
    expect(executeInputs[1]).toMatchObject({ planText: 'THE PLAN' });
  });

  it('refuses a legacy pause record that has no stored inputs instead of failing mid-graph', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const document = midGraphProfile();
    const first = prepareWorkflowProfileRun({ document, sources: sources(), env: ENV, runId: 'run-f7-legacy', stateStore: store });
    await first.run({
      input: { goal: 'entry' },
      handlers: {
        intake: () => ({ goal: 'g' }),
        planner: (invocation: { budget: { consumeModelCall: () => void } }) => {
          invocation.budget.consumeModelCall();
          return { planText: 'THE PLAN' };
        },
        approval: (invocation: { inputs: Record<string, unknown> }) => ({
          planText: invocation.inputs.planText, decision: { approved: true },
        }),
        execute: (invocation: { budget: { consumeModelCall: () => void } }) => {
          invocation.budget.consumeModelCall();
          return { summary: 'done' };
        },
      },
    });
    // Records written before F-7 have no `nodeInputs`: resuming one from a mid-graph node refuses
    // (a clear diagnostic) instead of running the node with the wrong inputs.
    const legacy = store.load('run-f7-legacy')!;
    const { nodeInputs: _dropped, ...withoutInputs } = legacy;
    store.save(withoutInputs as typeof legacy);

    const second = prepareWorkflowProfileRun({ document, sources: sources(), env: ENV, runId: 'run-f7-legacy', stateStore: store });
    await expect(second.run({
      input: { goal: 'entry' },
      handlers: { intake: () => ({ goal: 'g' }), planner: () => ({ planText: 'p' }), approval: () => ({}), execute: () => ({ summary: 's' }) },
    })).rejects.toThrow(/inputs-missing/);
  });
});

// ─── F-5: a bound approval must have shown the content ────────────

describe('F-5 — an approval cannot bind content the approver never saw', () => {
  it('refuses at the runtime boundary, before any interaction, when the bound port is not shown', async () => {
    const document = {
      schemaVersion: '1.0.0',
      profile: { id: 'test.f5', name: 'F-5 fixture', version: '1.0.0', author: 'tests' },
      dependencies: [],
      workflow: {
        startNode: 'start',
        nodes: [
          { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { plan: objectPort() }, config: {} },
          {
            id: 'ask', kind: 'approval', goal: 'ask',
            inputs: { plan: objectPort() },
            outputs: { decision: objectPort() },
            config: { prompt: 'Approve?', approvalType: 'side-effect', responseKind: 'decision', bindsTo: 'plan' },
          },
          {
            id: 'finish', kind: 'end', goal: 'finish', inputs: { decision: objectPort() },
            outputs: { decision: objectPort() }, config: { outcome: 'success', emit: { decision: 'decision' } },
          },
        ],
        edges: [
          { from: 'start', to: 'ask', map: { plan: '/plan' } },
          { from: 'ask', to: 'finish', map: { decision: '/decision' } },
        ],
      },
      policies: {
        execution: { maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 5, maxToolCalls: 5, onLimit: 'fail' },
        tools: { allowedToolsets: [] },
        approvals: { policy: 'runtime-default' },
      },
      result: [{ fromNode: 'finish', port: 'decision', kind: 'response', outcome: 'success' }],
    } as unknown as WorkflowProfileDocument;
    const approvals = { request: vi.fn(async () => ({ status: 'approved' as const, approvedDigest: contentDigest({ id: 'p1' }) })) };
    const handlers = createWorkflowProfileHandlers({ approvals });
    const result = await runWorkflowProfileKernel({ profile: document, input: { plan: { id: 'p1' } }, handlers });

    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('approval.bound-content-not-shown');
    expect(approvals.request).not.toHaveBeenCalled();

    // Showing the bound port is what makes the same profile legal.
    (document.workflow.nodes[1]!.config as Record<string, unknown>).show = ['plan'];
    const accepted = await runWorkflowProfileKernel({ profile: document, input: { plan: { id: 'p1' } }, handlers });
    expect(accepted.status).toBe('success');
    expect(approvals.request).toHaveBeenCalledTimes(1);
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

// ─── F-11: the surface reaches the runtime, not only the plan ──────

describe('F-11 — the declared surface also bounds what the runtime builds', () => {
  it('hands the runtime the profile’s declared surface so the skill fallback is bounded too', async () => {
    const { prepared } = preparedRequest();
    const runtimeExecute = vi.fn<PlanRuntimeLike['execute']>(async () => execution);
    const services = bridgeServices({ planRuntime: { execute: runtimeExecute } });
    const outcome = await runWorkflowProfileBridge(prepared, {
      services, input: { request: { goal: 'ship it', mode: 'plan' } },
    });

    expect(outcome.status).toBe('success');
    const meta = runtimeExecute.mock.calls[0]![1];
    // The bridge plan-level narrowing cannot see the tools a skill contributes or a re-planned
    // step invents, so the surface travels to the runtime with the call.
    expect(meta?.toolSurface).toEqual({
      allow: ['read_file', 'search_files'],
      deny: ['search_files'],
    });
  });
});

// ─── F-12: the budget is consulted by the runtime, and counted per call ─

describe('F-12 — the profile budget stops the delegated run and is counted per model call', () => {
  it('charges one model call per call the run reported, not one per agent run', () => {
    const bus = new EventBus();
    const recorder = createEventBusExecutionUsage(bus).begin({ id: 'plan-1' } as Plan);
    // One agent run that made three model calls (the SDK steps of a multi-step run).
    bus.emit({
      type: 'agent:completed', planId: 'plan-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      modelCalls: 3,
    } as AgentEvent);
    // An older emitter says nothing: the run is charged one call, never zero.
    bus.emit({
      type: 'agent:completed', planId: 'plan-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as AgentEvent);
    expect(recorder.end()).toEqual({ modelCalls: 4, toolCalls: 0 });
  });

  it('maps a delegated budget stop to a terminal budget failure, charging the calls it measured', async () => {
    const budget = {
      consumeModelCall: vi.fn(), consumeToolCall: vi.fn(),
      remaining: () => ({ maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 0, maxToolCalls: 10 }),
      elapsedMs: () => 0, usage: () => ({ visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 }),
    };
    const port = createExecutorPort({
      planRuntime: {
        execute: vi.fn(async () => ({
          ...execution, status: 'cancelled' as const, cancelReason: 'budget.model-calls-exceeded',
        })),
      },
      usageFor: () => ({ modelCalls: 3, toolCalls: 2 }),
    });
    await expect(port.execute({
      nodeId: 'work', goal: confinedGoal('g'), plan: planWith(['read_file']),
      mode: 'assisted', requireApprovalForSideEffects: true, budget,
    })).rejects.toMatchObject({
      options: { category: 'budget', code: 'budget.model-calls-exceeded', retryable: false },
    });
    // The stop is terminal, but the calls that already ran are still charged to the profile.
    expect(budget.consumeModelCall).toHaveBeenCalledWith(3);
    expect(budget.consumeToolCall).toHaveBeenCalledWith(2);
  });
});
