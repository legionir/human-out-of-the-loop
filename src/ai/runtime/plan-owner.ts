import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './atomic-write.js';
import { withFileLockSync } from './file-lock.js';

/**
 * B-01 — cross-process ownership of a running plan.
 *
 * A live owner file (pid + heartbeat) stops a second process from
 * `resume`ing a plan that is still executing. After the owner dies
 * (pid gone or heartbeat stale) the lock is stealable.
 */

export const PLAN_OWNER_STALE_MS = 10_000;
export const PLAN_OWNER_HEARTBEAT_MS = 2_000;

export interface PlanOwnerInfo {
  pid: number;
  heartbeatAt: number;
  planId: string;
}

export class PlanLiveOwnerError extends Error {
  readonly status = 409;
  readonly code = 'PLAN_LIVE_OWNER';
  constructor(
    readonly planId: string,
    readonly ownerPid?: number,
  ) {
    super(
      ownerPid
        ? `Plan "${planId}" is already running (pid ${ownerPid}).`
        : `Plan "${planId}" is already running.`,
    );
    this.name = 'PlanLiveOwnerError';
  }
}

export function planOwnerFilePath(plansDir: string, planId: string): string {
  const hash = createHash('sha256').update(planId).digest('hex').slice(0, 16);
  return path.join(plansDir, `${hash}.owner.json`);
}

export function readPlanOwner(plansDir: string, planId: string): PlanOwnerInfo | undefined {
  const fp = planOwnerFilePath(plansDir, planId);
  if (!fs.existsSync(fp)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<PlanOwnerInfo>;
    if (typeof raw.pid !== 'number' || typeof raw.heartbeatAt !== 'number') return undefined;
    return { pid: raw.pid, heartbeatAt: raw.heartbeatAt, planId: raw.planId ?? planId };
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPlanOwnerAlive(
  plansDir: string,
  planId: string,
  now = Date.now(),
  staleMs = PLAN_OWNER_STALE_MS,
): boolean {
  const info = readPlanOwner(plansDir, planId);
  if (!info) return false;
  if (now - info.heartbeatAt > staleMs) return false;
  return isPidAlive(info.pid);
}

export interface PlanOwnerHandle {
  release: () => void;
}

function writeOwner(fp: string, planId: string): void {
  atomicWriteFileSync(
    fp,
    JSON.stringify({ pid: process.pid, heartbeatAt: Date.now(), planId }, null, 2),
  );
}

/**
 * Take ownership of a plan. Returns `undefined` when another live owner holds it.
 */
export function tryAcquirePlanOwner(
  plansDir: string,
  planId: string,
  options: { staleMs?: number; heartbeatMs?: number } = {},
): PlanOwnerHandle | undefined {
  if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
  const staleMs = options.staleMs ?? PLAN_OWNER_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? PLAN_OWNER_HEARTBEAT_MS;
  const fp = planOwnerFilePath(plansDir, planId);
  // Check-and-claim under a lock: two processes resuming the same plan at
  // once must not both see "no live owner" and both take it.
  const claimed = withFileLockSync(`${fp}.lock`, () => {
    if (isPlanOwnerAlive(plansDir, planId, Date.now(), staleMs)) return false;
    writeOwner(fp, planId);
    return true;
  });
  if (!claimed) return undefined;
  const timer = setInterval(() => {
    try {
      writeOwner(fp, planId);
    } catch {
      // Heartbeat write failures are non-fatal; stale detection will recover.
    }
  }, heartbeatMs);
  timer.unref?.();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {
        // ignore
      }
    },
  };
}
