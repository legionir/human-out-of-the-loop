/**
 * F-11 / F-12 at the runtime boundary (independent review, 2026-09-30):
 *
 *   F-11  a profile's declared tool surface must bound the tools the *build* step leaves on a
 *         step agent.  Plan-level narrowing happens before the runtime sees the plan, so it cannot
 *         see tools a skill contributes when a step names none, nor tools a re-plan introduces.
 *   F-12  the profile budget is consulted by the runtime before it dispatches a step, instead of
 *         being discovered only after the delegated work already made its model calls; and the
 *         agent runtime reports how many model calls it made (an SDK step each) so the profile's
 *         model-call counter charges the run for every call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

vi.mock('../agents/agent-factory.js', async () => {
  const actual = (await vi.importActual('../agents/agent-factory.js')) as Record<string, unknown>;
  return { ...actual, createAgent: vi.fn() };
});

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus, type AgentCompletedEvent, type AgentErrorEvent } from '../runtime/event-bus.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime } from '../runtime/plan-runtime.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import type { TaskRuntime } from '../runtime/task-runtime.js';
import type { Planner } from '../planning/planner.js';
import type { Persona } from '../schemas/persona.js';

const mockGenerateText = vi.mocked(generateText);
const mockCreateAgent = vi.mocked(createAgent);

/** A TaskRuntime stand-in: records the agent each dispatch received, completes immediately. */
function stubTaskRuntime(onCreate?: () => void) {
  const created: Array<{
    agent: ResolvedAgent;
    planStepId?: string;
    executionGuards?: { beforeModelCall?: () => string | undefined; beforeToolCall?: (toolName: string) => string | undefined };
  }> = [];
  return {
    created,
    createTask: vi.fn((request: { agent: ResolvedAgent; planStepId?: string; executionGuards?: { beforeModelCall?: () => string | undefined; beforeToolCall?: (toolName: string) => string | undefined } }) => {
      created.push({ agent: request.agent, planStepId: request.planStepId, executionGuards: request.executionGuards });
      onCreate?.();
      return `task-${created.length}`;
    }),
    getResult: vi.fn(() => ({ status: 'completed' as const, summary: 'done' })),
    cancelTask: vi.fn(() => true),
    waitForAny: vi.fn(async () => {}),
    waitForAll: vi.fn(async () => {}),
  };
}

function runtimeWith(taskRuntime: ReturnType<typeof stubTaskRuntime>): PlanRuntime {
  return new PlanRuntime({
    taskRuntime: taskRuntime as unknown as TaskRuntime,
    planStore: new MemoryPlanStore(),
    planner: {} as unknown as Planner,
    feasibilityDeps: {} as never,
    refs: {} as never,
    maxReplanningAttempts: 0,
    defaultModelId: 'gpt-4o',
  });
}

/** A ResolvedAgent whose `tools` include one tool the surface denies (`search_files`). */
function agentWithTools(): ResolvedAgent {
  return {
    agentId: 'plan-step-s1',
    systemPrompt: 'sys',
    tools: { read_file: {}, search_files: {}, write_file: {} },
    model: { specificationVersion: 'v1' } as unknown as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'x', allowedTools: ['*'] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
    delegationDepth: 0,
  } as unknown as ResolvedAgent;
}

function oneStepPlan(): Plan {
  return createPlan('do work', [
    {
      id: 's1',
      description: 'work',
      dependsOn: [],
      assignedPersona: 'coder',
      // No explicit tools: this is exactly the skill/registry fallback path (F-11).
      assignedSkills: ['file_management'],
      assignedTools: [],
      claimedResources: [],
      acceptanceCriteria: 'done',
    },
  ]);
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockCreateAgent.mockReset();
});

describe('F-11 — the surface bounds the tools a built step agent is handed', () => {
  it('removes every tool the surface does not permit from the agent, not just from the plan', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    const taskRuntime = stubTaskRuntime();
    const plan = oneStepPlan();

    const result = await runtimeWith(taskRuntime).execute(plan, {
      toolSurface: { allow: ['read_file', 'search_files'], deny: ['search_files'] },
    });

    expect(result.status).toBe('completed');
    expect(taskRuntime.createTask).toHaveBeenCalledTimes(1);
    // `search_files` is denied outright; `write_file` is outside the allow list. Neither may reach
    // the agent, whatever path put it on the resolved agent.
    expect(Object.keys(taskRuntime.created[0]!.agent.tools)).toEqual(['read_file']);
    // The surface is a ceiling, not a source: the step named no tools, so its plan list stays
    // empty — the tools the fallback added are what had to be filtered.
    expect(plan.steps[0]!.assignedTools).toEqual([]);
  });

  it('leaves the built agent untouched when no surface is declared', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    const taskRuntime = stubTaskRuntime();
    const result = await runtimeWith(taskRuntime).execute(oneStepPlan());

    expect(result.status).toBe('completed');
    expect(Object.keys(taskRuntime.created[0]!.agent.tools).sort()).toEqual([
      'read_file', 'search_files', 'write_file',
    ]);
  });
});

describe('F-12 — the profile budget stops the run before it dispatches more work', () => {
  it('reports a cancelled run with the exhausted dimension, and dispatches nothing', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    const taskRuntime = stubTaskRuntime();
    const plan = oneStepPlan();

    const result = await runtimeWith(taskRuntime).execute(plan, {
      budgetExceeded: () => 'budget.model-calls-exceeded',
    });

    expect(result.status).toBe('cancelled');
    expect(result.cancelReason).toBe('budget.model-calls-exceeded');
    expect(taskRuntime.createTask).not.toHaveBeenCalled();
  });

  it('does not leak the guard into the next execute on the same runtime', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    const taskRuntime = stubTaskRuntime();
    const runtime = runtimeWith(taskRuntime);

    const guarded = await runtime.execute(oneStepPlan(), {
      budgetExceeded: () => 'budget.tool-calls-exceeded',
    });
    expect(guarded.status).toBe('cancelled');

    // Without options this call must dispatch normally: the guard belonged to the previous run.
    const unguarded = await runtime.execute(oneStepPlan());
    expect(unguarded.status).toBe('completed');
    expect(taskRuntime.createTask).toHaveBeenCalledTimes(1);
  });

  it('cancels already-dispatched PlanRuntime tasks when the execution is cancelled', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    let signalCreated!: () => void;
    const taskCreated = new Promise<void>((resolve) => { signalCreated = resolve; });
    const taskRuntime = stubTaskRuntime(signalCreated);
    const runtime = runtimeWith(taskRuntime);
    const running = runtime.execute(oneStepPlan());

    await taskCreated;
    runtime.cancel('user-cancelled');
    const result = await running;

    expect(taskRuntime.cancelTask).toHaveBeenCalledWith('task-1');
    expect(result.status).toBe('cancelled');

    // A fresh plan on this shared runtime must not inherit the previous attempt's cancellation.
    const next = await runtime.execute(oneStepPlan());
    expect(next.status).toBe('completed');
    expect(taskRuntime.createTask).toHaveBeenCalledTimes(2);
  });

  it('rejects overlapping executions on the same runtime rather than sharing guards or cancellation', async () => {
    mockCreateAgent.mockReturnValue(agentWithTools());
    const taskRuntime = stubTaskRuntime();
    const runtime = runtimeWith(taskRuntime);

    const first = runtime.execute(oneStepPlan());
    const second = runtime.execute(oneStepPlan());

    await expect(second).rejects.toThrow('Concurrent execute() calls on one runtime are not supported');
    expect((await first).status).toBe('completed');
    expect(taskRuntime.createTask).toHaveBeenCalledTimes(1);
  });
});

describe('F-12 — the agent runtime reports its model calls', () => {
  it('emits the SDK step count as modelCalls, and 1 when the SDK reports no steps', async () => {
    const bus = new EventBus();
    const events: AgentCompletedEvent[] = [];
    bus.subscribe('agent:completed', (event) => events.push(event as AgentCompletedEvent));
    const agent = {
      agentId: 'a1',
      systemPrompt: 'sys',
      tools: {},
      model: { specificationVersion: 'v1' } as unknown as LanguageModel,
      persona: { id: 'coder', name: 'Coder', system: 'x', allowedTools: ['*'] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
      delegationDepth: 0,
      generationSettings: { temperature: 0.15, maxOutputTokens: 1024 },
    } as unknown as ResolvedAgent;
    const runtime = new AgentRuntime();

    mockGenerateText.mockResolvedValue({
      text: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      steps: [{}, {}, {}],
    } as never);
    await runtime.run({ agent, prompt: 'hello', eventBus: bus, taskId: 't1', maxSteps: 5 });
    expect(events[0]!.modelCalls).toBe(3);

    mockGenerateText.mockResolvedValue({
      text: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, steps: [],
    } as never);
    await runtime.run({ agent, prompt: 'hello', eventBus: bus, taskId: 't2', maxSteps: 5 });
    expect(events[1]!.modelCalls).toBe(1);
  });

  it('refuses the next model request before the SDK sends it when the live guard is exhausted', async () => {
    let providerRequests = 0;
    mockGenerateText.mockImplementation((async (options: unknown) => {
      const sdkOptions = options as { prepareStep?: (context: { messages: unknown[] }) => unknown };
      // Simulate the SDK calling prepareStep immediately before its provider request.
      sdkOptions.prepareStep!({ messages: [] });
      providerRequests += 1;
      return { text: 'unexpected', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, steps: [{}] };
    }) as never);

    const result = await new AgentRuntime().run({
      agent: { ...agentWithTools(), tools: {} },
      prompt: 'hello',
      eventBus: new EventBus(),
      taskId: 'guarded-model',
      executionGuards: { beforeModelCall: () => 'budget.model-calls-exceeded' },
    });

    expect(providerRequests).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('budget.model-calls-exceeded');
  });

  it('reports every model request already attempted when a later request fails before token usage', async () => {
    mockGenerateText.mockImplementation((async (options: unknown) => {
      const sdkOptions = options as { prepareStep?: (context: { messages: unknown[] }) => unknown };
      sdkOptions.prepareStep!({ messages: [] });
      sdkOptions.prepareStep!({ messages: [] });
      throw new Error('provider failed after two requests');
    }) as never);
    const bus = new EventBus();
    const errors: AgentErrorEvent[] = [];
    bus.subscribe('agent:error', (event) => errors.push(event as AgentErrorEvent));

    await new AgentRuntime().run({
      agent: { ...agentWithTools(), tools: {} },
      prompt: 'hello',
      eventBus: bus,
      taskId: 'partial-model-budget',
      executionGuards: { beforeModelCall: () => undefined },
    });

    expect(errors[0]?.modelCalls).toBe(2);
    expect(errors[0]?.usage).toBeUndefined();
  });

  it('refuses a tool implementation before its side effect when the live guard is exhausted', async () => {
    const sideEffect = vi.fn(async () => 'should not run');
    mockGenerateText.mockImplementation((async (options: unknown) => {
      const sdkOptions = options as {
        tools?: Record<string, { execute: (input: unknown, callOptions?: { toolCallId?: string }) => Promise<unknown> }>;
      };
      await sdkOptions.tools!.dangerous!.execute({}, { toolCallId: 'call-guarded' });
      return { text: 'unexpected', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, steps: [{}] };
    }) as never);

    const result = await new AgentRuntime().run({
      agent: {
        ...agentWithTools(),
        tools: { dangerous: { description: 'dangerous operation', execute: sideEffect } as never },
      },
      prompt: 'call the tool',
      eventBus: new EventBus(),
      taskId: 'guarded-tool',
      executionGuards: { beforeToolCall: () => 'budget.tool-calls-exceeded' },
    });

    expect(sideEffect).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('budget.tool-calls-exceeded');
  });
});
