import { describe, expect, it, vi } from 'vitest';
import { createDefaultWorkflowProfileDocument } from '../workflow-profiles/default-profile.js';
import { runWorkflowProfileBridge, type WorkflowProfileBridgeServices } from '../workflow-profiles/orchestrator-bridge.js';
import { prepareWorkflowProfileRun, WORKFLOW_PROFILE_FLAG_ENV_VAR } from '../workflow-profiles/profile-runner.js';
import { createBuiltInRubricCatalogue, type WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import type { Plan } from '../schemas/plan.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import { emptyReviewUsage, type Review } from '../schemas/review.js';

const PLANNER_PERSONA = { id: 'planner', name: 'Task Planner', system: 'Plan.', allowedTools: ['create_task'] };
const REVIEWER_PERSONA = { id: 'reviewer', name: 'Code Reviewer', system: 'Review.', allowedTools: ['read_file'] };

function sources(): WorkflowProfileComponentSources {
  const personas: Record<string, unknown> = { planner: PLANNER_PERSONA, reviewer: REVIEWER_PERSONA };
  return {
    personas: { get: (id: string) => (personas[id] ? { ...(personas[id] as object) } : undefined) },
    skills: { get: () => undefined },
    models: { get: () => undefined },
    toolsets: { get: () => undefined },
    rubrics: { get: (id: string) => createBuiltInRubricCatalogue().get(id) },
  } as unknown as WorkflowProfileComponentSources;
}

const ENV = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' } as const;

const plan = { id: 'plan-1', goal: 'g', steps: [{ id: 's1', description: 'do it', status: 'pending' }] } as unknown as Plan;
const execution: PlanExecutionResult = {
  planId: 'plan-1', status: 'completed', completedSteps: 1, failedSteps: 0, totalSteps: 1, incompleteSteps: [], replanningAttempts: 0,
};
const review: Review = {
  planId: 'plan-1', goal: 'g', outcome: 'success', acceptedFindings: [], rejectedFindings: [], incompleteSteps: [],
  finalSummary: 'all steps accepted', usage: emptyReviewUsage,
};

function prepared() {
  const components = sources();
  return prepareWorkflowProfileRun({
    document: createDefaultWorkflowProfileDocument(components),
    sources: components,
    env: ENV,
  });
}

const baseServices = (overrides: Partial<WorkflowProfileBridgeServices> = {}): WorkflowProfileBridgeServices => ({
  planner: { plan: vi.fn(async () => ({ kind: 'plan' as const, plan })) },
  // The real default renderer summarizes a full Plan; the fixture is a minimal stub.
  renderPlan: () => 'PLAN TEXT',
  planRuntime: { execute: vi.fn(async () => execution) },
  finalReviewer: { review: vi.fn(async () => review) },
  confirm: vi.fn(async () => ({ confirmed: true })),
  ...overrides,
});

describe('workflow profile orchestration bridge', () => {
  it('runs the plan branch and hands the plan to persistence before execution', async () => {
    const order: string[] = [];
    const services = baseServices({
      planRuntime: { execute: vi.fn(async () => { order.push('execute'); return execution; }) },
    });
    const outcome = await runWorkflowProfileBridge(prepared(), {
      services,
      input: { request: { goal: 'ship it' } },
      onPlan: () => { order.push('persist'); },
    });
    expect(outcome.status).toBe('success');
    expect(outcome.plan).toBe(plan);
    expect(outcome.planText).toBe('PLAN TEXT');
    expect(outcome.execution).toBe(execution);
    expect(outcome.review).toBe(review);
    expect(outcome.visited).toEqual(['request', 'plan', 'confirm', 'execute', 'review', 'finish']);
    expect(order).toEqual(['persist', 'execute']);
    // The delegated reviewer judges the captured execution, not the review node's inputs.
    expect(services.finalReviewer!.review).toHaveBeenCalledWith(plan, execution, undefined);
  });

  it('runs the answer branch without executing anything', async () => {
    const services = baseServices({ planner: { plan: vi.fn(async () => ({ kind: 'answer' as const, answer: 'It is 42.' })) } });
    const outcome = await runWorkflowProfileBridge(prepared(), { services, input: { request: { goal: 'what is it' } } });
    expect(outcome.status).toBe('success');
    expect(outcome.answer).toBe('It is 42.');
    expect(outcome.visited).toEqual(['request', 'plan', 'answered']);
    expect(services.planRuntime.execute).not.toHaveBeenCalled();
  });

  it('stops at a denied confirmation without executing', async () => {
    const services = baseServices({ confirm: vi.fn(async () => ({ confirmed: false, feedback: 'please change the plan' })) });
    const outcome = await runWorkflowProfileBridge(prepared(), { services, input: { request: { goal: 'ship it' } } });
    expect(outcome.status).toBe('failure');
    expect(outcome.failure?.category).toBe('approval-denied');
    expect(services.planRuntime.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the approval service is not wired', async () => {
    const services = baseServices({ confirm: undefined });
    const outcome = await runWorkflowProfileBridge(prepared(), { services, input: { request: { goal: 'ship it' } } });
    expect(outcome.status).toBe('failure');
    expect(outcome.failure?.code).toBe('approval.service-missing');
    expect(services.planRuntime.execute).not.toHaveBeenCalled();
  });

  it('fails closed when no reviewer is wired', async () => {
    const services = baseServices({ finalReviewer: undefined });
    const outcome = await runWorkflowProfileBridge(prepared(), { services, input: { request: { goal: 'ship it' } } });
    expect(outcome.status).toBe('failure');
    expect(outcome.failure?.code).toBe('reviewer.service-missing');
  });

  it('treats a cancelled plan execution as a terminal cancellation', async () => {
    const services = baseServices({
      planRuntime: { execute: vi.fn(async () => ({ ...execution, status: 'cancelled' as PlanExecutionResult['status'] })) },
    });
    const outcome = await runWorkflowProfileBridge(prepared(), { services, input: { request: { goal: 'ship it' } } });
    expect(outcome.status).toBe('cancelled');
    expect(outcome.failure?.category).toBe('cancelled');
  });
});
