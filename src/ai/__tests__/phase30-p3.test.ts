/**
 * Phase 30 / P3 — real tool side effects + sandbox.
 *
 * Driving the real CLI against the stub provider (goal:
 * `WRITE:../p3-escape.txt` — a path outside the workspace) exposed a
 * silent-failure class of bug:
 *
 *   - the workspace sandbox DID refuse the write
 *     (`{ success: false, error, code: 'PATH_TRAVERSAL_BLOCKED' }`),
 *   - but nothing anywhere recorded that refusal: the observability log
 *     said `Tool "write_file" called` … `Task completed. 1 tools used.`,
 *   - the acceptance judge was told `## Task Errors (if any)\nNone`,
 *   - and the plan reported `Outcome: SUCCESS`.
 *
 * These tests pin the fix: every tool-level failure — a refusal result,
 * a thrown tool, a denied execution — becomes an `agent:tool_error`
 * event, lands in the task's `errors` (which the acceptance judge
 * reads) and shows up in the agent summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText, type LanguageModel } from 'ai';
const mockGenerateText = vi.mocked(generateText);

import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { EventBus, type AgentEvent } from '../runtime/event-bus.js';
import { StreamingManager, createArrayCollector } from '../runtime/streaming-manager.js';
import { ObservabilityLogger } from '../runtime/observability-logger.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeAgent(): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'Test',
    tools: {},
    model: {} as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'C', allowedTools: ['write_file'] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  } as unknown as ResolvedAgent;
}

/**
 * One SDK step that called `write_file`, plus the raw content part the
 * SDK produced for it (a `tool-result` for a returned value, a
 * `tool-error` for a thrown one).
 */
function sdkResultWith(part: unknown) {
  return {
    text: 'Step finished.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    steps: [
      {
        toolCalls: [{ toolName: 'write_file', toolCallId: 'call_1', input: { filePath: '../x' } }],
        content: [
          { type: 'tool-call', toolName: 'write_file', toolCallId: 'call_1', input: { filePath: '../x' } },
          part,
        ],
      },
    ],
  } as any;
}

async function runWith(part: unknown) {
  const eventBus = new EventBus();
  const events: AgentEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));

  mockGenerateText.mockResolvedValueOnce(sdkResultWith(part) as any);

  const result = await new AgentRuntime().run({
    agent: makeAgent(),
    taskId: 'task_1',
    prompt: 'Write ../x',
    eventBus,
  });

  return { result, events };
}

const REFUSAL = {
  type: 'tool-result',
  toolName: 'write_file',
  toolCallId: 'call_1',
  output: {
    success: false,
    error: 'Path "../x" resolves to "/tmp/x" which is outside workspace "/tmp/proj".',
    code: 'PATH_TRAVERSAL_BLOCKED',
  },
};

// ─── Tests ───────────────────────────────────────────────────────

describe('Phase 30 / P3 — tool failures are no longer silent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a refused tool call (`success: false`) as a tool error', async () => {
    const { result, events } = await runWith(REFUSAL);

    const errorEvents = events.filter((e) => e.type === 'agent:tool_error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      type: 'agent:tool_error',
      status: 'error',
      toolName: 'write_file',
      callId: 'call_1',
      taskId: 'task_1',
    });
    expect(errorEvents[0]).toHaveProperty('error', expect.stringContaining('outside workspace'));
    expect((errorEvents[0] as { error: string }).error).toContain('PATH_TRAVERSAL_BLOCKED');

    // The refusal reaches the acceptance judge (it reads `task.errors`)
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([
      expect.stringContaining('write_file: Path "../x" resolves'),
    ]);
    expect(result.errors[0]).toContain('PATH_TRAVERSAL_BLOCKED');

    // …and the human-visible summary — the same string the judge sees
    expect(result.summary).toContain('Tool errors: write_file');
    expect(result.summary).toContain('Used tools: write_file');
  });

  it('records a thrown tool (SDK `tool-error` part)', async () => {
    const { result, events } = await runWith({
      type: 'tool-error',
      toolName: 'write_file',
      toolCallId: 'call_1',
      error: new Error('EACCES: permission denied'),
    });

    const errorEvents = events.filter((e) => e.type === 'agent:tool_error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { error: string }).error).toBe('EACCES: permission denied');
    expect(result.errors).toEqual(['write_file: EACCES: permission denied']);
  });

  it('records a denied execution (`execution-denied`)', async () => {
    const { result, events } = await runWith({
      type: 'tool-result',
      toolName: 'write_file',
      toolCallId: 'call_1',
      output: { type: 'execution-denied', reason: 'user rejected the tool call' },
    });

    expect(events.filter((e) => e.type === 'agent:tool_error')).toHaveLength(1);
    expect(result.errors).toEqual(['write_file: user rejected the tool call']);
  });

  it('does not invent tool errors for successful tool results', async () => {
    const { result, events } = await runWith({
      type: 'tool-result',
      toolName: 'write_file',
      toolCallId: 'call_1',
      output: { success: true, path: 'notes/demo.txt', bytesWritten: 12 },
    });

    expect(events.filter((e) => e.type === 'agent:tool_error')).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.summary).not.toContain('Tool errors');
  });

  it('keeps a successful run with failed tools intact — events stay compact (Law 14)', async () => {
    const { events, result } = await runWith(REFUSAL);

    // Tool ARGUMENTS and results must never leak into events: the error
    // event carries the tool's own message (like `agent:error` always
    // has), never the call input.
    for (const event of events) {
      expect(event).not.toHaveProperty('input');
      expect(JSON.stringify(event)).not.toContain('filePath');
      expect(JSON.stringify(event)).not.toContain('"content"');
    }
    expect(result.summary).not.toContain('filePath');
    // …and the message the human sees is the tool's, not a raw dump.
    expect(result.summary).toContain('outside workspace');
  });

  it('truncates a huge tool error instead of flooding the log', async () => {
    const { result } = await runWith({
      type: 'tool-result',
      toolName: 'write_file',
      toolCallId: 'call_1',
      output: { success: false, error: 'x'.repeat(5000) },
    });

    expect(result.errors[0].length).toBeLessThan(300);
    expect(result.errors[0]).toContain('…');
  });

  it('stores tool errors on a COMPLETED task so the acceptance check sees them', async () => {
    const fakeAgentRuntime = {
      run: vi.fn(async () => ({
        taskId: 'ignored',
        agentId: 'test-agent',
        success: true,
        summary: 'Step finished. Used tools: write_file. Tool errors: write_file — refused.',
        result: 'Step finished.',
        toolsUsed: ['write_file'],
        errors: ['write_file: refused [PATH_TRAVERSAL_BLOCKED]'],
        usage: undefined,
        failureType: null,
      })),
    } as unknown as AgentRuntime;

    const taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus: new EventBus(),
      agentRuntime: fakeAgentRuntime,
    });

    const taskId = taskRuntime.createTask({ agent: makeAgent(), prompt: 'Write ../x' });
    await taskRuntime.waitForAll();

    const task = taskRuntime.getResult(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.errors).toEqual(['write_file: refused [PATH_TRAVERSAL_BLOCKED]']);
    taskRuntime.destroy();
  });

  it('writes a task:tool-error line to the observability log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-log-'));
    const logger = new ObservabilityLogger({ logFilePath: path.join(dir, 'obs.jsonl') });
    const eventBus = new EventBus();
    logger.subscribeToEventBus(eventBus);

    eventBus.emit({
      type: 'agent:tool_error',
      taskId: 'task_1',
      agentId: 'test-agent',
      timestamp: Date.now(),
      status: 'error',
      toolName: 'write_file',
      callId: 'call_1',
      error: 'Path "../x" is outside workspace',
    });

    const entries = logger.readAll();
    const entry = entries.find((e) => e.eventType === 'task:tool-error');
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('warn');
    expect(entry!.message).toContain('write_file');
    expect(entry!.message).toContain('outside workspace');
    expect(entry!.payload).toMatchObject({ toolName: 'write_file', callId: 'call_1' });

    logger.unsubscribeFromEventBus();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces tool errors to the live progress stream without touching the step counter', () => {
    const eventBus = new EventBus();
    const streaming = new StreamingManager({ eventBus });
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:tool_error',
      taskId: 'task_1',
      agentId: 'test-agent',
      timestamp: Date.now(),
      status: 'error',
      toolName: 'write_file',
      callId: 'call_1',
      error: 'Path "../x" is outside workspace',
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('task:tool-error');
    expect(collector.events[0].message).toContain('write_file');
    expect(collector.events[0].payload).toMatchObject({ agentLevel: true, toolName: 'write_file' });

    streaming.stop();
  });
});
