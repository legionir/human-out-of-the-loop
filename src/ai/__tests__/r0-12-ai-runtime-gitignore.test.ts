/**
 * R0-12 — `.ai-runtime/` must never be picked up by a user's `git add .`.
 * The Orchestrator writes a `.gitignore` (content: `*`) into it as soon as
 * the directory is created.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../orchestrator.js';

describe('R0-12 — .ai-runtime/.gitignore', () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes .ai-runtime/.gitignore with "*" on construction', () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-12-'));
    new Orchestrator({ projectRoot });
    const gitignorePath = path.join(projectRoot, '.ai-runtime', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe('*\n');
  });

  it('`git add .` in a fresh repo stages nothing under .ai-runtime', () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-12-'));
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    new Orchestrator({ projectRoot, persistent: true });
    fs.mkdirSync(path.join(projectRoot, '.ai-runtime', 'thinking'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.ai-runtime', 'thinking', 'x.json'), '{}');
    execFileSync('git', ['add', '.'], { cwd: projectRoot });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: projectRoot,
    }).toString();
    expect(staged.includes('.ai-runtime')).toBe(false);
  });
});
