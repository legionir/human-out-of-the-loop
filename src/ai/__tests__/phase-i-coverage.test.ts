import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UNIFIED = fs.readFileSync(path.join(ROOT, 'docs/UNIFIED_EXECUTION_PLAN.md'), 'utf8');

/** Default covering test file per phase; overrides for rows that live elsewhere. */
const PHASE_FILE: Record<string, string> = {
  A: 'src/server/__tests__/phase-a-security.test.ts',
  B: 'src/ai/__tests__/phase-b-orchestration.test.ts',
  C: 'src/ai/__tests__/phase-c-runtime.test.ts',
  D: 'src/ai/__tests__/phase-d-tools.test.ts',
  E: 'src/ai/__tests__/phase-e-context.test.ts',
  F: 'src/ai/__tests__/phase-f-perf.test.ts',
  G: 'src/cli/__tests__/phase-g.test.ts',
  H: 'src/server/__tests__/phase-h.test.ts',
};

const OVERRIDES: Record<string, string> = {
  'A-02': 'src/ai/__tests__/r0-08-project-trust.test.ts',
  'A-03': 'src/cli/__tests__/a02-trust-project.test.ts',
  'A-06': 'src/ai/__tests__/a06-a07-mcp-schema.test.ts',
  'A-07': 'src/ai/__tests__/a06-a07-mcp-schema.test.ts',
  'B-16': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-17': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-18': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-19': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-20': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-21': 'src/ai/__tests__/phase-b-registry.test.ts',
  'B-22': 'src/ai/__tests__/env-endpoint.test.ts',
  'C-04': 'src/ai/__tests__/phase-c-model-retry.test.ts',
  'E-03': 'src/ai/__tests__/phase-e-generation.test.ts',
  'H-01': 'src/ai/__tests__/phase-h-ui.test.ts',
};

function closedRowIds(): string[] {
  return [...UNIFIED.matchAll(/\|\s*\*\*((?:A|B|C|D|E|F|G|H)-\d+)\*\*/g)].map((m) => m[1]!);
}

function coveringFile(id: string): string {
  return OVERRIDES[id] ?? PHASE_FILE[id.split('-')[0]!] ?? '';
}

const ids = closedRowIds();

describe('I-02 — one directed regression file per closed UNIFIED row', () => {
  it('lists the closed A–H rows from UNIFIED', () => {
    expect(ids.length).toBeGreaterThanOrEqual(100);
  });

  it.each(ids)('%s has a covering test file on disk', (id) => {
    const rel = coveringFile(id);
    expect(rel, `${id} has no covering file mapping`).toBeTruthy();
    expect(fs.existsSync(path.join(ROOT, rel)), `${id} → ${rel}`).toBe(true);
  });
});
