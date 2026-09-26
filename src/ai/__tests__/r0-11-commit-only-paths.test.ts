/**
 * R0-11 — `git_commit` called with `paths` must commit ONLY those paths.
 * Before the fix, `git add -- paths` followed by a plain `git commit` also
 * committed anything the user had already staged themselves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitCommitTool } from '../tools/implementations/git-commit.js';
import { gitEnv } from '../tools/git/git-runner.js';

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

suite('R0-11 — git_commit --only for explicit paths', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-11-'));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'r0-11@example.com']);
    git(root, ['config', 'user.name', 'R0-11']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("commits only the given paths, leaving the user's own staged file staged (not committed)", async () => {
    // User stages their own change first.
    fs.writeFileSync(path.join(root, 'user.txt'), 'user change\n');
    git(root, ['add', 'user.txt']);

    // Agent writes and commits ITS OWN file via `paths`.
    fs.writeFileSync(path.join(root, 'agent.txt'), 'agent change\n');
    const execute = executeOf(createGitCommitTool(root));
    const result = await execute({ message: 'agent commit', paths: ['agent.txt'] });

    expect(result.success).toBe(true);

    const committedFiles = git(root, ['show', '--stat', '--format=', '--name-only', 'HEAD'])
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toEqual(['agent.txt']);
    expect(committedFiles).not.toContain('user.txt');

    // user.txt must still be staged (not committed, not unstaged).
    const staged = git(root, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);
    expect(staged).toEqual(['user.txt']);
  });
});
