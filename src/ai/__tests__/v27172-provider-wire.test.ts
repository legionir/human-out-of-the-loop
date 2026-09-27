/**
 * v27.17.2 — the wire shapes the reporter's provider actually sends.
 *
 * A real gateway (Windows, `I:\structured-ai\last\test-projects`) produced two
 * complaints in one session:
 *
 *   1. every planning turn cost TWO requests: the assessment answered with JSON
 *      that omitted the required `isClear`, the SDK refused the object, and the
 *      runtime retried the identical prompt instead of reading the answer it
 *      already had;
 *   2. the CLI showed a `💭` and no thinking text, because this provider streams
 *      reasoning as `response.reasoning_text.*` and inside the reasoning item —
 *      neither of which the AI SDK maps to a reasoning delta.
 *
 * These tests drive the REAL runtime against a mock language model, so what is
 * asserted is what a terminal would receive.
 */
import { describe, it, expect } from 'vitest';
import { NoObjectGeneratedError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import { responsesReasoningFromRawChunk, type ThoughtChunk } from '../runtime/thought-stream.js';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 6, text: 4, reasoning: 2 },
};

function textChunks(text: string): unknown[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ];
}

function makeAgent(model: unknown): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'You are a test agent.',
    tools: {},
    model: model as ResolvedAgent['model'],
    persona: { id: 'test-persona', name: 'Test', system: 'x', allowedTools: [] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  } as ResolvedAgent;
}

function recordedSink(): { chunks: ThoughtChunk[]; sink: (c: ThoughtChunk) => void } {
  const chunks: ThoughtChunk[] = [];
  return { chunks, sink: (chunk) => chunks.push(chunk) };
}

/** Every `delta` chunk's text, in order. */
const deltas = (chunks: ThoughtChunk[]): string =>
  chunks
    .filter((c) => c.kind === 'delta')
    .map((c) => c.text ?? '')
    .join('');

// ─── the raw wire ───────────────────────────────────────────────

describe('v27.17.2 — reasoning the SDK does not map', () => {
  it('reads response.reasoning_text deltas and the reasoning item', () => {
    expect(
      responsesReasoningFromRawChunk({ type: 'response.reasoning_text.delta', delta: 'think' })
    ).toEqual({ text: 'think', full: false });

    expect(
      responsesReasoningFromRawChunk({
        type: 'response.reasoning_text.done',
        text: 'thinking out loud',
      })
    ).toEqual({ text: 'thinking out loud', full: true });

    expect(
      responsesReasoningFromRawChunk({
        type: 'response.output_item.done',
        item: { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'x' }] },
      })
    ).toEqual({ text: 'x', full: true });

    expect(
      responsesReasoningFromRawChunk({
        type: 'response.output_item.added',
        item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'y' }] },
      })
    ).toEqual({ text: 'y', full: true });
  });

  it('leaves the SDK-mapped summary events alone (they would print twice)', () => {
    expect(
      responsesReasoningFromRawChunk({ type: 'response.reasoning_summary_text.delta', delta: 'x' })
    ).toBeUndefined();
    expect(
      responsesReasoningFromRawChunk({ type: 'response.reasoning_summary_text.done', text: 'x' })
    ).toBeUndefined();
  });

  it('ignores everything that is not reasoning', () => {
    expect(
      responsesReasoningFromRawChunk({
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      })
    ).toBeUndefined();
    expect(
      responsesReasoningFromRawChunk({ choices: [{ delta: { content: 'hi' } }] })
    ).toBeUndefined();
    expect(responsesReasoningFromRawChunk(null)).toBeUndefined();
    expect(responsesReasoningFromRawChunk('nope')).toBeUndefined();
  });

  it('fills the thinking block when the text only arrives with the item', async () => {
    // The reported shape: the block is announced (reasoning-start), the deltas
    // never come, and the text shows up inside the finished reasoning item.
    const model = new MockLanguageModelV4({
      modelId: 'mock-late-reasoning',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'reasoning-start', id: 'r1' },
            {
              type: 'raw',
              rawValue: {
                type: 'response.output_item.added',
                item: { type: 'reasoning', id: 'rs_1', summary: [] },
              },
            },
            {
              type: 'raw',
              rawValue: {
                type: 'response.output_item.done',
                item: {
                  type: 'reasoning',
                  id: 'rs_1',
                  summary: [],
                  content: [{ type: 'reasoning_text', text: 'checking the project files' }],
                },
              },
            },
            ...textChunks('Done.'),
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_late',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(result.result).toBe('Done.');
    expect(deltas(chunks)).toBe('checking the project files');
    expect(chunks[0]!.kind).toBe('start');
    expect(chunks[chunks.length - 1]!.kind).toBe('end');
    // The regression: a block that opens and stays empty.
    expect(deltas(chunks).length).toBeGreaterThan(0);
  });

  it('prints a raw delta stream once, not again when the item arrives', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-raw-deltas',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'raw', rawValue: { type: 'response.reasoning_text.delta', delta: 'one ' } },
            { type: 'raw', rawValue: { type: 'response.reasoning_text.delta', delta: 'two' } },
            {
              type: 'raw',
              rawValue: {
                type: 'response.output_item.done',
                item: { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'one two' }] },
              },
            },
            ...textChunks('Done.'),
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_raw',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(deltas(chunks)).toBe('one two');
  });
});

// ─── a provider that cannot stream ──────────────────────────────

describe('v27.17.2 — a gateway that ignores `stream: true`', () => {
  it('asks again without streaming instead of answering with nothing', async () => {
    // The reported body: a non-streamed Chat Completions reply with empty
    // content, to a streaming Responses request.
    const model = new MockLanguageModelV4({
      modelId: 'mock-no-stream',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
          ] as never[],
        }),
      },
      doGenerate: {
        content: [{ type: 'text', text: 'the answer the non-streamed call produced' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    });

    const { chunks, sink } = recordedSink();
    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_reask',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('the answer the non-streamed call produced');
    // Once, and the summary says why the provider saw two calls.
    expect(model.doGenerateCalls.length).toBe(1);
    expect(model.doStreamCalls.length).toBe(1);
    expect(result.summary).toContain('repeated without streaming');
  });

  it('re-asks when the stream itself fails (a gateway that cannot stream)', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-stream-error',
      // The stream dies with a provider error (a gateway that cannot stream).
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('streaming is not supported here') },
          ] as never[],
        }),
      },
      doGenerate: {
        content: [{ type: 'text', text: 'answered without streaming' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    });

    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_reask_error',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: () => {},
    });

    expect(result.result).toBe('answered without streaming');
    expect(model.doGenerateCalls.length).toBe(1);
    expect(result.summary).toContain('repeated without streaming');
  });

  it('does not re-ask when the stream produced an answer', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-streamed',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: textChunks('streamed fine') as never[],
        }),
      },
      doGenerate: {
        content: [{ type: 'text', text: 'should not be used' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    });

    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_streamed',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: () => {},
    });

    expect(result.result).toBe('streamed fine');
    expect(model.doGenerateCalls.length).toBe(0);
    expect(result.summary).not.toContain('repeated without streaming');
  });
});
