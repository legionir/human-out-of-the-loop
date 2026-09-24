/**
 * Phase 30 (P6) — real MCP transports (stdio + http).
 *
 * Before this phase the registry schema, the CLI help and
 * `CONFIGURATION.md` all advertised `transport: "stdio"`, but the
 * connector threw `stdio transport is not supported in this version`.
 * The transport now exists — and the seams around it had four bugs this
 * file locks down:
 *
 *   1. `mcp test <stdio>` connected, listed the tools, then NEVER
 *      exited (the spawned child held the event loop open).
 *   2. A connection that FAILED or TIMED OUT left its child process
 *      running (nothing held the transport, so nothing could close it).
 *   3. A child dying under us made the next stdin write emit an
 *      unhandled `'error'` event on the socket → the whole CLI crashed
 *      with `Error: write EPIPE`.
 *   4. An MCP tool that answers with `isError: true` looked like a
 *      SUCCESS: `task.errors` stayed empty, so the acceptance judge
 *      never saw the failure (the same invisibility bug P3 fixed for
 *      built-in tools).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Mock AI SDK (real MCP SDK stays real) ───────────────────────
vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText, type LanguageModel } from 'ai';
import { createStdioTransport } from '../tools/mcp-stdio-transport.js';
import { McpConnector } from '../tools/mcp-connector.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus, type AgentEvent } from '../runtime/event-bus.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import type { McpServerConfig } from '../schemas/mcp-server.js';
import { mcpTestCommand } from '../../cli/commands/mcp.js';

const mockGenerateText = vi.mocked(generateText);

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * A tiny newline-delimited JSON-RPC MCP server.  `initialize` is
 * answered with TWO protocol messages in ONE stdout write on purpose —
 * the transport must split chunks on newlines, not assume one message
 * per chunk.  `SIGTERM` writes a marker file synchronously so a test
 * can prove the child was actually terminated.
 */
function writeTestServer(dir: string, markerFile: string): string {
  const source = String.raw`
import fs from 'node:fs';
const MARKER = ${JSON.stringify(markerFile)};
process.on('SIGTERM', () => {
  try { fs.writeFileSync(MARKER, 'closed'); } catch {}
  process.exit(0);
});
const TOOLS = [
  { name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];
function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification
    if (msg.method === 'initialize') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'p6-test', version: '1.0.0' } } }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n'
      );
      continue;
    }
    if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); continue; }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
});
`;
  const file = path.join(dir, 'p6-test-server.mjs');
  fs.writeFileSync(file, source);
  return file;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition never became true');
}

function makeAgent(): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'Test',
    tools: {},
    model: {} as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'C', allowedTools: ['*'] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  } as unknown as ResolvedAgent;
}

/** One SDK step carrying a single raw content part. */
function sdkResultWith(part: unknown) {
  return {
    text: 'Step finished.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    steps: [
      {
        toolCalls: [{ toolName: 'stdio_demo_fail', toolCallId: 'call_1', input: {} }],
        content: [
          { type: 'tool-call', toolName: 'stdio_demo_fail', toolCallId: 'call_1', input: {} },
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
    prompt: 'Call the MCP tool',
    eventBus,
  });
  return { result, events };
}

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── 1. An MCP `isError: true` result is a tool failure ──────────

describe('Phase 30 / P6 — MCP tool failures reach the acceptance judge', () => {
  it('records an MCP `isError` result as a tool error', async () => {
    const { result, events } = await runWith({
      type: 'tool-result',
      toolName: 'stdio_demo_fail',
      toolCallId: 'call_1',
      // What `@ai-sdk/mcp` hands back: the raw MCP result object.
      output: {
        content: [{ type: 'text', text: 'demo_fail always fails' }],
        isError: true,
      },
    });

    const errorEvents = events.filter((e) => e.type === 'agent:tool_error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      type: 'agent:tool_error',
      status: 'error',
      toolName: 'stdio_demo_fail',
      callId: 'call_1',
      taskId: 'task_1',
    });
    expect((errorEvents[0] as { error: string }).error).toBe('demo_fail always fails');

    // The judge reads `task.errors` — this is what it must see.
    expect(result.errors).toEqual(['stdio_demo_fail: demo_fail always fails']);
    expect(result.summary).toContain('Tool errors: stdio_demo_fail');
  });

  it('reports an MCP error with no text content', async () => {
    const { result } = await runWith({
      type: 'tool-result',
      toolName: 'stdio_demo_fail',
      toolCallId: 'call_1',
      output: { content: [], isError: true },
    });

    expect(result.errors).toEqual(['stdio_demo_fail: MCP tool reported an error']);
  });

  it('does NOT treat a successful MCP result as a failure', async () => {
    const { result, events } = await runWith({
      type: 'tool-result',
      toolName: 'stdio_demo_echo',
      toolCallId: 'call_1',
      output: { content: [{ type: 'text', text: 'stdio-echo:hi' }], isError: false },
    });

    expect(events.filter((e) => e.type === 'agent:tool_error')).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });
});

// ─── 2. The stdio transport itself ───────────────────────────────

describe('Phase 30 / P6 — stdio transport', () => {
  it('splits several protocol messages arriving in one chunk', async () => {
    const marker = path.join(tmpRoot, 'closed');
    const server = writeTestServer(tmpRoot, marker);

    const transport = createStdioTransport({ command: process.execPath, args: [server] });
    const messages: Array<{ id?: unknown; method?: unknown; result?: { serverInfo?: { name?: string } } }> = [];
    let closeCount = 0;
    transport.onmessage = (message) => messages.push(message as never);
    transport.onclose = () => {
      closeCount += 1;
    };

    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as never);

    await waitFor(() => messages.some((m) => m.id === 1));
    const initialized = messages.find((m) => m.id === 1);
    expect(initialized?.result?.serverInfo?.name).toBe('p6-test');
    // The notification was written in the SAME chunk as the response.
    expect(messages.some((m) => m.method === 'notifications/initialized')).toBe(true);

    // A request/response round trip on the same connection.
    messages.length = 0;
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as never);
    await waitFor(() => messages.some((m) => m.id === 2));
    expect(JSON.stringify(messages.find((m) => m.id === 2))).toContain('"tools"');

    await transport.close();
    expect(closeCount).toBe(1);
    // The child really received SIGTERM (proved by its own marker file).
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('refuses to send after close instead of writing to a dead pipe', async () => {
    const marker = path.join(tmpRoot, 'closed');
    const server = writeTestServer(tmpRoot, marker);
    const transport = createStdioTransport({ command: process.execPath, args: [server] });
    transport.onmessage = () => {};
    transport.onclose = () => {};

    await transport.start();
    await transport.close();

    await expect(
      transport.send({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} } as never)
    ).rejects.toThrow(/not connected/);
  });

  it('survives a write into a child that closed its stdin (EPIPE)', async () => {
    // The real E2E run produced `Error: write EPIPE` as an UNHANDLED
    // 'error' event on the child's stdin socket — it killed the CLI.
    // A child that closes its own stdin while staying alive reproduces
    // the write failure deterministically (exitCode is still null, so
    // the "not connected" guard cannot mask it).
    const transport = createStdioTransport({
      command: process.execPath,
      // `closeSync(0)` really releases the child's read end (destroy() alone left the pipe writable).
      args: ['-e', "require('fs').closeSync(0); setInterval(() => {}, 1000);"],
    });
    const errors: Error[] = [];
    transport.onerror = (err) => errors.push(err);
    transport.onmessage = () => {};
    transport.onclose = () => {};

    await transport.start();
    await new Promise((r) => setTimeout(r, 200)); // let the child destroy stdin

    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} } as never)
    ).rejects.toThrow();
    // The failure was REPORTED, not thrown as an unhandled 'error' event.
    expect(errors.length).toBeGreaterThan(0);

    await transport.close();
  });

  it('does not crash the process when the child dies mid-session', async () => {
    // A child that exits ~50ms after spawn, then a send() into the dead
    // pipe: without an 'error' listener on stdin this was an unhandled
    // 'error' event → `Error: write EPIPE` and a dead CLI.
    const dying = createStdioTransport({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
    });
    const closed = new Promise<void>((resolve) => {
      dying.onclose = () => resolve();
    });
    dying.onerror = () => {};
    dying.onmessage = () => {};

    await dying.start();
    await closed; // the transport noticed the exit
    expect(closed).toBeDefined();

    await expect(
      dying.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} } as never)
    ).rejects.toThrow(/not connected/);
  });
});

// ─── 2b. The connector end-to-end over a real child ──────────────

describe('Phase 30 / P6 — connector over a real stdio child', () => {
  it('registers the server tools with source "mcp" and closes the child', async () => {
    const marker = path.join(tmpRoot, 'closed');
    const server = writeTestServer(tmpRoot, marker);
    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({ toolRegistry });

    const config: McpServerConfig = {
      id: 'p6-tools',
      name: 'P6 tool server',
      transport: 'stdio',
      command: process.execPath,
      args: [server],
      toolPrefix: 'p6_',
      auth: { type: 'none' },
      connectTimeoutMs: 5000,
    };

    const ok = await connector.connectServer(config);
    expect(ok).toBe(true);
    expect(connector.getServerState('p6-tools')?.toolIds).toEqual(['p6_echo']);

    const definition = toolRegistry.getDefinition('p6_echo');
    expect(definition).toMatchObject({ source: 'mcp', mcpServerId: 'p6-tools', category: 'mcp' });
    expect(toolRegistry.getImplementation('p6_echo')).toBeDefined();

    await connector.closeAll();
    expect(fs.existsSync(marker)).toBe(true);
  });
});

// ─── 3. A failed/timed-out attempt releases its transport ────────

describe('Phase 30 / P6 — failed connections do not leak', () => {
  it('closes the transport when the connect times out', async () => {
    const closed: string[] = [];
    const connector = new McpConnector({
      toolRegistry: new ToolRegistry(),
      createTransport: () => ({
        start: async () => {},
        send: async () => {},
        close: async () => {
          closed.push('closed');
        },
      }),
      // A server that accepts the transport and never answers.
      createClient: () => new Promise(() => {}) as never,
    });

    const config: McpServerConfig = {
      id: 'hang',
      name: 'hanging server',
      transport: 'stdio',
      command: 'node',
      args: [],
      auth: { type: 'none' },
      connectTimeoutMs: 100,
    };

    const ok = await connector.connectServer(config);
    expect(ok).toBe(false);
    expect(connector.getServerState('hang')?.lastError).toMatch(/Connection timeout after 100ms/);
    expect(closed).toEqual(['closed']);
  });

  it('closes the transport when the client factory throws', async () => {
    const closed: string[] = [];
    const connector = new McpConnector({
      toolRegistry: new ToolRegistry(),
      createTransport: () => ({
        start: async () => {},
        send: async () => {},
        close: async () => {
          closed.push('closed');
        },
      }),
      createClient: async () => {
        throw new Error('spawn ENOENT');
      },
    });

    const config: McpServerConfig = {
      id: 'broken',
      name: 'broken server',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary',
      args: [],
      auth: { type: 'none' },
      connectTimeoutMs: 5000,
    };

    const ok = await connector.connectServer(config);
    expect(ok).toBe(false);
    expect(connector.getServerState('broken')?.lastError).toContain('spawn ENOENT');
    expect(closed).toEqual(['closed']);
  });
});

// ─── 4. `hootl mcp test` closes the connection ───────────────────

describe('Phase 30 / P6 — `mcp test` does not leave the child running', () => {
  it('returns 0 for a stdio server AND terminates the child', async () => {
    const marker = path.join(tmpRoot, 'closed');
    const server = writeTestServer(tmpRoot, marker);
    const dir = path.join(tmpRoot, 'registry', 'mcp-servers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'p6-cli.json'),
      JSON.stringify({
        id: 'p6-cli',
        name: 'P6 CLI server',
        transport: 'stdio',
        command: process.execPath,
        args: [server],
        toolPrefix: 'p6_',
        connectTimeoutMs: 5000,
      })
    );

    const code = await mcpTestCommand('p6-cli', { projectRoot: tmpRoot });

    expect(code).toBe(0);
    // No `closeAll()` in the command → no SIGTERM → no marker file
    // (this is what made the CLI hang for 60s in the real E2E run).
    expect(fs.existsSync(marker)).toBe(true);
  });
});
