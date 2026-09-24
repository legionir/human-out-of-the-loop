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
import { EventBus, type AgentEvent } from '../runtime/event-bus.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { createPlan, type Plan } from '../schemas/plan.js';

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


// ─── PERF-06: store list() index ──────────────────────────────────

describe('PERF-06: store list() only parses unseen files', () => {
  let dir = '';
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** Counts real readFileSync calls inside the store directory. */
  function instrumentReads(): { count: () => number } {
    const real = fsSync.readFileSync.bind(fsSync);
    let n = 0;
    const spy = vi.spyOn(fsSync, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p).startsWith(dir)) n++;
      return (real as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    spies.push(spy);
    return { count: () => n };
  }

  function makePlan(i: number): Plan {
    // Deterministic id so assertions can name the expectations.
    const plan = createPlan(`goal ${i}`, [
      {
        id: `step-${i}`,
        description: `do ${i}`,
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: `done ${i}`,
      },
    ]);
    plan.id = `plan_phase27_${i}`;
    return plan;
  }

  it('a fresh instance reads each file once; warm lists read zero; new files read once', () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-perf06-'));
    const writer = new FilePlanStore(dir);
    for (let i = 0; i < 5; i++) writer.save(makePlan(i));

    // A FRESH instance (e.g. a restarted process) has a cold index.
    const store = new FilePlanStore(dir);
    const reads = instrumentReads();

    expect(store.list().sort()).toEqual([
      'plan_phase27_0',
      'plan_phase27_1',
      'plan_phase27_2',
      'plan_phase27_3',
      'plan_phase27_4',
    ]);
    const cold = reads.count();
    expect(cold).toBe(5);

    // Warm: no file is re-read at all — 20 calls, zero reads.
    for (let i = 0; i < 20; i++) store.list();
    expect(reads.count()).toBe(cold);

    // A plan written by ANOTHER instance costs exactly one parse.
    writer.save(makePlan(9));
    expect(store.list()).toContain('plan_phase27_9');
    expect(reads.count()).toBe(cold + 1);

    // …and our own writes warm the index (no read on the next list).
    store.save(makePlan(10));
    expect(store.list()).toContain('plan_phase27_10');
    expect(reads.count()).toBe(cold + 1);
  });

  it('picks up files written by another store/process and forgets deleted ones', () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-perf06b-'));
    const store = new FilePlanStore(dir);
    store.save(makePlan(1));
    expect(store.list()).toEqual(['plan_phase27_1']);

    // Another process (a second store instance) writes a plan.
    const other = new FilePlanStore(dir);
    other.save(makePlan(2));
    expect(store.list().sort()).toEqual(['plan_phase27_1', 'plan_phase27_2']);

    // …and deletes one behind our back.
    other.delete('plan_phase27_1');
    expect(store.list()).toEqual(['plan_phase27_2']);

    // Our own delete is reflected immediately too.
    store.delete('plan_phase27_2');
    expect(store.list()).toEqual([]);
  });

  it('session store behaves the same way', () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase27-perf06c-'));
    const writer = new FileSessionStore(dir);
    const ids = [writer.createSession(), writer.createSession(), writer.createSession()];

    // Fresh instance → cold index → one parse per file, then zero.
    const store = new FileSessionStore(dir);
    const reads = instrumentReads();
    expect(store.listSessions().sort()).toEqual([...ids].sort());
    const cold = reads.count();
    expect(cold).toBe(3);

    store.listSessions();
    store.listSessions();
    expect(reads.count()).toBe(cold);

    store.deleteSession(ids[0]);
    expect(store.listSessions().sort()).toEqual([ids[1], ids[2]].sort());
  });
});

// ---------------------------------------------------------------------------
// PERF-08 — EventBus.emit must not allocate a Set per emit
// ---------------------------------------------------------------------------

describe('PERF-08: EventBus emit allocation', () => {
  it('reuses one dedup buffer for every non-nested emit', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('*', (e) => seen.push(`wild:${e.type}`));
    bus.subscribe('step-start', (e) => seen.push(`typed:${e.type}`));

    for (let i = 0; i < 1000; i++) {
      bus.emit({ type: 'step-start', stepId: `s${i}` } as AgentEvent);
    }

    expect(seen).toHaveLength(2000);
    // 1000 emits → still exactly one buffer.
    expect(bus.emitBufferCount).toBe(1);
  });

  it('still deduplicates a subscriber registered for both type and *', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const both = () => calls.push('both');
    bus.subscribe('step-start', both);
    bus.subscribe('*', both);

    bus.emit({ type: 'step-start', stepId: 's1' } as AgentEvent);
    expect(calls).toEqual(['both']);
  });

  it('keeps every subscriber when only one of the two sets is populated', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.subscribe('step-start', () => calls.push('typed-1'));
    bus.subscribe('step-start', () => calls.push('typed-2'));
    bus.emit({ type: 'step-start', stepId: 's1' } as AgentEvent);
    expect(calls.sort()).toEqual(['typed-1', 'typed-2']);

    const bus2 = new EventBus();
    const wild: string[] = [];
    bus2.subscribe('*', () => wild.push('w1'));
    bus2.subscribe('*', () => wild.push('w2'));
    bus2.emit({ type: 'step-complete', stepId: 's1' } as AgentEvent);
    expect(wild.sort()).toEqual(['w1', 'w2']);
  });

  it('survives a re-entrant emit without losing subscribers', () => {
    const bus = new EventBus();
    const outer: string[] = [];
    const inner: string[] = [];
    bus.subscribe('*', (e) => {
      if (e.type === 'step-start') {
        outer.push('outer');
        // A handler that emits: must use a different buffer, otherwise
        // the outer iteration would be clobbered mid-flight.
        bus.emit({ type: 'step-complete', stepId: 'nested' } as AgentEvent);
      } else {
        inner.push('inner');
      }
    });
    bus.subscribe('step-start', () => outer.push('outer-typed'));
    // The nested event hits BOTH sets → it needs its own dedup buffer.
    bus.subscribe('step-complete', () => inner.push('inner-typed'));

    bus.emit({ type: 'step-start', stepId: 's1' } as AgentEvent);
    // The outer iteration was not clobbered by the nested emit.
    expect(outer.sort()).toEqual(['outer', 'outer-typed']);
    expect(inner.sort()).toEqual(['inner', 'inner-typed']);
    // depth 0 + depth 1 buffers were retained, nothing lost.
    expect(bus.emitBufferCount).toBe(2);

    // Depth tracking unwound — a later emit reuses the depth-0 buffer.
    bus.emit({ type: 'step-complete', stepId: 's2' } as AgentEvent);
    expect(bus.emitBufferCount).toBe(2);
    expect(inner.sort()).toEqual(['inner', 'inner', 'inner-typed', 'inner-typed']);
  });
});
