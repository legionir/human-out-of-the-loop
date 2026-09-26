/**
 * R0-09 — filesystem writing tools must refuse any path under `.git/` or
 * `.ai-runtime/`. A write to `.git/config` or `.git/hooks/pre-commit`
 * turns a later read-only `git_status`/`git_commit` call into arbitrary
 * command execution; a write under `.ai-runtime/` forges the audit trail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createEditFileTool } from '../tools/implementations/edit-file.js';
import { createMoveFileTool } from '../tools/implementations/move-file.js';
import { createWriteMultipleFilesTool } from '../tools/implementations/write-multiple-files.js';

type ToolExecute = (input: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

describe('R0-09 — protected paths (.git, .ai-runtime)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-09-'));
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.git', 'config'), '[core]\n');
    fs.mkdirSync(path.join(projectRoot, '.ai-runtime', 'journal'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.ai-runtime', 'journal', 'x.jsonl'), 'orig\n');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('write_file refuses .git/config and leaves it unchanged', async () => {
    const before = fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf-8');
    const execute = executeOf(createWriteFileTool(projectRoot));
    const result = await execute({ filePath: '.git/config', content: 'core.fsmonitor=evil', overwrite: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_PATH');
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf-8')).toBe(before);
  });

  it('write_file refuses .ai-runtime/journal/x.jsonl and leaves it unchanged', async () => {
    const before = fs.readFileSync(path.join(projectRoot, '.ai-runtime', 'journal', 'x.jsonl'), 'utf-8');
    const execute = executeOf(createWriteFileTool(projectRoot));
    const result = await execute({
      filePath: '.ai-runtime/journal/x.jsonl',
      content: 'forged\n',
      overwrite: true,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_PATH');
    expect(fs.readFileSync(path.join(projectRoot, '.ai-runtime', 'journal', 'x.jsonl'), 'utf-8')).toBe(
      before
    );
  });

  it('edit_file refuses an edit inside .git', async () => {
    const before = fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf-8');
    const execute = executeOf(createEditFileTool(projectRoot));
    const result = await execute({
      path: '.git/config',
      edits: [{ oldText: '[core]', newText: '[core]\nfsmonitor=evil' }],
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_PATH');
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf-8')).toBe(before);
  });

  it('move_file refuses a destination inside .git', async () => {
    fs.writeFileSync(path.join(projectRoot, 'payload.txt'), 'x');
    const execute = executeOf(createMoveFileTool(projectRoot));
    const result = await execute({ source: 'payload.txt', destination: '.git/hooks/pre-commit' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_PATH');
    expect(fs.existsSync(path.join(projectRoot, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'payload.txt'))).toBe(true);
  });

  it('move_file refuses a source inside .ai-runtime', async () => {
    const execute = executeOf(createMoveFileTool(projectRoot));
    const result = await execute({
      source: '.ai-runtime/journal/x.jsonl',
      destination: 'stolen.jsonl',
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROTECTED_PATH');
    expect(fs.existsSync(path.join(projectRoot, 'stolen.jsonl'))).toBe(false);
  });

  it('write_multiple_files refuses the protected entry and reports it, without touching disk', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(projectRoot));
    const result = await execute({
      files: [
        { path: 'ok.txt', content: 'fine' },
        { path: '.git/config', content: 'evil' },
      ],
      overwrite: true,
    });
    expect(fs.existsSync(path.join(projectRoot, '.git', 'config'))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf-8')).toBe('[core]\n');
    const errors = result.errors as Array<{ path: string; code: string }> | undefined;
    expect(errors?.some((e) => e.path === '.git/config' && e.code === 'PROTECTED_PATH')).toBe(true);
  });
});
