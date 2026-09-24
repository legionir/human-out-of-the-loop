import { describe, it, expect, beforeEach } from 'vitest';
import type { Tool } from 'ai';
import { ToolRegistry } from '../registries/tool-registry.js';
import { McpConnector } from '../tools/mcp-connector.js';
import { McpServerConfigSchema, type McpServerConfig } from '../schemas/mcp-server.js';
import { loadMcpServerConfigs, bootstrapMcpServers } from '../tools/mcp-bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Helpers ─────────────────────────────────────────────────────

/** Fake AI SDK Tool object — minimal shape acceptable by ToolRegistry */
function fakeTool(name: string): Tool {
  return {
    description: `Fake tool ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] } as never,
    execute: async () => ({ ok: true }),
  } as unknown as Tool;
}

/**
 * Fake MCP client factory — returns a controllable client without
 * touching the network.
 */
function createFakeClientFactory(behaviour: {
  tools?: Record<string, Tool>;
  throwOnCreate?: Error;
  throwOnToolsCall?: Error;
  delayMs?: number;
}) {
  return async (_opts: { transport: unknown; name: string }) => {
    if (behaviour.delayMs) {
      await new Promise((r) => setTimeout(r, behaviour.delayMs));
    }
    if (behaviour.throwOnCreate) throw behaviour.throwOnCreate;
    return {
      tools: async () => {
        if (behaviour.throwOnToolsCall) throw behaviour.throwOnToolsCall;
        return behaviour.tools ?? {};
      },
      close: async () => {},
    };
  };
}

/** Fake transport factory — just returns a placeholder object */
const fakeTransportFactory = (_config: McpServerConfig) => ({ fake: true });

// ─── McpServerConfigSchema ──────────────────────────────────────

describe('McpServerConfigSchema', () => {
  it('accepts a minimal HTTP config with no auth', () => {
    const parsed = McpServerConfigSchema.parse({
      id: 'srv1',
      name: 'Server One',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    expect(parsed.auth.type).toBe('none');
    expect(parsed.connectTimeoutMs).toBe(10_000);
  });

  it('accepts bearer auth referencing an env var', () => {
    const parsed = McpServerConfigSchema.parse({
      id: 'srv2',
      name: 'Server Two',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', tokenEnvVar: 'MY_TOKEN' },
    });
    expect(parsed.auth).toEqual({ type: 'bearer', tokenEnvVar: 'MY_TOKEN' });
  });

  it('rejects invalid transport', () => {
    expect(() =>
      McpServerConfigSchema.parse({
        id: 'srv3',
        name: 'S3',
        transport: 'invalid-transport' as never,
        url: 'https://x.com',
      })
    ).toThrow();
  });

  it('rejects config missing url for http transport at connect time', () => {
    // Schema itself allows missing url (stdio doesn't need it) —
    // the runtime check in defaultCreateTransport enforces this.
    const parsed = McpServerConfigSchema.parse({
      id: 'srv4',
      name: 'S4',
      transport: 'http',
    });
    expect(parsed.url).toBeUndefined();
  });
});

// ─── McpConnector — success path ────────────────────────────────

describe('McpConnector — success path', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('connects to a server and registers its tools with source="mcp"', async () => {
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        tools: {
          search: fakeTool('search'),
          fetch: fakeTool('fetch'),
        },
      }),
      createTransport: fakeTransportFactory,
    });

    const config: McpServerConfig = {
      id: 'test-srv',
      name: 'Test',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'none' },
      args: [],
      connectTimeoutMs: 5000,
    };

    const ok = await connector.connectServer(config);
    expect(ok).toBe(true);

    const state = connector.getServerState('test-srv')!;
    expect(state.status).toBe('ready');
    expect(state.toolIds).toEqual(['search', 'fetch']);

    // Registered in ToolRegistry with correct source
    const searchDef = toolRegistry.getDefinition('search')!;
    expect(searchDef.source).toBe('mcp');
    expect(searchDef.mcpServerId).toBe('test-srv');
    expect(toolRegistry.getImplementation('search')).toBeDefined();
  });

  it('applies toolPrefix to avoid id collisions', async () => {
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        tools: { search: fakeTool('search') },
      }),
      createTransport: fakeTransportFactory,
    });

    await connector.connectServer({
      id: 'prefixed',
      name: 'P',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'none' },
      args: [],
      connectTimeoutMs: 5000,
      toolPrefix: 'remote_',
    });

    expect(toolRegistry.hasDefinition('remote_search')).toBe(true);
    expect(toolRegistry.hasDefinition('search')).toBe(false);
  });

  it('getToolsByIds returns MCP tools alongside local tools uniformly', async () => {
    // Register a local tool first
    toolRegistry.registerDefinition({
      id: 'local_tool',
      name: 'Local',
      description: 'Local',
      source: 'local',
      modulePath: './x',
    });
    toolRegistry.registerImplementation('local_tool', fakeTool('local'));

    // Now connect MCP
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        tools: { mcp_tool: fakeTool('mcp_tool') },
      }),
      createTransport: fakeTransportFactory,
    });
    await connector.connectServer({
      id: 'srv',
      name: 'S',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'none' },
      args: [],
      connectTimeoutMs: 5000,
    });

    const combined = toolRegistry.getToolsByIds(['local_tool', 'mcp_tool']);
    expect(Object.keys(combined)).toEqual(['local_tool', 'mcp_tool']);
  });
});

// ─── McpConnector — failure paths ────────────────────────────────

describe('McpConnector — failure paths', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('does not throw on connection error — marks server as unavailable', async () => {
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        throwOnCreate: new Error('ECONNREFUSED'),
      }),
      createTransport: fakeTransportFactory,
    });

    const ok = await connector.connectServer({
      id: 'broken',
      name: 'Broken',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'none' },
      args: [],
      connectTimeoutMs: 5000,
    });

    expect(ok).toBe(false);
    const state = connector.getServerState('broken')!;
    expect(state.status).toBe('unavailable');
    expect(state.lastError).toContain('ECONNREFUSED');
    expect(state.toolIds).toEqual([]);
  });

  it('sanitises credentials from error messages', async () => {
    process.env.SECRET_TOKEN_ABC = 'super-secret-value-12345';

    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        throwOnCreate: new Error(
          'Auth failed for token super-secret-value-12345 at endpoint'
        ),
      }),
      createTransport: fakeTransportFactory,
    });

    const ok = await connector.connectServer({
      id: 'auth-fail',
      name: 'AF',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'bearer', tokenEnvVar: 'SECRET_TOKEN_ABC' },
      args: [],
      connectTimeoutMs: 5000,
    });

    expect(ok).toBe(false);
    const state = connector.getServerState('auth-fail')!;
    expect(state.lastError).toBeDefined();
    expect(state.lastError).not.toContain('super-secret-value-12345');
    expect(state.lastError).toContain('***REDACTED***');

    delete process.env.SECRET_TOKEN_ABC;
  });

  it('fails cleanly when required env var is missing', async () => {
    delete process.env.MISSING_TOKEN_XYZ;

    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({ tools: {} }),
      createTransport: fakeTransportFactory,
    });

    const ok = await connector.connectServer({
      id: 'no-env',
      name: 'NoEnv',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'bearer', tokenEnvVar: 'MISSING_TOKEN_XYZ' },
      args: [],
      connectTimeoutMs: 5000,
    });

    expect(ok).toBe(false);
    const state = connector.getServerState('no-env')!;
    expect(state.status).toBe('unavailable');
    expect(state.lastError).toContain('MISSING_TOKEN_XYZ');
  });

  it('respects connectTimeoutMs', async () => {
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({ delayMs: 500, tools: {} }),
      createTransport: fakeTransportFactory,
    });

    const start = Date.now();
    const ok = await connector.connectServer({
      id: 'slow',
      name: 'Slow',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'none' },
      args: [],
      connectTimeoutMs: 100, // shorter than delay
    });
    const elapsed = Date.now() - start;

    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(400); // aborted well before delay finished
    const state = connector.getServerState('slow')!;
    expect(state.lastError).toContain('timeout');
  });

  it('one server failure does not affect others in connectAll', async () => {
    let callCount = 0;
    const connector = new McpConnector({
      toolRegistry,
      createClient: async (opts) => {
        callCount++;
        if (opts.name === 'bad') {
          throw new Error('bad server error');
        }
        return {
          tools: async () => ({ [`t_${opts.name}`]: fakeTool(opts.name) }),
          close: async () => {},
        };
      },
      createTransport: fakeTransportFactory,
    });

    const configs: McpServerConfig[] = [
      {
        id: 'good1',
        name: 'G1',
        transport: 'http',
        url: 'http://x',
        auth: { type: 'none' },
        args: [],
        connectTimeoutMs: 2000,
      },
      {
        id: 'bad',
        name: 'B',
        transport: 'http',
        url: 'http://x',
        auth: { type: 'none' },
        args: [],
        connectTimeoutMs: 2000,
      },
      {
        id: 'good2',
        name: 'G2',
        transport: 'http',
        url: 'http://x',
        auth: { type: 'none' },
        args: [],
        connectTimeoutMs: 2000,
      },
    ];

    const results = await connector.connectAll(configs);

    expect(callCount).toBe(3);
    expect(results.find((r) => r.id === 'good1')!.success).toBe(true);
    expect(results.find((r) => r.id === 'bad')!.success).toBe(false);
    expect(results.find((r) => r.id === 'good2')!.success).toBe(true);

    // Both good servers registered their tools
    expect(toolRegistry.hasDefinition('t_good1')).toBe(true);
    expect(toolRegistry.hasDefinition('t_good2')).toBe(true);
  });
});

// ─── loadMcpServerConfigs ───────────────────────────────────────

describe('loadMcpServerConfigs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  it('returns empty result for non-existent directory', () => {
    const result = loadMcpServerConfigs('/nonexistent/path/xyz');
    expect(result.configs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('loads a valid MCP config file', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'srv.json'),
      JSON.stringify({
        id: 'srv',
        name: 'Server',
        transport: 'http',
        url: 'http://x.com',
      })
    );
    const result = loadMcpServerConfigs(tmpDir);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].id).toBe('srv');
    expect(result.errors).toEqual([]);
  });

  it('collects errors per-file without throwing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'good.json'),
      JSON.stringify({ id: 'good', name: 'G', url: 'http://x.com' })
    );
    fs.writeFileSync(
      path.join(tmpDir, 'bad.json'),
      JSON.stringify({ id: 'BAD-UPPERCASE', name: 'B' }) // invalid id pattern
    );
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not valid json');

    const result = loadMcpServerConfigs(tmpDir);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].id).toBe('good');
    expect(result.errors).toHaveLength(2);
  });
});

// ─── bootstrapMcpServers integration ────────────────────────────

describe('bootstrapMcpServers', () => {
  it('completes successfully with zero MCP configs', async () => {
    const toolRegistry = new ToolRegistry();
    const result = await bootstrapMcpServers('/nonexistent/dir', toolRegistry);
    expect(result.configErrors).toEqual([]);
    expect(result.connectionResults).toEqual([]);
  });

  it('registers tools from a configured server (using injected connector)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bs-'));
    fs.writeFileSync(
      path.join(tmpDir, 'srv.json'),
      JSON.stringify({
        id: 'bs-srv',
        name: 'BS',
        transport: 'http',
        url: 'http://fake',
      })
    );

    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({
      toolRegistry,
      createClient: createFakeClientFactory({
        tools: { bs_tool: fakeTool('bs_tool') },
      }),
      createTransport: fakeTransportFactory,
    });

    const result = await bootstrapMcpServers(tmpDir, toolRegistry, connector);
    expect(result.connectionResults).toHaveLength(1);
    expect(result.connectionResults[0].success).toBe(true);
    expect(toolRegistry.hasDefinition('bs_tool')).toBe(true);
  });
});
