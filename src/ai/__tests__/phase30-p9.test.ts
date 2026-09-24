/**
 * Phase 30 / P9 — web/API readiness: the runtime directories are recreated
 * on demand.
 *
 * Bug: the file-backed stores created `.ai-runtime/<store>/` only in their
 * constructor.  A process that outlives the directory (the web server after
 * `rm -rf .ai-runtime`, a cleanup script, `git clean`) then failed EVERY
 * write with a bare `ENOENT: … .json.lock`, because `withFileLockSync` did
 * `open(lockPath, 'wx')` into a directory that no longer existed and
 * `atomicWriteFileSync` wrote its temp file into the same missing directory.
 *
 * Fix: both primitives recreate the (missing) parent directory once — the
 * lock on `ENOENT` while opening, the atomic write on `ENOENT` while
 * writing — and retry the operation.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLockSync, lockPathFor } from '../runtime/file-lock.js';
import { atomicWriteFileSync } from '../runtime/atomic-write.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { ObservabilityLogger, type LogEntry } from '../runtime/observability-logger.js';
import { installCrashGuards } from '../../server.js';
import { createPlan, type PlanStep } from '../schemas/plan.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase30-p9-'));
}

function step(id: string): PlanStep {
  return {
    id,
    description: `part ${id}`,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: 'part handled',
    status: 'pending',
  };
}

describe('Phase 30 / P9 — stores survive their directory being removed', () => {
  it('withFileLockSync recreates a directory that vanished after startup', () => {
    const root = tmpRoot();
    const dir = path.join(root, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });

    let ran = false;
    withFileLockSync(path.join(dir, 'x.json.lock'), () => {
      ran = true;
    });

    expect(ran).toBe(true);
    // The lock was released again and the directory is back.
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('withFileLockSync creates a directory tree that never existed', () => {
    const root = tmpRoot();
    const lockPath = path.join(root, 'a', 'b', 'c', 'x.json.lock');

    withFileLockSync(lockPath, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    expect(fs.existsSync(path.dirname(lockPath))).toBe(true);
  });

  it('atomicWriteFileSync recreates a directory that vanished', () => {
    const root = tmpRoot();
    const dir = path.join(root, 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'p.json');
    fs.rmSync(dir, { recursive: true, force: true });

    atomicWriteFileSync(file, '{"ok":true}');

    expect(fs.readFileSync(file, 'utf-8')).toBe('{"ok":true}');
    // No orphan temp files left behind.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('FileSessionStore keeps saving after its directory is wiped', () => {
    const dir = path.join(tmpRoot(), 'sessions');
    const store = new FileSessionStore(dir);

    // Simulate `rm -rf .ai-runtime` under a long-running process.
    fs.rmSync(dir, { recursive: true, force: true });

    const id = store.createSession('after-wipe');
    const session = store.getSession(id);

    expect(session?.label).toBe('after-wipe');
    expect(store.listSessions()).toContain(id);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('FilePlanStore keeps saving after its directory is wiped', () => {
    const dir = path.join(tmpRoot(), 'plans');
    const store = new FilePlanStore(dir);
    fs.rmSync(dir, { recursive: true, force: true });

    const plan = createPlan('survive a wipe', [step('step-1')]);
    const planId = plan.id ?? '';
    store.save(plan);

    expect(store.load(planId)?.goal).toBe('survive a wipe');
    expect(store.exists(planId)).toBe(true);
    expect(store.list()).toEqual([planId]);
  });

  it('a non-ENOENT failure still surfaces instead of looping', () => {
    const root = tmpRoot();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    // `blocker/x.json.lock` can never be opened (ENOTDIR) — the lock must
    // throw the real error, not retry forever and not silently succeed.
    let ran = false;
    expect(() => {
      withFileLockSync(path.join(blocker, 'x.json.lock'), () => {
        ran = true;
      });
    }).toThrowError(/ENOTDIR|ENOENT/);
    expect(ran).toBe(false);
  });
});

describe('Phase 30 / P9 — the observability log survives its file being removed', () => {
  it('reopens the log file instead of writing into a deleted inode', () => {
    const dir = path.join(tmpRoot(), '.ai-runtime');
    const file = path.join(dir, 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file });

    logger.log({ eventType: 'system:info', message: 'before the wipe', level: 'info' });
    expect(fs.readFileSync(file, 'utf-8')).toContain('before the wipe');

    // `rm -rf .ai-runtime` while the process is still running.
    fs.rmSync(dir, { recursive: true, force: true });

    logger.log({ eventType: 'system:info', message: 'after the wipe', level: 'info' });
    logger.close();

    // The next reader (CLI `logs`/`usage`, the web server) opens the PATH,
    // so the entry must be in that file — not in an unlinked inode.
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const messages = lines.map((l) => (JSON.parse(l) as LogEntry).message);
    expect(messages).toEqual(['after the wipe']);
  });

  it('still opens the file only once while it is untouched (PERF-04)', () => {
    const dir = path.join(tmpRoot(), '.ai-runtime');
    const file = path.join(dir, 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file });

    const spy = vi.spyOn(fs, 'openSync');
    for (let i = 0; i < 5; i++) {
      logger.log({ eventType: 'system:info', message: `entry ${i}`, level: 'info' });
    }
    const opens = spy.mock.calls.filter(([p]) => p === file).length;
    spy.mockRestore();
    logger.close();

    expect(opens).toBe(1);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(5);
  });
});

describe('Phase 30 / P9 — the dashboard survives an unhandled background rejection', () => {
  it('reports the rejection instead of letting it kill the process', async () => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    installCrashGuards(emitter, (reason) => seen.push(reason));

    emitter.emit('unhandledRejection', new Error('stream fetch aborted'));

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('stream fetch aborted');
  });
});
