import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Plan } from '../schemas/plan.js';
import { atomicWriteFileSync } from './atomic-write.js';

// ─── Types ────────────────────────────────────────────────────────

export interface PlanStore {
  /** Save the entire plan (overwrite) */
  save(plan: Plan): void;
  /** Load a plan by id. Returns undefined if not found. */
  load(planId: string): Plan | undefined;
  /** List all stored plan ids */
  list(): string[];
  /** Delete a stored plan */
  delete(planId: string): void;
  /** Check if a plan exists */
  exists(planId: string): boolean;
}

// ─── File-based implementation ───────────────────────────────────

/**
 * File-based PlanStore.  Each plan is stored as a separate JSON
 * file in the configured directory.
 *
 * This is the minimum viable persistence — sufficient for
 * single-process Node.js and crash recovery (Phase 10, Step 5).
 * Can be upgraded to SQLite/Postgres/Redis without changing
 * the PlanStore interface.
 *
 * Writes are synchronous to guarantee durability before the
 * next step begins (crash between steps must not lose state).
 */
export class FilePlanStore implements PlanStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private filePath(planId: string): string {
    // Phase 22 (STORE-01): hash-based filename.  The old sanitiser
    // mapped DIFFERENT ids to the SAME file ('a/b' and 'a_b' both
    // became 'a_b.json' → silent cross-plan corruption).  A sha256
    // prefix is collision-free for practical purposes, is a pure
    // function of the id (so no separate id→filename map has to stay
    // in sync), and no id can ever escape the store directory.
    const hash = createHash('sha256').update(planId).digest('hex').slice(0, 16);
    return path.join(this.dir, `${hash}.json`);
  }

  save(plan: Plan): void {
    // Phase 19 (PERS-01): atomic write — a crash mid-save can never
    // leave a corrupted (truncated) plan file behind.
    const data = JSON.stringify(plan, null, 2);
    atomicWriteFileSync(this.filePath(plan.id ?? 'unknown'), data);
  }

  load(planId: string): Plan | undefined {
    const fp = this.filePath(planId);
    if (!fs.existsSync(fp)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      return raw as Plan;
    } catch {
      return undefined;
    }
  }

  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    // Phase 22: filenames are hashes — the real id lives inside each
    // file's JSON.  Corrupt/unreadable files are skipped, not fatal.
    const ids: string[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(this.dir, f), 'utf-8')
        ) as { id?: unknown };
        if (typeof raw.id === 'string') ids.push(raw.id);
      } catch {
        // Skip corrupt file
      }
    }
    return ids;
  }

  delete(planId: string): void {
    const fp = this.filePath(planId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }

  exists(planId: string): boolean {
    return fs.existsSync(this.filePath(planId));
  }
}

// ─── In-memory implementation (for tests) ────────────────────────

export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, Plan>();

  save(plan: Plan): void {
    // Phase 19 (PERS-03): structuredClone — faster than a JSON round-trip
    // and preserves Date/Map/Set types (JSON silently degrades them).
    this.plans.set(plan.id ?? 'unknown', structuredClone(plan));
  }

  load(planId: string): Plan | undefined {
    const p = this.plans.get(planId);
    return p ? structuredClone(p) : undefined;
  }

  list(): string[] {
    return Array.from(this.plans.keys());
  }

  delete(planId: string): void {
    this.plans.delete(planId);
  }

  exists(planId: string): boolean {
    return this.plans.has(planId);
  }
}
