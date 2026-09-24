/**
 * U2 (UI completion plan): registry introspection routes.
 *
 *   GET  /api/models /api/personas /api/skills /api/tools
 *   GET  /api/mcp
 *   POST /api/mcp/:id/test  (404 unknown; ok:true+toolIds; ok:false+error)
 *
 * The MCP connector is mocked with a hoisted mode flag so the
 * success path needs no real MCP server; the FAIL path still runs the
 * real loader + a real (fast-failing) connection attempt shape via the
 * mocked connector.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { CreatedServer } from '../../server.js';

const mcpMode = vi.hoisted(() => ({ mode: 'real' as 'real' | 'ok' | 'fail' }));

vi.mock('../../ai/tools/mcp-connector.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  class McpConnector extends actual.McpConnector {
    async connectServer(config: unknown): Promise<boolean> {
      if (mcpMode.mode === 'ok') return true;
      if (mcpMode.mode === 'fail') return false;
      return super.connectServer(config);
    }
    getServerState(id: string) {
      if (mcpMode.mode === 'ok') {
        return {
          config: {},
          status: 'ready',
          toolIds: ['demo_tool_a', 'demo_tool_b'],
        };
      }
      if (mcpMode.mode === 'fail') {
        return {
          config: {},
          status: 'unavailable',
          toolIds: [],
          lastError: 'mocked connection failure',
        };
      }
      return super.getServerState(id);
    }
  }
  return { ...actual, McpConnector };
});

import { createApp } from '../../server.js';

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

function makeProject(withMcpConfig: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-u2-'));
  fs.cpSync(REGISTRY_SRC, path.join(dir, 'registry'), { recursive: true });
  if (withMcpConfig) {
    fs.mkdirSync(path.join(dir, 'registry', 'mcp-servers'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'registry', 'mcp-servers', 'demo.json'),
      JSON.stringify({
        id: 'demo',
        name: 'Demo Server',
        transport: 'stdio',
        command: 'node',
        args: ['demo-server.js'],
        auth: { type: 'none' },
      }),
    );
  }
  return dir;
}

describe('U2 — registry routes', () => {
  let projectDir: string;
  let created: CreatedServer;

  beforeEach(async () => {
    mcpMode.mode = 'real';
  });

  afterEach(async () => {
    if (created) await created.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function boot(withMcpConfig: boolean): Promise<CreatedServer> {
    projectDir = makeProject(withMcpConfig);
    created = createApp({ projectRoot: projectDir, persistent: false });
    return created;
  }

  it('GET /api/models returns the model configs (id/provider/model/description)', async () => {
    const app = (await boot(false)).app;
    const res = await request(app).get('/api/models').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const gpt = res.body.find((m: any) => m.id === 'gpt-4o');
    expect(gpt).toBeDefined();
    expect(gpt.provider).toBe('openai');
    expect(gpt.model).toBeTruthy();
    expect(gpt).toHaveProperty('description');
  });

  it('GET /api/personas returns personas with allowedTools', async () => {
    const app = (await boot(false)).app;
    const res = await request(app).get('/api/personas').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    const coder = res.body.find((p: any) => p.id === 'coder');
    expect(coder).toBeDefined();
    expect(Array.isArray(coder.allowedTools)).toBe(true);
  });

  it('GET /api/skills returns skills with resolved tools', async () => {
    const app = (await boot(false)).app;
    const res = await request(app).get('/api/skills').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const fm = res.body.find((s: any) => s.id === 'file_management');
    expect(fm).toBeDefined();
    expect(Array.isArray(fm.tools)).toBe(true);
    expect(fm).toHaveProperty('version');
  });

  it('GET /api/tools returns tool definitions with source/category', async () => {
    const app = (await boot(false)).app;
    const res = await request(app).get('/api/tools').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    const rf = res.body.find((t: any) => t.id === 'read_file');
    expect(rf).toBeDefined();
    expect(rf.source).toBe('local');
    expect(rf).toHaveProperty('category');
    expect(rf).toHaveProperty('description');
  });

  it('GET /api/mcp lists configured servers (empty when none)', async () => {
    const app = (await boot(false)).app;
    const res = await request(app).get('/api/mcp').expect(200);
    expect(res.body.servers).toEqual([]);
    expect(res.body.errors).toEqual([]);
  });

  it('GET /api/mcp lists a configured server with endpoint + auth', async () => {
    const app = (await boot(true)).app;
    const res = await request(app).get('/api/mcp').expect(200);
    expect(res.body.servers).toHaveLength(1);
    expect(res.body.servers[0]).toMatchObject({
      id: 'demo',
      name: 'Demo Server',
      transport: 'stdio',
      auth: 'none',
    });
    expect(String(res.body.servers[0].endpoint)).toContain('node demo-server.js');
  });

  it('POST /api/mcp/:id/test → 404 {ok:false} for an unknown server', async () => {
    const app = (await boot(true)).app;
    const res = await request(app)
      .post('/api/mcp/does-not-exist/test')
      .expect(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('does-not-exist');
  });

  it('POST /api/mcp/:id/test → {ok:true, toolIds} on success', async () => {
    const app = (await boot(true)).app;
    mcpMode.mode = 'ok';
    const res = await request(app).post('/api/mcp/demo/test').expect(200);
    expect(res.body).toEqual({ ok: true, toolIds: ['demo_tool_a', 'demo_tool_b'] });
  });

  it('POST /api/mcp/:id/test → {ok:false, error} on failure (200, not 500)', async () => {
    const app = (await boot(true)).app;
    mcpMode.mode = 'fail';
    const res = await request(app).post('/api/mcp/demo/test').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('mocked connection failure');
  });
});
