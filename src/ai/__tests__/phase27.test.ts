/**
 * Phase 27 — residual P2 closure (EXECUTION_PLAN_V2 §"موارد باقی‌مانده").
 *
 *   SEC-02   search_code reports unreadable files/directories instead of
 *            skipping them silently
 *   PERF-06  store `list()` uses an id index — only NEW files are parsed
 *   PERF-08  EventBus reuses its emit buffer (no per-emit Set allocation)
 *   CFG-08   env injection: providers + MCP connector read an injected env
 *   PERS-04  cross-process file locking around store writes
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fsSync from 'node:fs';
import fsP from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { createSearchCodeTool } from '../tools/implementations/search-code.js';

// ─── SEC-02: unreadable paths are reported ────────────────────────

describe('SEC-02: search_code reports skipped paths (no silent skip)', () => {
  let dir = '';
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function makeDirent(name: string, isDir: boolean): import('node:fs').Dirent {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    } as import('node:fs').Dirent;
  }

  it('reports unreadable files with path/kind/error and an exact count', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-sec02-'));
    fsSync.writeFileSync(path.join(dir, 'ok.ts'), 'HIT here\n');
    // The files exist on disk; the spy makes reading them fail.
    fsSync.writeFileSync(path.join(dir, 'secret.ts'), 'secret\n');
    fsSync.writeFileSync(path.join(dir, 'broken.ts'), 'broken\n');

    const realReadFile = fsP.readFile.bind(fsP);
    // Deterministic "unreadable": EACCES for one file, a generic failure
    // for another (binary-ish read errors look like this in practice).
    const readFileSpy = vi
      .spyOn(fsP, 'readFile')
      .mockImplementation(((p: unknown, ...rest: unknown[]) => {
        const name = path.basename(String(p));
        if (name === 'secret.ts') {
          const err = new Error('EACCES: permission denied, open …/secret.ts');
          throw err;
        }
        if (name === 'broken.ts') throw new Error('EIO: i/o error');
        return (realReadFile as unknown as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as never);
    spies.push(readFileSpy);

    const tool = createSearchCodeTool(dir);
    const out = (await (
      tool as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ pattern: 'HIT', directory: dir, maxResults: 10 }, {})) as {
      success: boolean;
      totalMatches: number;
      skippedCount: number;
      skipped: Array<{ path: string; kind: string; error: string }>;
    };

    expect(out.success).toBe(true);
    expect(out.totalMatches).toBe(1);
    expect(out.skippedCount).toBe(2);
    const byPath = Object.fromEntries(out.skipped.map((s) => [s.path, s]));
    expect(byPath['secret.ts']).toMatchObject({ kind: 'file' });
    expect(byPath['secret.ts'].error).toContain('EACCES');
    expect(byPath['broken.ts'].error).toContain('EIO');
  });

  it('reports unreadable directories and caps the reported list while keeping the count', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-sec02b-'));

    const realReaddir = fsP.readdir.bind(fsP);
    const many = Array.from({ length: 30 }, (_, i) => makeDirent(`f${i}.ts`, false));
    const readdirSpy = vi
      .spyOn(fsP, 'readdir')
      .mockImplementation(((p: unknown, ...rest: unknown[]) => {
        const d = String(p);
        if (d === dir) {
          return Promise.resolve([makeDirent('locked', true), ...many]);
        }
        if (d.endsWith('locked')) throw new Error('EACCES: permission denied, scandir');
        return (realReaddir as unknown as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as never);
    const readFileSpy = vi
      .spyOn(fsP, 'readFile')
      .mockImplementation((() => Promise.reject(new Error('EACCES: permission denied'))) as never);
    spies.push(readdirSpy, readFileSpy);

    const tool = createSearchCodeTool(dir);
    const out = (await (
      tool as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ pattern: 'HIT', directory: dir, maxResults: 10 }, {})) as {
      skippedCount: number;
      skipped: Array<{ path: string; kind: string }>;
    };

    // 1 unreadable directory + 30 unreadable files
    expect(out.skippedCount).toBe(31);
    expect(out.skipped).toHaveLength(20); // capped payload
    expect(out.skipped[0]).toMatchObject({ path: 'locked', kind: 'directory' });
  });

  it('a clean tree reports zero skips (regression)', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-sec02c-'));
    fsSync.writeFileSync(path.join(dir, 'a.ts'), 'HIT\n');

    const tool = createSearchCodeTool(dir);
    const out = (await (
      tool as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ pattern: 'HIT', directory: dir }, {})) as {
      skippedCount: number;
      skipped: unknown[];
    };

    expect(out.skippedCount).toBe(0);
    expect(out.skipped).toEqual([]);
  });
});
