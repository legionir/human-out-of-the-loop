/**
 * R0-08 — a project's own `registry/mcp-servers/*.json` must not be
 * bootstrapped (no stdio child spawned) unless the caller has explicitly
 * marked the project trusted. This locks down the code-execution-on-first-
 * `initialize()` finding: a malicious cloned repo's stdio server must stay
 * unspawned until the operator opts in.
 *
 * `bootstrapMcpServers` is mocked so this test asserts on WHICH directories
 * the orchestrator hands it (never the project layer unless trusted)
 * without depending on a real stdio child process/handshake, which is
 * unreliable in this platform's test sandbox.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

const bootstrapMcpServersMock = vi.fn(async (dirs: string | string[]) => ({
  connector: { closeAll: vi.fn(async () => {}) },
  configErrors: [],
  connectionResults: [],
}));

vi.mock('../tools/mcp-bootstrap.js', () => ({
  bootstrapMcpServers: (...args: Parameters<typeof bootstrapMcpServersMock>) =>
    bootstrapMcpServersMock(...args),
}));

import { Orchestrator } from '../orchestrator.js';

function writeProjectMcpServer(root: string): void {
  const dir = path.join(root, 'registry', 'mcp-servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'evil.json'),
    JSON.stringify({
      id: 'evil',
      name: 'evil server',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      auth: { type: 'none' },
      connectTimeoutMs: 2000,
    })
  );
}

describe('R0-08 — project mcp-servers requires explicit trust', () => {
  let tmpRoot: string;

  beforeEach(() => {
    bootstrapMcpServersMock.mockClear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-08-'));
    writeProjectMcpServer(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does NOT hand the project mcp-servers directory to bootstrapMcpServers when untrusted', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: tmpRoot,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await orchestrator.initialize();
    await orchestrator.shutdown();

    expect(bootstrapMcpServersMock).toHaveBeenCalledTimes(1);
    const dirs = bootstrapMcpServersMock.mock.calls[0]![0] as string[];
    expect(dirs.some((d) => path.resolve(d).startsWith(path.resolve(tmpRoot)))).toBe(false);
  });

  it('DOES hand the project mcp-servers directory to bootstrapMcpServers once trustedProject:true is set', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: tmpRoot,
      trustedProject: true,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await orchestrator.initialize();
    await orchestrator.shutdown();

    expect(bootstrapMcpServersMock).toHaveBeenCalledTimes(1);
    const dirs = bootstrapMcpServersMock.mock.calls[0]![0] as string[];
    expect(dirs.some((d) => path.resolve(d).startsWith(path.resolve(tmpRoot)))).toBe(true);
  });
});
