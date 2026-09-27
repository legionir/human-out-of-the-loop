import type { Plan } from '../schemas/plan.js';
import type { PlanStore } from './plan-store.js';

/**
 * Phase 30 (P10) — scrubbing known secret VALUES out of runtime artifacts.
 *
 * `ObservabilityLoggerConfig.redactKeys` matches field NAMES (`apiKey`,
 * `token`, …), which is not enough: a model can echo a credential it read
 * from the project into its own summary, and that summary is copied into
 * the plan record and into the log.  These helpers remove the literal
 * values of the credentials this process actually holds.
 */

export const SECRET_REDACTION_MARKER = '***REDACTED***';

/**
 * Replace every occurrence of a known secret value with the marker.
 * Values shorter than a few characters are ignored by the collectors, so a
 * normal word is never destroyed; the longest values are applied first so a
 * token contained inside a longer one is scrubbed as part of it.
 */
export function scrubSecretValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(SECRET_REDACTION_MARKER);
  }
  return out;
}

/**
 * A `PlanStore` that never persists a known secret value.
 *
 * Step summaries carry the model's own words; a model that echoes a
 * credential must not put it into the plan record either — `hootl plans
 * show`, the acceptance judge's history and the UI all read this record.
 */
export class ScrubbingPlanStore implements PlanStore {
  constructor(
    private readonly inner: PlanStore,
    private readonly secrets: readonly string[]
  ) {}

  /**
   * Scrub every string in the plan, not a list of known fields: a field added
   * later (J-04's `handoff` copies the step summary) must not become a
   * credential leak just because nobody remembered to list it here.
   */
  private clean(plan: Plan): Plan {
    if (this.secrets.length === 0) return plan;
    return scrubDeep(plan, this.secrets) as Plan;
  }

  save(plan: Plan): void {
    this.inner.save(this.clean(plan));
  }

  load(planId: string): Plan | undefined {
    return this.inner.load(planId);
  }

  list(): string[] {
    return this.inner.list();
  }

  delete(planId: string): void {
    this.inner.delete(planId);
  }

  exists(planId: string): boolean {
    return this.inner.exists(planId);
  }

  update(planId: string, fn: (plan: Plan) => Plan): Plan | undefined {
    return this.inner.update(planId, (plan) => this.clean(fn(plan)));
  }

  pruneOlderThan(days: number): number {
    return this.inner.pruneOlderThan?.(days) ?? 0;
  }
}

function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return scrubSecretValues(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item, secrets);
    }
    return out;
  }
  return value;
}

/** Env var NAMES that mark their value as a credential. */
export const SECRET_NAME_PATTERNS = [
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'authorization',
  'credential',
  'bearer',
  'cookie',
  'session_key',
];

/** Values shorter than this are not treated as secrets (avoids scrubbing words). */
export const MIN_REDACT_VALUE_LENGTH = 6;

/**
 * Collect the actual secret VALUES visible to this process.
 *
 * An env var counts when its NAME contains one of the patterns above (or an
 * extra pattern supplied by configuration) and its value is long enough to
 * be a credential.
 */
export function collectSecretValues(
  env: Record<string, string | undefined>,
  extraPatterns: string[] = []
): string[] {
  const needles = [...SECRET_NAME_PATTERNS, ...extraPatterns.map((p) => p.toLowerCase())];
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_REDACT_VALUE_LENGTH) continue;
    const lower = key.toLowerCase();
    if (needles.some((needle) => lower.includes(needle.toLowerCase()))) values.add(value);
  }
  return [...values];
}
