/**
 * A-02 / A-03 — `--trust-project` persist + introspection paths must not
 * spawn a project-layer MCP server until the project is trusted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';
import { resolveAndMaybePersistTrust } from '../utils/trust-project.js';
import { loadGlobalConfig } from '../utils/config.js';
import { parseInteractiveArgs } from '../repl.js';
import { mcpTestCommand } from '../commands/mcp.js';
import { createProgram } from '../../cli.js';

function writeEvilServer(root: string, marker: string): void {
  const dir = path.join(root, 'registry', 'mcp-servers');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(root, 'evil-mcp.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'spawned');\nprocess.stdin.resume();\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'evil.json'),
    JSON.stringify({
      id: 'evil',
      name: 'evil',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      auth: { type: 'none' },
      connectTimeoutMs: 1500,
    }),
  );
}

describe('A-02 — --trust-project persist', () => {
  let home: HomeHandle;
  let project: string;

  beforeEach(() => {
    home = useIsolatedHome('a02-home-');
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'a02-proj-'));
  });

  afterEach(() => {
    home.restore();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('persists the project root in global config.trustedProjects', () => {
    expect(loadGlobalConfig().trustedProjects ?? []).toEqual([]);
    expect(resolveAndMaybePersistTrust(project, false)).toBe(false);
    expect(resolveAndMaybePersistTrust(project, true)).toBe(true);
    const saved = loadGlobalConfig().trustedProjects ?? [];
    expect(saved.some((p) => path.resolve(p) === path.resolve(project))).toBe(true);
    expect(resolveAndMaybePersistTrust(project, false)).toBe(true);
  });

  it('REPL accepts --trust-project as an interactive-only flag', () => {
    expect(parseInteractiveArgs(['--trust-project', '--yes'])).toEqual({
      trustProject: true,
      yes: true,
    });
  });

  it('run / mcp test / serve / tools expose --trust-project', () => {
    const program = createProgram('hootl');
    const help = program.commands.map((c) => c.name());
    expect(help).toEqual(expect.arrayContaining(['run', 'mcp', 'serve', 'tools']));
    const run = program.commands.find((c) => c.name() === 'run')!;
    expect(run.options.some((o) => o.long === '--trust-project')).toBe(true);
    const serve = program.commands.find((c) => c.name() === 'serve')!;
    expect(serve.options.some((o) => o.long === '--trust-project')).toBe(true);
    const tools = program.commands.find((c) => c.name() === 'tools')!;
    expect(tools.options.some((o) => o.long === '--trust-project')).toBe(true);
    const mcp = program.commands.find((c) => c.name() === 'mcp')!;
    const test = mcp.commands.find((c) => c.name() === 'test')!;
    expect(test.options.some((o) => o.long === '--trust-project')).toBe(true);
  });
});

describe('A-03 — mcp test does not spawn project servers when untrusted', () => {
  let home: HomeHandle;
  let project: string;
  let marker: string;

  beforeEach(() => {
    home = useIsolatedHome('a03-home-');
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'a03-proj-'));
    marker = path.join(project, 'spawned');
    writeEvilServer(project, marker);
  });

  afterEach(() => {
    home.restore();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('refuses without spawning', async () => {
    const code = await mcpTestCommand('evil', { projectRoot: project });
    expect(code).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('spawns after --trust-project (trusted:true for this call)', async () => {
    const code = await mcpTestCommand('evil', { projectRoot: project, trusted: true });
    // Connection may fail the handshake; the child must have started.
    expect(fs.existsSync(marker)).toBe(true);
    expect([0, 1]).toContain(code);
  }, 15_000);
});

describe('A-03 — tools --mcp does not spawn when untrusted', () => {
  let home: HomeHandle;
  let project: string;
  let marker: string;

  beforeEach(() => {
    home = useIsolatedHome('a03-tools-');
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'a03-tools-'));
    marker = path.join(project, 'spawned');
    writeEvilServer(project, marker);
  });

  afterEach(() => {
    home.restore();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('prints the trust warning and leaves the child unspawned', async () => {
    const { toolsCommand } = await import('../commands/registry.js');
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await toolsCommand({ projectRoot: project, mcp: true });
      expect(code).toBe(0);
      expect(chunks.join('')).toMatch(/untrusted project/i);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
