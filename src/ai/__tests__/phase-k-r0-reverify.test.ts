/**
 * K-09 — live re-verification of R0-07 / R0-09 / R0-10 after Phase D.
 * These are the same contracts as the original hardening files, re-run here
 * so a Phase K pass does not depend on remembering which suite to invoke.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../schemas/model-config.js';
import { openaiProviderFactory } from '../models/providers/openai-provider.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGitResetTool } from '../tools/implementations/git-reset.js';
import { gitEnv } from '../tools/git/git-runner.js';

type ToolExecute = (input: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

function cfg(config: ModelConfig['config']): ModelConfig {
  return { id: 'm', provider: 'openai', model: 'test-model', config };
}

describe('K-09 / R0-07 — OPENAI_API_KEY never goes to a custom baseURL', () => {
  it('throws HOTL_API_KEY when baseURL is not api.openai.com', () => {
    expect(() =>
      openaiProviderFactory.create(cfg({ baseURL: 'https://attacker.example/v1' }), {
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      }),
    ).toThrow(/HOTL_API_KEY/);
  });

  it('accepts OPENAI_API_KEY for api.openai.com', () => {
    expect(() =>
      openaiProviderFactory.create(cfg({ baseURL: 'https://api.openai.com/v1' }), {
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      }),
    ).not.toThrow();
  });
});

describe('K-09 / R0-09 — writers refuse .git and .ai-runtime', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'k09-r009-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
    fs.mkdirSync(path.join(root, '.ai-runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-runtime', 'secret'), 'orig\n');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('write_file leaves protected paths untouched', async () => {
    const execute = executeOf(createWriteFileTool(root));
    const git = await execute({ filePath: '.git/config', content: 'evil', overwrite: true });
    const runtime = await execute({ filePath: '.ai-runtime/secret', content: 'forged', overwrite: true });
    expect(git.success).toBe(false);
    expect(runtime.success).toBe(false);
    expect(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(fs.readFileSync(path.join(root, '.ai-runtime', 'secret'), 'utf8')).toBe('orig\n');
  });
});

describe('K-09 / R0-10 — git reset will not discard files outside the workspace', () => {
  let hasGit = true;
  try {
    execFileSync('git', ['--version'], { env: gitEnv(), stdio: 'ignore' });
  } catch {
    hasGit = false;
  }
  const suite = hasGit ? it : it.skip;

  suite('refuses --hard when the repo root is above the workspace', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k09-r010-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repoRoot, env: gitEnv(), encoding: 'utf-8' });
    try {
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'k09@example.com']);
      git(['config', 'user.name', 'K09']);
      const workspace = path.join(repoRoot, 'workspace');
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'in.txt'), 'base\n');
      fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'initial']);
      git(['checkout', '-q', '-b', 'feature']);
      fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'dirty-outside\n');
      fs.writeFileSync(path.join(workspace, 'in.txt'), 'dirty-inside\n');
      const execute = executeOf(createGitResetTool(workspace));
      const result = await execute({ mode: 'hard', confirmDestructive: true });
      expect(result.success).toBe(false);
      expect(fs.readFileSync(path.join(repoRoot, 'outside.txt'), 'utf8')).toBe('dirty-outside\n');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
