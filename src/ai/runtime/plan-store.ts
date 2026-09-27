import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PlanSchema, type Plan } from '../schemas/plan.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { lockPathFor, withFileLockSync } from './file-lock.js';

// ─── Types ────────────────────────────────────────────────────────

export interface StoreLoadWarning {
  file: string;
  error: string;
}

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
  /**
   * B-09: locked read-modify-write. Returns undefined when the plan is missing.
   * `fn` receives a clone; the returned plan is what is persisted.
   */
  update(planId: string, fn: (plan: Plan) => Plan): Plan | undefined;
  /** C-11: drop files older than `days`. Optional on memory stores. */
  pruneOlderThan?(days: number): number;
}

export function hashedStoreFileName(id: string): string {
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return `${hash}.json`;
}

const HASH_JSON = /^[0-9a-f]{16}\.json$/;
const OWNER_JSON = /\.owner\.json$/;

function parsePlanFile(raw: unknown, file: string): { plan?: Plan; error?: string } {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  return { plan: parsed.data };
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
  /** B-03: last list()/load() skipped files. */
  readonly loadWarnings: StoreLoadWarning[] = [];

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
    return path.join(this.dir, hashedStoreFileName(planId));
  }

  private warn(file: string, error: string): void {
    this.loadWarnings.push({ file, error });
  }

  private readPlanFromFile(fp: string): Plan | undefined {
    if (!fs.existsSync(fp)) return undefined;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const { plan, error } = parsePlanFile(raw, path.basename(fp));
      if (!plan) {
        this.warn(path.basename(fp), error ?? 'invalid plan');
        return undefined;
      }
      return plan;
    } catch (err) {
      this.warn(path.basename(fp), err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  save(plan: Plan): void {
    // Phase 30 (P10 follow-up): an id-less plan used to be written to the
    // SAME file as every other id-less plan (`sha256("unknown")`), so one
    // silently overwrote the other.  The planner now always assigns an id;
    // anything else fails loudly instead of losing data.
    if (!plan.id) {
      throw new Error('[plan-store] refusing to save a plan without an id.');
    }
    // Phase 19 (PERS-01): atomic write — a crash mid-save can never
    // leave a corrupted (truncated) plan file behind.
    const data = JSON.stringify(plan);
    const filePath = this.filePath(plan.id);
    // Phase 27 (PERS-04): serialise writers across processes sharing
    // this store directory (CLI ↔ server).
    withFileLockSync(lockPathFor(filePath), () => {
      atomicWriteFileSync(filePath, data);
    });
    // Phase 27 (PERF-06): keep the list index warm for our own writes.
    if (plan.id) this.idByFile.set(path.basename(filePath), plan.id);
  }

  load(planId: string): Plan | undefined {
    const hashed = this.filePath(planId);
    const fromHash = this.readPlanFromFile(hashed);
    if (fromHash) return fromHash;
    // B-11: a pre-hash filename may still exist until list() migrates it.
    return this.readLegacy(planId);
  }

  private readLegacy(planId: string): Plan | undefined {
    if (!fs.existsSync(this.dir)) return undefined;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || HASH_JSON.test(f) || OWNER_JSON.test(f)) continue;
      const fp = path.join(this.dir, f);
      const plan = this.readPlanFromFile(fp);
      if (plan?.id === planId) {
        this.migrateFile(fp, plan);
        return this.readPlanFromFile(this.filePath(planId));
      }
    }
    return undefined;
  }

  private migrateFile(oldPath: string, plan: Plan): void {
    if (!plan.id) return;
    const dest = this.filePath(plan.id);
    if (path.resolve(oldPath) === path.resolve(dest)) return;
    withFileLockSync(lockPathFor(dest), () => {
      if (!fs.existsSync(dest)) {
        atomicWriteFileSync(dest, JSON.stringify(plan));
      }
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch {
        // leave the old file if unlink fails; hashed copy is canonical
      }
    });
    this.idByFile.delete(path.basename(oldPath));
    this.idByFile.set(path.basename(dest), plan.id);
  }

  update(planId: string, fn: (plan: Plan) => Plan): Plan | undefined {
    const fp = this.filePath(planId);
    return withFileLockSync(lockPathFor(fp), () => {
      const plan = this.readPlanFromFile(fp) ?? this.readLegacy(planId);
      if (!plan) return undefined;
      const next = fn(structuredClone(plan));
      if (!next.id) {
        throw new Error('[plan-store] refusing to save a plan without an id.');
      }
      atomicWriteFileSync(this.filePath(next.id), JSON.stringify(next));
      this.idByFile.set(path.basename(this.filePath(next.id)), next.id);
      return structuredClone(next);
    });
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
      if (!f.endsWith('.json') || OWNER_JSON.test(f)) continue;
      seen.add(f);
      const cachedId = this.idByFile.get(f);
      if (cachedId !== undefined) {
        ids.push(cachedId);
        continue;
      }
      const fp = path.join(this.dir, f);
      const plan = this.readPlanFromFile(fp);
      if (!plan?.id) continue;
      if (!HASH_JSON.test(f)) {
        this.migrateFile(fp, plan);
        seen.delete(f);
        seen.add(hashedStoreFileName(plan.id));
      }
      this.idByFile.set(hashedStoreFileName(plan.id), plan.id);
      ids.push(plan.id);
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
    // Phase 27 (PERS-04): delete takes the same per-file lock as save,
    // so a concurrent writer cannot resurrect a half-deleted plan.
    withFileLockSync(lockPathFor(fp), () => {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
      }
      // B-11: also remove a leftover pre-hash file.
      if (fs.existsSync(this.dir)) {
        for (const f of fs.readdirSync(this.dir)) {
          if (!f.endsWith('.json') || HASH_JSON.test(f) || OWNER_JSON.test(f)) continue;
          const old = path.join(this.dir, f);
          try {
            const raw = JSON.parse(fs.readFileSync(old, 'utf-8')) as { id?: unknown };
            if (raw.id === planId) fs.unlinkSync(old);
          } catch {
            // ignore
          }
        }
      }
    });
    // Phase 27 (PERF-06): a deleted plan must leave the index at once.
    this.idByFile.delete(path.basename(fp));
  }

  exists(planId: string): boolean {
    return this.load(planId) !== undefined;
  }

  pruneOlderThan(days: number): number {
    if (days <= 0 || !fs.existsSync(this.dir)) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || OWNER_JSON.test(f)) continue;
      const fp = path.join(this.dir, f);
      try {
        if (fs.statSync(fp).mtimeMs >= cutoff) continue;
        fs.unlinkSync(fp);
        this.idByFile.delete(f);
        removed++;
      } catch {
        // ignore
      }
    }
    return removed;
  }
}

// ─── In-memory implementation (for tests) ────────────────────────

export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, Plan>();
  readonly loadWarnings: StoreLoadWarning[] = [];

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

  update(planId: string, fn: (plan: Plan) => Plan): Plan | undefined {
    const p = this.plans.get(planId);
    if (!p) return undefined;
    const next = fn(structuredClone(p));
    this.plans.set(next.id ?? planId, structuredClone(next));
    return structuredClone(next);
  }
}
