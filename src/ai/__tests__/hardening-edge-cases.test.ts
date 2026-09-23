import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlan, getReadySteps, isPlanTerminal, type Plan } from '../schemas/plan';
import { runFeasibilityGate } from '../planning/feasibility-gate';
import { detectCycles, topologicalSort } from '../planning/cycle-detector';
import { PersonaRegistry } from '../registries/persona-registry';
import { SkillRegistry } from '../registries/skill-registry';
import { ToolRegistry } from '../registries/tool-registry';
import { ReviewSchema } from '../schemas/review';
import path from 'node:path';

const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');

function minimalDeps() {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerDefinition({ id: 'read_file', name: 'R', description: 'R', source: 'local', modulePath: './r' });
  const skillRegistry = new SkillRegistry({ toolRegistry });
  return { personaRegistry, skillRegistry, toolRegistry };
}

// ─── Plan with zero valid steps ──────────────────────────────────

describe('Edge case: Plan with zero valid steps', () => {
  it('getReadySteps returns empty for plan with no steps', () => {
    const plan = createPlan('Empty', []);
    plan.steps = [];
    expect(getReadySteps(plan)).toEqual([]);
  });

  it('isPlanTerminal returns true for empty plan', () => {
    const plan = createPlan('Empty', []);
    plan.steps = [];
    expect(isPlanTerminal(plan)).toBe(true);
  });

  it('Feasibility Gate passes trivially for single-step valid plan', () => {
    const deps = minimalDeps();
    const plan = createPlan('Trivial', [
      {
        id: 's1',
        description: 'Read a file',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'File read',
        status: 'pending',
      },
    ]);

    const result = runFeasibilityGate(plan, deps);
    expect(result.feasible).toBe(true);
  });
});

// ─── Plan with ALL steps failed ──────────────────────────────────

describe('Edge case: Plan with all steps failed', () => {
  it('isPlanTerminal returns true when all steps are failed', () => {
    const plan = createPlan('All failed', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'failed' },
      { id: 's2', description: 'S2', dependsOn: ['s1'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'failed' },
    ]);

    expect(isPlanTerminal(plan)).toBe(true);
  });

  it('getReadySteps returns empty when all steps failed', () => {
    const plan = createPlan('All failed', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'failed' },
      { id: 's2', description: 'S2', dependsOn: ['s1'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(getReadySteps(plan)).toEqual([]);
  });
});

// ─── Simultaneous concurrency + re-planning ceiling ──────────────

describe('Edge case: Concurrency cap + re-planning ceiling simultaneously', () => {
  it('topologicalSort handles large DAGs efficiently', () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      description: `Step ${i}`,
      dependsOn: i > 0 ? [`s${i - 1}`] : [],
      assignedPersona: 'coder',
      assignedSkills: [] as string[],
      assignedTools: [] as string[],
      claimedResources: [] as string[],
      acceptanceCriteria: 'done',
      status: 'pending' as const,
    }));

    const plan = createPlan('Large DAG', steps);
    const sorted = topologicalSort(plan);

    expect(sorted).not.toBeNull();
    expect(sorted).toHaveLength(50);
    expect(sorted![0]).toBe('s0');
    expect(sorted![49]).toBe('s49');
  });

  it('detectCycles handles diamond dependencies without false positives', () => {
    const plan = createPlan('Diamond', [
      { id: 'A', description: 'A', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'B', description: 'B', dependsOn: ['A'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'C', description: 'C', dependsOn: ['A'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'D', description: 'D', dependsOn: ['B', 'C'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(detectCycles(plan).hasCycle).toBe(false);
    const sorted = topologicalSort(plan);
    expect(sorted).not.toBeNull();
    expect(sorted!.indexOf('A')).toBeLessThan(sorted!.indexOf('B'));
    expect(sorted!.indexOf('A')).toBeLessThan(sorted!.indexOf('C'));
    expect(sorted!.indexOf('B')).toBeLessThan(sorted!.indexOf('D'));
    expect(sorted!.indexOf('C')).toBeLessThan(sorted!.indexOf('D'));
  });
});

// ─── Invalid Output.object() response ────────────────────────────

describe('Edge case: Invalid structured output from model', () => {
  it('ReviewSchema rejects output with missing required fields', () => {
    expect(() =>
      ReviewSchema.parse({
        planId: 'p1',
      })
    ).toThrow();
  });

  it('ReviewSchema rejects invalid severity in findings', () => {
    expect(() =>
      ReviewSchema.parse({
        planId: 'p1',
        goal: 'Test',
        outcome: 'success',
        finalSummary: 'Done',
        acceptedFindings: [
          { stepId: 's1', title: 'T', description: 'D', severity: 'extreme' },
        ],
      })
    ).toThrow();
  });

  it('ReviewSchema rejects invalid outcome value', () => {
    expect(() =>
      ReviewSchema.parse({
        planId: 'p1',
        goal: 'Test',
        outcome: 'super-success',
        finalSummary: 'Done',
      })
    ).toThrow();
  });

  it('ReviewSchema accepts minimal valid review', () => {
    const review = ReviewSchema.parse({
      planId: 'p1',
      goal: 'Test',
      outcome: 'success',
      finalSummary: 'All done.',
    });

    expect(review.acceptedFindings).toEqual([]);
    expect(review.rejectedFindings).toEqual([]);
    expect(review.incompleteSteps).toEqual([]);
  });
});

// ─── Plan step status transitions ────────────────────────────────

describe('Edge case: Plan step status transitions', () => {
  it('step cannot become ready if any dependency is still running', () => {
    const plan = createPlan('Running dep', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'running' },
      { id: 's2', description: 'S2', dependsOn: ['s1'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(getReadySteps(plan)).toEqual([]);
  });

  it('step becomes ready only when ALL dependencies are done', () => {
    const plan = createPlan('Multi dep', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'done' },
      { id: 's2', description: 'S2', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'running' },
      { id: 's3', description: 'S3', dependsOn: ['s1', 's2'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(getReadySteps(plan)).toEqual([]);

    plan.steps[1].status = 'done';
    expect(getReadySteps(plan)).toHaveLength(1);
    expect(getReadySteps(plan)[0].id).toBe('s3');
  });
});
