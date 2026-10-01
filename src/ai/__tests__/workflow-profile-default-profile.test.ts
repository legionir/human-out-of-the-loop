import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKFLOW_PROFILE_ID,
  DEFAULT_WORKFLOW_PROFILE_RUBRIC,
  createDefaultWorkflowProfileDocument,
} from '../workflow-profiles/default-profile.js';
import { validateWorkflowProfileStructure } from '../workflow-profiles/profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from '../workflow-profiles/profile-semantic-validator.js';
import { createBuiltInRubricCatalogue, resolveWorkflowProfileDependencies, type WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import { runWorkflowProfileKernel, type WorkflowNodeHandler } from '../workflow-profiles/profile-kernel.js';
import { createWorkflowProfileHandlers } from '../workflow-profiles/node-handlers.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import { contentDigest } from '../workflow-profiles/untrusted-content.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const PLANNER_PERSONA = { id: 'planner', name: 'Task Planner', system: 'You are a strategic task planner.', allowedTools: ['create_task'] };
const REVIEWER_PERSONA = { id: 'reviewer', name: 'Code Reviewer', system: 'You are a meticulous code reviewer.', allowedTools: ['read_file'] };

function sources(): WorkflowProfileComponentSources {
  return {
    personas: { get: (id: string) => (id === 'planner' ? { ...PLANNER_PERSONA } : id === 'reviewer' ? { ...REVIEWER_PERSONA } : undefined) },
    skills: { get: () => undefined },
    models: { get: () => undefined },
    toolsets: { get: () => undefined },
    rubrics: { get: (id: string) => createBuiltInRubricCatalogue().get(id) as Record<string, unknown> | undefined },
  } as unknown as WorkflowProfileComponentSources;
}

const document = (): WorkflowProfileDocument => createDefaultWorkflowProfileDocument(sources());

function handlers(services: Parameters<typeof createWorkflowProfileHandlers>[0]): Partial<Record<string, WorkflowNodeHandler>> {
  return createWorkflowProfileHandlers(services) as Partial<Record<string, WorkflowNodeHandler>>;
}

const plan = { id: 'plan-1', steps: [{ id: 's1', description: 'do it' }] };
const planText = '1. do it';

/** Echoes the digest it was shown, like the text-confirm adapter does (D-WP-013). */
const approvingUser = { request: vi.fn(async (request: { responseKind: string; boundDigest?: string }) => (request.responseKind === 'text'
  ? { status: 'approved' as const, answer: 'the missing detail' }
  : { status: 'approved' as const, approvedDigest: request.boundDigest, decision: { approved: true } })) };

describe('built-in default workflow profile', () => {
  it('is structurally valid, semantically valid, and resolves against the components it pins', () => {
    const profile = document();
    expect(profile.profile.id).toBe(DEFAULT_WORKFLOW_PROFILE_ID);
    expect(validateWorkflowProfileStructure(profile)).toEqual([]);
    expect(validateWorkflowProfileSemantics(profile)).toEqual([]);
    const resolved = resolveWorkflowProfileDependencies(profile, sources());
    expect(resolved.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`)).toEqual([
      'persona:planner', 'persona:reviewer', `rubric:${DEFAULT_WORKFLOW_PROFILE_RUBRIC}`,
    ]);
    for (const dependency of resolved.dependencies) expect(dependency.contentDigest).toBe(dependency.declaredDigest);
  });

  it('fails closed instead of inventing a pin when a component is missing', () => {
    const incomplete = sources();
    Object.defineProperty(incomplete, 'rubrics', { value: { get: () => undefined } });
    expect(() => createDefaultWorkflowProfileDocument(incomplete)).toThrow(WorkflowProfileLoadError);
    try {
      createDefaultWorkflowProfileDocument(incomplete);
    } catch (error) {
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('default-profile.component-missing');
    }
  });

  it('runs the plan branch: request → plan → confirmation → execute → review → finish', async () => {
    const planner = { plan: vi.fn(async () => ({ kind: 'plan' as const, plan, planText })) };
    const executor = { execute: vi.fn(async () => ({ status: 'completed' as const, summary: 'done' })) };
    const reviewer = { review: vi.fn(async () => ({ decision: 'pass', reason: 'looks right' })) };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship it' } },
      handlers: handlers({ planner, executor, reviewer, approvals: approvingUser }),
    });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['request', 'plan', 'confirm', 'execute', 'review', 'finish']);
    expect(result.results[0]).toMatchObject({ fromNode: 'finish', kind: 'response', outcome: 'success' });
    // The confirmation is bound to the plan text the user was shown.
    expect(approvingUser.request).toHaveBeenCalledWith(expect.objectContaining({ boundPort: 'planText', boundDigest: contentDigest(planText) }));
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('runs the answer branch without confirmation or execution', async () => {
    const planner = { plan: vi.fn(async () => ({ kind: 'answer' as const, answer: 'It is 42.' })) };
    const executor = { execute: vi.fn() };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'what is the answer' } },
      handlers: handlers({ planner, executor, approvals: approvingUser }),
    });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['request', 'plan', 'answered']);
    expect(result.results[0]).toMatchObject({ fromNode: 'answered', outcome: 'success' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('asks for clarification, folds the answer back in, and bounds the rounds', async () => {
    const outcomes = [
      { kind: 'clarify' as const, needsClarification: ['which environment?'] },
      { kind: 'plan' as const, plan, planText },
    ];
    const planner = { plan: vi.fn(async () => outcomes.shift() ?? { kind: 'plan' as const, plan, planText }) };
    const executor = { execute: vi.fn(async () => ({ status: 'completed' as const, summary: 'done' })) };
    const reviewer = { review: vi.fn(async () => ({ decision: 'pass', reason: 'ok' })) };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'deploy' } },
      handlers: handlers({ planner, executor, reviewer, approvals: approvingUser }),
    });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['request', 'plan', 'clarify', 'plan', 'confirm', 'execute', 'review', 'finish']);
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(result.loopCounters['clarification-rounds']).toBe(1);

    const endless = { plan: vi.fn(async () => ({ kind: 'clarify' as const, needsClarification: ['again?'] })) };
    const exhausted = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'deploy' } },
      handlers: handlers({ planner: endless, approvals: approvingUser }),
    });
    expect(exhausted.status).toBe('failure');
    expect(exhausted.terminalFailure).toMatchObject({ code: 'loop.exhausted' });
    expect(exhausted.nodeSequence.filter((id) => id === 'clarify')).toHaveLength(3);
  });

  it('routes a rejected review to the rejected end and never re-executes', async () => {
    const executor = { execute: vi.fn(async () => ({ status: 'completed' as const, summary: 'attempt' })) };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      handlers: handlers({
        planner: { plan: async () => ({ kind: 'plan' as const, plan, planText }) },
        executor,
        reviewer: { review: async () => ({ decision: 'reject', reason: 'does not satisfy the request' }) },
        approvals: approvingUser,
      }),
    });
    expect(result.status).toBe('rejected');
    expect(result.nodeSequence).toEqual(['request', 'plan', 'confirm', 'execute', 'review', 'rejected']);
    expect(result.results[0]).toMatchObject({ fromNode: 'rejected', outcome: 'rejected' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('reports a revise decision as rejected without running the plan again', async () => {
    const executor = { execute: vi.fn(async () => ({ status: 'completed' as const, summary: 'partial' })) };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      handlers: handlers({
        planner: { plan: async () => ({ kind: 'plan' as const, plan, planText }) },
        executor,
        reviewer: { review: async () => ({ decision: 'revise', reason: 'one step was not accepted' }) },
        approvals: approvingUser,
      }),
    });
    expect(result.status).toBe('rejected');
    expect(result.nodeSequence).toEqual(['request', 'plan', 'confirm', 'execute', 'review', 'rejected']);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the reviewer answers outside the profile decision domain', async () => {
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      handlers: handlers({
        planner: { plan: async () => ({ kind: 'plan' as const, plan, planText }) },
        executor: { execute: async () => ({ status: 'completed' as const, summary: 'done' }) },
        // `accept` is outside the rubric-pinned domain, so the kernel must refuse it.
        reviewer: { review: async () => ({ decision: 'accept', reason: 'not sure' }) },
        approvals: approvingUser,
      }),
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('review.decision-invalid');
  });

  it('cancels through the kernel signal without executing anything further', async () => {
    const controller = new AbortController();
    const executor = { execute: vi.fn(async () => ({ status: 'completed' as const, summary: 'done' })) };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      signal: controller.signal,
      handlers: handlers({
        planner: {
          plan: async () => {
            controller.abort();
            return { kind: 'plan' as const, plan, planText };
          },
        },
        executor,
        approvals: approvingUser,
      }),
    });
    expect(result.status).toBe('cancelled');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('aborts when the approved digest is not the digest that was shown', async () => {
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      handlers: handlers({
        planner: { plan: async () => ({ kind: 'plan' as const, plan, planText }) },
        executor: { execute: async () => ({ status: 'completed' as const, summary: 'done' }) },
        approvals: { request: async () => ({ status: 'approved' as const, approvedDigest: contentDigest('a different plan'), decision: { approved: true } }) },
      }),
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure).toMatchObject({ code: 'approval.digest-mismatch' });
  });

  it('does not let a denied confirmation reach execution', async () => {
    const executor = { execute: vi.fn() };
    const result = await runWorkflowProfileKernel({
      profile: document(),
      input: { request: { goal: 'ship' } },
      handlers: handlers({
        planner: { plan: async () => ({ kind: 'plan' as const, plan, planText }) },
        executor,
        approvals: { request: async () => ({ status: 'denied' as const, reason: 'no' }) },
      }),
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure).toMatchObject({ category: 'approval-denied', code: 'approval.denied' });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
