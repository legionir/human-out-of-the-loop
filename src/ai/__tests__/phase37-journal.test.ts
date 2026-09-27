import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The hook under test is the runtime's own wiring: what it hands to
// generateText / streamText.  Mocking the SDK at the module boundary keeps the
// test about that wiring, not about a provider.
vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateText, streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';

const generateTextMock = vi.mocked(generateText);
const streamTextMock = vi.mocked(streamText);

import {
  JournalWriter,
  artifactsOf,
  journalFileFor,
  journalOptionsFromEnv,
  outcomeStatus,
  withJournal,
  type JournalEntry,
} from '../runtime/journal.js';
import { collectSecretValues } from '../runtime/secret-scrub.js';
import {
  filterRecords,
  journalFiles,
  journalStats,
  parseSince,
  readJournal,
} from '../../cli/commands/journal.js';

function readLines(file: string): JournalEntry[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalEntry);
}

describe('Phase 37 — JournalWriter', () => {
  let runtimeDir: string;
  let writer: JournalWriter;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-journal-'));
    writer = new JournalWriter({ runtimeDir });
  });

  afterEach(() => {
    writer.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('appends one JSON line per entry, in the day file under the runtime dir', () => {
    const day = new Date();
    writer.log({
      ts: day.toISOString(),
      kind: 'tool',
      tool: 'read_file',
      ok: true,
      summary: 'first',
    });
    writer.log({
      ts: day.toISOString(),
      kind: 'tool',
      tool: 'write_file',
      ok: true,
      summary: 'second',
    });

    const file = journalFileFor(runtimeDir, day);
    expect(fs.existsSync(file)).toBe(true);
    expect(file).toBe(path.join(runtimeDir, 'journal', `${day.toISOString().slice(0, 10)}.jsonl`));

    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.tool)).toEqual(['read_file', 'write_file']);
  });

  it('recreates the file (and the directory) when a running process deletes them', () => {
    writer.log({ ts: new Date().toISOString(), kind: 'tool', tool: 'a', ok: true });
    const file = journalFileFor(runtimeDir, new Date());
    fs.rmSync(path.dirname(file), { recursive: true, force: true });

    writer.log({ ts: new Date().toISOString(), kind: 'tool', tool: 'b', ok: true });

    expect(fs.existsSync(file)).toBe(true);
    expect(readLines(file).map((line) => line.tool)).toEqual(['b']);
  });

  it('does not write when disabled', () => {
    const off = new JournalWriter({ runtimeDir, enabled: false });
    off.log({ ts: new Date().toISOString(), kind: 'tool', tool: 'x', ok: true });
    expect(journalFiles(runtimeDir)).toEqual([]);
  });

  it('redacts credential VALUES and key-named fields', () => {
    const secret = 'sk-live-abcdefghijklmnop';
    const writerWithSecrets = new JournalWriter({
      runtimeDir,
      redactValues: [secret],
    });
    writerWithSecrets.log({
      ts: new Date().toISOString(),
      kind: 'tool',
      tool: 'write_file',
      ok: true,
      input: {
        filePath: 'notes.txt',
        content: `key is ${secret}`,
        apiKey: 'another-secret',
        nested: { Authorization: 'Bearer xyz', keep: 'visible' },
      },
    });
    writerWithSecrets.close();

    const entry = readLines(journalFileFor(runtimeDir, new Date()))[0]!;
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('***REDACTED***');
    const input = entry.input as Record<string, unknown>;
    expect(input.apiKey).toBe('***REDACTED***');
    expect((input.nested as Record<string, unknown>).Authorization).toBe('***REDACTED***');
    expect((input.nested as Record<string, unknown>).keep).toBe('visible');
  });

  it('caps an oversized entry, keeping metadata and a preview', () => {
    const small = new JournalWriter({ runtimeDir, maxEntryBytes: 512, includeResults: 'full' });
    small.log({
      ts: new Date().toISOString(),
      kind: 'tool',
      tool: 'read_file',
      ok: true,
      input: { filePath: 'big.ts' },
      result: { content: 'x'.repeat(4096) },
    });
    small.close();

    const entry = readLines(journalFileFor(runtimeDir, new Date()))[0]!;
    expect(entry.truncated).toBe(true);
    expect(entry.tool).toBe('read_file');
    expect((entry.input as Record<string, unknown>).preview).toBeDefined();
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(8192);
  });

  it('drops the result when includeResults is "none"', () => {
    const quiet = new JournalWriter({ runtimeDir, includeResults: 'none' });
    quiet.log({
      ts: new Date().toISOString(),
      kind: 'tool',
      tool: 'read_file',
      ok: true,
      result: { content: 'x' },
    });
    quiet.close();
    const entry = readLines(journalFileFor(runtimeDir, new Date()))[0]!;
    expect(entry.result).toBeUndefined();
  });

  it('prunes files older than retentionDays and keeps today', () => {
    const dir = path.join(runtimeDir, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1999-01-01.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '1999-01-02.jsonl'), '{}\n');
    const today = new Date();
    fs.writeFileSync(journalFileFor(runtimeDir, today), '{}\n');

    const removed = writer.prune();
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(dir, '1999-01-01.jsonl'))).toBe(false);
    expect(fs.existsSync(journalFileFor(runtimeDir, today))).toBe(true);
  });

  it('reads env overrides for enablement and result verbosity', () => {
    expect(journalOptionsFromEnv({ HOTL_JOURNAL: '0' })).toEqual({ enabled: false });
    expect(journalOptionsFromEnv({ HOTL_JOURNAL: 'on' })).toEqual({ enabled: true });
    expect(journalOptionsFromEnv({ HOTL_JOURNAL_RESULTS: 'full' })).toEqual({
      includeResults: 'full',
    });
    expect(journalOptionsFromEnv({})).toEqual({});
  });
});

describe('Phase 37 — withJournal wraps tool execution', () => {
  let runtimeDir: string;
  let writer: JournalWriter;
  let file: string;

  const echoTool = tool({
    description: 'echo',
    inputSchema: z.object({ text: z.string(), apiKey: z.string().optional() }),
    execute: async ({ text }) => ({ success: true as const, text }),
  });

  const failingTool = tool({
    description: 'fails',
    inputSchema: z.object({ filePath: z.string() }),
    execute: async () => ({ success: false as const, error: 'nope', code: 'EACCES' }),
  });

  const throwingTool = tool({
    description: 'throws',
    inputSchema: z.object({ filePath: z.string() }),
    // The explicit return type keeps the SDK's overload resolution happy: a
    // bare `throw` infers `Promise<never>`, which `tool()` cannot match.
    execute: async (): Promise<{ success: true }> => {
      const error = new Error('disk on fire') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    },
  });

  const writeTool = tool({
    description: 'writes',
    inputSchema: z.object({ filePath: z.string(), content: z.string() }),
    execute: async ({ filePath, content }) => ({
      success: true as const,
      path: filePath,
      bytes: Buffer.byteLength(content),
    }),
  });

  const nestedTool = tool({
    description: 'batch',
    inputSchema: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }),
    execute: async ({ files }) => ({ success: true as const, files }),
  });

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-wrap-'));
    writer = new JournalWriter({ runtimeDir });
    file = journalFileFor(runtimeDir, new Date());
  });

  afterEach(() => {
    writer.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  function executeOf(tools: Record<string, unknown>, name: string) {
    return (tools[name] as { execute: (input: unknown, options?: unknown) => Promise<unknown> })
      .execute;
  }

  it('records name, input, result, duration, callId and context', async () => {
    const wrapped = withJournal(
      { echo: echoTool } as Record<string, unknown>,
      { taskId: 'task_1', agentId: 'agent_1', planId: 'plan_1', planStepId: 'step-1' },
      writer
    );

    const output = await executeOf(wrapped, 'echo')({ text: 'hello' }, { toolCallId: 'call_42' });
    expect(output).toEqual({ success: true, text: 'hello' });

    const [entry] = readLines(file);
    expect(entry).toMatchObject({
      kind: 'tool',
      tool: 'echo',
      callId: 'call_42',
      taskId: 'task_1',
      agentId: 'agent_1',
      planId: 'plan_1',
      planStepId: 'step-1',
      ok: true,
    });
    expect(typeof entry!.durationMs).toBe('number');
    expect(entry!.result).toBeUndefined();
    expect(entry!.summary).toBeDefined();
    expect(entry!.input).toEqual({ text: 'hello' });
  });

  it('passes the result through untouched and keeps the SDK shape', async () => {
    const wrapped = withJournal({ echo: echoTool } as Record<string, unknown>, {}, writer);
    const target = wrapped.echo as Record<string, unknown>;
    const original = echoTool as unknown as Record<string, unknown>;
    // The wrapper is transparent: schema/description survive, only `execute` is replaced.
    expect(target.description).toBe(original.description);
    expect(target.inputSchema).toBe(original.inputSchema);
  });

  it('marks a `{ success: false }` result as failed, with its code', async () => {
    const wrapped = withJournal({ failing: failingTool } as Record<string, unknown>, {}, writer);
    await executeOf(wrapped, 'failing')({ filePath: 'x' }, { toolCallId: 'call_1' });

    const [entry] = readLines(file);
    expect(entry!.ok).toBe(false);
    expect(entry!.code).toBe('EACCES');
    expect(entry!.summary).toContain('failed');
  });

  it('records a throwing tool as failed and rethrows the original error', async () => {
    const wrapped = withJournal({ throwing: throwingTool } as Record<string, unknown>, {}, writer);
    await expect(
      executeOf(wrapped, 'throwing')({ filePath: 'x' }, { toolCallId: 'call_2' })
    ).rejects.toThrow('disk on fire');

    const [entry] = readLines(file);
    expect(entry!.ok).toBe(false);
    expect(entry!.error).toBe('disk on fire');
    expect(entry!.code).toBe('EIO');
  });

  it('writes artifacts with a sha256 of the content that was written', async () => {
    const wrapped = withJournal({ write: writeTool } as Record<string, unknown>, {}, writer);
    await executeOf(wrapped, 'write')({ filePath: 'src/a.ts', content: 'export const a = 1;\n' });

    const [entry] = readLines(file);
    const content = 'export const a = 1;\n';
    expect(entry!.artifacts).toEqual([
      {
        path: 'src/a.ts',
        bytes: Buffer.byteLength(content),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it('writes one artifact per file of a batch', async () => {
    const wrapped = withJournal({ batch: nestedTool } as Record<string, unknown>, {}, writer);
    await executeOf(
      wrapped,
      'batch'
    )({
      files: [
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'bb' },
      ],
    });

    const [entry] = readLines(file);
    expect(entry!.artifacts?.map((artifact) => artifact.path)).toEqual(['a.ts', 'b.ts']);
    expect(entry!.artifacts?.map((artifact) => artifact.bytes)).toEqual([1, 2]);
  });

  it('is a no-op without a writer (or when disabled) — tools stay identical', async () => {
    const withoutWriter = withJournal({ echo: echoTool } as Record<string, unknown>, {}, null);
    expect(withoutWriter.echo).toBe(echoTool);

    const disabled = new JournalWriter({ runtimeDir, enabled: false });
    expect(withJournal({ echo: echoTool } as Record<string, unknown>, {}, disabled).echo).toBe(
      echoTool
    );
    disabled.close();
  });

  it('leaves tools without an execute function alone', () => {
    const passive = { description: 'static' };
    const wrapped = withJournal({ passive } as Record<string, unknown>, {}, writer);
    expect(wrapped.passive).toBe(passive);
  });
});

describe('Phase 37 — result classification and artifacts', () => {
  it('reads the project failure contract, SDK errors and MCP isError', () => {
    expect(outcomeStatus({ success: true })).toEqual({ ok: true });
    expect(outcomeStatus({ plain: 'value' })).toEqual({ ok: true });
    expect(outcomeStatus({ success: false, error: 'no', code: 'E' })).toEqual({
      ok: false,
      error: 'no',
      code: 'E',
    });
    expect(outcomeStatus({ type: 'error-text', value: 'boom' })).toEqual({
      ok: false,
      error: 'boom',
    });
    expect(outcomeStatus({ isError: true })).toEqual({
      ok: false,
      error: 'MCP tool reported an error',
    });
  });

  it('extracts nothing from an output that names no file', () => {
    expect(artifactsOf({ pattern: '*.ts' }, { totalMatches: 2 })).toBeUndefined();
  });

  it('collects the secret values of the process for redaction', () => {
    const secrets = collectSecretValues({ OPENAI_API_KEY: 'sk-test-1234567890', PATH: '/usr/bin' });
    expect(secrets).toContain('sk-test-1234567890');
  });
});

describe('Phase 37 — reading the journal (CLI helpers)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-read-'));
    const dir = path.join(projectRoot, '.ai-runtime', 'journal');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const lines = [
      {
        ts: new Date(now - 60_000).toISOString(),
        kind: 'plan',
        planId: 'plan_a',
        ok: true,
        summary: 'started',
      },
      {
        ts: new Date(now - 30_000).toISOString(),
        kind: 'tool',
        tool: 'read_file',
        planId: 'plan_a',
        planStepId: 'step-1',
        ok: true,
        durationMs: 5,
      },
      {
        ts: new Date(now - 10_000).toISOString(),
        kind: 'tool',
        tool: 'write_file',
        planId: 'plan_a',
        planStepId: 'step-2',
        ok: false,
        error: 'EACCES',
        durationMs: 15,
      },
      'not json at all',
    ];
    fs.writeFileSync(
      path.join(dir, '2026-09-25.jsonl'),
      lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') +
        '\n'
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reads every file, skipping corrupt lines', () => {
    const records = readJournal(projectRoot);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.kind)).toEqual(['plan', 'tool', 'tool']);
  });

  it('filters by tool, plan and failure', () => {
    const records = readJournal(projectRoot);
    expect(filterRecords(records, { tool: 'write_file' })).toHaveLength(1);
    expect(filterRecords(records, { plan: 'plan_a' })).toHaveLength(3);
    expect(filterRecords(records, { plan: 'plan_b' })).toHaveLength(0);
    expect(filterRecords(records, { failed: true })).toHaveLength(1);
  });

  it('parses relative and absolute --since values', () => {
    const now = Date.now();
    expect(parseSince('30m', now)).toBe(now - 30 * 60_000);
    expect(parseSince('2h', now)).toBe(now - 2 * 3_600_000);
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000);
    expect(parseSince('2026-09-25T00:00:00.000Z')).toBe(Date.parse('2026-09-25T00:00:00.000Z'));
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince('yesterday-ish')).toBeNull();
  });

  it('filters by recency, and aggregates per-tool stats', () => {
    const records = readJournal(projectRoot);
    expect(filterRecords(records, { since: '1h' })).toHaveLength(3);
    const stats = journalStats(records);
    expect(stats.find((entry) => entry.tool === 'write_file')).toEqual({
      tool: 'write_file',
      calls: 1,
      failures: 1,
      totalMs: 15,
    });
    // Only tool entries count towards the table.
    expect(stats).toHaveLength(2);
  });

  it('reports no files for a project without a journal', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-empty-'));
    expect(journalFiles(empty)).toEqual([]);
    expect(readJournal(empty)).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

// ─── The hook itself: AgentRuntime journals both execution branches ──

describe('Phase 37 — AgentRuntime is the one hook for every tool call', () => {
  let runtimeDir: string;
  let journal: JournalWriter;
  let eventBus: EventBus;

  /** A tool that records what the runtime passed into `execute`. */
  const writeTool = {
    description: 'write',
    inputSchema: { type: 'object' } as never,
    execute: async ({ filePath }: { filePath: string }, options?: { toolCallId?: string }) => ({
      success: true,
      path: filePath,
      bytes: 5,
      seenCallId: options?.toolCallId,
    }),
  };

  function agentWithTools(): ResolvedAgent {
    return {
      agentId: 'worker',
      systemPrompt: 's',
      tools: { write_file: writeTool as never },
      model: {} as LanguageModel,
    } as unknown as ResolvedAgent;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-hook-'));
    journal = new JournalWriter({ runtimeDir });
    eventBus = new EventBus();
  });

  afterEach(() => {
    journal.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('wraps the tools handed to generateText, and journals the call', async () => {
    generateTextMock.mockImplementation((async (options: {
      tools?: Record<string, { execute: (input: unknown, o?: unknown) => Promise<unknown> }>;
    }) => {
      // Identity check: what the SDK receives must NOT be the raw tool object.
      const wrapped = options.tools!.write_file;
      await wrapped.execute({ filePath: 'notes/a.txt' }, { toolCallId: 'call_gen' });
      return {
        text: 'done',
        steps: [{ toolCalls: [{ toolName: 'write_file', toolCallId: 'call_gen' }], content: [] }],
        usage: {},
      };
    }) as never);

    const runtime = new AgentRuntime();
    runtime.setJournal(journal);
    await runtime.run({ agent: agentWithTools(), taskId: 'task_1', prompt: 'write', eventBus });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const passed = generateTextMock.mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(passed.tools.write_file).not.toBe(writeTool);

    const [entry] = readLines(journalFileFor(runtimeDir, new Date()));
    expect(entry).toMatchObject({
      kind: 'tool',
      tool: 'write_file',
      callId: 'call_gen',
      taskId: 'task_1',
      ok: true,
    });
    expect(entry!.artifacts?.[0]?.path).toBe('notes/a.txt');
  });

  it('wraps the tools handed to streamText too (the live-thinking branch)', async () => {
    streamTextMock.mockImplementation((async (options: {
      tools?: Record<string, { execute: (input: unknown, o?: unknown) => Promise<unknown> }>;
    }) => {
      const wrapped = options.tools!.write_file;
      await wrapped.execute({ filePath: 'notes/b.txt' }, { toolCallId: 'call_stream' });
      return {
        // pipeThoughts consumes this; no reasoning parts here.
        fullStream: (async function* empty() {})() as AsyncIterable<unknown>,
        text: Promise.resolve('done'),
        steps: Promise.resolve([
          { toolCalls: [{ toolName: 'write_file', toolCallId: 'call_stream' }], content: [] },
        ]),
        usage: Promise.resolve({}),
      };
    }) as never);

    const runtime = new AgentRuntime();
    runtime.setJournal(journal);
    await runtime.run({
      agent: agentWithTools(),
      taskId: 'task_2',
      prompt: 'write with thinking',
      eventBus,
      onThought: () => {
        /* sink present → streamText path */
      },
    });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledTimes(1);

    const [entry] = readLines(journalFileFor(runtimeDir, new Date()));
    expect(entry).toMatchObject({
      tool: 'write_file',
      callId: 'call_stream',
      taskId: 'task_2',
      ok: true,
    });
    expect(entry!.artifacts?.[0]?.path).toBe('notes/b.txt');
  });

  it('passes tools through untouched when no journal is wired', async () => {
    generateTextMock.mockImplementation((async () => ({
      text: 'done',
      steps: [],
      usage: {},
    })) as never);

    const runtime = new AgentRuntime(); // no setJournal
    await runtime.run({ agent: agentWithTools(), taskId: 'task_3', prompt: 'write', eventBus });

    const passed = generateTextMock.mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(passed.tools.write_file).toBeDefined();
    expect(typeof (passed.tools.write_file as { execute?: unknown }).execute).toBe('function');
    expect(journalFiles(runtimeDir)).toEqual([]);
  });
});
