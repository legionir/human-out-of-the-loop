/**
 * v27.17.3 — one record per tool call: type, name, input, status.
 *
 * The runtime-level seam is what these tests pin down: what a consumer (the
 * CLI today, a UI tomorrow) receives for a successful call, for the three ways
 * a tool can refuse, for a thrown error, and what happens when there is no
 * consumer at all.  The CLI's own rendering lives in
 * `src/cli/__tests__/v27173-tool-log.test.ts`, and the end-to-end proof is in
 * the `success` scenario.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { Orchestrator } from '../orchestrator.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import {
  DEFAULT_TOOL_INPUT_MAX_CHARS,
  UNKNOWN_TOOL_TYPE,
  emitToolCall,
  formatToolInput,
  inferToolType,
  redactToolInput,
  resolveToolType,
  withToolCallLog,
  type ToolCallLogOptions,
  type ToolCallRecord,
} from '../runtime/tool-call-log.js';

const generateTextMock = vi.mocked(generateText);

// ─── type, input ─────────────────────────────────────────────────

describe('v27.17.3 — the tool’s type', () => {
  it('reads the reference catalog by name', () => {
    expect(inferToolType('write_file')).toBe('filesystem');
    expect(inferToolType('git_commit')).toBe('git');
    expect(inferToolType('create_entities')).toBe('memory');
    expect(inferToolType('get_current_time')).toBe('time');
    expect(inferToolType('fetch')).toBe('web');
    expect(inferToolType('sequentialthinking')).toBe('reasoning');
    expect(inferToolType('a_tool_from_nowhere')).toBe(UNKNOWN_TOOL_TYPE);
  });

  it('prefers the registry resolver, then a static map, then inference', () => {
    expect(resolveToolType('whatever_server_tool', { toolType: () => 'mcp' })).toBe('mcp');
    expect(resolveToolType('write_file', { toolTypes: { write_file: 'custom' } })).toBe('custom');
    expect(resolveToolType('write_file')).toBe('filesystem');
    // An empty answer from the registry falls back rather than showing "undefined".
    expect(resolveToolType('git_status', { toolType: () => undefined })).toBe('git');
  });
});

describe('v27.17.3 — the input a log may show', () => {
  it('redacts credential-shaped keys', () => {
    expect(
      redactToolInput({ apiKey: 'sk-live-123', token: 'abc', filePath: 'notes/a.txt' })
    ).toEqual({ apiKey: '***REDACTED***', token: '***REDACTED***', filePath: 'notes/a.txt' });
    // Case and separators do not matter (api_key == apiKey).
    expect(redactToolInput({ API_KEY: 'x' })).toEqual({ API_KEY: '***REDACTED***' });
  });

  it('scrubs the literal values of the credentials the process holds', () => {
    const secret = 'sk-secret-value-1234';
    expect(redactToolInput({ content: `key=${secret}` }, [secret])).toEqual({
      content: 'key=***REDACTED***',
    });
    expect(redactToolInput({ nested: [{ text: secret }] }, [secret])).toEqual({
      nested: [{ text: '***REDACTED***' }],
    });
  });

  it('formats one capped line, and nothing for no arguments', () => {
    expect(formatToolInput({ filePath: 'notes/a.txt' })).toBe('{"filePath":"notes/a.txt"}');
    expect(formatToolInput(undefined)).toBe('');
    expect(formatToolInput({})).toBe('');
    const long = formatToolInput({ content: 'x'.repeat(2000) });
    expect(long.length).toBe(DEFAULT_TOOL_INPUT_MAX_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ─── the hook ────────────────────────────────────────────────────

describe('v27.17.3 — withToolCallLog', () => {
  const call = (input: unknown, execute: (i: unknown) => Promise<unknown>) => {
    const records: ToolCallRecord[] = [];
    const tools = withToolCallLog(
      { some_tool: { description: 'd', execute } },
      { taskId: 'task_1', agentId: 'agent_1', planId: 'plan_1', planStepId: 'step-1' },
      (record) => records.push(record),
      { toolTypes: { some_tool: 'custom-type' } }
    );
    return {
      records,
      run: (callOptions?: { toolCallId?: string }) =>
        (tools.some_tool as { execute: (i: unknown, o?: unknown) => Promise<unknown> }).execute(
          input,
          callOptions ?? { toolCallId: 'call_1' }
        ),
    };
  };

  it('reports the four fields of a successful call, in two phases', async () => {
    const { records, run } = call({ filePath: 'notes/a.txt' }, async () => ({
      success: true,
    }));
    await run();

    expect(records.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(records[0]).toMatchObject({
      phase: 'start',
      status: 'running',
      toolType: 'custom-type',
      toolName: 'some_tool',
      input: { filePath: 'notes/a.txt' },
      callId: 'call_1',
      taskId: 'task_1',
      agentId: 'agent_1',
      planId: 'plan_1',
      planStepId: 'step-1',
    });
    expect(records[1]).toMatchObject({ phase: 'end', status: 'success' });
    expect(typeof records[1]!.durationMs).toBe('number');
    expect(records[1]!.error).toBeUndefined();
  });

  it('reports the project’s failure contract with its code', async () => {
    const { records, run } = call({ filePath: '../x' }, async () => ({
      success: false,
      error: 'path escapes the project root',
      code: 'PATH_TRAVERSAL_BLOCKED',
    }));
    await run();

    expect(records[1]).toMatchObject({
      phase: 'end',
      status: 'failure',
      error: 'path escapes the project root',
      code: 'PATH_TRAVERSAL_BLOCKED',
    });
  });

  it('reports an MCP refusal (isError) as a failure', async () => {
    const { records, run } = call({ path: 'x' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    }));
    await run();
    expect(records[1]).toMatchObject({ status: 'failure' });
  });

  it('reports a thrown error as a failure and still re-throws', async () => {
    const { records, run } = call({ filePath: 'x' }, async () => {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    await expect(run()).rejects.toThrow('EACCES: permission denied');
    expect(records[1]).toMatchObject({
      phase: 'end',
      status: 'failure',
      error: 'EACCES: permission denied',
      code: 'EACCES',
    });
  });

  it('never redacts what it reports as a success that was not', async () => {
    const { records, run } = call({ filePath: 'x' }, async () => ({ success: undefined }));
    await run();
    expect(records[1]!.status).toBe('success');
  });

  it('returns the tool set untouched when there is no consumer', () => {
    const tools = { some_tool: { execute: async () => ({}) } };
    expect(withToolCallLog(tools, { taskId: 't' })).toBe(tools);
    expect(withToolCallLog(tools, { taskId: 't' }, undefined)).toBe(tools);
  });

  it('keeps every other property of the tool, and tools without execute', () => {
    const tools = {
      some_tool: {
        description: 'the description',
        inputSchema: { type: 'object' },
        execute: async () => ({}),
      },
      not_a_tool: 'value',
    } as unknown as Record<string, unknown>;
    const wrapped = withToolCallLog(tools, { taskId: 't' }, () => {}) as Record<string, any>;
    expect(wrapped.some_tool.description).toBe('the description');
    expect(wrapped.some_tool.inputSchema).toEqual({ type: 'object' });
    expect(wrapped.not_a_tool).toBe('value');
    expect(wrapped.some_tool).not.toBe(tools.some_tool);
  });

  it('a broken consumer never breaks the tool call', async () => {
    const records: ToolCallRecord[] = [];
    const tools = withToolCallLog(
      {
        some_tool: {
          execute: async () => {
            records.push({ phase: 'end', status: 'success', toolType: 'x', toolName: 'some_tool' });
            return { success: true, value: 'done' };
          },
        },
      },
      { taskId: 't' },
      () => {
        throw new Error('the terminal is gone');
      }
    );
    const result = await (
      tools.some_tool as { execute: (input: unknown) => Promise<unknown> }
    ).execute({});
    expect(result).toEqual({ success: true, value: 'done' });
    expect(records).toHaveLength(1);
  });

  it('emitToolCall swallows a broken sink', () => {
    expect(() =>
      emitToolCall(
        () => {
          throw new Error('closed');
        },
        { phase: 'start', status: 'running', toolType: 'x', toolName: 'y' }
      )
    ).not.toThrow();
  });
});

// ─── the runtime wiring ──────────────────────────────────────────

describe('v27.17.3 — AgentRuntime reports every tool call', () => {
  const writeTool = tool({
    description: 'write',
    inputSchema: z.object({ filePath: z.string() }),
    execute: async () => ({ success: true, path: 'notes/a.txt' }),
  });

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
  });

  it('feeds the sink with type, name, input and status', async () => {
    generateTextMock.mockImplementation((async (options: {
      tools?: Record<string, { execute: (input: unknown, o?: unknown) => Promise<unknown> }>;
    }) => {
      await options.tools!.write_file.execute({ filePath: 'notes/a.txt' }, { toolCallId: 'c1' });
      return { text: 'done', steps: [], usage: {} };
    }) as never);

    const records: ToolCallRecord[] = [];
    await new AgentRuntime().run({
      agent: agentWithTools(),
      taskId: 'task_1',
      prompt: 'write',
      eventBus: new EventBus(),
      onToolCall: (record) => records.push(record),
      toolCallOptions: {
        toolType: (name) => (name === 'write_file' ? 'filesystem' : undefined),
        secrets: ['sk-should-never-print'],
      },
    });

    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      phase: 'end',
      status: 'success',
      toolType: 'filesystem',
      toolName: 'write_file',
      input: { filePath: 'notes/a.txt' },
      taskId: 'task_1',
      agentId: 'worker',
    });
  });

  it('falls back to name inference when no resolver is supplied', async () => {
    generateTextMock.mockImplementation((async (options: {
      tools?: Record<string, { execute: (input: unknown, o?: unknown) => Promise<unknown> }>;
    }) => {
      await options.tools!.write_file.execute({ filePath: 'a' });
      return { text: 'done', steps: [], usage: {} };
    }) as never);

    const records: ToolCallRecord[] = [];
    await new AgentRuntime().run({
      agent: agentWithTools(),
      taskId: 'task_1',
      prompt: 'write',
      eventBus: new EventBus(),
      onToolCall: (record) => records.push(record),
    });

    expect(records[1]!.toolType).toBe('filesystem');
  });

  it('does not touch the tool set when nobody listens', async () => {
    generateTextMock.mockImplementation((async (options: { tools?: Record<string, unknown> }) => {
      expect(options.tools?.write_file).toBe(writeTool);
      return { text: 'done', steps: [], usage: {} };
    }) as never);

    await new AgentRuntime().run({
      agent: agentWithTools(),
      taskId: 'task_1',
      prompt: 'write',
      eventBus: new EventBus(),
    });
  });
});

// ─── the Orchestrator's hand-over ────────────────────────────────

describe('v27.17.3 — the options the TaskRuntime keeps are complete', () => {
  it('carry the category resolver and the process secrets from the start', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toollog-orch-'));
    try {
      const orchestrator = new Orchestrator({
        projectRoot: path.resolve(__dirname, '../../..'),
        runtimeDir: tmpDir,
        env: { OPENAI_API_KEY: 'sk-super-secret-value-1234' },
      });
      await orchestrator.initialize();
      const internals = orchestrator as unknown as {
        toolCallOptions: ToolCallLogOptions;
        taskRuntime: { toolCallOptions?: ToolCallLogOptions };
      };
      // The very object the TaskRuntime was constructed with must be the one
      // that ends up complete — v27.17.3 filled `secrets` in AFTER the hand-over
      // once, and the plan steps' records were rendered without it.
      expect(internals.taskRuntime.toolCallOptions).toBe(internals.toolCallOptions);
      expect(internals.toolCallOptions.secrets).toContain('sk-super-secret-value-1234');
      // The registry is loaded by `initialize()`, so this is a live lookup.
      expect(internals.toolCallOptions.toolType?.('write_file')).toBe('filesystem');
      expect(internals.toolCallOptions.toolType?.('git_commit')).toBe('git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
