/**
 * J-08 — successful plan examples: stored under .ai-runtime, disable-able, size-capped, selectable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAN_EXAMPLES_MAX,
  exampleFromPlan,
  formatPlanExample,
  loadPlanExamples,
  planExamplesEnabled,
  savePlanExample,
  selectPlanExample,
  type PlanExample,
} from '../planning/plan-examples.js';
import { buildPlanPrompt } from '../planning/planner.js';
import { createPlan } from '../schemas/plan.js';

describe('J-08 — plan examples', () => {
  let root: string;
  const prev = process.env.HOTL_PLAN_EXAMPLES;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j08-'));
    delete process.env.HOTL_PLAN_EXAMPLES;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.HOTL_PLAN_EXAMPLES;
    else process.env.HOTL_PLAN_EXAMPLES = prev;
  });

  it('can be disabled with HOTL_PLAN_EXAMPLES=0', () => {
    expect(planExamplesEnabled({})).toBe(true);
    expect(planExamplesEnabled({ HOTL_PLAN_EXAMPLES: '0' })).toBe(false);
    expect(planExamplesEnabled({ HOTL_PLAN_EXAMPLES: 'off' })).toBe(false);
  });

  it('caps the store at PLAN_EXAMPLES_MAX', () => {
    const plan = createPlan('add a login form', [
      {
        id: 's1',
        description: 'write form',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['write_file'],
        claimedResources: [],
        acceptanceCriteria: 'form exists',
      },
    ]);
    for (let i = 0; i < PLAN_EXAMPLES_MAX + 5; i++) {
      savePlanExample(root, { ...plan, goal: `goal number ${i} login form` });
    }
    const loaded = loadPlanExamples(root);
    expect(loaded.length).toBe(PLAN_EXAMPLES_MAX);
  });

  it('selects the example whose goal overlaps the request', () => {
    const examples: PlanExample[] = [
      { goal: 'add logout button to the header', stepIds: ['a'], personas: ['coder'], tools: ['write_file'] },
      { goal: 'rewrite the billing invoice PDF', stepIds: ['b'], personas: ['coder'], tools: ['write_file'] },
    ];
    const picked = selectPlanExample('please add a logout button', examples);
    expect(picked?.goal).toContain('logout');
    expect(selectPlanExample('totally unrelated xyz', examples)).toBeUndefined();
  });

  it('formats a bounded example block for the planner prompt', () => {
    const example = exampleFromPlan(
      createPlan('add login', [
        {
          id: 's1',
          description: 'x',
          dependsOn: [],
          assignedPersona: 'coder',
          assignedSkills: [],
          assignedTools: ['write_file'],
          claimedResources: [],
          acceptanceCriteria: 'ok',
        },
      ]),
    );
    const block = formatPlanExample(example);
    expect(block).toContain('EXAMPLE OF A SUCCESSFUL PLAN');
    expect(buildPlanPrompt('add login', undefined, undefined, undefined, undefined, block)).toContain(
      'EXAMPLE OF A SUCCESSFUL PLAN',
    );
  });
});
