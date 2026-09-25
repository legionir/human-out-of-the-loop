import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createMCPClient } from '@ai-sdk/mcp';

import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  JSON_RPC_ERRORS,
  negotiateProtocolVersion,
  packageVersion,
  parseMessage,
  toolInputJsonSchema,
} from '../../mcp/protocol.js';
import { McpServer, createMcpServer, isReadOnlyTool, readOnlyToolIds } from '../../mcp/server.js';
import { serveHttp, serveStdio } from '../../mcp/transports.js';
import { createStdioTransport } from '../tools/mcp-stdio-transport.js';
import { LOCAL_TOOL_IDS } from '../tools/local-tools.js';
import { JournalWriter } from '../runtime/journal.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import type { Plan } from '../schemas/plan.js';

/**
 * Phase 43 — this runtime *as* an MCP server.
 *
 * The suite covers the protocol surface (handshake, listing, calling, resources,
 * malformed input), the two filters that make external access safe
 * (`--read-only`, `--allow-tools`), the two transports (stdio framing and
 * loopback HTTP with a bearer token), the Journal — and, at the end, a **real
 * `@ai-sdk/mcp` client** talking to the real CLI over stdio, because "it works
 * with the SDK everyone uses" is the actual requirement.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let root = '';
let server: McpServer;

function makeProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hootl-${name}-`));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello from the project\n');
  return dir;
}

/** A frame that expects a reply, as a client would write it. */
function frame(id: number, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

interface RpcResponse {
  jsonrpc?: string;
  id?: unknown;
  // `any` here is deliberate: every assertion below reads a different part of a
  // dynamically shaped protocol result, and re-typing each one buys nothing.
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
}

async function call(
  server: McpServer,
  id: number,
  method: string,
  params?: unknown
): Promise<RpcResponse> {
  const responses = await server.handleFrame(frame(id, method, params));
  return JSON.parse(responses[0] ?? '{}') as RpcResponse;
}

beforeAll(() => {
  root = makeProject('mcp-server');
  server = createMcpServer({ projectRoot: root });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Phase 43 — framing and negotiation', () => {
  it('turns unparseable input into -32700 and non-JSON-RPC into -32600', () => {
    const unparseable = parseMessage('not json');
    expect(unparseable.ok).toBe(false);
    if (!unparseable.ok) expect(unparseable.response.error?.code).toBe(JSON_RPC_ERRORS.parseError);

    const notJsonRpc = parseMessage(JSON.stringify({ id: 1, method: 'tools/list' }));
    expect(notJsonRpc.ok).toBe(false);
    if (!notJsonRpc.ok)
      expect(notJsonRpc.response.error?.code).toBe(JSON_RPC_ERRORS.invalidRequest);

    const empty = parseMessage('   ');
    expect(empty.ok).toBe(false);

    const listMessage = parseMessage(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'x' }]));
    expect(listMessage.ok).toBe(false);
  });

  it('accepts a well-formed request and keeps its id', () => {
    const parsed = parseMessage(frame(7, 'ping'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.id).toBe(7);
  });

  it('negotiates the version: ours if asked for, otherwise the newest we have', () => {
    expect(MCP_PROTOCOL_VERSIONS).toContain(MCP_DEFAULT_PROTOCOL_VERSION);
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toEqual({ version, supported: true });
    }
    expect(negotiateProtocolVersion('1999-01-01')).toEqual({
      version: MCP_DEFAULT_PROTOCOL_VERSION,
      supported: false,
    });
    expect(negotiateProtocolVersion(undefined).supported).toBe(false);
  });

  it('converts a tool schema without redefining it by hand', () => {
    const schema = toolInputJsonSchema(undefined);
    expect(schema.type).toBe('object');

    // The real conversion is exercised through `tools/list` below; here the
    // contract is that it never throws, so one odd schema cannot break listing.
    const odd = toolInputJsonSchema({ safeParse: () => ({ success: true }) });
    expect(odd.type).toBe('object');
  });

  it('reports the package version as the server version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe('Phase 43 — the handshake', () => {
  it('answers initialize with capabilities, identity and the project note', async () => {
    const response = await call(server, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    const result = response.result!;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect((result.serverInfo as Record<string, unknown>).name).toBe('human-out-of-the-loop');
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
    expect((result.capabilities as Record<string, unknown>).resources).toBeDefined();
    expect(String(result.instructions)).toContain(root);
  });

  it('answers an unknown protocol version with ours, and says so once', async () => {
    const response = await call(server, 2, 'initialize', { protocolVersion: '2026-99-99' });
    const result = response.result!;
    expect(result.protocolVersion).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(String(result.instructions)).toContain('not implemented');
  });

  it('answers ping, and never answers a notification', async () => {
    expect((await call(server, 3, 'ping')).result).toEqual({});

    const notification = await server.handleFrame(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );
    expect(notification).toEqual([]);
    const unknownNotification = await server.handleFrame(
      JSON.stringify({ jsonrpc: '2.0', method: 'something/unknown' })
    );
    expect(unknownNotification).toEqual([]);
  });

  it('reports an unknown method as -32601', async () => {
    const response = await call(server, 4, 'tools/explode');
    expect(response.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
    expect(String(response.error?.message)).toContain('tools/explode');
  });
});

describe('Phase 43 — tools/list', () => {
  it('lists every local tool, with its schema and read-only hint', async () => {
    const response = await call(server, 10, 'tools/list');
    const tools = response.result!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(LOCAL_TOOL_IDS.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...LOCAL_TOOL_IDS].sort());

    const readFile = tools.find((tool) => tool.name === 'read_file')!;
    const schema = readFile.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('filePath');
    expect(schema.required).toContain('filePath');
    // `describe()` survives the conversion — that is what a client shows its
    // model, and it is why the schemas are converted rather than rewritten.
    expect(JSON.stringify(properties)).toContain('description');
    expect(JSON.stringify(tools)).toContain('Return only the first N lines');

    const annotations = readFile.annotations as Record<string, unknown>;
    expect(annotations.readOnlyHint).toBe(true);
    const writeFile = tools.find((tool) => tool.name === 'write_file')!;
    expect((writeFile.annotations as Record<string, unknown>).readOnlyHint).toBe(false);
    expect(writeFile.description).not.toBe('');
  });

  it('answers prompts/list with an empty list rather than an error', async () => {
    const response = await call(server, 11, 'prompts/list');
    expect(response.result).toEqual({ prompts: [] });
  });
});

describe('Phase 43 — tools/call', () => {
  it('runs a tool through the runtime\u2019s own path and returns structured content', async () => {
    const response = await call(server, 20, 'tools/call', {
      name: 'read_file',
      arguments: { filePath: 'hello.txt' },
    });
    const result = response.result as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).content).toBe(
      'hello from the project\n'
    );
    expect(JSON.stringify(result.content)).toContain('hello from the project');
  });

  it('validates arguments with the tool\u2019s own schema (-32602)', async () => {
    const missing = await call(server, 21, 'tools/call', { name: 'read_file', arguments: {} });
    expect(missing.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
    expect(String(missing.error?.message)).toContain('filePath');

    const wrongType = await call(server, 22, 'tools/call', {
      name: 'read_file',
      arguments: { filePath: 42 },
    });
    expect(wrongType.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });

  it('reports an unknown tool as -32601 with the visible names', async () => {
    const response = await call(server, 23, 'tools/call', {
      name: 'does_not_exist',
      arguments: {},
    });
    expect(response.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
    expect(String(response.error?.message)).toContain('read_file');
  });

  it('returns a tool\u2019s refusal in-band, as isError, not as a protocol error', async () => {
    // A path outside the project is the sandbox refusing, not a server crash.
    const response = await call(server, 24, 'tools/call', {
      name: 'read_file',
      arguments: { filePath: '../../../etc/passwd' },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(String((result.structuredContent as Record<string, unknown>).code)).toBe(
      'PATH_TRAVERSAL_BLOCKED'
    );
    expect(JSON.stringify(result.content)).toContain('PATH_TRAVERSAL_BLOCKED');
  });

  it('requires a tool name', async () => {
    const response = await call(server, 25, 'tools/call', {});
    expect(response.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

describe('Phase 43 — least privilege', () => {
  it('--read-only exposes only tools that cannot change anything', async () => {
    const readOnly = createMcpServer({ projectRoot: root, readOnly: true });
    const expected = readOnlyToolIds();
    expect(readOnly.toolNames).toEqual(expected);
    expect(readOnly.toolNames.length).toBeLessThan(LOCAL_TOOL_IDS.length);
    expect(readOnly.toolNames).not.toContain('write_file');
    expect(readOnly.toolNames).not.toContain('git_push');
    expect(readOnly.toolNames).not.toContain('git_commit');
    // The reads a client needs are all there.
    for (const id of [
      'read_file',
      'list_directory',
      'search_code',
      'git_status',
      'git_diff',
      'fetch',
    ]) {
      expect(readOnly.toolNames, `${id} should be readable`).toContain(id);
    }
    // `sequentialthinking` persists a session file, so it is not read-only.
    expect(isReadOnlyTool('sequentialthinking')).toBe(false);
    expect(isReadOnlyTool('git_log')).toBe(true);

    // A filtered tool cannot be *called* either — the listing and the call must
    // agree, or the filter is theatre.
    const denied = await call(readOnly, 30, 'tools/call', {
      name: 'write_file',
      arguments: { filePath: 'x.txt', content: 'x' },
    });
    expect(denied.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false);
  });

  it('--allow-tools narrows the set, and --prefix renames it consistently', async () => {
    const narrow = createMcpServer({
      projectRoot: root,
      allowTools: ['read_file', 'git_status'],
    });
    expect(narrow.toolNames).toEqual(['read_file', 'git_status']);

    const prefixed = createMcpServer({
      projectRoot: root,
      allowTools: ['read_file'],
      prefix: 'hootl',
    });
    expect(prefixed.toolNames).toEqual(['hootl_read_file']);
    const listed = (await call(prefixed, 31, 'tools/list')).result!.tools as Array<
      Record<string, unknown>
    >;
    expect(listed[0]!.name).toBe('hootl_read_file');
    expect((listed[0]!.annotations as Record<string, unknown>)['x-local-name']).toBe('read_file');

    const called = await call(prefixed, 32, 'tools/call', {
      name: 'hootl_read_file',
      arguments: { filePath: 'hello.txt' },
    });
    expect((called.result as Record<string, unknown>).isError).toBeUndefined();
    // The local name is not a back door.
    const localName = await call(prefixed, 33, 'tools/call', {
      name: 'read_file',
      arguments: { filePath: 'hello.txt' },
    });
    expect(localName.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
  });
});

describe('Phase 43 — the Journal records external calls', () => {
  it('writes one line per call, marked with the mcp client id', async () => {
    const project = makeProject('mcp-journal');
    const runtimeDir = path.join(project, '.ai-runtime');
    try {
      const journal = new JournalWriter({ runtimeDir, includeResults: 'summary' });
      const audited = createMcpServer({ projectRoot: project, journal });
      await audited.handleFrame(
        frame(40, 'tools/call', { name: 'read_file', arguments: { filePath: 'hello.txt' } })
      );
      const files = fs.readdirSync(path.join(runtimeDir, 'journal'));
      expect(files).toHaveLength(1);
      const lines = fs
        .readFileSync(path.join(runtimeDir, 'journal', files[0]!), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(entry.kind).toBe('tool');
      expect(entry.tool).toBe('read_file');
      expect(entry.agentId).toBe('mcp');
      expect(entry.ok).toBe(true);
      expect(String(entry.summary)).toContain('hello.txt');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('Phase 43 — resources', () => {
  it('lists the three read-only resources', () => {
    const uris = server.listResources().map((resource) => resource.uri);
    expect(uris).toEqual(['plan://{id}', 'journal://{YYYY-MM-DD}', 'memory://graph']);
  });

  it('reads the memory graph, an empty one when the project has none', async () => {
    const response = await call(server, 50, 'resources/read', { uri: 'memory://graph' });
    const contents = (response.result as { contents: Array<Record<string, unknown>> }).contents;
    expect(contents[0]!.mimeType).toBe('application/json');
    expect(JSON.parse(String(contents[0]!.text))).toEqual({ entities: [], relations: [] });
  });

  it('reads a plan by id, and reports a missing one as -32002', async () => {
    const project = makeProject('mcp-resources');
    try {
      const store = new FilePlanStore(path.join(project, '.ai-runtime', 'plans'));
      const plan = {
        id: 'plan-mcp-resource',
        goal: 'be readable over MCP',
        status: 'completed',
        createdAt: new Date('2026-09-25T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-09-25T00:00:00.000Z').toISOString(),
        steps: [],
      } as unknown as Plan;
      store.save(plan);

      const resourceServer = createMcpServer({ projectRoot: project });
      const found = await call(resourceServer, 51, 'resources/read', {
        uri: 'plan://plan-mcp-resource',
      });
      const contents = (found.result as { contents: Array<Record<string, unknown>> }).contents;
      expect(JSON.parse(String(contents[0]!.text)).goal).toBe('be readable over MCP');

      const missing = await call(resourceServer, 52, 'resources/read', { uri: 'plan://nope' });
      expect(missing.error?.code).toBe(JSON_RPC_ERRORS.resourceNotFound);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reads a journal day and refuses anything that is not a day', async () => {
    const project = makeProject('mcp-journal-resource');
    try {
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(project, '.ai-runtime', 'journal');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${day}.jsonl`),
        `${JSON.stringify({ ts: new Date().toISOString(), kind: 'tool', tool: 'read_file', ok: true })}\n`
      );
      const resourceServer = createMcpServer({ projectRoot: project });
      const found = await call(resourceServer, 60, 'resources/read', { uri: `journal://${day}` });
      const contents = (found.result as { contents: Array<Record<string, unknown>> }).contents;
      expect(contents[0]!.mimeType).toBe('application/x-ndjson');
      expect(String(contents[0]!.text)).toContain('read_file');

      const bad = await call(resourceServer, 61, 'resources/read', { uri: 'journal://yesterday' });
      expect(bad.error?.code).toBe(JSON_RPC_ERRORS.resourceNotFound);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('never lets a resource uri become a path outside .ai-runtime', async () => {
    for (const uri of [
      'plan://../../etc/passwd',
      'plan://..%2F..%2Fetc%2Fpasswd',
      'journal://../../etc/passwd',
      'journal://2026-09-25/../../../etc/passwd',
      'file:///etc/passwd',
      'memory://graph/../../etc/passwd',
    ]) {
      const response = await call(server, 70, 'resources/read', { uri });
      expect(response.error?.code, `${uri} must be refused`).toBe(JSON_RPC_ERRORS.resourceNotFound);
      expect(JSON.stringify(response)).not.toContain('root:x:');
    }
  });

  it('requires a uri', async () => {
    const response = await call(server, 71, 'resources/read', {});
    expect(response.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

describe('Phase 43 — the stdio transport', () => {
  it('answers frames in order, stays silent on notifications, and banners on stderr', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    const handle = serveStdio(server, {
      input,
      output,
      errorOutput: errors,
      banner: 'banner goes to stderr',
    });
    input.write(`${frame(80, 'initialize', { protocolVersion: '2024-11-05' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${frame(81, 'ping')}\n`);
    input.write(
      `${frame(82, 'tools/call', { name: 'read_file', arguments: { filePath: 'hello.txt' } })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    input.end();
    await handle.done;

    const responses = written
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses.map((response) => response.id)).toEqual([80, 81, 82]);
    expect((responses[2]!.result as Record<string, unknown>).isError).toBeUndefined();

    // stdout carried protocol only; the human-facing line went to stderr.
    expect(written.join('')).not.toContain('banner');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors.read()?.toString()).toContain('banner goes to stderr');
  });

  it('answers an unparseable line in-band, because a client has to hear about it', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    const handle = serveStdio(server, { input, output });
    input.write('{ this is not json\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.end();
    await handle.done;
    const response = JSON.parse(written.join('').trim()) as Record<string, unknown>;
    expect((response.error as Record<string, unknown>).code).toBe(JSON_RPC_ERRORS.parseError);
  });
});

describe('Phase 43 — the HTTP transport', () => {
  const TOKEN = 'test-bearer-token-value';
  let http: Awaited<ReturnType<typeof serveHttp>>;

  beforeAll(async () => {
    http = await serveHttp(server, { token: TOKEN, port: 0 });
  });

  afterAll(async () => {
    if (http) await http.close();
  });

  it('binds loopback only', () => {
    expect(http.url).toContain('127.0.0.1');
    expect(http.url).toContain('/mcp');
  });

  it('answers /health without a token (it says nothing else)', async () => {
    const response = await request(http.app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.tools).toBe(LOCAL_TOOL_IDS.length);
  });

  it('refuses a missing or wrong token with 401', async () => {
    const missing = await request(http.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(missing.status).toBe(401);

    const wrong = await request(http.app)
      .post('/mcp')
      .set('authorization', 'Bearer not-the-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(wrong.status).toBe(401);
  });

  it('serves the same protocol with a valid token', async () => {
    const initialized = await request(http.app)
      .post('/mcp')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({
        jsonrpc: '2.0',
        id: 90,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.protocolVersion).toBe('2025-06-18');

    const called = await request(http.app)
      .post('/mcp')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { filePath: 'hello.txt' } },
      });
    expect(called.status).toBe(200);
    expect(called.body.result.structuredContent.content).toBe('hello from the project\n');
  });

  it('accepts a notification with 202 and reports a malformed body as -32700', async () => {
    const notification = await request(http.app)
      .post('/mcp')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);

    const malformed = await request(http.app)
      .post('/mcp')
      .set('authorization', `Bearer ${TOKEN}`)
      .set('content-type', 'application/json')
      .send('{"jsonrpc":"2.0",');
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.body.error.code).toBe(JSON_RPC_ERRORS.parseError);
  });

  it('refuses to start without a token', async () => {
    await expect(serveHttp(server, { token: '   ', port: 0 })).rejects.toThrow(/bearer token/i);
  });
});

/**
 * The acceptance's real-interop test: the **actual** `@ai-sdk/mcp` client — the
 * one `McpConnector` uses in production — connects to the **actual** CLI running
 * `serve --mcp`, lists the tools and calls one.
 */
describe('Phase 43 — interop with the real @ai-sdk/mcp client', () => {
  it('connects to `hootl serve --mcp`, lists 45 tools and calls one', async () => {
    const project = makeProject('mcp-interop');
    const transport = createStdioTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        path.join(REPO_ROOT, 'src', 'cli.ts'),
        'serve',
        '--mcp',
        '--project-root',
        project,
      ],
    });
    const client = await createMCPClient({
      transport: transport as never,
      clientName: 'phase43-interop',
    });
    try {
      expect(client.serverInfo.name).toBe('human-out-of-the-loop');
      expect(MCP_PROTOCOL_VERSIONS).toContain(client.initializeResult.protocolVersion);

      const tools = await client.tools();
      expect(Object.keys(tools)).toHaveLength(LOCAL_TOOL_IDS.length);

      const readFile = tools['read_file'] as unknown as {
        execute: (input: unknown) => Promise<unknown>;
      };
      const result = await readFile.execute({ filePath: 'hello.txt' });
      expect(JSON.stringify(result)).toContain('hello from the project');

      // A failed call comes back as a tool result the client can show, not as a
      // dead connection.
      const refused = await readFile.execute({ filePath: '../../etc/passwd' });
      expect(JSON.stringify(refused)).toContain('PATH_TRAVERSAL_BLOCKED');
    } finally {
      await client.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
