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
  /**
   * Phase 27 (PERF-06): filename → plan id index.
   *
   * `list()` used to read and JSON-parse EVERY file on every call
   * (O(files) reads for an O(files) answer).  The filename is
   * `sha256(id)`, so the mapping is stable — once a file has been
   * parsed, its id is remembered and only files that appear LATER are
   * parsed.  Files that vanish are pruned from the index.
   */
  private readonly idByFile = new Map<string, string>();

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
    const filePath = this.filePath(plan.id ?? 'unknown');
    atomicWriteFileSync(filePath, data);
    // Phase 27 (PERF-06): keep the list index warm for our own writes.
    if (plan.id) this.idByFile.set(path.basename(filePath), plan.id);
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
    // Phase 27 (PERF-06): cached ids are reused; only files that are
    // new since the last call are read.
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      seen.add(f);
      const cachedId = this.idByFile.get(f);
      if (cachedId !== undefined) {
        ids.push(cachedId);
        continue;
      }
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(this.dir, f), 'utf-8')
        ) as { id?: unknown };
        if (typeof raw.id === 'string') {
          this.idByFile.set(f, raw.id);
          ids.push(raw.id);
        }
      } catch {
        // Skip corrupt file
      }
    }
    // Drop index entries for files that disappeared (deleted elsewhere).
    if (this.idByFile.size > seen.size) {
      for (const f of [...this.idByFile.keys()]) {
        if (!seen.has(f)) this.idByFile.delete(f);
      }
    }
    return ids;
  }

  delete(planId: string): void {
    const fp = this.filePath(planId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
    // Phase 27 (PERF-06): a deleted plan must leave the index at once.
    this.idByFile.delete(path.basename(fp));
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
