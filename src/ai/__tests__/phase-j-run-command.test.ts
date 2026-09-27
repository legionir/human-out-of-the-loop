/**
 * J-01 — `run_command` / `run_tests`: allowlist, argv (no shell), timeout+kill,
 * output cap + truncated, cwd = projectRoot, journal, not read-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnArgv } from '../tools/spawn-argv.js';
import {
  commandChildEnv,
  isCommandAllowed,
  isForbiddenShell,
  loadCommandPolicy,
} from '../tools/command-allowlist.js';
import { clearSessionTrust, markRootTrusted } from '../registries/trust.js';
import { createRunCommandTool, createRunTestsTool, runProjectTests } from '../tools/implementations/run-command.js';
import { isReadOnlyTool } from '../tools/read-only.js';
import { JournalWriter, journalFileFor, withJournal, type JournalEntry } from '../runtime/journal.js';

type ToolExecute = (args: unknown, options?: { abortSignal?: AbortSignal }) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function writePolicy(root: string, policy: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.ai-runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-runtime', 'commands.json'), JSON.stringify(policy));
}

describe('J-01 — run_command / run_tests', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j01-'));
    markRootTrusted(root);
  });
  afterEach(() => {
    clearSessionTrust();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an empty allowlist and every shell binary', () => {
    expect(isCommandAllowed('node', [])).toBe(false);
    expect(isForbiddenShell('bash')).toBe(true);
    expect(isForbiddenShell('/bin/zsh')).toBe(true);
    expect(isCommandAllowed('bash', ['bash', 'node'])).toBe(false);
    expect(isCommandAllowed('node', ['node'])).toBe(true);
  });

  it('matches argv[0] exactly: a bare name never matches a path to a same-named binary', () => {
    expect(isCommandAllowed('./scripts/node', ['node'])).toBe(false);
    expect(isCommandAllowed('/tmp/evil/node', ['node'])).toBe(false);
    expect(isCommandAllowed('evil/node', ['node'])).toBe(false);
    expect(isCommandAllowed('/usr/bin/node', ['/usr/bin/node'])).toBe(true);
    expect(isCommandAllowed('rel/node', ['rel/node'])).toBe(false);
  });

  it('ignores .ai-runtime/commands.json in an untrusted project', async () => {
    clearSessionTrust();
    writePolicy(root, { allow: ['node'], testCommand: ['node', '-e', '0'] });
    const policy = loadCommandPolicy(root, {});
    expect(policy.allow).toEqual([]);
    expect(policy.testCommand).toEqual([]);
    const tests = await runProjectTests(root);
    expect(tests.code).toBe('NO_TEST_COMMAND');
  });

  it('does not hand credentials to the child process', async () => {
    const env = commandChildEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 't', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
    writePolicy(root, { allow: ['node'] });
    const prev = process.env.MY_SECRET_TOKEN;
    process.env.MY_SECRET_TOKEN = 'leak-me-please';
    try {
      const out = await executeOf(createRunCommandTool(root))({
        argv: ['node', '-e', 'process.stdout.write(String(process.env.MY_SECRET_TOKEN))'],
      });
      expect(out.stdout).toBe('undefined');
    } finally {
      if (prev === undefined) delete process.env.MY_SECRET_TOKEN;
      else process.env.MY_SECRET_TOKEN = prev;
    }
  });

  it('loads allow + testCommand from .ai-runtime/commands.json', () => {
    writePolicy(root, { allow: ['node'], testCommand: ['node', '-e', '0'], timeoutMs: 500, maxOutputBytes: 128 });
    const policy = loadCommandPolicy(root, {});
    expect(policy.allow).toEqual(['node']);
    expect(policy.testCommand).toEqual(['node', '-e', '0']);
    expect(policy.timeoutMs).toBe(500);
    expect(policy.maxOutputBytes).toBe(128);
  });

  it('falls back to HOTL_ALLOWED_COMMANDS / HOTL_TEST_COMMAND', () => {
    const policy = loadCommandPolicy(root, {
      HOTL_ALLOWED_COMMANDS: 'node, python',
      HOTL_TEST_COMMAND: 'node -e process.exit(0)',
    });
    expect(policy.allow).toEqual(['node', 'python']);
    expect(policy.testCommand[0]).toBe('node');
  });

  it('spawns argv without a shell and uses cwd', async () => {
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const result = await spawnArgv(['node', '-e', 'process.stdout.write(process.cwd())'], {
      cwd: nested,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    // The child reports the OS's real path (macOS: /private/var/…).
    expect(fs.realpathSync(result.stdout)).toBe(fs.realpathSync(nested));
  });

  it('kills on timeout and caps output with truncated=true', async () => {
    const timed = await spawnArgv(['node', '-e', 'setTimeout(() => {}, 60_000)'], {
      cwd: root,
      timeoutMs: 250,
    });
    expect(timed.timedOut).toBe(true);
    expect(timed.ok).toBe(false);

    const fat = await spawnArgv(['node', '-e', 'process.stdout.write("x".repeat(80_000))'], {
      cwd: root,
      timeoutMs: 5_000,
      maxBytes: 64,
    });
    expect(fat.truncated).toBe(true);
    expect(Buffer.byteLength(fat.stdout, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('run_command refuses unknown binaries and runs allowlisted node in projectRoot', async () => {
    writePolicy(root, { allow: ['node'] });
    const run = executeOf(createRunCommandTool(root));
    const denied = await run({ argv: ['rm', '-rf', '/'] });
    expect(denied.success).toBe(false);
    expect(denied.code).toBe('NOT_ALLOWED');

    const shell = await run({ argv: ['bash', '-c', 'echo pwned'] });
    expect(shell.success).toBe(false);

    const ok = await run({ argv: ['node', '-e', 'process.stdout.write("hi")'] });
    expect(ok.success).toBe(true);
    expect(ok.stdout).toBe('hi');
    expect(ok.truncated).toBe(false);
  });

  it('run_tests uses the configured testCommand at projectRoot', async () => {
    writePolicy(root, {
      allow: ['node'],
      testCommand: ['node', '-e', 'process.stdout.write("PASS")'],
    });
    const tests = executeOf(createRunTestsTool(root));
    const result = await tests({});
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('PASS');
    const shared = await runProjectTests(root);
    expect(shared.success).toBe(true);
  });

  it('is not a read-only tool and is registered for the coder', () => {
    expect(isReadOnlyTool('run_command')).toBe(false);
    expect(isReadOnlyTool('run_tests')).toBe(false);
    const coder = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry/personas/coder.json'), 'utf8')) as {
      allowedTools: string[];
    };
    expect(coder.allowedTools).toContain('run_command');
    expect(coder.allowedTools).toContain('run_tests');
    expect(fs.existsSync(path.join(ROOT, 'registry/tools/run_command.json'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'registry/tools/run_tests.json'))).toBe(true);
  });

  it('journals a run_command invocation', async () => {
    writePolicy(root, { allow: ['node'] });
    const runtimeDir = path.join(root, '.ai-runtime');
    const writer = new JournalWriter({ runtimeDir, includeResults: 'full' });
    try {
      const wrapped = withJournal(
        { run_command: createRunCommandTool(root) } as Record<string, unknown>,
        {},
        writer,
      );
      await executeOf(wrapped.run_command)({ argv: ['node', '-e', '0'] });
      const lines = fs
        .readFileSync(journalFileFor(runtimeDir, new Date()), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEntry);
      expect(lines.some((entry) => entry.tool === 'run_command')).toBe(true);
    } finally {
      writer.close();
    }
  });
});
