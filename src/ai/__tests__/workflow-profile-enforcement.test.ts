import { describe, expect, it, vi } from 'vitest';
import {
  assertNoAuthorityIncrease,
  assertSideEffectAuthorized,
  assertToolAccess,
  detectAuthorityIncrease,
  narrowAccessPolicy,
} from '../workflow-profiles/profile-access-guard.js';
import { createWorkflowProfileHandlers } from '../workflow-profiles/node-handlers.js';
import { WorkflowNodeError, runWorkflowProfileKernel, type WorkflowNodeHandler } from '../workflow-profiles/profile-kernel.js';
import { WorkflowBudget } from '../workflow-profiles/profile-budget.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const stringPort = () => ({ type: 'string', required: true });

const policies = (overrides: Record<string, unknown> = {}) => ({
  execution: { maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 10, maxToolCalls: 10, onLimit: 'fail', ...overrides },
  tools: { allowedToolsets: [] },
  approvals: { policy: 'runtime-default' },
});

function executeProfile(config: Record<string, unknown> = {}, nodePolicies: unknown = policies()): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.enforce', name: 'Enforcement fixture', version: '1.0.0', author: 'tests' },
    dependencies: [],
    workflow: {
      startNode: 'start',
      nodes: [
        { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
        { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { summary: stringPort() }, config },
        { id: 'finish', kind: 'end', goal: 'finish', inputs: { summary: stringPort() }, outputs: { summary: stringPort() }, config: { outcome: 'success', emit: { summary: 'summary' } } },
      ],
      edges: [
        { from: 'start', to: 'work', map: { goal: '/goal' } },
        { from: 'work', to: 'finish', map: { summary: '/summary' } },
      ],
    },
    policies: nodePolicies,
    result: [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  } as unknown as WorkflowProfileDocument;
}

function planProfile(): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.plan', name: 'Plan fixture', version: '1.0.0', author: 'tests' },
    dependencies: [],
    workflow: {
      startNode: 'start',
      nodes: [
        { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
        { id: 'plan', kind: 'planner', goal: 'plan', inputs: { goal: stringPort() }, outputs: { planText: stringPort() }, config: {} },
        { id: 'finish', kind: 'end', goal: 'finish', inputs: { planText: stringPort() }, outputs: { planText: stringPort() }, config: { outcome: 'success', emit: { planText: 'planText' } } },
      ],
      edges: [
        { from: 'start', to: 'plan', map: { goal: '/goal' } },
        { from: 'plan', to: 'finish', map: { planText: '/planText' } },
      ],
    },
    policies: policies(),
    result: [{ fromNode: 'finish', port: 'planText', kind: 'response', outcome: 'success' }],
  } as unknown as WorkflowProfileDocument;
}

/** Every profile layer below the profile itself may only narrow what the runtime permits. */
describe('effective access policy', () => {
  it('intersects tool sets and lets an absent layer never widen one', () => {
    const policy = narrowAccessPolicy([
      { toolIds: ['read-file', 'write-file', 'delete-file'] },
      undefined,
      { toolIds: ['read-file', 'write-file'] },
      { toolIds: [] },
    ]);
    expect(policy.toolIds).toEqual([]); // the empty layer removes everything: no tools, no exemption
    expect(narrowAccessPolicy([{ toolIds: ['a', 'b'] }, {}]).toolIds).toEqual(['a', 'b']);
    expect(narrowAccessPolicy([{ toolIds: ['a', 'b'] }, { toolIds: ['b'] }]).toolIds).toEqual(['b']);
  });

  it('requires an explicit tool universe before honouring a wildcard layer', () => {
    const withoutUniverse = narrowAccessPolicy([{ toolIds: ['*'] }]);
    expect(withoutUniverse.toolIds).toEqual([]);
    expect(withoutUniverse.notes.join(' ')).toMatch(/known tool universe/i);

    const withUniverse = narrowAccessPolicy([{ toolIds: ['*'] }], { knownToolUniverse: ['b', 'a'] });
    expect(withUniverse.toolIds).toEqual(['a', 'b']);
  });

  it('folds budgets to the per-dimension minimum, never additively', () => {
    const policy = narrowAccessPolicy([
      { budget: { maxNodeVisits: 100, maxModelCalls: 8 } },
      { budget: { maxToolCalls: 3 } },
      { budget: { maxNodeVisits: 500, maxToolCalls: 90 } }, // a later wider layer cannot raise anything
    ]);
    expect(policy.budget).toEqual({ maxNodeVisits: 100, maxDurationSeconds: 86_400, maxModelCalls: 8, maxToolCalls: 3 });
  });

  it('takes the strictest approval policy and treats an unknown one as maximally strict', () => {
    expect(narrowAccessPolicy([{ approvalPolicy: 'runtime-default' }, { approvalPolicy: 'side-effects' }]).approvalPolicy)
      .toBe('side-effects');
    expect(narrowAccessPolicy([{ approvalPolicy: 'every-tool-call' }, { approvalPolicy: 'runtime-default' }]).approvalPolicy)
      .toBe('every-tool-call');
    const unknown = narrowAccessPolicy([{ approvalPolicy: 'runtime-default' }, { approvalPolicy: 'whatever-this-is' }]);
    expect(unknown.approvalPolicy).toBe('whatever-this-is');
    expect(unknown.approvalStrictness).toBeGreaterThan(narrowAccessPolicy([{ approvalPolicy: 'every-tool-call' }]).approvalStrictness);
    expect(unknown.notes.join(' ')).toMatch(/maximally strict/i);
  });

  it('detects a widened authority and refuses it', () => {
    const before = { toolIds: ['read-file'], budget: { maxModelCalls: 5, maxNodeVisits: 10 }, approvalStrictness: 1 };
    expect(detectAuthorityIncrease(before, before)).toEqual([]);
    expect(detectAuthorityIncrease(before, { ...before, toolIds: ['read-file', 'write-file'] })).toHaveLength(1);
    expect(detectAuthorityIncrease(before, { ...before, budget: { maxModelCalls: 6 } })).toHaveLength(1);
    expect(detectAuthorityIncrease(before, { ...before, approvalStrictness: 0 })).toHaveLength(1);
    expect(() => assertNoAuthorityIncrease(before, { ...before, approvalStrictness: 0 })).toThrow(/increase authority/i);
    expect(() => assertNoAuthorityIncrease(before, { ...before, approvalStrictness: 2, toolIds: [] })).not.toThrow();
  });
});

/** Schema validation is not authorization: the call site must decide. */
describe('authorization at the call site', () => {
  const callSite = { nodeId: 'work', toolId: 'write-file', effectiveToolIds: ['read-file', 'write-file'], runtimePermittedToolIds: ['read-file'] };

  it('denies a tool the runtime does not permit, and a tool outside the effective set', () => {
    expect(() => assertToolAccess(callSite)).toThrow(/not permitted by the Runtime/);
    expect(() => assertToolAccess({ ...callSite, runtimePermittedToolIds: ['read-file', 'write-file'] })).not.toThrow();
    expect(() => assertToolAccess({ ...callSite, runtimePermittedToolIds: [...callSite.runtimePermittedToolIds, 'write-file'], effectiveToolIds: ['read-file'] }))
      .toThrow(/not in the effective tool set/);
    expect(() => assertToolAccess({ ...callSite, runtimePermittedToolIds: ['write-file'], effectiveToolIds: ['read-file', 'write-file'] }))
      .toThrow(/contains tools the Runtime does not permit/);
    try {
      assertToolAccess({ ...callSite, toolId: 'rm-rf' });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowNodeError);
      expect((error as WorkflowNodeError).options.code).toBe('tool.denied');
      expect((error as WorkflowNodeError).options.category).toBe('security-denied');
    }
  });

  it('requires runtime authorization in addition to any approval, and binds the approval digest', () => {
    const approval = { status: 'approved', digest: 'sha256:abc', boundPort: 'planText' };
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: true, approvalRequired: true, approval, requiredDigest: 'sha256:abc' })).not.toThrow();
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: false, approvalRequired: true, approval, requiredDigest: 'sha256:abc' }))
      .toThrow(/Runtime authorization is required/);
    // A digest-bound plan approval never substitutes the runtime's own authorization.
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: false, approvalRequired: true, approval }))
      .toThrow(/effect\.runtime-authorization-missing|Runtime authorization/);
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: true, approvalRequired: true }))
      .toThrow(/requires an approval/);
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: true, approvalRequired: true, approval: { status: 'denied', digest: 'sha256:abc' } }))
      .toThrow(/requires an approval/);
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: true, approvalRequired: true, approval, requiredDigest: 'sha256:other' }))
      .toThrow(/bound to different content/);
    // No approval is required when the profile does not ask for one.
    expect(() => assertSideEffectAuthorized({ nodeId: 'work', runtimeAuthorized: true, approvalRequired: false })).not.toThrow();
  });
});

function reviewProfile(): WorkflowProfileDocument {
  const document = planProfile();
  (document as { profile: { id: string } }).profile.id = 'test.review';
  const workflow = document.workflow as unknown as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  workflow.nodes[1] = {
    id: 'plan', kind: 'review', goal: 'check', inputs: { goal: stringPort() },
    outputs: { decision: stringPort() }, config: { rubricRef: 'hootl.default-review', allowedDecisions: ['pass', 'reject'] },
  };
  workflow.edges[1] = { from: 'plan', to: 'finish', map: { planText: '/decision' } };
  return document;
}

/** The budget must be charged before the real work happens, never after. */
describe('budget charged before delegation', () => {
  it('never calls the planner or reviewer when the model budget is already spent', async () => {
    const plan = vi.fn(async () => ({ kind: 'plan' as const, plan: { items: [] }, planText: 'step 1' }));
    const review = vi.fn(async () => ({ decision: 'pass', reason: 'fine' }));
    const handlers = createWorkflowProfileHandlers({ planner: { plan }, reviewer: { review } }) as Partial<Record<string, WorkflowNodeHandler>>;

    const planResult = await runWorkflowProfileKernel({
      profile: planProfile(), input: { goal: 'g' }, budget: { maxModelCalls: 0 }, handlers,
    });
    expect(planResult.terminalFailure).toMatchObject({ category: 'budget', code: 'budget.model-calls-exceeded' });
    expect(plan).not.toHaveBeenCalled();

    const reviewResult = await runWorkflowProfileKernel({
      profile: reviewProfile(), input: { goal: 'g' }, budget: { maxModelCalls: 0 }, handlers,
    });
    expect(reviewResult.terminalFailure).toMatchObject({ category: 'budget', code: 'budget.model-calls-exceeded' });
    expect(review).not.toHaveBeenCalled();

    // The same cap, enforced directly: a zero model-call budget is spent from the start.
    const budget = new WorkflowBudget({ caps: { maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 0, maxToolCalls: 10 } });
    expect(budget.recordModelCall(1)?.code).toBe('budget.model-calls-exceeded');
  });

  it('charges the calls an executor reports and stops once the tool budget is spent', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const, summary: 'done', usage: { modelCalls: 1, toolCalls: 2 } }));
    const handlers = createWorkflowProfileHandlers({ executor: { execute } }) as Partial<Record<string, WorkflowNodeHandler>>;

    const within = await runWorkflowProfileKernel({ profile: executeProfile(), input: { goal: 'g' }, handlers });
    expect(within.status).toBe('success');
    expect(within.budget).toMatchObject({ modelCalls: 1, toolCalls: 2 });

    const overTool = await runWorkflowProfileKernel({
      profile: executeProfile({}, policies({ maxToolCalls: 1 })),
      input: { goal: 'g' },
      handlers,
    });
    expect(overTool.status).toBe('failure');
    expect(overTool.terminalFailure).toMatchObject({ category: 'budget', code: 'budget.tool-calls-exceeded' });
    expect(execute).toHaveBeenCalledTimes(2); // charged after the real call: the overspend is what stops the run
  });

  it('keeps a handler-visible denial terminal: it is not retried and not routed', async () => {
    const calls: string[] = [];
    const guarded: WorkflowNodeHandler = (invocation) => {
      calls.push(invocation.node.id);
      assertToolAccess({ nodeId: invocation.node.id, toolId: 'delete-file', effectiveToolIds: ['read-file'], runtimePermittedToolIds: ['read-file'] });
      return { summary: 'never' };
    };
    const result = await runWorkflowProfileKernel({
      profile: executeProfile({ onError: { strategy: 'retry', maxAttempts: 5, backoffSeconds: 0 } }),
      input: { goal: 'g' },
      handlers: { intake: () => ({ goal: 'g' }), execute: guarded },
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure).toMatchObject({ category: 'security-denied', code: 'tool.denied', retryable: false });
    expect(calls).toEqual(['work']); // one attempt: a denial is never retried
    expect(result.nodeSequence).toEqual(['start', 'work']);
  });
});
