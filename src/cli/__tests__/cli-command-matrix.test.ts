/**
 * Every read-only CLI command runs end to end on a fresh project: exit code 0
 * and a recognisable output, plus the "unknown id" error path of the
 * show/cancel commands.  No model is called.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../cli.js';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void chunks.push(a.join(' ') + '\n'));
  const errLogSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void chunks.push(a.join(' ') + '\n'));
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'hootl', ...args]);
    return { code: code ?? process.exitCode ?? 0, out: chunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
    errLogSpy.mockRestore();
    process.exitCode = prev;
  }
}

let project: string;
let home: HomeHandle;

beforeAll(() => {
  home = useIsolatedHome();
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-matrix-'));
  fs.cpSync(path.join(REPO_ROOT, 'registry'), path.join(project, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
  home.restore();
});

describe('CLI command matrix (read-only commands)', () => {
  const cases: Array<[string[], RegExp]> = [
    [['models'], /gpt-4o/],
    [['personas'], /coder/i],
    [['skills'], /\S/],
    [['tools'], /read_file/],
    [['mcp', 'list'], /\S/],
    [['sessions', 'list'], /\S|^$/],
    [['plans', 'list'], /\S|^$/],
    [['usage'], /\S|^$/],
    [['usage', '--json'], /"totals"/],
    [['tasks', 'list'], /\S|^$/],
    [['journal'], /\S|^$/],
    [['logs'], /\S|^$/],
    [['index'], /\S/],
  ];
  for (const [args, pattern] of cases) {
    it(`hootl ${args.join(' ')}`, async () => {
      const { code, out } = await runCli([...args, '--project-root', project]);
      expect(code, out).toBe(0);
      expect(out).toMatch(pattern);
    });
  }

  const unknown: string[][] = [
    ['plans', 'show', 'plan_does-not-exist'],
    ['plans', 'cancel', 'plan_does-not-exist'],
    ['sessions', 'show', 'session_does-not-exist'],
    ['tasks', 'show', 'task_does-not-exist'],
  ];
  for (const args of unknown) {
    it(`hootl ${args.join(' ')} fails cleanly for an unknown id`, async () => {
      const { code } = await runCli([...args, '--project-root', project]);
      expect(code).not.toBe(0);
    });
  }
});
