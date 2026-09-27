/**
 * A-06 — MCP schema `env` is passed through to the stdio child.
 * A-07 — http/sse URLs must be http(s); tokenEnvVar must look like an env var.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServerConfigSchema } from '../schemas/mcp-server.js';
import { createStdioTransport } from '../tools/mcp-stdio-transport.js';

describe('A-07 — MCP schema constraints', () => {
  it('rejects file:// URLs for http transport', () => {
    const parsed = McpServerConfigSchema.safeParse({
      id: 'bad',
      name: 'bad',
      transport: 'http',
      url: 'file:///etc/passwd',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid tokenEnvVar name', () => {
    const parsed = McpServerConfigSchema.safeParse({
      id: 'bad',
      name: 'bad',
      transport: 'http',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', tokenEnvVar: 'not-a-var' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts https + a valid env var name', () => {
    const parsed = McpServerConfigSchema.parse({
      id: 'ok',
      name: 'ok',
      transport: 'http',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', tokenEnvVar: 'MY_MCP_TOKEN' },
      env: { EXTRA_FLAG: '1' },
    });
    expect(parsed.env).toEqual({ EXTRA_FLAG: '1' });
    expect(parsed.auth).toMatchObject({ type: 'bearer', tokenEnvVar: 'MY_MCP_TOKEN' });
  });
});

describe('A-06 — custom env reaches the stdio child', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('createStdioTransport env is visible in the child process', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a06-env-'));
    const outFile = path.join(tmp, 'env.txt');
    const script = path.join(tmp, 'child.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], process.env.HOTL_MCP_CUSTOM ?? '');\nsetTimeout(() => process.exit(0), 200);\n`,
    );
    const transport = createStdioTransport({
      command: process.execPath,
      args: [script, outFile],
      env: { HOTL_MCP_CUSTOM: 'from-config' },
    });
    await transport.start();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8') === 'from-config') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, 'utf8')).toBe('from-config');
    await transport.close?.();
  }, 10_000);

  it('schema env is accepted and kept on the config object', () => {
    const parsed = McpServerConfigSchema.parse({
      id: 'stdio1',
      name: 'stdio',
      transport: 'stdio',
      command: 'node',
      env: { HOTL_MCP_CUSTOM: 'from-config' },
    });
    expect(parsed.env?.HOTL_MCP_CUSTOM).toBe('from-config');
  });
});
