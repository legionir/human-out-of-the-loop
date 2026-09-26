import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGitAddTool } from '../tools/implementations/git-add.js';
import { createGitCommitTool } from '../tools/implementations/git-commit.js';
import {
  createGitCheckoutTool,
  createGitCreateBranchTool,
} from '../tools/implementations/git-branch-write.js';
import { createGitResetTool } from '../tools/implementations/git-reset.js';
import { createGitPushTool } from '../tools/implementations/git-push.js';
import { createGitStashTool } from '../tools/implementations/git-stash.js';
import {
  createGitPrCommentTool,
  createGitPrCreateTool,
  createGitPrListTool,
  createGitPrViewTool,
} from '../tools/implementations/git-pr.js';
import { gitEnv } from '../tools/git/git-runner.js';
import { parseRemoteUrl } from '../tools/git/pr-backend.js';
import { protectedBranches } from '../tools/git/git-safe.js';

/**
 * Phase 42 — the writing half of git, against a real repository.
 *
 * The fixture is built here: a repo with two commits and a **bare remote** in
 * the same temp directory, so `git_push` is exercised end to end without a
 * network. The PR tools are exercised with an injected `gh` runner and an
 * injected `fetch`, so nothing in this file can reach GitHub — and the paths
 * that matter most (no backend, wrong remote, API error) are tested as first
 * class cases.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf-8' });
}

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

let hasGit = true;
try {
  execFileSync('git', ['--version'], { env: gitEnv(), stdio: 'ignore' });
} catch {
  hasGit = false;
}
const suite = hasGit ? describe : describe.skip;

let root = '';
let bare = '';
let firstSha = '';

function freshRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hootl-${name}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'phase42@example.com']);
  git(dir, ['config', 'user.name', 'Phase 42']);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), `hootl-${name}-bare-`));
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', remote]);
  return dir;
}

beforeAll(() => {
  if (!hasGit) return;
  root = freshRepo('write');
  firstSha = git(root, ['rev-parse', 'HEAD']).trim();
  bare = git(root, ['remote', 'get-url', 'origin']).trim();
});

afterAll(() => {
  for (const dir of [root, bare]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

suite('Phase 42 — the safety model', () => {
  it('protects main and master by default, and can be configured', () => {
    expect(protectedBranches({})).toEqual(['main', 'master']);
    expect(protectedBranches({ HOTL_PROTECTED_BRANCHES: 'trunk, release/*' })).toEqual([
      'trunk',
      'release/*',
    ]);
    expect(protectedBranches({ HOTL_PROTECTED_BRANCHES: '' })).toEqual([]);
  });

  it('never lets a force push exist: no write schema has such an option', () => {
    // The plan's acceptance asks for this specifically about `git_push`, but the
    // guarantee is stronger if it holds for every tool that can touch a
    // repository or a remote — so every schema is inspected, by name.
    const tools: Record<string, unknown> = {
      git_add: createGitAddTool(root),
      git_commit: createGitCommitTool(root),
      git_create_branch: createGitCreateBranchTool(root),
      git_checkout: createGitCheckoutTool(root),
      git_reset: createGitResetTool(root),
      git_push: createGitPushTool(root),
      git_stash: createGitStashTool(root),
      git_pr_create: createGitPrCreateTool(root),
      git_pr_list: createGitPrListTool(root),
      git_pr_view: createGitPrViewTool(root),
      git_pr_comment: createGitPrCommentTool(root),
    };
    const forbidden = ['force', 'no-verify', 'noVerify', 'mirror', 'prune', 'delete'];
    for (const [name, toolObj] of Object.entries(tools)) {
      const schema = JSON.stringify(
        (toolObj as { inputSchema: unknown }).inputSchema
      ).toLowerCase();
      for (const word of forbidden) {
        expect(schema, `${name} must not offer "${word}"`).not.toContain(word.toLowerCase());
      }
    }
    // …and the one destructive shortcut git offers is absent from `git_reset`
    // too: only the three documented modes exist.
    const reset = JSON.stringify(createGitResetTool(root).inputSchema);
    expect(reset).toContain('"mixed"');
    expect(reset).not.toContain('merge');
    expect(reset).not.toContain('keep');
  });

  it('never writes git config: no tool schema mentions a config write', () => {
    const commit = createGitCommitTool(root);
    const schema = JSON.stringify((commit as unknown as { inputSchema: unknown }).inputSchema);
    expect(schema).not.toContain('"config"');
    expect(schema).not.toContain('userName');
  });
});

suite('Phase 42 — git_add and git_commit', () => {
  it('stages paths and reports the before/after state', async () => {
    const add = executeOf(createGitAddTool(root));
    fs.writeFileSync(path.join(root, 'feature.ts'), 'export const added = true;\n');
    const result = await add({ directory: '.', files: ['feature.ts'] });
    expect(result.success).toBe(true);
    expect(result.staged).toEqual(['feature.ts']);
    expect((result.before as Record<string, unknown>).clean).toBe(false);
    expect((result.after as Record<string, unknown>).files).toBeGreaterThan(0);
  });

  it('refuses a path outside the workspace', async () => {
    const add = executeOf(createGitAddTool(root));
    const result = await add({ directory: '.', files: ['../../etc/passwd'] });
    expect(result.success).toBe(false);
    expect(['PATH_TRAVERSAL_BLOCKED', 'BAD_ARGUMENT']).toContain(result.code);
  });

  it('refuses a path that starts with a dash', async () => {
    const add = executeOf(createGitAddTool(root));
    const result = await add({ directory: '.', files: ['-f'] });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
  });

  it('commits the staged change and moves HEAD', async () => {
    const commit = executeOf(createGitCommitTool(root));
    const result = await commit({ directory: '.', message: 'add feature' });
    expect(result.success).toBe(true);
    expect(result.subject).toBe('add feature');
    expect(String(result.commit)).not.toBe(firstSha);
    expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('add feature');
    expect((result.before as Record<string, unknown>).head).toBe(firstSha);
    expect((result.after as Record<string, unknown>).head).toBe(result.commit);
  });

  it('stages a path and commits it in one call', async () => {
    const commit = executeOf(createGitCommitTool(root));
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = true;\n');
    const result = await commit({ directory: '.', message: 'add second', paths: ['second.ts'] });
    expect(result.success).toBe(true);
    expect(git(root, ['show', '--stat', '--format=', 'HEAD'])).toContain('second.ts');
  });

  it('refuses to commit with nothing staged', async () => {
    const commit = executeOf(createGitCommitTool(root));
    const result = await commit({ directory: '.', message: 'empty commit' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOTHING_TO_COMMIT');
    expect(String(result.error)).toContain('clean');
  });

  it('requires a non-empty message', async () => {
    const commit = executeOf(createGitCommitTool(root));
    const result = await commit({ directory: '.', message: '   ' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
  });

  it('refuses to invent an identity when the repo has none', async () => {
    const anonymous = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-noident-'));
    try {
      git(anonymous, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(anonymous, 'a.txt'), 'a\n');
      git(anonymous, ['add', '.']);
      const commit = executeOf(
        createGitCommitTool(anonymous, {
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent' },
        })
      );
      const result = await commit({ directory: '.', message: 'no identity' });
      expect(result.success).toBe(false);
      expect(['MISSING_IDENTITY', 'GIT_FAILED']).toContain(result.code);
      if (result.code === 'MISSING_IDENTITY') {
        expect(String(result.error)).toContain('git config user.name');
      }
    } finally {
      fs.rmSync(anonymous, { recursive: true, force: true });
    }
  });

  it('gates amend behind confirmDestructive and refuses it on a protected branch', async () => {
    const commit = executeOf(createGitCommitTool(root));
    const unconfirmed = await commit({ directory: '.', message: 'amend', amend: true });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.code).toBe('PROTECTED_BRANCH'); // main is checked first

    const onBranch = freshRepo('amend');
    try {
      git(onBranch, ['checkout', '-q', '-b', 'feature/amend']);
      fs.writeFileSync(path.join(onBranch, 'x.txt'), 'x\n');
      git(onBranch, ['add', '.']);
      const tool = executeOf(createGitCommitTool(onBranch));
      const refused = await tool({ directory: '.', message: 'amend me', amend: true });
      expect(refused.success).toBe(false);
      expect(refused.code).toBe('CONFIRM_REQUIRED');
      const allowed = await tool({
        directory: '.',
        message: 'amended',
        amend: true,
        confirmDestructive: true,
      });
      expect(allowed.success).toBe(true);
      expect(git(onBranch, ['log', '-1', '--pretty=%s']).trim()).toBe('amended');
      expect(git(onBranch, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    } finally {
      const remote = git(onBranch, ['remote', 'get-url', 'origin']).trim();
      fs.rmSync(onBranch, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });
});

suite('Phase 42 — branches and checkout', () => {
  it('creates a branch and switches to it, without confirmation', async () => {
    const create = executeOf(createGitCreateBranchTool(root));
    const result = await create({ directory: '.', name: 'feature/guarded-write' });
    expect(result.success).toBe(true);
    expect(result.branch).toBe('feature/guarded-write');
    expect(result.previousBranch).toBe('main');
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/guarded-write');
  });

  it('validates the name with git itself', async () => {
    const create = executeOf(createGitCreateBranchTool(root));
    for (const name of ['bad name', 'bad..name', 'bad~name', '-bad']) {
      const result = await create({ directory: '.', name });
      expect(result.success, `${name} should be refused`).toBe(false);
      expect(result.code).toBe('BAD_ARGUMENT');
    }
  });

  it('refuses to discard uncommitted changes without confirmation, and loses nothing', async () => {
    const file = path.join(root, 'app.ts');
    // Make the two branches disagree about this file, so switching really does
    // require throwing the local edit away (git only refuses when it must).
    fs.writeFileSync(file, 'export const version = 1; // branch side\n');
    git(root, ['commit', '-q', '-am', 'branch-side edit']);
    fs.writeFileSync(file, 'export const version = 99; // precious\n');
    const checkout = executeOf(createGitCheckoutTool(root));

    const refused = await checkout({ directory: '.', branch: 'main', discardChanges: true });
    expect(refused.success).toBe(false);
    expect(refused.code).toBe('CONFIRM_REQUIRED');
    expect(String(refused.error)).toContain('app.ts');
    // Nothing moved and nothing was lost.
    expect(fs.readFileSync(file, 'utf-8')).toContain('precious');
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/guarded-write');

    // A plain checkout with local changes fails, as git intends, without -f.
    const plain = await checkout({ directory: '.', branch: 'main' });
    expect(plain.success).toBe(false);
    expect(plain.code).toBe('GIT_FAILED');
    expect(fs.readFileSync(file, 'utf-8')).toContain('precious');

    const confirmed = await checkout({
      directory: '.',
      branch: 'main',
      discardChanges: true,
      confirmDestructive: true,
    });
    expect(confirmed.success).toBe(true);
    expect(confirmed.discarded).toEqual([' M app.ts']);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('precious');
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
  });

  it('reports standing on a protected branch as a warning, not a failure', async () => {
    const checkout = executeOf(createGitCheckoutTool(root));
    const result = await checkout({ directory: '.', branch: 'main' });
    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(String(result.warnings)).toContain('protected');
  });
});

suite('Phase 42 — git_reset', () => {
  it('unstages everything by default (the reference behaviour) without any confirmation', async () => {
    const file = path.join(root, 'staged-only.ts');
    fs.writeFileSync(file, 'export const staged = true;\n');
    git(root, ['add', 'staged-only.ts']);
    const reset = executeOf(createGitResetTool(root));
    const result = await reset({ directory: '.' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('mixed');
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(fs.existsSync(file)).toBe(true); // unstaged, not deleted
    fs.rmSync(file); // keep the rest of the suite's porcelain assertions honest
  });

  it('unstages a single path', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'b\n');
    git(root, ['add', 'a.ts', 'b.ts']);
    const reset = executeOf(createGitResetTool(root));
    const result = await reset({ directory: '.', paths: ['a.ts'] });
    expect(result.success).toBe(true);
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('b.ts');
    git(root, ['reset', '-q']);
    fs.rmSync(path.join(root, 'a.ts'));
    fs.rmSync(path.join(root, 'b.ts'));
  });

  it('refuses a hard reset on a protected branch, even with the flag', async () => {
    const file = path.join(root, 'app.ts');
    fs.writeFileSync(file, 'export const version = 100;\n');
    const reset = executeOf(createGitResetTool(root));
    const result = await reset({ directory: '.', mode: 'hard', confirmDestructive: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_BRANCH');
    expect(fs.readFileSync(file, 'utf-8')).toContain('version = 100');
  });

  it('refuses a hard reset without confirmation, and does nothing', async () => {
    git(root, ['checkout', '-q', '-b', 'feature/hard-reset']);
    const file = path.join(root, 'app.ts');
    fs.writeFileSync(file, 'export const version = 101; // precious\n');
    const reset = executeOf(createGitResetTool(root));
    const result = await reset({ directory: '.', mode: 'hard' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('CONFIRM_REQUIRED');
    expect(String(result.error)).toContain('app.ts');
    expect(fs.readFileSync(file, 'utf-8')).toContain('precious');
    expect(git(root, ['status', '--porcelain']).trim()).toBe('M app.ts');
  });

  it('performs the hard reset once confirmed', async () => {
    const reset = executeOf(createGitResetTool(root));
    const result = await reset({ directory: '.', mode: 'hard', confirmDestructive: true });
    expect(result.success).toBe(true);
    expect(result.discarded).toEqual([' M app.ts']);
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    git(root, ['checkout', '-q', 'main']);
    git(root, ['branch', '-q', '-D', 'feature/hard-reset']);
  });
});

suite('Phase 42 — git_push (to a local bare remote)', () => {
  it('refuses to push a protected branch', async () => {
    const push = executeOf(createGitPushTool(root));
    const result = await push({ directory: '.', remote: 'origin', branch: 'main' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_BRANCH');
    expect(String(result.error)).toContain('pull request');
    // The bare remote is still empty: the refusal happened before git ran.
    expect(git(bare, ['rev-list', '--all', '--count']).trim()).toBe('0');
  });

  it('pushes a feature branch and the remote receives it', async () => {
    git(root, ['checkout', '-q', '-b', 'feature/push-me']);
    fs.writeFileSync(path.join(root, 'pushed.txt'), 'pushed\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'a commit worth pushing']);

    const push = executeOf(createGitPushTool(root));
    const result = await push({ directory: '.', remote: 'origin', setUpstream: true });
    expect(result.success).toBe(true);
    expect(result.branch).toBe('feature/push-me');
    expect(git(bare, ['rev-parse', '--abbrev-ref', 'feature/push-me']).trim()).toBe(
      'feature/push-me'
    );
    expect(git(bare, ['log', '-1', '--pretty=%s', 'feature/push-me']).trim()).toBe(
      'a commit worth pushing'
    );
  });

  it('refuses an unknown remote with a readable code', async () => {
    const push = executeOf(createGitPushTool(root));
    const result = await push({ directory: '.', remote: 'nowhere', branch: 'feature/push-me' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
    expect(String(result.error)).toContain('git_remote_list');
  });

  it('refuses a remote or branch that looks like an option', async () => {
    const push = executeOf(createGitPushTool(root));
    expect((await push({ directory: '.', remote: '--upload-pack=/bin/sh' })).code).toBe(
      'BAD_ARGUMENT'
    );
    expect((await push({ directory: '.', branch: '--force' })).code).toBe('BAD_ARGUMENT');
  });

  it('rejects R0-01 refspec-smuggling branch names before running git', async () => {
    const push = executeOf(createGitPushTool(root));
    for (const branch of ['+feat:main', ':main', 'feat:main', 'main^', 'main~1', 'a..b']) {
      const result = await push({ directory: '.', remote: 'origin', branch });
      expect(result.success, `branch "${branch}" must be rejected`).toBe(false);
      expect(result.code, `branch "${branch}" must be rejected`).toBe('BAD_ARGUMENT');
    }
    // main was never created on the remote via a smuggled refspec.
    expect(git(bare, ['branch', '--list', 'main']).trim()).toBe('');
  });

  it('a rejected push stays rejected: there is no force to reach for', async () => {
    // Rewriting the pushed commit makes the local branch diverge from the
    // remote, which is exactly the case a force flag would "solve".
    git(root, ['commit', '-q', '--amend', '-m', 'rewritten after pushing']);
    const push = executeOf(createGitPushTool(root));
    const result = await push({ directory: '.', remote: 'origin', branch: 'feature/push-me' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('GIT_FAILED');
    expect(String(result.error)).toMatch(/rejected|non-fast-forward|fetch first/i);
    // The remote still has the original commit: nothing was overwritten.
    expect(git(bare, ['log', '-1', '--pretty=%s', 'feature/push-me']).trim()).toBe(
      'a commit worth pushing'
    );
    git(root, ['checkout', '-q', 'main']);
  });
});

suite('Phase 42 — git_stash', () => {
  it('pushes, lists and pops work', async () => {
    const stash = executeOf(createGitStashTool(root));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const version = 7; // stashed\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');

    const pushed = await stash({
      directory: '.',
      action: 'push',
      message: 'wip',
      includeUntracked: true,
    });
    expect(pushed.success).toBe(true);
    expect((pushed.stashes as string[])[0]).toContain('wip');
    // The tree is clean and the untracked file is gone from it.
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    expect(fs.existsSync(path.join(root, 'untracked.txt'))).toBe(false);

    const listed = await stash({ directory: '.', action: 'list' });
    expect((listed.stashes as string[]).length).toBe(1);

    const popped = await stash({ directory: '.', action: 'pop' });
    expect(popped.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf-8')).toContain('stashed');
    expect(fs.existsSync(path.join(root, 'untracked.txt'))).toBe(true);
    git(root, ['checkout', '-q', '--', 'app.ts']);
    fs.rmSync(path.join(root, 'untracked.txt'));
  });

  it('refuses to stash a clean tree with NOTHING_TO_STASH', async () => {
    const stash = executeOf(createGitStashTool(root));
    const result = await stash({ directory: '.', action: 'push' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOTHING_TO_STASH');
  });

  it('gates drop behind confirmDestructive and keeps the stash when refused', async () => {
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const version = 8; // keep me\n');
    const stash = executeOf(createGitStashTool(root));
    await stash({ directory: '.', action: 'push', message: 'keep this' });

    const refused = await stash({ directory: '.', action: 'drop' });
    expect(refused.success).toBe(false);
    expect(refused.code).toBe('CONFIRM_REQUIRED');
    expect((refused.stashes as string[]).length).toBe(1);

    const dropped = await stash({ directory: '.', action: 'drop', confirmDestructive: true });
    expect(dropped.success).toBe(true);
    expect((dropped.stashes as string[]).length).toBe(0);
  });
});

// ─── PR tools: injected backends, no network ─────────────────────

interface GhCall {
  args: string[];
}

/** A `gh` that answers the four subcommands the tools use. */
function fakeGh(calls: GhCall[], options: { loggedOut?: boolean } = {}) {
  return async (
    args: readonly string[]
  ): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
    calls.push({ args: [...args] });
    if (args[0] === '--version')
      return { ok: true, stdout: 'gh version 2.40.0\n', stderr: '', code: 0 };
    if (options.loggedOut) {
      return {
        ok: false,
        stdout: '',
        stderr: 'gh: To get started with GitHub CLI, run: gh auth login',
        code: 4,
      };
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const title = args[args.indexOf('--title') + 1];
      return { ok: true, stdout: `https://github.com/acme/widgets/pull/42\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        ok: true,
        stdout: JSON.stringify({
          number: 42,
          title: 'Guarded write support',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          isDraft: false,
          author: { login: 'octocat' },
          headRefName: 'feature/push-me',
          baseRefName: 'main',
          createdAt: '2026-09-25T00:00:00Z',
          updatedAt: '2026-09-25T00:00:00Z',
          body: 'Body text',
        }),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Guarded write support',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            isDraft: false,
            author: { login: 'octocat' },
            headRefName: 'feature/push-me',
            baseRefName: 'main',
          },
        ]),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      return {
        ok: true,
        stdout: 'https://github.com/acme/widgets/pull/42#issuecomment-1\n',
        stderr: '',
        code: 0,
      };
    }
    return { ok: false, stdout: '', stderr: `unknown gh invocation: ${args.join(' ')}`, code: 1 };
  };
}

function githubRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hootl-${name}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'phase42@example.com']);
  git(dir, ['config', 'user.name', 'Phase 42']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  return dir;
}

suite('Phase 42 — pull requests (gh backend)', () => {
  const calls: GhCall[] = [];
  let repo = '';

  beforeAll(() => {
    if (!hasGit) return;
    repo = githubRepo('pr-gh');
    calls.length = 0;
  });
  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('parses the GitHub remote shapes git actually stores', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toMatchObject({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
      apiBase: 'https://api.github.com',
    });
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
    });
    expect(parseRemoteUrl('ssh://git@github.com/acme/widgets')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
    });
    expect(parseRemoteUrl('https://git.example.com/acme/widgets.git')).toMatchObject({
      host: 'git.example.com',
      apiBase: 'https://git.example.com/api/v3',
    });
    expect(parseRemoteUrl('/tmp/some/bare.git')).toBeUndefined();
    expect(parseRemoteUrl('https://github.com/onlyowner')).toBeUndefined();
  });

  it('creates a PR through gh and reports the created pull request', async () => {
    const tool = executeOf(createGitPrCreateTool(repo, { runGh: fakeGh(calls) }));
    const result = await tool({
      directory: '.',
      title: 'Guarded write support',
      body: 'What it does.',
    });
    expect(result.success).toBe(true);
    expect(result.backend).toBe('gh');
    expect((result.pr as Record<string, unknown>).number).toBe(42);
    expect(result.url).toBe('https://github.com/acme/widgets/pull/42');
    const createCall = calls.find((call) => call.args[1] === 'create');
    expect(createCall?.args).toEqual(
      expect.arrayContaining([
        'pr',
        'create',
        '--title',
        'Guarded write support',
        '--body',
        'What it does.',
      ])
    );
  });

  it('lists PRs with the fields a model needs', async () => {
    const tool = executeOf(createGitPrListTool(repo, { runGh: fakeGh(calls) }));
    const result = await tool({ directory: '.', state: 'open', limit: 5 });
    expect(result.success).toBe(true);
    const pulls = result.pulls as Array<Record<string, unknown>>;
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      number: 42,
      state: 'open',
      head: 'feature/push-me',
      base: 'main',
      author: 'octocat',
    });
    expect(pulls[0]!.draft).toBe(false);
  });

  it('views one PR and comments on it', async () => {
    const view = executeOf(createGitPrViewTool(repo, { runGh: fakeGh(calls) }));
    const viewed = await view({ directory: '.', number: 42 });
    expect(viewed.success).toBe(true);
    expect((viewed.pr as Record<string, unknown>).title).toBe('Guarded write support');
    expect((viewed.pr as Record<string, unknown>).body).toBe('Body text');

    const comment = executeOf(createGitPrCommentTool(repo, { runGh: fakeGh(calls) }));
    const commented = await comment({ directory: '.', number: 42, body: 'Ran the suite: green.' });
    expect(commented.success).toBe(true);
    expect(String(commented.output)).toContain('issuecomment');
  });

  it('reports gh-not-authenticated as PR_UNAVAILABLE with instructions', async () => {
    const tool = executeOf(
      createGitPrListTool(repo, { runGh: fakeGh(calls, { loggedOut: true }) })
    );
    const result = await tool({ directory: '.', state: 'open', limit: 5 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PR_UNAVAILABLE');
    expect(String(result.error)).toContain('gh auth login');
  });
});

suite('Phase 42 — pull requests (REST backend and refusals)', () => {
  let repo = '';

  beforeAll(() => {
    if (!hasGit) return;
    repo = githubRepo('pr-rest');
  });
  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  const noGh = async (): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number;
  }> => ({
    ok: false,
    stdout: '',
    stderr: 'spawn gh ENOENT',
    code: 127,
  });

  it('falls back to the REST API with a token, and sends no more than it must', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          number: 7,
          title: 'From REST',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/7',
          draft: false,
          user: { login: 'rest-user' },
          head: { ref: 'feature/rest' },
          base: { ref: 'main' },
          created_at: '2026-09-25T00:00:00Z',
          updated_at: '2026-09-25T00:00:00Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const tool = executeOf(
      createGitPrCreateTool(repo, {
        runGh: noGh,
        fetchImpl,
        env: { GITHUB_TOKEN: 'ghp_secret_token_value' },
      })
    );
    const result = await tool({ directory: '.', title: 'From REST', body: 'body' });
    expect(result.success).toBe(true);
    expect(result.backend).toBe('rest');
    expect((result.pr as Record<string, unknown>).number).toBe(7);
    expect(seen[0]!.url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ghp_secret_token_value');
    expect(JSON.stringify(result)).not.toContain('ghp_secret_token_value');
  });

  it('answers PR_UNAVAILABLE when there is no gh and no token', async () => {
    const tool = executeOf(createGitPrListTool(repo, { runGh: noGh, env: {} }));
    const result = await tool({ directory: '.', state: 'open', limit: 5 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PR_UNAVAILABLE');
    expect(String(result.error)).toContain('GITHUB_TOKEN');
  });

  it('surfaces an API error with its status', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Validation Failed' }), {
        status: 422,
      })) as unknown as typeof fetch;
    const tool = executeOf(
      createGitPrCreateTool(repo, {
        runGh: noGh,
        fetchImpl,
        env: { GH_TOKEN: 'token' },
      })
    );
    const result = await tool({ directory: '.', title: 'Nope' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PR_FAILED');
    expect(String(result.error)).toContain('422');
    expect(String(result.error)).toContain('Validation Failed');
  });

  it('reports PR_NOT_FOUND for a 404', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    const tool = executeOf(
      createGitPrViewTool(repo, { runGh: noGh, fetchImpl, env: { GH_TOKEN: 'token' } })
    );
    const result = await tool({ directory: '.', number: 999 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PR_NOT_FOUND');
  });

  it('refuses a remote that is not GitHub-shaped, before any call', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-notgithub-'));
    try {
      git(local, ['init', '-q', '-b', 'main']);
      git(local, ['config', 'user.email', 'phase42@example.com']);
      git(local, ['config', 'user.name', 'Phase 42']);
      git(local, ['remote', 'add', 'origin', '/tmp/some/bare.git']);
      const tool = executeOf(
        createGitPrListTool(local, { runGh: noGh, env: { GH_TOKEN: 'token' } })
      );
      const result = await tool({ directory: '.', state: 'open', limit: 5 });
      expect(result.success).toBe(false);
      expect(result.code).toBe('NOT_GITHUB_REMOTE');
      expect(String(result.error)).toContain('/tmp/some/bare.git');
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
    }
  });

  it('requires a title, a body and a number where each is needed', async () => {
    const create = executeOf(
      createGitPrCreateTool(repo, { runGh: noGh, env: { GH_TOKEN: 'token' } })
    );
    expect((await create({ directory: '.', title: '   ' })).code).toBe('BAD_ARGUMENT');
    const comment = executeOf(
      createGitPrCommentTool(repo, { runGh: noGh, env: { GH_TOKEN: 'token' } })
    );
    expect((await comment({ directory: '.', number: 7, body: '  ' })).code).toBe('BAD_ARGUMENT');
    const view = executeOf(createGitPrViewTool(repo, { runGh: noGh, env: { GH_TOKEN: 'token' } }));
    expect((await view({ directory: '.', number: 0 })).code).toBe('BAD_ARGUMENT');
  });
});

/**
 * The **real** runner, with a stub `gh` on `PATH` (the plan's "stub در PATH").
 *
 * The injected runner in the suites above covers the tool logic; this one
 * covers `runGhDefault` itself: a child process started with an argument list,
 * `GH_PROMPT_DISABLED=1` in its environment, stdout read back as JSON, and a
 * non-zero exit turned into an error rather than an exception.
 *
 * POSIX only: a Windows stub would have to be a `.cmd`/`.bat`, which
 * `child_process.execFile` refuses to start without a shell — and a tool that
 * runs other programs must not ask for one.
 */
const canStubPath = process.platform !== 'win32';
const pathSuite = canStubPath ? describe : describe.skip;

pathSuite('Phase 42 — the real gh runner, with a stub on PATH', () => {
  it('runs gh with argv, reads its JSON back, and never prompts', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-ghbin-'));
    const repo = githubRepo('pr-path-stub');
    const logFile = path.join(bin, 'gh.log');
    const stub = path.join(bin, 'gh');
    try {
      // The stub records the environment variable that keeps a prompt from ever
      // appearing, plus the argument list, so the test can read what git-for-GitHub
      // actually received.
      fs.writeFileSync(
        stub,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.40.0 (hootl stub)"; exit 0; fi
echo "GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED argv=$*" >> ${JSON.stringify(logFile)}
if [ "$2" = "list" ]; then
  printf '%s\n' '[{"number":9,"title":"from the PATH stub","state":"OPEN","url":"https://github.com/acme/widgets/pull/9","isDraft":false,"author":{"login":"stub"},"headRefName":"feature/stub","baseRefName":"main"}]'
  exit 0
fi
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
`
      );
      fs.chmodSync(stub, 0o755);

      const list = executeOf(
        createGitPrListTool(repo, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
      );
      const listed = await list({ directory: '.', state: 'open', limit: 3 });
      expect(listed.success).toBe(true);
      expect(listed.backend).toBe('gh');
      const pulls = listed.pulls as Array<Record<string, unknown>>;
      expect(pulls[0]).toMatchObject({ number: 9, title: 'from the PATH stub', author: 'stub' });

      const recorded = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      expect(recorded[0]).toContain('GH_PROMPT_DISABLED=1');
      expect(recorded[0]).toContain('argv=pr list --state open --limit 3 --json');
      expect(recorded[0]).toContain('headRefName');

      // A non-zero exit from the real child becomes a structured failure.
      const view = executeOf(
        createGitPrViewTool(repo, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
      );
      const failed = await view({ directory: '.', number: 9 });
      expect(failed.success).toBe(false);
      expect(failed.code).toBe('PR_NOT_FOUND');
      expect(String(failed.error)).toContain('404');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

suite('Phase 42 — registry wiring', () => {
  const WRITE_TOOLS = [
    'git_add',
    'git_commit',
    'git_create_branch',
    'git_checkout',
    'git_reset',
    'git_push',
    'git_stash',
    'git_pr_create',
    'git_pr_list',
    'git_pr_view',
    'git_pr_comment',
  ];

  it('ships a registry entry per write/PR tool, all category git', () => {
    for (const id of WRITE_TOOLS) {
      const file = path.join(REPO_ROOT, 'registry', 'tools', `${id}.json`);
      expect(fs.existsSync(file), `${file} is missing`).toBe(true);
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(entry.id).toBe(id);
      expect(entry.category).toBe('git');
      expect(entry.source).toBe('local');
      expect(
        fs.existsSync(
          path.join(
            REPO_ROOT,
            'src',
            'ai',
            'tools',
            'implementations',
            `${entry.modulePath.replace('./implementations/', '')}.ts`
          )
        )
      ).toBe(true);
    }
  });

  it('gives coder the write set and keeps PR reads with the other personas', () => {
    const toolsOf = (persona: string): string[] =>
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'registry', 'personas', `${persona}.json`), 'utf-8')
      ).allowedTools;
    for (const id of WRITE_TOOLS) {
      expect(toolsOf('coder'), `coder is missing ${id}`).toContain(id);
    }
    for (const persona of ['architect', 'reviewer']) {
      expect(toolsOf(persona)).toContain('git_pr_view');
      expect(toolsOf(persona), `${persona} must not push`).not.toContain('git_push');
      expect(toolsOf(persona), `${persona} must not commit`).not.toContain('git_commit');
    }
  });

  it('teaches the write workflow in the git skill', () => {
    const skill = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'registry', 'skills', 'git_operations', 'skill.json'),
        'utf-8'
      )
    );
    expect(skill.version).toBe('1.2.0');
    expect(skill.tools).toEqual(
      expect.arrayContaining(['git_add', 'git_commit', 'git_push', 'git_pr_create'])
    );
    const markdown = fs.readFileSync(
      path.join(REPO_ROOT, 'registry', 'skills', 'git_operations', 'SKILL.md'),
      'utf-8'
    );
    for (const tool of [
      'git_create_branch',
      'git_commit',
      'git_push',
      'git_pr_create',
      'confirmDestructive',
    ]) {
      expect(markdown).toContain(tool);
    }
  });
});
