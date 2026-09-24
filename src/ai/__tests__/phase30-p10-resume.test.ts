/**
 * Phase 30 (P10 follow-up) — `plans resume` must never redo finished work.
 *
 * The documented contract is "re-execute every step that is not done/failed
 * yet".  Two things follow from that, and this file pins both:
 *
 *   - a `done` step is never dispatched again (no second model call, no
 *     second write, no second bill);
 *   - a plan whose steps are all done/failed is a no-op, and a cancelled
 *     plan stays cancelled.
 *
 * It also fixes the opposite failure: `isPlanTerminal()` treats
 * `failed-partial` as terminal, so the very case the command exists for
 * (finish an interrupted plan) used to do nothing at all.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanRuntime, type PlanRuntimeConfig } from '../runtime/plan-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry } from '../registries/model-registry.js';
import { createPlan, type Plan, type PlanStep } from '../schemas/plan.js';
import type { TaskRuntime } from '../runtime/task-runtime.js';
import type { Planner } from '../planning/planner.js';
import type { LanguageModel } from 'ai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `do ${id}`,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: `${id} done`,
    status: 'pending',
    ...over,
  };
}

/** A task runtime that completes instantly and records every dispatch. */
function fakeTaskRuntime(dispatched: string[]): TaskRuntime {
  let seq = 0;
  const tasks = new Map<string, { status: string; summary: string; failureType?: string }>();
  return {
    createTask: (input: { planStepId?: string }) => {
      const id = `task_${++seq}`;
      dispatched.push(input.planStepId ?? '?');
      tasks.set(id, { status: 'completed', summary: `ran ${input.planStepId}` });
      return id;
    },
    waitForAll: async () => undefined,
    getResult: (id: string) => tasks.get(id),
  } as unknown as TaskRuntime;
}

function makeRuntime(planStore: MemoryPlanStore, dispatched: string[]): PlanRuntime {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerDefinition({
    id: 'read_file',
    name: 'Read',
    description: 'read',
    source: 'local',
    modulePath: './read-file.js',
  });
  // `createAgent` refuses a tool id without an implementation — the resume
  // tests only need *a* tool, so a no-op one is enough.
  toolRegistry.registerImplementation('read_file', {
    description: 'read',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ success: true }),
  } as never);
  const skillRegistry = new SkillRegistry({ toolRegistry });
  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider({
    name: 'openai',
    create: () => ({ specificationVersion: 'v1' }) as unknown as LanguageModel,
  });
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  const planner = {
    assess: async () => ({ isClear: false, needsClarification: [] }),
    generatePlan: async () => {
      throw new Error('resume must not plan from scratch');
    },
    plan: async () => ({ isClear: false, needsClarification: [], errors: [] }),
  } as unknown as Planner;

  const config: PlanRuntimeConfig = {
    taskRuntime: fakeTaskRuntime(dispatched),
    planStore,
    planner,
    feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
    refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
    maxReplanningAttempts: 0,
    defaultModelId: 'gpt-4o',
  };
  return new PlanRuntime(config);
}

describe('Phase 30 / P10 — resume never repeats a finished step', () => {
  it('a failed-partial plan re-runs only its unfinished steps', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('finish the job', [
      step('step-1', { status: 'done', resultSummary: 'finished earlier', taskId: 'old-1' }),
      step('step-2', { status: 'pending' }),
    ]);
    plan.id = 'plan_partial';
    plan.status = 'failed-partial';
    store.save(plan);

    const dispatched: string[] = [];
    const result = await makeRuntime(store, dispatched).resume('plan_partial');

    expect(dispatched).toEqual(['step-2']);
    expect(result.status).toBe('completed');
    const stored = store.load('plan_partial');
    expect(stored?.steps[0].resultSummary).toBe('finished earlier');
    expect(stored?.steps[1].status).toBe('done');
  });

  it('a fully completed plan is a no-op — no dispatch, no model call', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('already done', [
      step('step-1', { status: 'done', resultSummary: 'one' }),
      step('step-2', { status: 'done', resultSummary: 'two' }),
    ]);
    plan.id = 'plan_complete';
    plan.status = 'completed';
    store.save(plan);

    const dispatched: string[] = [];
    await makeRuntime(store, dispatched).resume('plan_complete');

    expect(dispatched).toEqual([]);
    const stored = store.load('plan_complete');
    expect(stored?.steps.map((s) => s.resultSummary)).toEqual(['one', 'two']);
  });

  it('a plan whose steps are all done/failed is a no-op even without a terminal status', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('nothing left', [
      step('step-1', { status: 'done', resultSummary: 'one' }),
      step('step-2', { status: 'failed', resultSummary: 'two failed' }),
    ]);
    plan.id = 'plan_mixed';
    plan.status = 'running'; // e.g. killed between the last step and the review
    store.save(plan);

    const dispatched: string[] = [];
    await makeRuntime(store, dispatched).resume('plan_mixed');

    expect(dispatched).toEqual([]);
  });

  it('a cancelled plan stays cancelled and is not resumed', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('cancelled', [
      step('step-1', { status: 'done', resultSummary: 'one' }),
      step('step-2', { status: 'pending' }),
    ]);
    plan.id = 'plan_cancelled';
    plan.status = 'cancelled';
    store.save(plan);

    const dispatched: string[] = [];
    const result = await makeRuntime(store, dispatched).resume('plan_cancelled');

    expect(dispatched).toEqual([]);
    expect(result.status).toBe('cancelled');
    expect(store.load('plan_cancelled')?.status).toBe('cancelled');
  });

  it('a step interrupted mid-flight is retried, its finished siblings are not', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('crash recovery', [
      step('step-1', { status: 'done', resultSummary: 'finished earlier' }),
      step('step-2', { status: 'running', taskId: 'orphan-task' }),
      step('step-3', { status: 'pending' }),
    ]);
    plan.id = 'plan_crashed';
    plan.status = 'running';
    store.save(plan);

    const dispatched: string[] = [];
    await makeRuntime(store, dispatched).resume('plan_crashed');

    expect(dispatched).toEqual(['step-2', 'step-3']);
    expect(store.load('plan_crashed')?.steps[0].resultSummary).toBe('finished earlier');
  });
});

describe('Phase 30 / P10 — a plan being cancelled is not resumable', () => {
  it('refuses to resume a plan in `cancelling` and finalises it as cancelled', async () => {
    const store = new MemoryPlanStore();
    const plan: Plan = createPlan('cancelled by Ctrl-C', [
      step('step-1', { status: 'done', resultSummary: 'finished earlier' }),
      step('step-2', { status: 'pending' }),
    ]);
    plan.id = 'plan_cancelling';
    plan.status = 'cancelling'; // the process left before the runtime could finish
    store.save(plan);

    const dispatched: string[] = [];
    const result = await makeRuntime(store, dispatched).resume('plan_cancelling');

    expect(dispatched).toEqual([]);
    expect(result.status).toBe('cancelled');
    expect(store.load('plan_cancelling')?.status).toBe('cancelled');
  });
});
