import fs from 'node:fs';
import path from 'node:path';

/**
 * Phase 27 (PERS-04): cross-process advisory locking for file stores.
 *
 * The file-backed stores (plans, sessions) used to rely solely on
 * `atomicWriteFileSync` — a crash could never leave a torn file, but two
 * processes (e.g. the CLI and the web server sharing a project's
 * `.ai-runtime`) could still interleave a read-modify-write and lose an
 * update.  This module adds an `O_EXCL` lock file around store writes.
 *
 * Properties:
 *   - **Cross-process exclusive** — `open(lockPath, 'wx')` fails with
 *     EEXIST when another process holds the lock.
 *   - **Re-entrant in-process** — a nested `withFileLockSync` on the
 *     same path (e.g. `addInteraction` → `saveSession`) runs inline
 *     instead of deadlocking against itself.
 *   - **Self-healing** — a lock whose mtime is older than `staleMs`, or
 *     whose recorded PID is no longer alive, is treated as abandoned
 *     and taken over.
 *   - **Bounded wait** — contention is retried until `timeoutMs`, then a
 *     typed `FileLockTimeoutError` is thrown (never an infinite hang).
 */

export interface FileLockOptions {
  /** Max time to wait for a contended lock (default 5000ms). */
  timeoutMs?: number;
  /** Age after which a lock file is considered abandoned (default 10000ms). */
  staleMs?: number;
  /** Delay between acquisition attempts (default 20ms). */
  pollMs?: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_LOCK_STALE_MS = 10000;
export const DEFAULT_LOCK_POLL_MS = 20;

/** Thrown when a lock could not be acquired within `timeoutMs`. */
export class FileLockTimeoutError extends Error {
  constructor(
    readonly lockPath: string,
    readonly timeoutMs: number,
    readonly holder: LockInfo | undefined
  ) {
    super(
      `[file-lock] Timed out after ${timeoutMs}ms waiting for "${lockPath}"` +
        (holder ? ` (held by pid ${holder.pid} since ${holder.acquiredAt})` : '')
    );
    this.name = 'FileLockTimeoutError';
  }
}

/** Metadata written inside a lock file (diagnostics only). */
export interface LockInfo {
  pid: number;
  acquiredAt: number;
}

/** In-process re-entrancy bookkeeping: lockPath → nesting depth. */
const heldLocks = new Map<string, number>();

/** Synchronous sleep without a busy loop burning CPU. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** True when the process that created the lock file is still running. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read lock metadata; undefined when the file is missing/corrupt. */
export function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockInfo>;
    if (typeof raw.pid === 'number' && typeof raw.acquiredAt === 'number') {
      return { pid: raw.pid, acquiredAt: raw.acquiredAt };
    }
  } catch {
    // Missing or corrupt — the caller only uses this for reporting.
  }
  return undefined;
}

/** True when some process currently holds the lock (diagnostics/tests). */
export function isLockHeld(lockPath: string): boolean {
  return fs.existsSync(lockPath);
}

/**
 * Decide whether an existing lock file is abandoned.  A lock is stale
 * when its mtime is older than `staleMs`, or when the recorded pid is
 * gone (a crashed writer must not block the store forever).
 */
function isStaleLock(lockPath: string, staleMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between EEXIST and stat → the holder just released it.
    return true;
  }
  if (Date.now() - mtimeMs > staleMs) return true;

  const info = readLockInfo(lockPath);
  if (info && !isProcessAlive(info.pid)) return true;

  return false;
}

/** Remove a stale lock file; a concurrent remover losing the race is fine. */
function breakStaleLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore — someone else released it first
  }
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`.
 *
 * The lock file's directory is created on demand (the stores also create
 * it in their constructor, but a long-running process can outlive the
 * directory — e.g. `rm -rf .ai-runtime` while the web server is running).
 * The lock is always released — also when `fn` throws.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;

  // Re-entrant: same path already held by this process → run inline.
  const depth = heldLocks.get(lockPath);
  if (depth !== undefined) {
    heldLocks.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      const current = heldLocks.get(lockPath) ?? 1;
      if (current <= 1) heldLocks.delete(lockPath);
      else heldLocks.set(lockPath, current - 1);
    }
  }

  const startedAt = Date.now();
  let fd: number | undefined;
  let healedDir = false;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      // Phase 30 (P9): the lock directory vanished under us — recreate it
      // once and retry.  Without this, a store whose directory was removed
      // after construction fails every write with a bare ENOENT.
      if (code === 'ENOENT' && !healedDir) {
        healedDir = true;
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        continue;
      }

      if (code !== 'EEXIST') throw err;

      if (isStaleLock(lockPath, staleMs)) {
        breakStaleLock(lockPath);
        continue; // retry immediately
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new FileLockTimeoutError(lockPath, timeoutMs, readLockInfo(lockPath));
      }
      sleepSync(Math.min(pollMs, timeoutMs));
    }
  }

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
  } catch {
    // Metadata is best-effort — the lock itself is already held.
  }

  heldLocks.set(lockPath, 1);
  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore — already gone
    }
  }
}

/**
 * Convenience: the lock path used for a store file.  Keeping the suffix
 * `.lock` (not `.json`) means store `list()` never mistakes it for data.
 */
export function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

/** Directory helper so a store can create its lock directory. */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Remove leftover `*.lock` files (from crashed writers) in a directory.
 * Non-recursive; a missing directory is not an error.
 */
export function cleanupStaleLockFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const lockPath = path.join(dir, f);
    if (isStaleLock(lockPath, DEFAULT_LOCK_STALE_MS)) {
      breakStaleLock(lockPath);
      removed++;
    }
  }
  return removed;
}
