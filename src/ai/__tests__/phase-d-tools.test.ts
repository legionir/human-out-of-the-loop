import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFileEdits } from '../tools/fs/lib.js';
import { createEditFileTool } from '../tools/implementations/edit-file.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGetCurrentTimeTool } from '../tools/implementations/get-current-time.js';
import { createSequentialThinkingTool } from '../tools/implementations/sequential-thinking.js';
import { createCreateTaskTool } from '../tools/implementations/task-control-tools.js';
import { createGitCommitTool } from '../tools/implementations/git-commit.js';
import { createGitPushTool } from '../tools/implementations/git-push.js';
import { createGitPrCreateTool } from '../tools/implementations/git-pr.js';
import {
  GIT_COMMIT_TIMEOUT_MS,
  gitEnv,
  runGit,
} from '../tools/git/git-runner.js';
import { McpConnector } from '../tools/mcp-connector.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import type { McpServerConfig } from '../schemas/mcp-server.js';
import { isReadOnlyTool, readOnlyToolIds } from '../tools/read-only.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { MemorySessionStore } from '../runtime/session-store.js';
import { JournalWriter, journalFileFor, withJournal, type JournalEntry } from '../runtime/journal.js';
import { runWithAgentContext } from '../runtime/agent-run-context.js';
import { EventBus } from '../runtime/event-bus.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { tool } from 'ai';
import { z } from 'zod';

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

function readJournalLines(file: string): JournalEntry[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalEntry);
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { env: gitEnv(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf-8' });
}

function initRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hootl-d-${name}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'phase-d@example.com']);
  git(dir, ['config', 'user.name', 'Phase D']);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

describe('Phase D — edit_file matching and encoding (D-01…D-05)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-d-edit-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('D-01 refuses an ambiguous match and leaves the file untouched', async () => {
    const file = path.join(root, 'dup.ts');
    const original = 'foo = 1;\nbar = 2;\nfoo = 1;\n';
    fs.writeFileSync(file, original);
    await expect(
      applyFileEdits(file, [{ oldText: 'foo = 1;', newText: 'foo = 9;' }])
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_MATCH', matchCount: 2 });
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  it('D-02 keeps tabs in a Makefile recipe', async () => {
    const file = path.join(root, 'Makefile');
    fs.writeFileSync(file, 'all:\n\techo hello\n');
    await applyFileEdits(file, [{ oldText: '\techo hello', newText: '\techo world' }]);
    const updated = fs.readFileSync(file);
    expect(updated.includes(Buffer.from([0x09]))).toBe(true);
    expect(updated.toString('utf-8')).toBe('all:\n\techo world\n');
  });

  it('D-02 whitespace-tolerant match still keeps the original tab indent', async () => {
    const file = path.join(root, 'Makefile.ws');
    fs.writeFileSync(file, 'all:\n\techo hello\n');
    await applyFileEdits(file, [{ oldText: '    echo hello', newText: '    echo world' }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('all:\n\techo world\n');
  });

  it('D-03 preserves CRLF on the lines that were not edited', async () => {
    const file = path.join(root, 'win.txt');
    fs.writeFileSync(file, Buffer.from('keep-a\r\nchange-me\r\nkeep-b\r\n', 'utf-8'));
    await applyFileEdits(file, [{ oldText: 'change-me', newText: 'changed' }]);
    expect(fs.readFileSync(file)).toEqual(Buffer.from('keep-a\r\nchanged\r\nkeep-b\r\n', 'utf-8'));
  });

  it('D-04 rejects empty oldText', async () => {
    const file = path.join(root, 'empty.txt');
    fs.writeFileSync(file, 'hello\n\nworld\n');
    await expect(applyFileEdits(file, [{ oldText: '', newText: 'x' }])).rejects.toMatchObject({
      code: 'EMPTY_OLD_TEXT',
    });
    const tool = executeOf(createEditFileTool(root));
    const result = await tool({
      path: 'empty.txt',
      edits: [{ oldText: '', newText: 'x' }],
    });
    expect(result.success).toBe(false);
    expect(result.code === 'EMPTY_OLD_TEXT' || String(result.error).length > 0).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n\nworld\n');
  });

  it('D-05 refuses a Latin-1 file and write_file can store base64 bytes', async () => {
    const latin = path.join(root, 'latin.txt');
    const bytes = Buffer.from([0xc0, 0x41, 0x0a]); // À in latin-1 + A + LF, invalid UTF-8
    fs.writeFileSync(latin, bytes);
    await expect(
      applyFileEdits(latin, [{ oldText: 'A', newText: 'B' }])
    ).rejects.toMatchObject({ code: 'ENCODING_UNSUPPORTED' });
    expect(fs.readFileSync(latin)).toEqual(bytes);

    const write = executeOf(createWriteFileTool(root));
    const written = await write({
      filePath: 'bin.dat',
      content: Buffer.from([0xc0, 0x41]).toString('base64'),
      encoding: 'base64',
      overwrite: false,
    });
    expect(written.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'bin.dat'))).toEqual(Buffer.from([0xc0, 0x41]));
  });
});

describe('Phase D — MCP connect timeout (D-06)', () => {
  it('times out a hanging tools() list and closes the client and transport', async () => {
    const closed: string[] = [];
    const connector = new McpConnector({
      toolRegistry: new ToolRegistry(),
      createTransport: () => ({
        close: async () => {
          closed.push('transport');
        },
      }),
      createClient: async () => ({
        tools: () => new Promise(() => {}),
        close: async () => {
          closed.push('client');
        },
      }),
    });
    const config: McpServerConfig = {
      id: 'hang-tools',
      name: 'hang',
      transport: 'stdio',
      command: 'node',
      args: [],
      auth: { type: 'none' },
      connectTimeoutMs: 120,
    };
    const started = Date.now();
    const ok = await connector.connectServer(config);
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(connector.getServerState('hang-tools')?.lastError).toMatch(/Connection timeout after 120ms/);
    expect(closed).toEqual(expect.arrayContaining(['client', 'transport']));
  });
});

const gitSuite = gitAvailable() ? describe : describe.skip;

gitSuite('Phase D — git runner, commit, push, PR (D-07…D-10, D-13)', () => {
  it('D-07 kills a sleeping hook process group within the timeout', async () => {
    const repo = initRepo('hook');
    try {
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      const pidFile = path.join(repo, 'hook.pid');
      fs.writeFileSync(
        hook,
        // Git for Windows runs hooks in MSYS, where $$ is not a Windows pid;
        // /proc/$$/winpid is.
        `#!/bin/sh\nif [ -r /proc/$$/winpid ]; then cat /proc/$$/winpid; else echo $$; fi > ${JSON.stringify(pidFile.split(path.sep).join('/'))}\nsleep 60\n`
      );
      fs.chmodSync(hook, 0o755);
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const n = 2;\n');
      git(repo, ['add', 'app.ts']);
      const started = Date.now();
      const result = await runGit(repo, ['commit', '-m', 'hooked'], {
        timeoutMs: 1000,
        env: {
          GIT_AUTHOR_NAME: 'Phase D',
          GIT_AUTHOR_EMAIL: 'phase-d@example.com',
          GIT_COMMITTER_NAME: 'Phase D',
          GIT_COMMITTER_EMAIL: 'phase-d@example.com',
        },
      });
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(2500);
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
        if (Number.isInteger(pid) && pid > 0) {
          expect(isAliveNotZombie(pid)).toBe(false);
        }
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('D-08 passes SSH/proxy/author vars and drops secrets', () => {
    const previous = {
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      USERPROFILE: process.env.USERPROFILE,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    try {
      process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
      process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/id';
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      process.env.HTTP_PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = 'localhost';
      process.env.XDG_CONFIG_HOME = '/tmp/xdg';
      process.env.GIT_AUTHOR_NAME = 'Ada';
      process.env.GIT_AUTHOR_EMAIL = 'ada@example.com';
      process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
      process.env.GIT_COMMITTER_NAME = 'Ada';
      process.env.USERPROFILE = '/tmp/profile';
      process.env.OPENAI_API_KEY = 'sk-secret-must-not-leak';
      const env = gitEnv();
      expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
      expect(env.GIT_SSH_COMMAND).toBe('ssh -i /tmp/id');
      expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
      expect(env.HTTP_PROXY).toBe('http://proxy:8080');
      expect(env.NO_PROXY).toBe('localhost');
      expect(env.XDG_CONFIG_HOME).toBe('/tmp/xdg');
      expect(env.GIT_AUTHOR_NAME).toBe('Ada');
      expect(env.GIT_AUTHOR_EMAIL).toBe('ada@example.com');
      expect(env.GIT_AUTHOR_DATE).toBe('2026-01-01T00:00:00Z');
      expect(env.GIT_COMMITTER_NAME).toBe('Ada');
      expect(env.USERPROFILE).toBe('/tmp/profile');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('D-09 refuses a commit on detached HEAD', async () => {
    const repo = initRepo('detach');
    try {
      git(repo, ['checkout', '--detach', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const n = 3;\n');
      git(repo, ['add', 'app.ts']);
      const result = await executeOf(createGitCommitTool(repo))({
        directory: '.',
        message: 'orphan',
      });
      expect(result.success).toBe(false);
      expect(result.code).toBe('DETACHED_HEAD');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('D-09 reports pushed:false when the remote is already up to date', async () => {
    const repo = initRepo('push-uptodate');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-d-bare-'));
    try {
      git(bare, ['init', '-q', '--bare', '-b', 'main']);
      git(repo, ['checkout', '-q', '-b', 'feature/uptodate']);
      git(repo, ['remote', 'add', 'origin', bare]);
      git(repo, ['push', '-u', 'origin', 'feature/uptodate']);
      const result = await executeOf(createGitPushTool(repo))({
        directory: '.',
        remote: 'origin',
        branch: 'feature/uptodate',
      });
      expect(result.success).toBe(true);
      expect(result.pushed).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('D-10 sends head/base and --repo, and REST fork head is owner:branch', async () => {
    const repo = initRepo('pr-refs');
    try {
      git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['update-ref', 'refs/remotes/origin/main', sha]);
      git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

      const ghArgs: string[][] = [];
      const ghCreate = executeOf(
        createGitPrCreateTool(repo, {
          runGh: async (args) => {
            ghArgs.push([...args]);
            if (args[0] === '--version') {
              return { ok: true, stdout: 'gh 2', stderr: '', code: 0 };
            }
            return {
              ok: true,
              stdout: 'https://github.com/acme/widgets/pull/8\n',
              stderr: '',
              code: 0,
            };
          },
          ghAvailable: true,
        })
      );
      const created = await ghCreate({ directory: '.', title: 'From D-10' });
      expect(created.success).toBe(true);
      const createArgs = ghArgs.find((row) => row.includes('create'));
      expect(createArgs).toEqual(
        expect.arrayContaining([
          'pr',
          'create',
          '--repo',
          'acme/widgets',
          '--head',
          'main',
          '--base',
          'main',
        ])
      );

      const bodies: unknown[] = [];
      const restCreate = executeOf(
        createGitPrCreateTool(repo, {
          ghAvailable: false,
          runGh: async () => ({ ok: false, stdout: '', stderr: 'ENOENT', code: 127 }),
          env: { GITHUB_TOKEN: 'tok' },
          fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body ?? '{}')));
            return new Response(
              JSON.stringify({
                number: 3,
                title: 'fork',
                state: 'open',
                html_url: 'https://github.com/acme/widgets/pull/3',
                head: { ref: 'feat' },
                base: { ref: 'main' },
              }),
              { status: 201, headers: { 'content-type': 'application/json' } }
            );
          }) as unknown as typeof fetch,
        })
      );
      const forked = await restCreate({
        directory: '.',
        title: 'fork PR',
        head: 'forkuser:feat',
        base: 'main',
      });
      expect(forked.success).toBe(true);
      expect(bodies[0]).toMatchObject({ head: 'forkuser:feat', base: 'main' });

      const missing = await executeOf(
        createGitPrCreateTool(repo, {
          ghAvailable: false,
          runGh: async () => ({ ok: false, stdout: '', stderr: 'ENOENT', code: 127 }),
          env: { GITHUB_TOKEN: 'tok' },
          fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch,
        })
      )({ directory: '.', title: 'nope', head: 'never-pushed' });
      expect(missing.success).toBe(false);
      expect(missing.code).toBe('BRANCH_NOT_PUSHED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('D-13 commits a multiline message via stdin', async () => {
    expect(GIT_COMMIT_TIMEOUT_MS).toBe(120_000);
    const repo = initRepo('body');
    try {
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const n = 4;\n');
      git(repo, ['add', 'app.ts']);
      const message = 'subject line\n\nbody paragraph';
      const result = await executeOf(createGitCommitTool(repo))({
        directory: '.',
        message,
      });
      expect(result.success).toBe(true);
      const body = git(repo, ['log', '-1', '--pretty=%B']);
      expect(body).toContain('subject line');
      expect(body).toContain('body paragraph');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Phase D — sequentialthinking sessions (D-11)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-d-think-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('isolates sessions per plan and redacts secrets', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_ABCDEF1234';
    try {
      const execute = executeOf(createSequentialThinkingTool(root));
      const think = async (planId: string, n: number) =>
        runWithAgentContext(
          {
            taskId: `task-${planId}`,
            agentId: 'a',
            personaId: 'p',
            delegationDepth: 0,
            planId,
          },
          () =>
            execute({
              thought:
                n === 1
                  ? `step for ${planId} token=ghp_ABCDEF1234`
                  : `step ${n} of ${planId}`,
              thoughtNumber: n,
              totalThoughts: 30,
              nextThoughtNeeded: n < 30,
            })
        );

      for (let n = 1; n <= 30; n++) await think('planA', n);
      for (let n = 1; n <= 30; n++) await think('planB', n);

      const dir = path.join(root, '.ai-runtime', 'thinking');
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(2);
      const serialized = files
        .map((name) => fs.readFileSync(path.join(dir, name), 'utf-8'))
        .join('\n');
      expect(serialized).not.toContain('ghp_ABCDEF1234');
      const a = JSON.parse(
        fs.readFileSync(path.join(dir, files.find((f) => f.includes('planA'))!), 'utf-8')
      );
      const b = JSON.parse(
        fs.readFileSync(path.join(dir, files.find((f) => f.includes('planB'))!), 'utf-8')
      );
      expect(a.thoughts).toHaveLength(30);
      expect(b.thoughts).toHaveLength(30);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('prunes a thinking session older than the TTL', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    const dir = path.join(root, '.ai-runtime', 'thinking');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify({ sessionId: 'stale', thoughts: [] }));
    const ancient = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, ancient / 1000, ancient / 1000);
    await execute({
      thought: 'fresh',
      thoughtNumber: 1,
      totalThoughts: 1,
      nextThoughtNeeded: false,
      sessionId: 'fresh',
    });
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('Phase D — time, create_task, read-only, previous plan (D-14…D-17)', () => {
  it('D-14 rejects 2026-02-31', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-d-time-'));
    try {
      const result = await executeOf(createGetCurrentTimeTool(root))({
        date: '2026-02-31',
        timezone: 'UTC',
      });
      expect(result.success).toBe(false);
      expect(result.code).toBe('INVALID_DATE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('D-15 does not fake-succeed on a bare TaskRuntime', async () => {
    const runtime = new TaskRuntime({ maxConcurrentTasks: 1, eventBus: new EventBus() });
    try {
      const result = await executeOf(createCreateTaskTool(runtime))({
        agentId: 'coder',
        prompt: 'p',
        claimedResources: [],
      });
      expect(result.success).toBe(false);
      expect(result.code).toBe('USE_DELEGATE_TASK');
    } finally {
      runtime.destroy();
    }
  });

  it('D-16 treats git_pr_list and git_pr_view as read-only', () => {
    expect(isReadOnlyTool('git_pr_list')).toBe(true);
    expect(isReadOnlyTool('git_pr_view')).toBe(true);
    expect(isReadOnlyTool('git_pr_create')).toBe(false);
    expect(isReadOnlyTool('git_pr_comment')).toBe(false);
    expect(readOnlyToolIds()).toEqual(
      expect.arrayContaining(['git_pr_list', 'git_pr_view'])
    );
  });

  it('D-17 registers get_previous_plan_summary when a session store is provided', async () => {
    const toolRegistry = new ToolRegistry();
    const personaRegistry = new PersonaRegistry();
    const skillRegistry = new SkillRegistry({ toolRegistry });
    const sessionStore = new MemorySessionStore();
    const sessionId = sessionStore.createSession();
    const interaction = sessionStore.addInteraction(sessionId, 'continue');
    expect(interaction).toBeDefined();
    sessionStore.updateInteraction(sessionId, interaction!.id, {
      outcome: 'success',
      reviewSummary: 'Shipped the widget.',
      completedAt: Date.now(),
    });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry, sessionStore });
    expect(toolRegistry.hasDefinition('get_previous_plan_summary')).toBe(true);
    const impl = toolRegistry.getImplementation('get_previous_plan_summary');
    const result = await executeOf(impl)({ sessionId });
    expect(result.success).toBe(true);
    expect(result.previousPlanSummary).toBe('Shipped the widget.');
  });
});

describe('Phase D — journal summary and redaction (D-18)', () => {
  let runtimeDir: string;
  afterEach(() => {
    if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('summary mode omits the full result and redacts substring keys plus 6-char secrets', async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-d-journal-'));
    const writer = new JournalWriter({
      runtimeDir,
      includeResults: 'summary',
      redactValues: ['abcdef'],
    });
    const echo = tool({
      description: 'echo',
      inputSchema: z.object({
        text: z.string(),
        githubToken: z.string(),
        'x-api-key': z.string(),
      }),
      execute: async (input) => ({ success: true as const, huge: 'x'.repeat(4000), ...input }),
    });
    try {
      const wrapped = withJournal({ echo } as Record<string, unknown>, {}, writer);
      await (
        wrapped.echo as { execute: (input: unknown) => Promise<unknown> }
      ).execute({
        text: `secret=abcdef visible`,
        githubToken: 'should-mask',
        'x-api-key': 'also-mask',
      });
      const [entry] = readJournalLines(journalFileFor(runtimeDir, new Date()));
      expect(entry!.result).toBeUndefined();
      expect(entry!.summary).toBeDefined();
      expect(entry!.summary!.length).toBeLessThanOrEqual(400);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('abcdef');
      const input = entry!.input as Record<string, unknown>;
      expect(input.githubToken).toBe('***REDACTED***');
      expect(input['x-api-key']).toBe('***REDACTED***');
    } finally {
      writer.close();
    }
  });
});

/** A killed process nobody has reaped yet is a zombie: gone, but kill(pid, 0) still succeeds. */
function isAliveNotZombie(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    return !/^State:\s+Z/m.test(status);
  } catch {
    return true;
  }
}
