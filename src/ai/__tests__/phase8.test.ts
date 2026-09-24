import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import type { LanguageModel } from 'ai';

// ─── Mock AI SDK ─────────────────────────────────────────────────

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai') as any;
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

// ─── Helpers ─────────────────────────────────────────────────────

function createMockModel(): LanguageModel {
  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  } as unknown as LanguageModel;
}

function createMockAgent(id = 'test-agent'): ResolvedAgent {
  return {
    agentId: id,
    systemPrompt: 'You are a test agent.',
    tools: {},
    model: createMockModel(),
    persona: {
      id: 'test',
      name: 'Test',
      system: 'Test',
      allowedTools: [],
    } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── TaskRuntime — basic lifecycle ──────────────────────────────

describe('TaskRuntime — basic lifecycle', () => {
  let eventBus: EventBus;
  let taskRuntime: TaskRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 3,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });
  });

  afterEach(() => {
    taskRuntime.destroy();
  });

  it('creates a task and returns a taskId', () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Do something',
    });

    expect(taskId).toBeDefined();
    expect(taskId.startsWith('task_')).toBe(true);
  });

  it('task transitions from pending → running → completed', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Analysis complete.',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Analyse',
    });

    // Wait for execution
    await taskRuntime.waitForAll();

    const task = taskRuntime.getResult(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.summary).toContain('Analysis complete');
    expect(task.startedAt).toBeDefined();
    expect(task.completedAt).toBeDefined();
    expect(task.usage?.totalTokens).toBe(30);
  });

  it('task transitions to failed on agent error', async () => {
    mockGenerateText.mockRejectedValue(new Error('Provider crashed'));

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Fail',
    });

    await taskRuntime.waitForAll();

    const task = taskRuntime.getResult(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.failureType).toBe('technical');
    expect(task.errors.length).toBeGreaterThan(0);
  });

  it('getStatus returns current status', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'OK',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Test',
    });

    // Immediately after creation, should be running (or pending)
    const status = taskRuntime.getStatus(taskId);
    expect(status).toBeDefined();
    expect(['pending', 'running']).toContain(status!.status);

    await taskRuntime.waitForAll();

    const finalStatus = taskRuntime.getStatus(taskId);
    expect(finalStatus!.status).toBe('completed');
  });

  it('getResult returns null result for running task (no throw)', async () => {
    // Use a slow mock to keep the task in "running" state
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: 'Slow',
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
                steps: [],
              } as any),
            200
          )
        )
    );

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Slow task',
    });

    // Check immediately
    await delay(20);
    const task = taskRuntime.getResult(taskId)!;
    expect(['pending', 'running']).toContain(task.status);

    await taskRuntime.waitForAll();
  });
});

// ─── Resource Lock ──────────────────────────────────────────────

describe('TaskRuntime — Resource Lock', () => {
  let eventBus: EventBus;
  let taskRuntime: TaskRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 5,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });
  });

  afterEach(() => {
    taskRuntime.destroy();
  });

  it('two tasks with overlapping resources do not run simultaneously', async () => {
    const executionOrder: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockGenerateText.mockImplementation(async (opts: any) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      executionOrder.push(`start:${opts.prompt}`);
      await delay(100);
      executionOrder.push(`end:${opts.prompt}`);
      concurrentCount--;
      return {
        text: `Done: ${opts.prompt}`,
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        steps: [],
      } as any;
    });

    // Both tasks claim the same file
    const t1 = taskRuntime.createTask({
      agent: createMockAgent('agent-1'),
      prompt: 'task-A',
      claimedResources: ['src/main.ts'],
    });

    const t2 = taskRuntime.createTask({
      agent: createMockAgent('agent-2'),
      prompt: 'task-B',
      claimedResources: ['src/main.ts'],
    });

    await taskRuntime.waitForAll();

    // Both should complete
    expect(taskRuntime.getResult(t1)!.status).toBe('completed');
    expect(taskRuntime.getResult(t2)!.status).toBe('completed');

    // They should NOT have overlapped (max concurrent with shared resource = 1)
    expect(maxConcurrent).toBe(1);
  });

  it('tasks with non-overlapping resources run concurrently', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockGenerateText.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await delay(100);
      concurrentCount--;
      return {
        text: 'Done',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        steps: [],
      } as any;
    });

    taskRuntime.createTask({
      agent: createMockAgent('a1'),
      prompt: 'task-X',
      claimedResources: ['src/file-a.ts'],
    });

    taskRuntime.createTask({
      agent: createMockAgent('a2'),
      prompt: 'task-Y',
      claimedResources: ['src/file-b.ts'],
    });

    await taskRuntime.waitForAll();

    // Different resources → can run in parallel
    expect(maxConcurrent).toBe(2);
  });

  it('tasks with no claimed resources run concurrently', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockGenerateText.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await delay(100);
      concurrentCount--;
      return {
        text: 'Done',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        steps: [],
      } as any;
    });

    taskRuntime.createTask({ agent: createMockAgent(), prompt: 't1' });
    taskRuntime.createTask({ agent: createMockAgent(), prompt: 't2' });
    taskRuntime.createTask({ agent: createMockAgent(), prompt: 't3' });

    await taskRuntime.waitForAll();

    expect(maxConcurrent).toBe(3);
  });
});

// ─── Concurrency Cap ────────────────────────────────────────────

describe('TaskRuntime — Concurrency Cap', () => {
  let eventBus: EventBus;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never exceeds maxConcurrentTasks', async () => {
    eventBus = new EventBus();
    const taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 2,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });

    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockGenerateText.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await delay(100);
      concurrentCount--;
      return {
        text: 'Done',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        steps: [],
      } as any;
    });

    // Create 5 tasks with cap of 2
    for (let i = 0; i < 5; i++) {
      taskRuntime.createTask({
        agent: createMockAgent(`agent-${i}`),
        prompt: `task-${i}`,
      });
    }

    await taskRuntime.waitForAll();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(taskRuntime.getRunningCount()).toBe(0);
    expect(taskRuntime.getPendingCount()).toBe(0);

    // All 5 should be completed
    const allTasks = taskRuntime.getAllTasks();
    expect(allTasks).toHaveLength(5);
    expect(allTasks.every((t) => t.status === 'completed')).toBe(true);

    taskRuntime.destroy();
  });

  it('queued tasks start when running tasks complete', async () => {
    eventBus = new EventBus();
    const taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });

    const startTimes: number[] = [];

    mockGenerateText.mockImplementation(async () => {
      startTimes.push(Date.now());
      await delay(50);
      return {
        text: 'Done',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        steps: [],
      } as any;
    });

    taskRuntime.createTask({ agent: createMockAgent(), prompt: 'first' });
    taskRuntime.createTask({ agent: createMockAgent(), prompt: 'second' });
    taskRuntime.createTask({ agent: createMockAgent(), prompt: 'third' });

    await taskRuntime.waitForAll();

    // With cap=1, tasks should start sequentially
    expect(startTimes).toHaveLength(3);
    // Each should start after the previous one (with some tolerance)
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(30);
    expect(startTimes[2] - startTimes[1]).toBeGreaterThanOrEqual(30);

    taskRuntime.destroy();
  });
});

// ─── Control Tools ──────────────────────────────────────────────

describe('Task Control Tools', () => {
  let eventBus: EventBus;
  let taskRuntime: TaskRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 3,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });
  });

  afterEach(() => {
    taskRuntime.destroy();
  });

  it('get_agent_status returns status for existing task', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'OK',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Test',
    });
    await taskRuntime.waitForAll();

    const { createGetAgentStatusTool } = await import(
      '../tools/implementations/task-control-tools.js'
    );
    const tool = createGetAgentStatusTool(taskRuntime);
    const result = await (tool as any).execute({ taskId });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('get_agent_status returns error for non-existent task', async () => {
    const { createGetAgentStatusTool } = await import(
      '../tools/implementations/task-control-tools.js'
    );
    const tool = createGetAgentStatusTool(taskRuntime);
    const result = await (tool as any).execute({ taskId: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('TASK_NOT_FOUND');
  });

  it('get_agent_result returns status (not throw) for running task', async () => {
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: 'Slow',
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
                steps: [],
              } as any),
            500
          )
        )
    );

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Slow',
    });

    await delay(20);

    const { createGetAgentResultTool } = await import(
      '../tools/implementations/task-control-tools.js'
    );
    const tool = createGetAgentResultTool(taskRuntime);
    const result = await (tool as any).execute({ taskId });

    expect(result.success).toBe(true);
    expect(['pending', 'running']).toContain(result.status);
    expect(result.result).toBeNull();

    await taskRuntime.waitForAll();
  });

  it('get_task_details returns full task record', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Detailed result here.',
      usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Detailed task',
      claimedResources: ['src/main.ts'],
    });
    await taskRuntime.waitForAll();

    const { createGetTaskDetailsTool } = await import(
      '../tools/implementations/task-control-tools.js'
    );
    const tool = createGetTaskDetailsTool(taskRuntime);
    const result = await (tool as any).execute({ taskId });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe(taskId);
    expect(result.status).toBe('completed');
    expect(result.claimedResources).toContain('src/main.ts');
    expect(result.usage).toBeDefined();
    expect(result.createdAt).toBeDefined();
  });
});

// ─── Cancellation ───────────────────────────────────────────────

describe('TaskRuntime — Cancellation', () => {
  let eventBus: EventBus;
  let taskRuntime: TaskRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1, // Force queuing
      eventBus,
      agentRuntime: new AgentRuntime(),
    });
  });

  afterEach(() => {
    taskRuntime.destroy();
  });

  it('cancels a pending task', async () => {
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: 'Done',
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
                steps: [],
              } as any),
            200
          )
        )
    );

    // First task fills the slot
    taskRuntime.createTask({ agent: createMockAgent(), prompt: 'blocker' });

    // Second task should be pending
    const t2 = taskRuntime.createTask({ agent: createMockAgent(), prompt: 'to-cancel' });

    await delay(20);
    const cancelled = taskRuntime.cancelTask(t2);
    expect(cancelled).toBe(true);
    expect(taskRuntime.getResult(t2)!.status).toBe('cancelled');

    await taskRuntime.waitForAll();
  });

  it('cannot cancel an already completed task', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      steps: [],
    } as any);

    const taskId = taskRuntime.createTask({
      agent: createMockAgent(),
      prompt: 'Quick',
    });
    await taskRuntime.waitForAll();

    const cancelled = taskRuntime.cancelTask(taskId);
    expect(cancelled).toBe(false);
  });
});
