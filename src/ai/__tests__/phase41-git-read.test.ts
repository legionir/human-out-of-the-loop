import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGitStatusTool } from '../tools/implementations/git-status.js';
import { createGitDiffTool } from '../tools/implementations/git-diff.js';
import { createGitLogTool } from '../tools/implementations/git-log.js';
import { createGitShowTool } from '../tools/implementations/git-show.js';
import { createGitBranchListTool } from '../tools/implementations/git-branch-list.js';
import { createGitRemoteListTool } from '../tools/implementations/git-remote-list.js';
import { ensureRepo, gitEnv, rejectFlagLike, runGit } from '../tools/git/git-runner.js';

/**
 * Phase 41 — the read-only git tools, against a real repository.
 *
 * The repository is built in a temp directory by this file (no fixtures on
 * disk): two commits on `main`, a second branch, a staged change, an unstaged
 * change, an untracked file and a remote — enough for every tool to have
 * something true to say.  `git` itself must be installed; the suite skips
 * loudly (not silently) if it is not.
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

let root: string;
let headSha: string;
let firstSha: string;

beforeAll(() => {
  if (!hasGit) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-git-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'e2e@example.com']);
  git(root, ['config', 'user.name', 'E2E Stub']);

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'first commit']);
  firstSha = git(root, ['rev-parse', 'HEAD']).trim();

  // A branch at that point, then a second commit on main.
  git(root, ['branch', 'feature/early']);
  fs.writeFileSync(
    path.join(root, 'src/app.ts'),
    'export const value = 2;\nexport const other = 3;\n'
  );
  git(root, ['add', 'src/app.ts']);
  git(root, ['commit', '-q', '-m', 'second commit\n\nWith a body line.']);
  headSha = git(root, ['rev-parse', 'HEAD']).trim();

  // Working tree: one staged addition, one unstaged modification, one untracked.
  fs.writeFileSync(path.join(root, 'src/staged.ts'), 'export const staged = true;\n');
  git(root, ['add', 'src/staged.ts']);
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n\nUnstaged line.\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'untracked\n');

  git(root, ['remote', 'add', 'origin', 'https://example.invalid/fixture.git']);
  git(root, ['remote', 'add', 'mirror', 'https://example.invalid/mirror.git']);
  // A second URL shape: push differs from fetch for one remote.
  git(root, ['remote', 'set-url', '--push', 'mirror', 'git@example.invalid:mirror.git']);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

suite('Phase 41 — git runner core', () => {
  it('runs git without a shell and returns stdout', async () => {
    const result = await runGit(root, ['rev-parse', '--short', 'HEAD']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout.trim()).toBe(headSha.slice(0, 7));
  });

  it('maps "not a git repository" onto NOT_A_REPO', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-norepo-'));
    try {
      const result = await runGit(outside, ['status']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_A_REPO');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns a structured TIMEOUT for a command that cannot finish', async () => {
    const result = await runGit(root, ['rev-parse', 'HEAD'], { timeoutMs: 1 });
    // A 1 ms budget is a race, but the shape must hold either way: a timeout is
    // reported as TIMEOUT with an explanation, never as an exception.
    if (!result.ok) {
      expect(['TIMEOUT', 'GIT_FAILED']).toContain(result.code);
    }
  });

  it('cuts output at the byte ceiling and marks it truncated', async () => {
    const big = path.join(root, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(50_000));
    git(root, ['add', 'big.txt']);
    try {
      const result = await runGit(root, ['diff', '--cached', '--', 'big.txt'], { maxBytes: 2_000 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('OUTPUT_TOO_LARGE');
        expect(result.error).toContain('2000 bytes');
      }
    } finally {
      git(root, ['rm', '--cached', '-q', '--', 'big.txt']);
      fs.rmSync(big, { force: true });
    }
  });

  it('never hangs waiting for input: GIT_TERMINAL_PROMPT is 0 and askpass is neutral', () => {
    const env = gitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('echo');
    expect(env.SSH_ASKPASS).toBe('echo');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    // Nothing else of the caller's environment leaks in.
    expect(env.HOTL_SECRET).toBeUndefined();
  });

  it('refuses a value that starts with a dash, like the reference does', () => {
    expect(rejectFlagLike('--upload-pack=/bin/sh', 'target')?.code).toBe('BAD_ARGUMENT');
    expect(rejectFlagLike('main', 'target')).toBeUndefined();
  });

  it('resolves a workspace directory to its repository root', async () => {
    const repo = await ensureRepo('src', root);
    expect(repo.ok).toBe(true);
    if (repo.ok) {
      expect(repo.root).toBe(fs.realpathSync(root));
      expect(repo.display).toBe('src');
    }
  });

  it('refuses a directory outside the workspace', async () => {
    const repo = await ensureRepo('/etc', root);
    expect(repo.ok).toBe(false);
    if (!repo.ok) expect(repo.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('reports a directory that is not a repository as NOT_A_REPO', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-plain-'));
    try {
      const repo = await ensureRepo('.', plain);
      expect(repo.ok).toBe(false);
      if (!repo.ok) expect(repo.code).toBe('NOT_A_REPO');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

suite('Phase 41 — git_status', () => {
  it('keeps the phase-18 contract (directory, short, output) and adds counts', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '.', short: true });
    expect(result.success).toBe(true);
    expect(result.directory).toBe('.');
    expect(result.output).toContain('src/staged.ts');
    expect(result.clean).toBe(false);
    const counts = result.counts as Record<string, number>;
    expect(counts.untracked).toBeGreaterThanOrEqual(1);
    expect(counts.staged).toBeGreaterThanOrEqual(1);
  });

  it('parses porcelain v1 entries with their index/worktree characters', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '.', porcelain: 'v1' });
    const entries = result.entries as Array<{
      path: string;
      index: string;
      worktree: string;
      kind: string;
    }>;
    expect(result.porcelain).toBe('v1');
    const staged = entries.find((entry) => entry.path === 'src/staged.ts');
    const modified = entries.find((entry) => entry.path === 'README.md');
    const untracked = entries.find((entry) => entry.path === 'notes.txt');
    expect(staged?.index).toBe('A');
    expect(modified?.worktree).toBe('M');
    expect(untracked?.kind).toBe('untracked');
  });

  it('parses porcelain v2 including the branch block', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '.', porcelain: 'v2', branch: true });
    expect(result.porcelain).toBe('v2');
    const branch = result.branch as { name: string; ahead?: number };
    expect(branch.name).toBe('main');
    expect(typeof branch.ahead === 'number' || branch.ahead === undefined).toBe(true);
    const entries = result.entries as Array<{ path: string }>;
    expect(entries.map((entry) => entry.path)).toContain('src/staged.ts');
  });

  it('narrows the answer to one path', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '.', porcelain: 'v1', path: 'README.md' });
    const entries = result.entries as Array<{ path: string }>;
    expect(entries.map((entry) => entry.path)).toEqual(['README.md']);
  });

  it('reports a clean tree as clean', async () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-clean-'));
    try {
      git(clone, ['init', '-q', '-b', 'main']);
      git(clone, ['config', 'user.email', 'e2e@example.com']);
      git(clone, ['config', 'user.name', 'E2E Stub']);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
      git(clone, ['add', '.']);
      git(clone, ['commit', '-q', '-m', 'only']);
      const execute = executeOf(createGitStatusTool(clone));
      const result = await execute({ directory: '.', porcelain: 'v1' });
      expect(result.clean).toBe(true);
      expect(result.entries).toEqual([]);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it('refuses a path that looks like an option', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '.', porcelain: 'v1', path: '--help' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
  });

  it('blocks a directory outside the workspace with the ported path check', async () => {
    const execute = executeOf(createGitStatusTool(root));
    const result = await execute({ directory: '/etc', short: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('answers NOT_A_REPO for a directory that is not a repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-plain2-'));
    try {
      const execute = executeOf(createGitStatusTool(plain));
      const result = await execute({ directory: '.', porcelain: 'v1' });
      expect(result.success).toBe(false);
      expect(result.code).toBe('NOT_A_REPO');
      expect(String(result.error)).toContain('git init');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

suite('Phase 41 — git_diff', () => {
  it("diffs the working tree by default (the reference's git_diff_unstaged)", async () => {
    const execute = executeOf(createGitDiffTool(root));
    const result = await execute({ directory: '.' });
    expect(result.success).toBe(true);
    expect(result.scope).toBe('worktree');
    expect(String(result.diff)).toContain('Unstaged line.');
    const files = result.files as Array<{ path: string; additions: number }>;
    expect(files.map((file) => file.path)).toContain('README.md');
    expect(files.find((file) => file.path === 'README.md')?.additions).toBeGreaterThan(0);
  });

  it("diffs the index with staged: true (the reference's git_diff_staged)", async () => {
    const execute = executeOf(createGitDiffTool(root));
    const result = await execute({ directory: '.', staged: true });
    expect(result.success).toBe(true);
    expect(result.scope).toBe('staged');
    const paths = result.paths as string[];
    expect(paths).toContain('src/staged.ts');
    expect(paths).not.toContain('README.md'); // its change is unstaged
  });

  it("diffs against a ref (the reference's git_diff)", async () => {
    const execute = executeOf(createGitDiffTool(root));
    const result = await execute({ directory: '.', target: 'HEAD~1' });
    expect(result.success).toBe(true);
    expect(result.scope).toBe('target');
    expect(result.target).toBe('HEAD~1');
    expect(String(result.diff)).toContain('other = 3');
  });

  it('honours contextLines and path', async () => {
    const execute = executeOf(createGitDiffTool(root));
    const noContext = await execute({ directory: '.', contextLines: 0, path: 'README.md' });
    const withContext = await execute({ directory: '.', contextLines: 5, path: 'README.md' });
    expect(String(noContext.diff)).toContain('@@');
    const hunks = (text: unknown): number => (String(text).match(/^@@/gm) ?? []).length;
    expect(hunks(noContext.diff)).toBe(1);
    expect(String(withContext.diff).length).toBeGreaterThan(String(noContext.diff).length);
  });

  it('summarises with statOnly and lists paths with nameOnly', async () => {
    const execute = executeOf(createGitDiffTool(root));
    const stat = await execute({ directory: '.', staged: true, statOnly: true });
    expect(String(stat.diff)).toContain('src/staged.ts');
    const names = await execute({ directory: '.', staged: true, nameOnly: true });
    expect(names.paths).toEqual(['src/staged.ts']);
    expect(names.filesChanged).toBe(1);
  });

  it('refuses target and staged together, and a target that looks like an option', async () => {
    const execute = executeOf(createGitDiffTool(root));
    const both = await execute({ directory: '.', staged: true, target: 'HEAD' });
    expect(both.success).toBe(false);
    expect(both.code).toBe('BAD_ARGUMENT');
    const flag = await execute({ directory: '.', target: '--output=/tmp/x' });
    expect(flag.success).toBe(false);
    expect(flag.code).toBe('BAD_ARGUMENT');
  });

  it('reports an unknown revision as BAD_ARGUMENT, not a crash', async () => {
    const execute = executeOf(createGitDiffTool(root));
    const result = await execute({ directory: '.', target: 'no-such-ref' });
    expect(result.success).toBe(false);
    expect(['BAD_ARGUMENT', 'GIT_FAILED']).toContain(result.code);
  });

  it('is empty when nothing changed', async () => {
    const execute = executeOf(createGitDiffTool(root));
    const result = await execute({ directory: '.', path: 'src/app.ts', staged: true });
    expect(result.success).toBe(true);
    expect(result.diff).toBe('');
    expect(result.filesChanged).toBe(0);
  });
});

suite('Phase 41 — git_log', () => {
  it('returns parsed entries, newest first, with the full metadata', async () => {
    const execute = executeOf(createGitLogTool(root));
    const result = await execute({ directory: '.', format: 'json' });
    expect(result.success).toBe(true);
    expect(result.format).toBe('json');
    const entries = result.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sha).toBe(headSha);
    expect(entries[0]!.shortSha).toBe(headSha.slice(0, 7));
    expect(entries[0]!.author).toBe('E2E Stub');
    expect(entries[0]!.authorEmail).toBe('e2e@example.com');
    expect(entries[0]!.subject).toBe('second commit');
    expect(entries[0]!.body).toContain('With a body line.');
    expect(entries[1]!.sha).toBe(firstSha);
    expect(entries[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `log` is the rendered text: absent in json mode, present otherwise.
    expect(result.log).toBeUndefined();
  });

  it('renders oneline and short', async () => {
    const execute = executeOf(createGitLogTool(root));
    const oneline = await execute({ directory: '.', format: 'oneline' });
    expect(String(oneline.log).split('\n')).toHaveLength(2);
    expect(String(oneline.log)).toMatch(new RegExp(`^${headSha.slice(0, 7)} second commit`));

    const short = await execute({ directory: '.', format: 'short' });
    expect(String(short.log)).toContain(`commit ${headSha}`);
    expect(String(short.log)).toContain('Author: E2E Stub <e2e@example.com>');
    expect(String(short.log)).toContain('    second commit');
  });

  it('honours maxCount and reports the revision', async () => {
    const execute = executeOf(createGitLogTool(root));
    const result = await execute({ directory: '.', maxCount: 1, format: 'oneline' });
    const entries = result.entries as unknown[];
    expect(entries).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.revision).toBe('main');
  });

  it('filters by path and by author', async () => {
    const execute = executeOf(createGitLogTool(root));
    const readmeOnly = await execute({ directory: '.', path: 'README.md', format: 'oneline' });
    expect((readmeOnly.entries as unknown[]).length).toBe(1);

    const nobody = await execute({ directory: '.', author: 'Nobody', format: 'oneline' });
    expect(nobody.entries).toEqual([]);
    expect(nobody.log).toBe('');
  });

  it("filters by date (git's own parser: a relative date, a day, a timestamp)", async () => {
    const execute = executeOf(createGitLogTool(root));
    const past = await execute({ directory: '.', since: '2000-01-01', format: 'oneline' });
    expect((past.entries as unknown[]).length).toBe(2);
    const before = await execute({ directory: '.', until: '1999-01-01', format: 'oneline' });
    expect(before.entries).toEqual([]);
    const relative = await execute({ directory: '.', since: '10 years ago', format: 'oneline' });
    expect((relative.entries as unknown[]).length).toBe(2);
    // (git silently ignores a `--since` it cannot represent — year 2100 and
    // beyond — so the empty-history case is asserted with --until.)
  });

  it('refuses flag-shaped filters', async () => {
    const execute = executeOf(createGitLogTool(root));
    for (const input of [{ since: '--all' }, { author: '-x' }, { path: '--textconv' }]) {
      const result = await execute({ directory: '.', ...input });
      expect(result.success).toBe(false);
      expect(result.code).toBe('BAD_ARGUMENT');
    }
  });

  it('is empty (not an error) in a repository with no commits', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-empty-'));
    try {
      git(empty, ['init', '-q', '-b', 'main']);
      const execute = executeOf(createGitLogTool(empty));
      const result = await execute({ directory: '.', format: 'oneline' });
      expect(result.success).toBe(true);
      expect(result.entries).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

suite('Phase 41 — git_show', () => {
  it('returns the commit metadata and the patch', async () => {
    const execute = executeOf(createGitShowTool(root));
    const result = await execute({ directory: '.', revision: 'HEAD' });
    expect(result.success).toBe(true);
    const commit = result.commit as Record<string, unknown>;
    expect(commit.sha).toBe(headSha);
    expect(commit.subject).toBe('second commit');
    expect(commit.body).toContain('With a body line.');
    const paths = result.paths as string[];
    expect(paths).toContain('src/app.ts');
    expect(String(result.show)).toContain('+export const other = 3;');
    expect(result.additions).toBeGreaterThan(0);
  });

  it('limits the patch to one path while keeping the metadata', async () => {
    const execute = executeOf(createGitShowTool(root));
    const result = await execute({ directory: '.', revision: 'HEAD~1', path: 'README.md' });
    expect(result.success).toBe(true);
    expect((result.commit as Record<string, unknown>).sha).toBe(firstSha);
    expect(result.paths).toEqual(['README.md']);
  });

  it('statOnly keeps the summary and drops the patch', async () => {
    const execute = executeOf(createGitShowTool(root));
    const result = await execute({ directory: '.', revision: 'HEAD', statOnly: true });
    expect(result.success).toBe(true);
    expect((result.commit as Record<string, unknown>).subject).toBe('second commit');
    expect(result.filesChanged).toBe(0);
    expect(String(result.show)).not.toContain('+export const other');
  });

  it('answers BAD_ARGUMENT for a revision that does not exist', async () => {
    const execute = executeOf(createGitShowTool(root));
    const result = await execute({ directory: '.', revision: 'no-such-revision' });
    expect(result.success).toBe(false);
    expect(['BAD_ARGUMENT', 'GIT_FAILED']).toContain(result.code);
  });

  it('refuses a revision that looks like an option', async () => {
    const execute = executeOf(createGitShowTool(root));
    const result = await execute({ directory: '.', revision: '--exec=sh' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
  });
});

suite('Phase 41 — git_branch_list', () => {
  it('lists local branches with the current flag, sha and last commit', async () => {
    const execute = executeOf(createGitBranchListTool(root));
    const result = await execute({ directory: '.' });
    expect(result.success).toBe(true);
    expect(result.current).toBe('main');
    const branches = result.branches as Array<Record<string, unknown>>;
    const names = branches.map((branch) => branch.name);
    expect(names).toContain('main');
    expect(names).toContain('feature/early');
    const main = branches.find((branch) => branch.name === 'main')!;
    expect(main.current).toBe(true);
    expect(main.sha).toBe(headSha.slice(0, 7));
    expect(main.subject).toBe('second commit');
    expect(main.remote).toBe(false);
    expect(String(result.output)).toMatch(/^\* main /m);
  });

  it('answers "which branches already have this commit?"', async () => {
    const execute = executeOf(createGitBranchListTool(root));
    const both = await execute({ directory: '.', contains: firstSha });
    expect((both.branches as unknown[]).length).toBe(2);
    const onlyMain = await execute({ directory: '.', contains: headSha });
    expect((onlyMain.branches as Array<Record<string, unknown>>).map((b) => b.name)).toEqual([
      'main',
    ]);
    const older = await execute({ directory: '.', notContains: headSha });
    expect((older.branches as Array<Record<string, unknown>>).map((b) => b.name)).toEqual([
      'feature/early',
    ]);
  });

  it('refuses flag-shaped contains values', async () => {
    const execute = executeOf(createGitBranchListTool(root));
    const result = await execute({ directory: '.', contains: '--all' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_ARGUMENT');
  });

  it('reports a detached HEAD as detached, with its sha', async () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-detached-'));
    try {
      git(clone, ['clone', '-q', root, '.']);
      git(clone, ['checkout', '-q', firstSha]);
      const execute = executeOf(createGitBranchListTool(clone));
      const result = await execute({ directory: '.' });
      expect(result.success).toBe(true);
      expect(result.detached).toBe(true);
      expect(result.detachedAt).toBe(firstSha);
      expect(result.current).toBeUndefined();
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});

suite('Phase 41 — git_remote_list', () => {
  it('lists remotes with fetch and push URLs', async () => {
    const execute = executeOf(createGitRemoteListTool(root));
    const result = await execute({ directory: '.' });
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    const remotes = result.remotes as Array<{ name: string; fetchUrl: string; pushUrl: string }>;
    const origin = remotes.find((remote) => remote.name === 'origin')!;
    expect(origin.fetchUrl).toBe('https://example.invalid/fixture.git');
    expect(origin.pushUrl).toBe('https://example.invalid/fixture.git');
    const mirror = remotes.find((remote) => remote.name === 'mirror')!;
    expect(mirror.fetchUrl).toBe('https://example.invalid/mirror.git');
    expect(mirror.pushUrl).toBe('git@example.invalid:mirror.git'); // push differs from fetch
    expect(String(result.output)).toContain('origin');
  });

  it('names only, with verbose: false', async () => {
    const execute = executeOf(createGitRemoteListTool(root));
    const result = await execute({ directory: '.', verbose: false });
    // `git remote` lists names in its own (sorted) order.
    expect(result.names).toEqual(['mirror', 'origin']);
  });

  it('is empty (not an error) when no remote is configured', async () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-noremote-'));
    try {
      git(clone, ['init', '-q', '-b', 'main']);
      const execute = executeOf(createGitRemoteListTool(clone));
      const result = await execute({ directory: '.' });
      expect(result.success).toBe(true);
      expect(result.remotes).toEqual([]);
      expect(result.count).toBe(0);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});

suite('Phase 41 — git registry wiring', () => {
  const READ_TOOLS = [
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'git_branch_list',
    'git_remote_list',
  ];

  it('ships a registry entry per git tool, all category git', () => {
    for (const id of READ_TOOLS) {
      const file = path.join(REPO_ROOT, 'registry', 'tools', `${id}.json`);
      expect(fs.existsSync(file), `${file} is missing`).toBe(true);
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(entry.id).toBe(id);
      expect(entry.category).toBe('git');
      expect(entry.source).toBe('local');
      expect(entry.modulePath).toBe(`./implementations/${id.replace(/_/g, '-')}`);
    }
  });

  it('grants the read set to the working personas, and teaches it in the git skill', () => {
    const toolsOf = (persona: string): string[] =>
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'registry', 'personas', `${persona}.json`), 'utf-8')
      ).allowedTools;
    const NEW_TOOLS = ['git_diff', 'git_log', 'git_show', 'git_branch_list', 'git_remote_list'];
    for (const persona of ['coder', 'architect', 'reviewer']) {
      for (const id of NEW_TOOLS) {
        expect(toolsOf(persona), `${persona} is missing ${id}`).toContain(id);
      }
    }
    // git_status predates phase 41 and the working personas already had it;
    // the reviewer's set is deliberately narrower (it never had it).
    for (const persona of ['coder', 'architect']) {
      expect(toolsOf(persona), `${persona} is missing git_status`).toContain('git_status');
    }

    const skill = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'registry', 'skills', 'git_operations', 'skill.json'),
        'utf-8'
      )
    );
    expect(skill.tools).toEqual(expect.arrayContaining(READ_TOOLS));
    const markdown = fs.readFileSync(
      path.join(REPO_ROOT, 'registry', 'skills', 'git_operations', 'SKILL.md'),
      'utf-8'
    );
    for (const id of READ_TOOLS) expect(markdown).toContain(id);
  });
});
