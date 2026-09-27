/**
 * Phase 32 — "is it still working?" feedback in the CLI.
 *
 * Three pieces are covered here, each at the seam it lives in:
 *
 *   1. `ActivityIndicator` — one self-overwriting line with a message that
 *      changes every 3 seconds, picked at random from the twelve texts that
 *      were asked for, silent without a TTY, and erased before any real
 *      line of output is printed;
 *   2. the thinking renderer — the model's reasoning, streamed in italic
 *      and a colour of its own, with the spinner paused while it streams;
 *   3. the wiring — a thinking sink reaches `AgentRuntime.run` through
 *      `TaskRuntime`, and `--thinking`/`HOTL_THINKING` decide whether one
 *      exists at all (absent by default: tests, pipes and CI keep the
 *      non-streaming path they always had).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { EventBus } from '../../ai/runtime/event-bus.js';
import { TaskRuntime } from '../../ai/runtime/task-runtime.js';
import type { AgentRuntime } from '../../ai/runtime/agent-runtime.js';
import type { ResolvedAgent } from '../../ai/agents/agent-factory.js';
import type { Persona } from '../../ai/schemas/persona.js';
import type { ThoughtChunk } from '../../ai/runtime/thought-stream.js';
import {
  ACTIVITY_INTERVAL_MS,
  ActivityIndicator,
  PROCESSING_MESSAGES,
  resolveActivityEnabled,
  resolveActivityIntervalMs,
  stopActiveActivity,
} from '../utils/activity.js';
import {
  createReasoningRenderer,
  resolveThinkingMode,
} from '../utils/reasoning.js';
import { color, out } from '../utils/output.js';
import { runCommand } from '../commands/run.js';

// ─── A stdout stand-in ───────────────────────────────────────────

interface FakeStream {
  isTTY: boolean;
  writes: string[];
  text(): string;
  write(chunk: string): boolean;
}

function fakeStream(isTTY = true): FakeStream {
  const stream: FakeStream = {
    isTTY,
    writes: [],
    text: () => stream.writes.join(''),
    write(chunk: string) {
      stream.writes.push(chunk);
      return true;
    },
  };
  return stream;
}

const asStream = (s: FakeStream): NodeJS.WriteStream => s as unknown as NodeJS.WriteStream;

function makeAgent(): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'x',
    tools: {},
    model: {} as ResolvedAgent['model'],
    persona: { id: 'p', name: 'P', system: 'x', allowedTools: [] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  } as ResolvedAgent;
}

// ─── 1. The messages ─────────────────────────────────────────────

describe('Phase 32 — the waiting messages', () => {
  it('are exactly the twelve requested texts, in order', () => {
    expect(PROCESSING_MESSAGES).toEqual([
      'dreaming...',
      'Crunching the numbers...',
      'Analyzing the data...',
      'Generating insights...',
      'Processing your request...',
      'Thinking deeply...',
      'Working on it...',
      'Hold tight, almost there...',
      'Just a moment, please...',
      'Loading the magic...',
      'Preparing the response...',
      "Hang tight, we're on it...",
    ]);
  });

  it('rotate every 3 seconds', () => {
    expect(ACTIVITY_INTERVAL_MS).toBe(3000);
  });
});

// ─── 2. The indicator ────────────────────────────────────────────

describe('Phase 32 — ActivityIndicator', () => {
  beforeEach(() => stopActiveActivity());
  afterEach(() => {
    stopActiveActivity();
    vi.useRealTimers();
  });

  it('draws a message immediately and changes it every 3 s', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const indicator = new ActivityIndicator({
      stream: asStream(stream),
      random: () => 0.5,
      frames: ['*'],
    });

    indicator.start();
    const first = indicator.currentMessage;
    expect(stream.text()).toContain(first);
    expect(PROCESSING_MESSAGES).toContain(first);

    vi.advanceTimersByTime(ACTIVITY_INTERVAL_MS);
    expect(indicator.currentMessage).not.toBe(first);
    expect(PROCESSING_MESSAGES).toContain(indicator.currentMessage);

    // Each rotation rewrites the same line (carriage return + erase), so
    // nothing is left behind in the scrollback.
    const markers = stream.text().split('\r\x1b[2K').length - 1;
    expect(markers).toBeGreaterThanOrEqual(2);
    indicator.stop();
  });

  it('never shows the same message twice in a row', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    // A generator that always picks the same index would look frozen.
    const indicator = new ActivityIndicator({
      stream: asStream(stream),
      random: () => 0,
      frames: ['*'],
    });
    const seen: string[] = [];
    indicator.start();
    for (let i = 0; i < 12; i++) {
      seen.push(indicator.currentMessage);
      vi.advanceTimersByTime(ACTIVITY_INTERVAL_MS);
    }
    indicator.stop();
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it('writes nothing without a TTY (or when disabled)', () => {
    vi.useFakeTimers();
    const stream = fakeStream(false);
    const indicator = new ActivityIndicator({ stream: asStream(stream) });
    indicator.start();
    vi.advanceTimersByTime(ACTIVITY_INTERVAL_MS * 3);
    indicator.stop();
    expect(stream.writes).toEqual([]);

    const forced = new ActivityIndicator({ stream: asStream(fakeStream()), enabled: false });
    forced.start();
    expect(forced.isRunning).toBe(false);
  });

  it('is erased before a real line of output and comes back after', () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const indicator = new ActivityIndicator({
      stream: process.stdout,
      enabled: true,
      frames: ['*'],
    });
    indicator.start();
    out('a real line');

    const written = write.mock.calls.map((c) => String(c[0])).join('');
    const lineAt = written.indexOf('a real line');
    expect(lineAt).toBeGreaterThan(-1);
    expect(written).toContain('a real line\n');
    // …and the erase happens right before it, not after.
    expect(written.slice(0, lineAt).endsWith('\r\x1b[2K')).toBe(true);

    // The indicator is not stopped by real output: it comes back on the
    // next frame, so the user keeps seeing that work is in progress.
    vi.advanceTimersByTime(200);
    expect(write.mock.calls.map((c) => String(c[0])).join('').length).toBeGreaterThan(
      written.length,
    );

    indicator.stop();
    write.mockRestore();
  });

  it('pauses for a prompt and resumes afterwards', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const indicator = new ActivityIndicator({
      stream: asStream(stream),
      frames: ['*'],
      random: () => 0.4,
    });
    indicator.start();
    const beforePause = stream.writes.length;
    indicator.pause();
    expect(stream.text().endsWith('\r\x1b[2K')).toBe(true);
    vi.advanceTimersByTime(ACTIVITY_INTERVAL_MS * 2);
    expect(stream.writes.length).toBe(beforePause + 1); // only the erase

    indicator.resume();
    vi.advanceTimersByTime(ACTIVITY_INTERVAL_MS);
    expect(stream.writes.length).toBeGreaterThan(beforePause + 1);
    indicator.stop();
  });

  it('reads its switches from the environment', () => {
    expect(resolveActivityEnabled({}, true)).toBe(true);
    expect(resolveActivityEnabled({}, false)).toBe(false);
    expect(resolveActivityEnabled({ HOTL_NO_ACTIVITY: '1' }, true)).toBe(false);
    expect(resolveActivityEnabled({ HOTL_ACTIVITY: 'off' }, true)).toBe(false);
    expect(resolveActivityIntervalMs({})).toBe(3000);
    expect(resolveActivityIntervalMs({ HOTL_ACTIVITY_INTERVAL_MS: '500' })).toBe(500);
    expect(resolveActivityIntervalMs({ HOTL_ACTIVITY_INTERVAL_MS: 'nonsense' })).toBe(3000);
  });
});

// ─── 3. The thinking renderer ────────────────────────────────────

describe('Phase 32 — thinking text on the terminal', () => {
  it('streams deltas inline, in italic and a colour of its own', () => {
    const stream = fakeStream();
    const indicator = { pause: vi.fn(), resume: vi.fn() };
    const renderer = createReasoningRenderer({
      stream: asStream(stream),
      indicator,
      style: (t) => `«${t}»`,
      prefix: 'think: ',
    });

    renderer({ kind: 'start', source: 'reasoning' });
    renderer({ kind: 'delta', text: 'one ' });
    renderer({ kind: 'delta', text: 'two' });
    renderer({ kind: 'end' });

    // One block: prefix once, deltas as they arrive, a newline at the end.
    expect(stream.text()).toBe('think: «one »«two»\n');
    expect(indicator.pause).toHaveBeenCalledTimes(1);
    expect(indicator.resume).toHaveBeenCalledTimes(1);
  });

  it('uses italic + violet by default', () => {
    const previous = chalk.level;
    chalk.level = 3;
    try {
      const stream = fakeStream();
      const renderer = createReasoningRenderer({ stream: asStream(stream) });
      renderer({ kind: 'start', source: 'reasoning' });
      renderer({ kind: 'delta', text: 'hidden thought' });
      renderer({ kind: 'end' });
      const written = stream.text();
      expect(written).toContain('\x1b[3m'); // italic
      expect(written).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/); // truecolor
      expect(written).toContain('hidden thought');
      expect(color.thinking('x')).toContain('\x1b[3m');
    } finally {
      chalk.level = previous;
    }
  });

  it('opens the block on a delta that was not announced', () => {
    const stream = fakeStream();
    const renderer = createReasoningRenderer({
      stream: asStream(stream),
      style: (t) => t,
      prefix: '',
    });
    renderer({ kind: 'delta', text: 'implicit start' });
    renderer.close();
    expect(stream.text()).toBe('implicit start\n');
  });

  it('keeps the indent on the model’s own line breaks', () => {
    const stream = fakeStream();
    const renderer = createReasoningRenderer({
      stream: asStream(stream),
      style: (t) => t,
      prefix: '',
      indent: '   ',
    });
    renderer({ kind: 'delta', text: 'first\nsecond' });
    renderer({ kind: 'end' });
    expect(stream.text()).toBe('first\n   second\n');
  });

  it('caps a very long block instead of flooding the terminal', () => {
    const stream = fakeStream();
    const renderer = createReasoningRenderer({
      stream: asStream(stream),
      style: (t) => t,
      prefix: '',
      maxChars: 10,
    });
    renderer({ kind: 'delta', text: '0123456789' });
    renderer({ kind: 'delta', text: 'and more' });
    renderer({ kind: 'end' });
    expect(stream.text()).toContain('0123456789');
    expect(stream.text()).toContain('thinking truncated');
    expect(stream.text()).not.toContain('and more');
    expect(stream.text().endsWith('\n')).toBe(true);
  });

  it('close() ends an open block (end of run, cancellation)', () => {
    const stream = fakeStream();
    const indicator = { pause: vi.fn(), resume: vi.fn() };
    const renderer = createReasoningRenderer({ stream: asStream(stream), indicator, style: (t) => t, prefix: '' });
    renderer({ kind: 'delta', text: 'unfinished' });
    renderer.close();
    renderer.close(); // idempotent
    expect(stream.text()).toBe('unfinished\n');
    expect(indicator.resume).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. Switches ─────────────────────────────────────────────────

describe('Phase 32 — when is thinking shown?', () => {
  it('follows --thinking, then the environment, then the TTY', () => {
    expect(resolveThinkingMode(undefined, {}, true)).toBe(true);
    expect(resolveThinkingMode(undefined, {}, false)).toBe(false);
    expect(resolveThinkingMode('auto', { HOTL_THINKING: 'on' }, false)).toBe(true);
    expect(resolveThinkingMode('auto', { HOTL_THINKING: 'off' }, true)).toBe(false);
    expect(resolveThinkingMode('auto', { HOTL_SHOW_THINKING: '1' }, false)).toBe(true);
    // An explicit flag wins over the environment.
    expect(resolveThinkingMode('off', { HOTL_THINKING: 'on' }, true)).toBe(false);
    expect(resolveThinkingMode('on', { HOTL_THINKING: 'off' }, false)).toBe(true);
    expect(resolveThinkingMode('ON', {}, false)).toBe(true);
  });

  it('rejects a typo in --thinking with exit code 2', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await runCommand('do something', { thinking: 'maybe' });
    write.mockRestore();
    expect(result.exitCode).toBe(2);
  });
});

// ─── 5. The sink reaches the agent runtime ───────────────────────

describe('Phase 32 — TaskRuntime forwards the thinking sink', () => {
  it('passes the default sink to every agent turn', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fakeRuntime = {
      run: async (options: Record<string, unknown>) => {
        seen.push(options);
        return {
          taskId: options.taskId as string,
          agentId: 'test-agent',
          success: true,
          summary: 'ok',
          result: 'ok',
          toolsUsed: [],
          errors: [],
          failureType: null,
        };
      },
    } as unknown as AgentRuntime;

    const runtime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus: new EventBus(),
      agentRuntime: fakeRuntime,
      onThought: () => undefined,
    });
    runtime.createTask({ agent: makeAgent(), prompt: 'do it' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(typeof seen[0]!.onThought).toBe('function');
    runtime.destroy();
  });

  it('adds no sink when none was configured (non-streaming path)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fakeRuntime = {
      run: async (options: Record<string, unknown>) => {
        seen.push(options);
        return {
          taskId: options.taskId as string,
          agentId: 'test-agent',
          success: true,
          summary: 'ok',
          result: 'ok',
          toolsUsed: [],
          errors: [],
          failureType: null,
        };
      },
    } as unknown as AgentRuntime;

    const runtime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus: new EventBus(),
      agentRuntime: fakeRuntime,
    });
    runtime.createTask({ agent: makeAgent(), prompt: 'do it' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.onThought).toBeUndefined();
    runtime.destroy();
  });

  it('lets a single task carry its own sink', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fakeRuntime = {
      run: async (options: Record<string, unknown>) => {
        seen.push(options);
        return {
          taskId: options.taskId as string,
          agentId: 'test-agent',
          success: true,
          summary: 'ok',
          result: 'ok',
          toolsUsed: [],
          errors: [],
          failureType: null,
        };
      },
    } as unknown as AgentRuntime;

    const chunks: ThoughtChunk[] = [];
    const runtime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus: new EventBus(),
      agentRuntime: fakeRuntime,
    });
    runtime.createTask({
      agent: makeAgent(),
      prompt: 'do it',
      onThought: (chunk) => chunks.push(chunk),
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    (seen[0]!.onThought as (c: ThoughtChunk) => void)({ kind: 'delta', text: 'x' });
    expect(chunks).toHaveLength(1);
    runtime.destroy();
  });
});
