/**
 * R0-10 — when the repository root sits above the workspace (a project
 * directory nested inside a bigger checkout), git tools must not touch
 * files outside the workspace. `git_stash push` must be scoped to the
 * workspace; `git_reset --hard` must refuse outright if it would also
 * discard uncommitted changes outside the workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitStashTool } from '../tools/implementations/git-stash.js';
import { createGitResetTool } from '../tools/implementations/git-reset.js';
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

suite('R0-10 — repo root above the workspace', () => {
  let repoRoot: string;
  let workspace: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-10-'));
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'r0-10@example.com']);
    git(repoRoot, ['config', 'user.name', 'R0-10']);
    workspace = path.join(repoRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'in.txt'), 'base\n');
    fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'base\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('git_stash push does not stash a change to outside.txt', async () => {
    fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'changed outside\n');
    fs.writeFileSync(path.join(workspace, 'in.txt'), 'changed inside\n');

    const execute = executeOf(createGitStashTool(workspace));
    const result = await execute({});
    expect(result.success).toBe(true);

    // in.txt (workspace) was stashed back to its base content...
    expect(fs.readFileSync(path.join(workspace, 'in.txt'), 'utf-8').replace(/\r\n/g, '\n')).toBe(
      'base\n'
    );
    // ...but outside.txt was left exactly as the user changed it.
    expect(
      fs.readFileSync(path.join(repoRoot, 'outside.txt'), 'utf-8').replace(/\r\n/g, '\n')
    ).toBe('changed outside\n');
  });

  it('git_reset --hard refuses when it would also discard a change outside the workspace', async () => {
    git(repoRoot, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'changed outside\n');
    fs.writeFileSync(path.join(workspace, 'in.txt'), 'changed inside\n');

    const execute = executeOf(createGitResetTool(workspace));
    const result = await execute({ mode: 'hard', confirmDestructive: true });

    expect(result.success).toBe(false);
    expect(result.code).toBe('OUTSIDE_WORKSPACE');
    // Nothing was touched.
    expect(
      fs.readFileSync(path.join(repoRoot, 'outside.txt'), 'utf-8').replace(/\r\n/g, '\n')
    ).toBe('changed outside\n');
    expect(fs.readFileSync(path.join(workspace, 'in.txt'), 'utf-8').replace(/\r\n/g, '\n')).toBe(
      'changed inside\n'
    );
  });
});
