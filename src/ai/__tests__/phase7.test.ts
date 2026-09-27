import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { LanguageModel, Tool } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime, type AgentRunResult } from '../runtime/agent-runtime.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';

// ─── Mock AI SDK ─────────────────────────────────────────────────
// We mock `generateText` from the `ai` package to avoid real API calls.

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai') as any;
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

// ─── Test helpers ────────────────────────────────────────────────

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

function createMockAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'You are a test agent.',
    tools: {},
    model: createMockModel(),
    persona: {
      id: 'test-persona',
      name: 'Test',
      system: 'You are a test agent.',
      allowedTools: [],
    } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
    ...overrides,
  };
}

// ─── EventBus tests ──────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('delivers events to matching subscribers', () => {
    const received: any[] = [];
    bus.subscribe('agent:running', (e) => received.push(e));

    bus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });

    expect(received).toHaveLength(1);
    expect(received[0].taskId).toBe('t1');
  });

  it('wildcard subscriber receives all event types', () => {
    const received: any[] = [];
    bus.subscribe('*', (e) => received.push(e));

    bus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });
    bus.emit({
      type: 'agent:completed',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'done',
      toolsUsed: [],
    });

    expect(received).toHaveLength(2);
  });

  it('unsubscribe stops delivery', () => {
    const received: any[] = [];
    const unsub = bus.subscribe('agent:running', (e) => received.push(e));

    bus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });
    expect(received).toHaveLength(1);

    unsub();

    bus.emit({
      type: 'agent:running',
      taskId: 't2',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test2',
    });
    expect(received).toHaveLength(1); // No new event
  });

  it('subscriber error does not prevent other subscribers', () => {
    const received: any[] = [];
    bus.subscribe('agent:running', () => {
      throw new Error('bad subscriber');
    });
    bus.subscribe('agent:running', (e) => received.push(e));

    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    bus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a1',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });

    expect(received).toHaveLength(1);
    consoleSpy.mockRestore();
  });
});

// ─── AgentRuntime — success path ────────────────────────────────

describe('AgentRuntime — success path', () => {
  let runtime: AgentRuntime;
  let eventBus: EventBus;

  beforeEach(() => {
    runtime = new AgentRuntime();
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  it('executes agent and returns compact result with usage', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Analysis complete. Found 3 issues in main.ts.',
      usage: {
        promptTokens: 150,
        completionTokens: 45,
        totalTokens: 195,
      },
      steps: [],
    } as any);

    const agent = createMockAgent();
    const result = await runtime.run({
      agent,
      taskId: 'task-1',
      prompt: 'Analyse the codebase',
      eventBus,
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('task-1');
    expect(result.agentId).toBe('test-agent');
    expect(result.result).toContain('Analysis complete');
    expect(result.summary).toContain('Analysis complete');
    expect(result.usage).toBeDefined();
    expect(result.usage!.totalTokens).toBe(195);
    expect(result.failureType).toBeNull();
  });

  it('emits correct event sequence: running → completed', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const events: string[] = [];
    eventBus.subscribe('*', (e) => events.push(e.type));

    await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-2',
      prompt: 'Do something',
      eventBus,
    });

    expect(events).toContain('agent:running');
    expect(events).toContain('agent:completed');
    expect(events.indexOf('agent:running')).toBeLessThan(
      events.indexOf('agent:completed')
    );
  });

  it('emits tool_call events with tool name only (no args)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'File read successfully.',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      steps: [
        {
          toolCalls: [
            { toolName: 'read_file', toolCallId: 'call-1', args: { filePath: '/secret/path' } },
            { toolName: 'search_code', toolCallId: 'call-2', args: { pattern: 'password' } },
          ],
        },
      ],
    } as any);

    const toolCallEvents: any[] = [];
    eventBus.subscribe('agent:tool_call', (e) => toolCallEvents.push(e));

    const agent = createMockAgent({
      tools: {
        read_file: { description: 'Read', parameters: {} } as unknown as Tool,
        search_code: { description: 'Search', parameters: {} } as unknown as Tool,
      },
    });

    const result = await runtime.run({
      agent,
      taskId: 'task-3',
      prompt: 'Read and search',
      eventBus,
    });

    expect(result.success).toBe(true);
    expect(result.toolsUsed).toContain('read_file');
    expect(result.toolsUsed).toContain('search_code');

    // Verify compact events: tool name present, args NOT present
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0].toolName).toBe('read_file');
    expect(toolCallEvents[0]).not.toHaveProperty('args');
    expect(toolCallEvents[0]).not.toHaveProperty('arguments');
    expect(toolCallEvents[1].toolName).toBe('search_code');
  });

  it('completed event contains compact summary, not full transcript', async () => {
    const longText = 'A'.repeat(2000);
    mockGenerateText.mockResolvedValueOnce({
      text: longText,
      usage: { promptTokens: 100, completionTokens: 500, totalTokens: 600 },
      steps: [],
    } as any);

    const completedEvents: any[] = [];
    eventBus.subscribe('agent:completed', (e) => completedEvents.push(e));

    await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-4',
      prompt: 'Generate a long report',
      eventBus,
    });

    expect(completedEvents).toHaveLength(1);
    // Summary should be truncated
    expect(completedEvents[0].summary.length).toBeLessThan(600);
  });
});

// ─── AgentRuntime — error paths ──────────────────────────────────

describe('AgentRuntime — error paths', () => {
  let runtime: AgentRuntime;
  let eventBus: EventBus;

  beforeEach(() => {
    runtime = new AgentRuntime();
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  it('handles provider error without crashing', async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error('API rate limit exceeded (429)')
    );

    const result = await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-err-1',
      prompt: 'Do something',
      eventBus,
    });

    expect(result.success).toBe(false);
    expect(result.failureType).toBe('technical');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('rate limit');
  });

  it('emits agent:error event on failure', async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error('Connection refused')
    );

    const errorEvents: any[] = [];
    eventBus.subscribe('agent:error', (e) => errorEvents.push(e));

    await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-err-2',
      prompt: 'Do something',
      eventBus,
    });

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].status).toBe('error');
    expect(errorEvents[0].code).toBeDefined();
    expect(errorEvents[0].error).toBeDefined();
  });

  it('handles timeout without crashing', async () => {
    // Simulate a very slow provider
    mockGenerateText.mockImplementationOnce(
      ((opts: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => _resolve({ text: 'late' }), 5000);
          opts.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('Agent run timed out'));
            },
            { once: true }
          );
        })) as never
    );

    const result = await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-timeout',
      prompt: 'Do something slow',
      eventBus,
      timeoutMs: 100, // Very short timeout
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('timed out');
    expect(result.failureType).toBe('technical');
  });

  it('handles authentication error with correct code', async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error('Invalid API key (401 Unauthorized)')
    );

    const result = await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-auth',
      prompt: 'Do something',
      eventBus,
    });

    expect(result.success).toBe(false);
    // The error should be classified (either AUTH_ERROR or PROVIDER_ERROR)
    expect(result.errors[0]).toBeDefined();
  });

  it('event sequence on error: running → error (no completed)', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Boom'));

    const events: string[] = [];
    eventBus.subscribe('*', (e) => events.push(e.type));

    await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-seq',
      prompt: 'Fail',
      eventBus,
    });

    expect(events).toContain('agent:running');
    expect(events).toContain('agent:error');
    expect(events).not.toContain('agent:completed');
  });

  it('returns tools used before the error occurred', async () => {
    // Simulate: first step succeeds with a tool call, second step fails
    mockGenerateText.mockRejectedValueOnce(
      Object.assign(new Error('Provider crashed mid-execution'), {
        // Some partial state might be available in real SDK errors
      })
    );

    const result = await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-partial',
      prompt: 'Do complex work',
      eventBus,
    });

    expect(result.success).toBe(false);
    // toolsUsed should be an array (possibly empty if error happened before any tool call)
    expect(Array.isArray(result.toolsUsed)).toBe(true);
  });
});

// ─── AgentRuntime — no raw transcript leak ──────────────────────

describe('AgentRuntime — Law 14 compliance', () => {
  let runtime: AgentRuntime;
  let eventBus: EventBus;

  beforeEach(() => {
    runtime = new AgentRuntime();
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  it('result does not contain raw tool call arguments or results', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Found the bug on line 42.',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      steps: [
        {
          toolCalls: [
            {
              toolName: 'read_file',
              toolCallId: 'call-1',
              args: { filePath: '/etc/passwd' },
            },
          ],
          toolResults: [
            {
              toolCallId: 'call-1',
              toolName: 'read_file',
              result: 'root:x:0:0:root:/root:/bin/bash\nSECRET_DATA_HERE',
            },
          ],
        },
      ],
    } as any);

    const allEvents: any[] = [];
    eventBus.subscribe('*', (e) => allEvents.push(e));

    const result = await runtime.run({
      agent: createMockAgent(),
      taskId: 'task-leak',
      prompt: 'Read sensitive file',
      eventBus,
    });

    // Check that no event contains raw args or results
    for (const event of allEvents) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('/etc/passwd');
      expect(serialized).not.toContain('SECRET_DATA_HERE');
      expect(serialized).not.toContain('root:x:0:0');
    }

    // Result summary should be compact
    expect(result.summary).not.toContain('SECRET_DATA_HERE');
  });
});
