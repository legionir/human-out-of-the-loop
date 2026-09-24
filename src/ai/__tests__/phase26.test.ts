/**
 * Phase 26 (Category D — ID Generation & Collision):
 * every runtime-generated id must use `node:crypto` `randomUUID()`
 * (collision-free within a millisecond, unpredictable).
 *
 * Verified: ID-01..ID-06 + the `call-` fallback in agent-runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createPlan } from '../schemas/plan.js';
import { createSession, createInteraction } from '../schemas/session.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;

const minimalStep = {
  id: 'step-1',
  description: 'do the thing',
  dependsOn: [],
  assignedPersona: 'coder',
  assignedSkills: [],
  assignedTools: [],
  claimedResources: [],
  acceptanceCriteria: 'the thing is done',
};

describe('phase 26 — ID generation (Category D)', () => {
  it('ID-03/06: 5000 plans created in a tight loop have UNIQUE ids (Date.now() would collide)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = createPlan(`goal ${i}`, [minimalStep]).id;
      expect(id).toBeTypeOf('string');
      ids.add(id!);
    }
    expect(ids.size).toBe(5000);
  });

  it('ID-01: 5000 sessions created in a tight loop have UNIQUE ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(createSession().id);
    }
    expect(ids.size).toBe(5000);
  });

  it('ID-02: 2000 interactions in a tight loop have UNIQUE ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      ids.add(createInteraction('req').id);
    }
    expect(ids.size).toBe(2000);
  });

  it('id formats: stable prefix + UUIDv4 (unpredictable, sortable in logs)', () => {
    expect(createPlan('g', [minimalStep]).id).toMatch(new RegExp(`^plan_${UUID_V4.source}$`));
    expect(createSession('lbl').id).toMatch(new RegExp(`^session_${UUID_V4.source}$`));
    expect(createInteraction('r').id).toMatch(new RegExp(`^interaction_${UUID_V4.source}$`));
  });

  it('source scan: no Date.now()/Math.random() id generation remains in src/ai', () => {
    const root = join(__dirname, '..');
    const bad = /_?\$\{(Date\.now\(\)|Math\.random\(\))/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === '__tests__') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (p.endsWith('.ts')) {
          const text = readFileSync(p, 'utf-8');
          if (bad.test(text)) offenders.push(p.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('persistence regression: FilePlanStore round-trip with UUID ids (filename = sha256(id))', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase26-store-'));
    const store = new FilePlanStore(dir);
    const a = createPlan('plan A', [minimalStep]);
    const b = createPlan('plan B', [minimalStep]);
    expect(a.id).not.toBe(b.id);
    store.save(a);
    store.save(b);
    const listed = store.list().sort();
    expect(listed).toEqual([a.id!, b.id!].sort());
    expect(store.load(a.id!)?.goal).toBe('plan A');
    expect(store.load(b.id!)?.goal).toBe('plan B');
  });
});
