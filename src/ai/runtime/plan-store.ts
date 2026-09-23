import fs from 'node:fs';
import path from 'node:path';
import type { Plan } from '../schemas/plan.js';

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
    // Sanitise planId to prevent path traversal
    const safe = planId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  save(plan: Plan): void {
    const data = JSON.stringify(plan, null, 2);
    fs.writeFileSync(this.filePath(plan.id ?? 'unknown'), data, 'utf-8');
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
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
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
    // Deep clone to prevent mutation
    this.plans.set(plan.id ?? 'unknown', JSON.parse(JSON.stringify(plan)));
  }

  load(planId: string): Plan | undefined {
    const p = this.plans.get(planId);
    return p ? JSON.parse(JSON.stringify(p)) : undefined;
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
