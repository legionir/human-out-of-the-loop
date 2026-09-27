/**
 * Phase 32 — the model's live thinking text.
 *
 * The runtime switches an agent turn from `generateText` to `streamText`
 * only when a thinking sink is attached; these tests drive the REAL
 * `streamText` against a mock language model (no network, no key) and
 * assert what a terminal would receive:
 *
 *   - provider reasoning parts (`reasoning-start/-delta/-end`) arrive as
 *     start/delta/end chunks, in order;
 *   - a gateway that answers reasoning in `delta.reasoning_content` (which
 *     the SDK's chat schema drops) is covered through the raw chunk;
 *   - the two sources never double up;
 *   - without a sink the turn is the non-streaming call it always was.
 *
 * The planner's PROJECT CONTEXT lives here too: it is the other half of
 * the same complaint ("the AI does not know what path the project is in").
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import {
  reasoningFromRawChunk,
  emitThought,
  type ThoughtChunk,
} from '../runtime/thought-stream.js';
import {
  buildAssessmentPrompt,
  buildPlanPrompt,
  buildProjectContext,
  projectTopLevelEntries,
} from '../planning/planner.js';

// ─── Helpers ─────────────────────────────────────────────────────

/** LanguageModelV4 usage as the provider spec expects it. */
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 6, text: 4, reasoning: 2 },
};

/** A stream part list that ends the turn with text. */
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

// ─── thought-stream: raw provider chunks ─────────────────────────

describe('reasoningFromRawChunk — the fields gateways actually use', () => {
  it('reads delta.reasoning_content (DeepSeek/Qwen-style gateways)', () => {
    expect(
      reasoningFromRawChunk({ choices: [{ delta: { reasoning_content: 'Hmm,' } }] }),
    ).toBe('Hmm,');
  });

  it('reads delta.reasoning and delta.thinking', () => {
    expect(reasoningFromRawChunk({ choices: [{ delta: { reasoning: 'a' } }] })).toBe('a');
    expect(reasoningFromRawChunk({ choices: [{ delta: { thinking: 'b' } }] })).toBe('b');
  });

  it('reads OpenRouter-style reasoning_details', () => {
    expect(
      reasoningFromRawChunk({
        choices: [{ delta: { reasoning_details: [{ text: 'one ' }, { text: 'two' }] } }],
      }),
    ).toBe('one two');
  });

  it('reads reasoning from a non-streaming message as well', () => {
    expect(reasoningFromRawChunk({ choices: [{ message: { reasoning_content: 'x' } }] })).toBe('x');
  });

  it('ignores chunks without reasoning (content, tools, other APIs)', () => {
    expect(reasoningFromRawChunk({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined();
    expect(reasoningFromRawChunk({ type: 'response.reasoning_summary_text.delta', delta: 'x' })).toBeUndefined();
    expect(reasoningFromRawChunk(null)).toBeUndefined();
    expect(reasoningFromRawChunk('nope')).toBeUndefined();
    expect(reasoningFromRawChunk({ choices: [] })).toBeUndefined();
  });
});

describe('emitThought', () => {
  it('never lets a broken sink fail the model call', () => {
    const sink = vi.fn(() => {
      throw new Error('terminal is gone');
    });
    expect(() => emitThought(sink, { kind: 'delta', text: 'x' })).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

// ─── AgentRuntime: streamed thinking ─────────────────────────────

describe('Phase 32 — AgentRuntime streams the model thinking', () => {
  it('forwards provider reasoning and returns the same result shape', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-reasoning',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'First, ' },
            { type: 'reasoning-delta', id: 'r1', delta: 'check the files.' },
            { type: 'reasoning-end', id: 'r1' },
            ...textChunks('Done.'),
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    const runtime = new AgentRuntime();
    const result = await runtime.run({
      agent: makeAgent(model),
      taskId: 'task_1',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('Done.');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 6, totalTokens: 16 });

    expect(chunks.map((c) => c.kind)).toEqual(['start', 'delta', 'delta', 'end']);
    expect(chunks[1]).toMatchObject({ text: 'First, ', source: 'reasoning', taskId: 'task_1', agentId: 'test-agent' });
    expect(chunks[2]!.text).toBe('check the files.');
    expect(chunks[0]!.source).toBe('reasoning');
  });

  it('covers gateways whose reasoning only exists in the raw chunk', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-gateway',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'raw', rawValue: { choices: [{ delta: { role: 'assistant', reasoning_content: 'Think' } }] } },
            { type: 'raw', rawValue: { choices: [{ delta: { reasoning_content: ' about it.' } }] } },
            ...textChunks('Answer.'),
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    const runtime = new AgentRuntime();
    const result = await runtime.run({
      agent: makeAgent(model),
      taskId: 'task_2',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(result.result).toBe('Answer.');
    expect(chunks.map((c) => c.kind)).toEqual(['start', 'delta', 'delta', 'end']);
    expect(chunks.map((c) => c.text).filter(Boolean).join('')).toBe('Think about it.');
    expect(chunks[1]!.source).toBe('provider-field');
    // The answer starting closes the thinking block.
    expect(chunks[3]!.kind).toBe('end');
  });

  it('never prints the same thinking twice when both sources are present', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-both',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'native' },
            { type: 'reasoning-end', id: 'r1' },
            // The Responses API ships its summaries as reasoning parts AND
            // as raw events; the raw copy must be ignored.
            { type: 'raw', rawValue: { choices: [{ delta: { reasoning_content: 'native' } }] } },
            ...textChunks('ok'),
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_3',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    expect(chunks.filter((c) => c.kind === 'delta').map((c) => c.text)).toEqual(['native']);
  });

  it('turns a thinking block that never closes into an end chunk', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-open',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'only thinking' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
          ] as never[],
        }),
      },
    });

    const { chunks, sink } = recordedSink();
    const runtime = new AgentRuntime();
    const result = await runtime.run({
      agent: makeAgent(model),
      taskId: 'task_4',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: sink,
    });

    // No text and no tool call: the turn is an empty response, and the sink
    // is still left with a closed block (the terminal must not be stuck).
    expect(result.success).toBe(false);
    expect(chunks.map((c) => c.kind)).toEqual(['start', 'delta', 'end']);
  });

  it('stays on the non-streaming call when nothing is watching', async () => {
    const doStream = vi.fn(async () => ({
      stream: simulateReadableStream({ chunks: textChunks('unused') as never[] }),
    }));
    const model = new MockLanguageModelV4({
      modelId: 'mock-generate',
      doGenerate: {
        content: [{ type: 'text', text: 'Generated.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
      doStream,
    });

    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_5',
      prompt: 'do it',
      eventBus: new EventBus(),
    });

    expect(result.result).toBe('Generated.');
    expect(doStream).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('keeps a sink failure out of the run', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-sink-error',
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'boom' },
            ...textChunks('fine'),
          ] as never[],
        }),
      },
    });

    const result = await new AgentRuntime().run({
      agent: makeAgent(model),
      taskId: 'task_6',
      prompt: 'do it',
      eventBus: new EventBus(),
      onThought: () => {
        throw new Error('broken renderer');
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('fine');
  });
});

// ─── Project context ─────────────────────────────────────────────

describe('Phase 32 — the planner is told where it is working', () => {
  function tempProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase32-project-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'README.md'), '# x');
    return root;
  }

  it('names the root, the platform and the top-level entries', () => {
    const root = tempProject();
    const context = buildProjectContext(root);
    expect(context).toContain(`project root: ${root}`);
    expect(context).toContain(`platform: ${process.platform}`);
    expect(context).toContain('package.json is present');
    expect(context).toContain('top-level entries:');
    expect(context).toContain('src/');
    expect(context).toContain('README.md');
    // Heavy directories are not pushed at the model.
    expect(context).not.toContain('node_modules');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is empty without a project root (and leaves the prompts untouched)', () => {
    expect(buildProjectContext(undefined)).toBe('');
    expect(buildAssessmentPrompt('hi')).not.toContain('PROJECT CONTEXT');
    expect(buildPlanPrompt('hi')).not.toContain('PROJECT CONTEXT');
  });

  it('rides along with the assessment and the plan prompts', () => {
    const root = tempProject();
    const assessment = buildAssessmentPrompt('scan this project', root);
    expect(assessment).toContain('PROJECT CONTEXT');
    expect(assessment).toContain(root);
    // The whole point: "which project?" is answered by the context.
    expect(assessment).toContain('CLEAR');
    expect(assessment).toContain('scan this project');

    const plan = buildPlanPrompt('scan this project', { 'Which project?': 'this one' }, root);
    expect(plan).toContain('PROJECT CONTEXT');
    expect(plan).toContain(root);
    expect(plan).toContain('CLARIFICATIONS PROVIDED BY USER');
    expect(plan).toContain('A: this one');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('caps the listing and survives a directory that cannot be read', () => {
    const root = tempProject();
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    expect(projectTopLevelEntries(root, 5)).toHaveLength(5);
    expect(projectTopLevelEntries(path.join(root, 'does-not-exist'))).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
