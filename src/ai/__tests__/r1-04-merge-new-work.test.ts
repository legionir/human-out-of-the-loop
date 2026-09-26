/**
 * R1-04 — a re-plan that puts genuinely NEW work under an id that already
 * belongs to a DONE step must not be silently dropped. Before the fix,
 * `mergeReplannedSteps` treated any revised step whose id collided with a
 * `done` step as a no-op resubmission and discarded it unconditionally,
 * even when its description was completely different new work.
 */
import { describe, it, expect } from 'vitest';
import { mergeReplannedSteps } from '../runtime/replan-merge.js';
import type { PlanStep } from '../schemas/plan.js';

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
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
    ...over,
  };
}

describe('R1-04 — new work under a done step id is renamed, not dropped', () => {
  it('keeps genuinely different new work under a fresh id', () => {
    const current = [step('step-1', { status: 'done' })];
    const revised = [step('step-1', { description: 'a completely different follow-up task' })];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.find((s) => s.id === 'step-1')?.status).toBe('done');
    const added = merged.find((s) => s.id === 'step-1-r1');
    expect(added).toBeDefined();
    expect(added?.status).toBe('pending');
    expect(added?.description).toBe('a completely different follow-up task');
  });

  it('still drops an identical resubmission (no-op) of a done step', () => {
    const current = [step('step-1', { status: 'done' })];
    const revised = [step('step-1')]; // same description as current

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged).toEqual([current[0]]);
  });
});
