import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventBus } from '../runtime/event-bus.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import {
  StreamingManager,
  createArrayCollector,
  formatAsSSE,
  type ProgressEvent,
} from '../runtime/streaming-manager.js';
import {
  CancellationManager,
} from '../runtime/cancellation-manager.js';
import { RateLimiter } from '../runtime/rate-limiter.js';
import { UsageAggregator } from '../runtime/usage-aggregator.js';
import { createPlan } from '../schemas/plan.js';
import type { Task } from '../schemas/task.js';
import type { TokenUsage } from '../runtime/event-bus.js';

// ─── StreamingManager tests ──────────────────────────────────────

describe('StreamingManager', () => {
  let eventBus: EventBus;
  let streaming: StreamingManager;

  beforeEach(() => {
    eventBus = new EventBus();
    streaming = new StreamingManager({ eventBus });
  });

  afterEach(() => {
    streaming.stop();
  });

  it('translates agent:running to plan:step-started', () => {
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:running',
      taskId: 'task-1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'Do something',
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('plan:step-started');
    expect(collector.events[0].message).toContain('coder');
  });

  it('translates agent:tool_call with tool name only (no args)', () => {
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:tool_call',
      taskId: 'task-1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      toolName: 'read_file',
      callId: 'call-1',
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('task:tool-call');
    expect(collector.events[0].message).toContain('read_file');
    expect(collector.events[0].payload?.toolName).toBe('read_file');
    // No args leaked
    expect(JSON.stringify(collector.events[0])).not.toContain('filePath');
  });

  it('translates agent:completed with usage info', () => {
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done',
      toolsUsed: ['read_file', 'write_file'],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('plan:step-completed');
    expect(collector.events[0].payload?.usage).toBeDefined();
  });

  it('translates agent:error with truncated message', () => {
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    const longError = 'A'.repeat(500);
    eventBus.emit({
      type: 'agent:error',
      taskId: 'task-1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'error',
      error: longError,
      code: 'PROVIDER_ERROR',
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('plan:step-failed');
    // Message should be truncated
    expect(collector.events[0].message.length).toBeLessThan(200);
  });

  it('supports multiple subscribers', () => {
    const c1 = createArrayCollector();
    const c2 = createArrayCollector();
    streaming.subscribe(c1.handler);
    streaming.subscribe(c2.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });

    expect(c1.events).toHaveLength(1);
    expect(c2.events).toHaveLength(1);
  });

  it('subscriber error does not break the stream', () => {
    streaming.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });

    expect(collector.events).toHaveLength(1);
  });
});

// ─── formatAsSSE tests ──────────────────────────────────────────

describe('formatAsSSE', () => {
  it('formats a progress event as SSE', () => {
    const event: ProgressEvent = {
      type: 'plan:step-completed',
      planId: 'plan-1',
      stepId: 'step-1',
      timestamp: 1234567890,
      message: 'Step done',
    };

    const sse = formatAsSSE(event);

    expect(sse).toContain('event: plan:step-completed');
    expect(sse).toContain('data:');
    expect(sse).toContain('"planId":"plan-1"');
    expect(sse.endsWith('\n\n')).toBe(true);
  });
});

// ─── CancellationManager tests ──────────────────────────────────

describe('CancellationManager', () => {
  let planStore: MemoryPlanStore;
  let taskRuntime: TaskRuntime;
  let cancelManager: CancellationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    planStore = new MemoryPlanStore();
    const eventBus = new EventBus();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 3,
      eventBus,
      agentRuntime: new AgentRuntime(),
    });
    cancelManager = new CancellationManager(planStore, taskRuntime);
  });

  afterEach(() => {
    taskRuntime.destroy();
  });

  it('cancels a running plan', async () => {
    const plan = createPlan('Test', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'running' },
      { id: 's2', description: 'S2', dependsOn: ['s1'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);
    plan.id = 'cancel-test';
    plan.status = 'running';
    planStore.save(plan);

    // Mock PlanRuntime
    const mockRuntime = { cancel: vi.fn() } as any;
    cancelManager.registerRuntime('cancel-test', mockRuntime);

    const result = await cancelManager.cancelPlan('cancel-test');

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe('cancelled');
    expect(mockRuntime.cancel).toHaveBeenCalled();
  });

  it('returns error for non-existent plan', async () => {
    const result = await cancelManager.cancelPlan('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('returns error for already-completed plan', async () => {
    const plan = createPlan('Done', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'done' },
    ]);
    plan.id = 'done-plan';
    plan.status = 'completed';
    planStore.save(plan);

    const result = await cancelManager.cancelPlan('done-plan');
    expect(result.success).toBe(false);
    expect(result.message).toContain('terminal state');
  });

  it('persists cancelled status to the store', async () => {
    const plan = createPlan('To cancel', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);
    plan.id = 'persist-cancel';
    plan.status = 'running';
    planStore.save(plan);

    await cancelManager.cancelPlan('persist-cancel');

    const stored = planStore.load('persist-cancel')!;
    expect(stored.status).toBe('cancelled');
    expect(stored.completedAt).toBeDefined();
  });
});

// ─── RateLimiter tests ──────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxConcurrentPerProvider: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      maxRetries: 2,
    });
  });

  it('allows requests within the concurrency limit', async () => {
    await limiter.acquire('openai');
    await limiter.acquire('openai');

    const stats = limiter.getStats('openai');
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(0);

    limiter.release('openai');
    limiter.release('openai');
  });

  it('queues requests beyond the limit', async () => {
    await limiter.acquire('openai');
    await limiter.acquire('openai');

    // Third request should queue
    let acquired = false;
    const p = limiter.acquire('openai').then(() => {
      acquired = true;
    });

    // Give the event loop a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);
    expect(limiter.getStats('openai').queued).toBe(1);

    // Release one slot
    limiter.release('openai');
    await p;
    expect(acquired).toBe(true);

    limiter.release('openai');
    limiter.release('openai');
  });

  it('detects rate-limit errors', () => {
    expect(limiter.isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(limiter.isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(limiter.isRateLimitError(new Error('Connection refused'))).toBe(false);
  });

  it('calculates exponential backoff with jitter', () => {
    const d0 = limiter.getBackoffDelay(0); // ~50ms ± 25%
    const d1 = limiter.getBackoffDelay(1); // ~100ms ± 25%
    const d2 = limiter.getBackoffDelay(2); // ~200ms ± 25%

    expect(d0).toBeGreaterThanOrEqual(37);
    expect(d0).toBeLessThanOrEqual(63);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('caps backoff at maxBackoffMs', () => {
    const d = limiter.getBackoffDelay(20); // Would be huge without cap
    expect(d).toBeLessThanOrEqual(500);
  });

  it('retries on rate-limit and succeeds', async () => {
    let attempts = 0;

    const result = await limiter.executeWithRetry('openai', async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('HTTP 429 Too Many Requests');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('throws after exhausting retries', async () => {
    let attempts = 0;

    await expect(
      limiter.executeWithRetry('openai', async () => {
        attempts++;
        throw new Error('HTTP 429 Too Many Requests');
      })
    ).rejects.toThrow('429');

    // 1 initial + 2 retries = 3
    expect(attempts).toBe(3);
  });

  it('does not retry non-rate-limit errors', async () => {
    let attempts = 0;

    await expect(
      limiter.executeWithRetry('openai', async () => {
        attempts++;
        throw new Error('Connection refused');
      })
    ).rejects.toThrow('Connection refused');

    expect(attempts).toBe(1); // No retry
  });
});

// ─── UsageAggregator tests ──────────────────────────────────────

describe('UsageAggregator', () => {
  let aggregator: UsageAggregator;

  beforeEach(() => {
    aggregator = new UsageAggregator();
  });

  // Phase 20 (CORR-03): usage is bucketed by the task's real planId
  // (previously these tests relied on record() misusing planStepId).
  function makeTask(id: string, usage?: TokenUsage, planId?: string): Task {
    return {
      id,
      agentDefinitionOrId: 'coder',
      prompt: 'test',
      status: 'completed',
      claimedResources: [],
      errors: [],
      usage,
      createdAt: Date.now(),
      completedAt: Date.now(),
      planId,
    };
  }

  it('records and aggregates usage from tasks', () => {
    aggregator.record(makeTask('t1', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }), 'coder', 'coder-persona');
    aggregator.record(makeTask('t2', { promptTokens: 200, completionTokens: 100, totalTokens: 300 }), 'reviewer', 'reviewer-persona');

    const summary = aggregator.getSummary();

    expect(summary.totalPromptTokens).toBe(300);
    expect(summary.totalCompletionTokens).toBe(150);
    expect(summary.totalTokens).toBe(450);
    expect(summary.taskCount).toBe(2);
  });

  it('breaks down usage by agent', () => {
    aggregator.record(makeTask('t1', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }), 'coder');
    aggregator.record(makeTask('t2', { promptTokens: 200, completionTokens: 100, totalTokens: 300 }), 'coder');
    aggregator.record(makeTask('t3', { promptTokens: 50, completionTokens: 25, totalTokens: 75 }), 'reviewer');

    const summary = aggregator.getSummary();

    expect(summary.byAgent['coder'].totalTokens).toBe(450);
    expect(summary.byAgent['coder'].count).toBe(2);
    expect(summary.byAgent['reviewer'].totalTokens).toBe(75);
    expect(summary.byAgent['reviewer'].count).toBe(1);
  });

  it('breaks down usage by plan', () => {
    aggregator.record(makeTask('t1', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'plan-A'), 'coder');
    aggregator.record(makeTask('t2', { promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'plan-A'), 'coder');
    aggregator.record(makeTask('t3', { promptTokens: 50, completionTokens: 25, totalTokens: 75 }, 'plan-B'), 'reviewer');

    const summary = aggregator.getSummary();

    expect(summary.byPlan['plan-A'].totalTokens).toBe(450);
    expect(summary.byPlan['plan-B'].totalTokens).toBe(75);
  });

  it('getPlanUsage returns correct totals for a specific plan', () => {
    aggregator.record(makeTask('t1', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'plan-X'), 'coder');
    aggregator.record(makeTask('t2', { promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'plan-X'), 'coder');

    const usage = aggregator.getPlanUsage('plan-X');

    expect(usage.totalTokens).toBe(450);
    expect(usage.taskCount).toBe(2);
  });

  it('ignores tasks without usage data', () => {
    aggregator.record(makeTask('t1', undefined), 'coder');
    aggregator.record(makeTask('t2', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }), 'coder');

    const summary = aggregator.getSummary();
    expect(summary.taskCount).toBe(1);
    expect(summary.totalTokens).toBe(150);
  });

  it('clear() resets all records', () => {
    aggregator.record(makeTask('t1', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }), 'coder');
    aggregator.clear();

    const summary = aggregator.getSummary();
    expect(summary.taskCount).toBe(0);
    expect(summary.totalTokens).toBe(0);
  });

  it('getRecords returns all raw records', () => {
    aggregator.recordDirect({
      taskId: 't1',
      planId: 'p1',
      agentId: 'coder',
      personaId: 'coder-persona',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      timestamp: Date.now(),
    });

    const records = aggregator.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].taskId).toBe('t1');
  });
});
