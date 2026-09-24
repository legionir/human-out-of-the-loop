/**
 * U3 acceptance (unit): a task's per-run execution values actually reach
 * `AgentRuntime.run()`, and the runtime-level config (`maxSteps`,
 * `agentTimeoutMs` — wired in U3, previously dead config) is the fallback
 * only when no per-run override is present.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../runtime/event-bus.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import type { AgentRunOptions, AgentRunResult } from '../runtime/agent-runtime.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';

function testAgent(): ResolvedAgent {
  return {
    agentId: 'u3-agent',
    systemPrompt: 'You are a U3 test agent.',
    tools: {},
    model: {} as ResolvedAgent['model'],
    persona: {
      id: 'coder',
      name: 'Coder',
      description: 'test',
      system: 'test',
      allowedTools: [],
    },
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  };
}

function resultFor(taskId: string): AgentRunResult {
  return {
    taskId,
    agentId: 'u3-agent',
    success: true,
    summary: 'done',
    result: 'done',
    toolsUsed: [],
    errors: [],
    failureType: null,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe('U3 — TaskRuntime per-run execution values', () => {
  it('forwards a task-level timeoutMs and maxSteps to AgentRuntime.run', async () => {
    const run = vi.fn(async (options: AgentRunOptions) => resultFor(options.taskId));
    const runtime = new TaskRuntime({
      eventBus: new EventBus(),
      agentRuntime: { run } as never,
      agentTimeoutMs: 9000,
      maxSteps: 20,
    });

    runtime.createTask({
      agent: testAgent(),
      prompt: 'per-run overrides win',
      agentTimeoutMs: 1234,
      maxSteps: 7,
    });
    await runtime.waitForAll();

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 1234, maxSteps: 7 });
    runtime.destroy();
  });

  it('falls back to the runtime config (wired maxSteps + timeout) without overrides', async () => {
    const run = vi.fn(async (options: AgentRunOptions) => resultFor(options.taskId));
    const runtime = new TaskRuntime({
      eventBus: new EventBus(),
      agentRuntime: { run } as never,
      agentTimeoutMs: 4321,
      maxSteps: 11,
    });

    runtime.createTask({ agent: testAgent(), prompt: 'config fallback' });
    await runtime.waitForAll();

    expect(run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 4321, maxSteps: 11 });
    runtime.destroy();
  });

  it('omits both values when neither overrides nor config are set', async () => {
    const run = vi.fn(async (options: AgentRunOptions) => resultFor(options.taskId));
    const runtime = new TaskRuntime({
      eventBus: new EventBus(),
      agentRuntime: { run } as never,
    });

    runtime.createTask({ agent: testAgent(), prompt: 'defaults' });
    await runtime.waitForAll();

    const options = run.mock.calls[0]![0] as AgentRunOptions;
    expect(options.timeoutMs).toBeUndefined();
    expect(options.maxSteps).toBeUndefined();
    runtime.destroy();
  });
});
