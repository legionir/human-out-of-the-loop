import { describe, expect, it, vi } from 'vitest';
import {
  SCHEMA_BUDGET_MAXIMA,
  WorkflowBudget,
  effectiveWorkflowBudget,
  limitRunStatus,
} from '../workflow-profiles/profile-budget.js';
import { runWorkflowProfileKernel, type WorkflowNodeHandler } from '../workflow-profiles/profile-kernel.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const basePolicies = (overrides: Record<string, unknown> = {}) => ({
  execution: {
    maxNodeVisits: 30, maxDurationSeconds: 60, maxModelCalls: 10, maxToolCalls: 10, onLimit: 'fail',
    ...overrides,
  },
  tools: { allowedToolsets: [] },
  approvals: { policy: 'runtime-default' },
});

function profileWith(nodes: unknown[], edges: unknown[], result: unknown[], policies: unknown): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.budget', name: 'Budget fixture', version: '1.0.0', author: 'tests' },
    dependencies: [],
    workflow: { startNode: 'start', nodes, edges },
    policies,
    result,
  } as unknown as WorkflowProfileDocument;
}

const stringPort = () => ({ type: 'string', required: true });

function twoStepProfile(policies: unknown): WorkflowProfileDocument {
  return profileWith(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { summary: stringPort() }, config: {} },
      { id: 'finish', kind: 'end', goal: 'finish', inputs: { summary: stringPort() }, outputs: { summary: stringPort() }, config: { outcome: 'success', emit: { summary: 'summary' } } },
    ],
    [{ from: 'start', to: 'work', map: { goal: '/goal' } }, { from: 'work', to: 'finish', map: { summary: '/summary' } }],
    [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
    policies,
  );
}

describe('Workflow Profile budget contract', () => {
  it('takes the strictest cap per dimension and never exceeds the schema maxima', () => {
    const caps = effectiveWorkflowBudget(
      { maxNodeVisits: 500, maxDurationSeconds: 3_600, maxModelCalls: 8, maxToolCalls: 12 },
      { maxNodeVisits: 40, maxModelCalls: 100 },
      { maxDurationSeconds: 120, maxToolCalls: 3 },
    );
    expect(caps).toEqual({ maxNodeVisits: 40, maxDurationSeconds: 120, maxModelCalls: 8, maxToolCalls: 3 });
    expect(effectiveWorkflowBudget({ maxNodeVisits: 10_000, maxDurationSeconds: 999_999 })).toEqual({
      ...SCHEMA_BUDGET_MAXIMA, maxNodeVisits: 1000, maxDurationSeconds: 86_400,
    });
    // Missing, negative, and non-finite values cannot raise a cap.
    expect(effectiveWorkflowBudget({ maxNodeVisits: -5, maxModelCalls: Number.POSITIVE_INFINITY }).maxNodeVisits).toBe(SCHEMA_BUDGET_MAXIMA.maxNodeVisits);
    expect(effectiveWorkflowBudget(undefined).maxModelCalls).toBe(SCHEMA_BUDGET_MAXIMA.maxModelCalls);
  });

  it('maps onLimit to the run status it may produce', () => {
    expect(limitRunStatus('fail')).toBe('failure');
    expect(limitRunStatus('handoff')).toBe('handoff');
    expect(limitRunStatus('ask-user')).toBe('handoff');
    expect(limitRunStatus(undefined)).toBe('failure');
  });

  it('counts usage, refuses to exceed a cap, and continues from seeded counters on resume', () => {
    const budget = new WorkflowBudget({ caps: effectiveWorkflowBudget({ maxNodeVisits: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationSeconds: 60 }), now: 1_000 });
    expect(budget.recordVisit(1_000)).toBeUndefined();
    expect(budget.recordVisit(1_000)).toBeUndefined();
    expect(budget.recordVisit(1_000)).toBeUndefined();
    const visits = budget.recordVisit(1_000);
    expect(visits?.code).toBe('budget.node-visits-exceeded');
    expect(budget.recordModelCall(1, 1_000)).toBeUndefined();
    expect(budget.recordModelCall(1, 1_000)).toBeUndefined();
    expect(budget.recordModelCall(1, 1_000)?.code).toBe('budget.model-calls-exceeded');
    expect(budget.recordToolCall(2, 1_000)?.code).toBe('budget.tool-calls-exceeded');
    expect(budget.elapsedMs(5_000)).toBe(4_000);
    expect(budget.remaining(5_000).maxDurationSeconds).toBe(56);

    // A resume seeds the counters: a spent budget stays spent.
    const resumed = new WorkflowBudget({
      caps: effectiveWorkflowBudget({ maxNodeVisits: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationSeconds: 60 }),
      usage: { visits: 3, modelCalls: 2, toolCalls: 1, durationMs: 10_000 },
      now: 20_000,
    });
    expect(resumed.recordVisit(20_000)?.code).toBe('budget.node-visits-exceeded');
    expect(resumed.recordModelCall(1, 20_000)?.code).toBe('budget.model-calls-exceeded');
    expect(resumed.elapsedMs(20_000)).toBe(10_000);
    expect(resumed.usage(21_500).durationMs).toBe(11_500);
  });

  it('reports an exhausted duration against the injected clock', () => {
    const budget = new WorkflowBudget({ caps: effectiveWorkflowBudget({ maxDurationSeconds: 5 }), now: 0 });
    expect(budget.checkDuration(5_000)).toBeUndefined();
    expect(budget.checkDuration(5_001)?.code).toBe('budget.duration-exceeded');
  });
});

describe('Workflow Profile kernel budget enforcement', () => {
  const handlers = (execute: WorkflowNodeHandler): Partial<Record<string, WorkflowNodeHandler>> => ({
    intake: () => ({ goal: 'g' }),
    execute,
  });

  it('charges model calls through the handle and fails closed when the budget is spent', async () => {
    const executor = vi.fn((invocation: Parameters<WorkflowNodeHandler>[0]) => {
      invocation.budget.consumeModelCall();
      return { summary: 'done' };
    });
    const policies = basePolicies({ maxModelCalls: 1 });
    const result = await runWorkflowProfileKernel({ profile: twoStepProfile(policies), input: {}, handlers: handlers(executor) });
    expect(result.status).toBe('success');
    expect(result.budget.modelCalls).toBe(1);

    const spent = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxModelCalls: 0 })),
      input: {},
      handlers: handlers(executor),
    });
    expect(spent.status).toBe('failure');
    expect(spent.terminalFailure).toMatchObject({ category: 'budget', code: 'budget.model-calls-exceeded', retryable: false });
    expect(executor).toHaveBeenCalledTimes(2); // the second run never reached the handler body
  });

  it('honours onLimit=handoff for an exhausted budget and never routes or retries it', async () => {
    const escalating = vi.fn(() => ({ summary: 'x' }));
    const result = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxToolCalls: 0, onLimit: 'handoff' })),
      input: {},
      handlers: handlers((invocation) => {
        invocation.budget.consumeToolCall();
        return escalating();
      }),
    });
    expect(result.status).toBe('handoff');
    expect(result.limit).toBe('handoff');
    expect(result.terminalFailure?.category).toBe('budget');
    expect(result.terminalFailure?.code).toBe('budget.tool-calls-exceeded');

    // `ask-user` is a pause the durable layer must keep resumable, so the run
    // result says which limit policy produced it.
    const asking = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxToolCalls: 0, onLimit: 'ask-user' })),
      input: {},
      handlers: handlers((invocation) => {
        invocation.budget.consumeToolCall();
        return { summary: 'x' };
      }),
    });
    expect(asking.status).toBe('handoff');
    expect(asking.limit).toBe('ask-user');
  });

  it('stops on the duration budget at a transition, using the injected clock', async () => {
    let clock = 0;
    const result = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxDurationSeconds: 1 })),
      input: {},
      now: () => clock,
      handlers: handlers(() => {
        clock += 1_500; // the handler took longer than the whole duration budget
        return { summary: 'slow' };
      }),
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('budget.duration-exceeded');
    expect(result.terminalFailure?.category).toBe('budget');
  });

  it('takes the strictest of runtime and session caps and ignores attempts to raise them', async () => {
    const result = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxModelCalls: 10 })),
      input: {},
      budget: { maxModelCalls: 0 },          // runtime layer
      sessionBudget: { maxModelCalls: 5 },   // user/session layer
      handlers: handlers((invocation) => {
        invocation.budget.consumeModelCall();
        return { summary: 'done' };
      }),
    });
    expect(result.terminalFailure?.code).toBe('budget.model-calls-exceeded');
    const ttl = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies({ maxNodeVisits: 2 })),
      input: {},
      budget: { maxNodeVisits: 500 },
      handlers: handlers(() => ({ summary: 'done' })),
    });
    expect(ttl.terminalFailure?.code).toBe('max-node-visits');
  });

  it('continues counters across a resume instead of resetting them', async () => {
    const execute = vi.fn(() => ({ summary: 'done' }));
    const first = await runWorkflowProfileKernel({ profile: twoStepProfile(basePolicies()), input: {}, handlers: handlers(execute) });
    // A resume re-enters at the node the previous attempt stopped on.
    const resumedProfile = twoStepProfile(basePolicies());
    const resumed = await runWorkflowProfileKernel({
      profile: { ...resumedProfile, workflow: { ...resumedProfile.workflow, startNode: 'work' } },
      input: {},
      usage: first.budget,
      visitCount: first.visits,
      handlers: handlers(execute),
    });
    expect(first.visits).toBe(3);
    expect(resumed.visits).toBe(5);
    expect(resumed.budget.visits).toBe(5);
    expect(resumed.budget).toEqual({ ...resumed.budget, visits: 5 });
  });

  it('has no path for a spent budget to be replenished by a resume', async () => {
    const profile = twoStepProfile(basePolicies({ maxNodeVisits: 3, onLimit: 'handoff' }));
    const execute = vi.fn(() => ({ summary: 'done' }));
    const spent = { visits: 3, modelCalls: 0, toolCalls: 0, durationMs: 0 };
    const first = await runWorkflowProfileKernel({ profile, input: {}, usage: spent, visitCount: 3, handlers: handlers(execute) });
    expect(first.status).toBe('handoff');
    expect(first.terminalFailure?.category).toBe('visit-cap');
    expect(first.terminalFailure?.code).toBe('max-node-visits');
    expect(first.visits).toBe(3);
    expect(execute).not.toHaveBeenCalled();

    // Runtime and session layers can only lower a cap; none of them resets the counter.
    const second = await runWorkflowProfileKernel({
      profile,
      input: {},
      usage: spent,
      visitCount: 3,
      budget: { maxNodeVisits: 900 },
      sessionBudget: { maxNodeVisits: 900 },
      handlers: handlers(execute),
    });
    expect(second.status).toBe('handoff');
    expect(second.terminalFailure?.code).toBe('max-node-visits');
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops at the next transition after a cancellation and reports it as terminal', async () => {
    const controller = new AbortController();
    const execute = vi.fn(() => {
      controller.abort();
      return { summary: 'done' };
    });
    const result = await runWorkflowProfileKernel({
      profile: twoStepProfile(basePolicies()),
      input: {},
      signal: controller.signal,
      handlers: handlers(execute),
    });
    expect(result.status).toBe('cancelled');
    expect(result.terminalFailure?.category).toBe('cancelled');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
