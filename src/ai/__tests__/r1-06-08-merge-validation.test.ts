/**
 * R1-06 — a revised plan that omits a still-pending step must not silently
 * cancel it: `mergeReplannedSteps` now keeps any pending step the model
 * didn't re-list (and didn't explicitly replace) in the merged result.
 *
 * R1-08 — the feasibility gate must reject a plan with two steps sharing
 * the same id (previously accepted, making dependsOn/lookup ambiguous).
 */
import { describe, it, expect } from 'vitest';
import { mergeReplannedSteps } from '../runtime/replan-merge.js';
import { runFeasibilityGate } from '../planning/feasibility-gate.js';
import type { PlanStep, Plan } from '../schemas/plan.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';

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

describe('R1-06 — forgotten pending steps survive a re-plan merge', () => {
  it('keeps an old pending step the revised plan does not mention', () => {
    const current = [
      step('step-1', { status: 'failed' }),
      step('step-2', { status: 'pending' }), // model forgot to re-list this
    ];
    const revised = [step('step-1', { description: 'retry step 1' })];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.find((s) => s.id === 'step-2')?.status).toBe('pending');
  });

  it('does not resurrect a pending step the revised plan explicitly replaces', () => {
    const current = [step('step-1', { status: 'pending' })];
    const revised = [step('step-1', { description: 'a totally new take' })];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.filter((s) => s.id === 'step-1' || s.id === 'step-1-r1')).toHaveLength(1);
  });
});

describe('R1-08 — duplicate step ids are rejected by the feasibility gate', () => {
  it('rejects a plan with two steps sharing the same id', () => {
    const toolRegistry = new ToolRegistry();
    const deps = {
      personaRegistry: new PersonaRegistry(),
      skillRegistry: new SkillRegistry({ toolRegistry }),
      toolRegistry,
    };
    const plan: Plan = {
      id: 'plan-1',
      goal: 'test',
      status: 'draft',
      createdAt: Date.now(),
      clarifications: [],
      steps: [step('step-1'), step('step-1', { description: 'a different task' })],
    };

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate step id'))).toBe(true);
  });
});
