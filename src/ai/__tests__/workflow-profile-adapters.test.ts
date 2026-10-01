import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApprovalPort,
  createExecutorPort,
  createPlannerPort,
  createReviewerPort,
  executorOutcomeFromResult,
  DEFAULT_APPROVAL_RENDER,
} from '../workflow-profiles/orchestrator-adapters.js';
import { runWorkflowProfileKernel } from '../workflow-profiles/profile-kernel.js';
import { createWorkflowProfileHandlers } from '../workflow-profiles/node-handlers.js';
import { contentDigest, UNTRUSTED_CONTENT_POLICY } from '../workflow-profiles/untrusted-content.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

function reviewOf(outcome: 'success' | 'partial-success' | 'failure' | 'cancelled', summary = `${outcome} summary`, accepted = 1) {
  return {
    planId: 'p1',
    goal: 'g',
    outcome,
    acceptedFindings: Array.from({ length: accepted }, (_unused, index) => ({
      stepId: `s${index}`, title: 'finding', description: 'd', severity: 'info' as const,
    })),
    rejectedFindings: [],
    incompleteSteps: [],
    finalSummary: summary,
    usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
  };
}

function executionResult(overrides: Partial<PlanExecutionResult> = {}): PlanExecutionResult {
  return {
    planId: 'p1',
    status: 'completed',
    completedSteps: 3,
    failedSteps: 0,
    totalSteps: 3,
    incompleteSteps: [],
    replanningAttempts: 0,
    ...overrides,
  } as PlanExecutionResult;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Workflow Profile planner adapter', () => {
  it('hands the confined goal to the existing planner and returns rendered plan text', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const planner = {
      plan: (request: string, usagePlanId?: string, modelId?: string, mode?: unknown) => {
        calls.push({ request, usagePlanId, modelId, mode });
        return Promise.resolve({ kind: 'plan' as const, plan: { id: 'p1' }, needsClarification: [] });
      },
    };
    const port = createPlannerPort({ planner, modelId: 'm1', renderPlan: () => 'RENDERED PLAN' });
    const outcome = await port.plan({
      nodeId: 'plan',
      goal: { kind: 'goal', source: 'request', digest: contentDigest('do it'), bytes: 5, truncated: false, confined: '<untrusted-data kind="goal" source="request">\ndo it\n</untrusted-data>' },
      mode: 'decompose',
    });
    expect(outcome).toEqual({ kind: 'plan', plan: { id: 'p1' }, planText: 'RENDERED PLAN' });
    expect(calls[0]).toMatchObject({ request: '<untrusted-data kind="goal" source="request">\ndo it\n</untrusted-data>', modelId: 'm1' });
  });

  it('reports clarification, and a plan-less result as clarification rather than an empty plan', async () => {
    const clarify = createPlannerPort({ planner: { plan: () => Promise.resolve({ kind: 'clarify' as const, needsClarification: ['which repo?'] }) } });
    const clarified = await clarify.plan({ nodeId: 'plan', goal: confined('g'), mode: 'decompose' });
    expect(clarified).toEqual({ kind: 'clarify', needsClarification: ['which repo?'] });

    const answer = createPlannerPort({ planner: { plan: () => Promise.resolve({ kind: 'answer' as const, answer: 'hello' }) } });
    expect(await answer.plan({ nodeId: 'plan', goal: confined('g'), mode: 'direct' })).toEqual({ kind: 'answer', answer: 'hello' });

    const planless = createPlannerPort({ planner: { plan: () => Promise.resolve({ kind: 'plan' as const }) } });
    expect(await planless.plan({ nodeId: 'plan', goal: confined('g'), mode: 'decompose' })).toEqual({ kind: 'clarify', needsClarification: [] });
  });
});

function confined(text: string) {
  return { kind: 'goal', source: 'request', digest: contentDigest(text), bytes: Buffer.byteLength(text), truncated: false, confined: `<untrusted-data kind="goal" source="request">\n${text}\n</untrusted-data>` };
}

describe('Workflow Profile executor adapter', () => {
  it('maps a PlanExecutionResult onto the execute ports', () => {
    expect(executorOutcomeFromResult(executionResult())).toMatchObject({ status: 'completed', summary: '3/3 steps completed' });
    const partial = executorOutcomeFromResult(executionResult({ status: 'failed-partial', completedSteps: 2, failedSteps: 1, incompleteSteps: [{ stepId: 's3', description: 'd', reason: 'tool error' }] }));
    expect(partial.status).toBe('partial');
    expect(partial.summary).toContain('s3: tool error');
    expect(partial.failure).toBeUndefined();
    const failed = executorOutcomeFromResult(executionResult({ status: 'failed-partial', completedSteps: 0, failedSteps: 2, incompleteSteps: [{ stepId: 's1', description: 'd', reason: 'denied' }] }));
    expect(failed.status).toBe('failed');
    expect(failed.failure).toEqual({ category: 'tool', code: 'execute.plan-failed', retryable: false });
  });

  it('delegates to PlanRuntime.execute with the plan produced upstream', async () => {
    const execute = vi.fn(() => Promise.resolve(executionResult()));
    const port = createExecutorPort({ planRuntime: { execute } });
    const outcome = await port.execute({ nodeId: 'work', goal: confined('g'), plan: { id: 'p1' }, mode: 'assisted', requireApprovalForSideEffects: true });
    expect(execute).toHaveBeenCalledWith({ id: 'p1' }, { nodeId: 'work' });
    expect(outcome.status).toBe('completed');
    await expect(port.execute({ nodeId: 'work', goal: confined('g'), mode: 'assisted', requireApprovalForSideEffects: true })).rejects.toThrow(/requires a plan/);

    // A cancelled run is terminal, never a routeable status.
    const cancelled = createExecutorPort({ planRuntime: { execute: () => Promise.resolve(executionResult({ status: 'cancelled' })) } });
    await expect(cancelled.execute({ nodeId: 'work', goal: confined('g'), plan: { id: 'p1' }, mode: 'assisted', requireApprovalForSideEffects: true }))
      .rejects.toMatchObject({ name: 'WorkflowNodeError', options: { category: 'cancelled', code: 'execute.cancelled' } });
  });
});

describe('Workflow Profile reviewer adapter', () => {
  const plan = { id: 'p1', steps: [] } as never;

  it('maps the existing final review outcome onto pass/revise/reject', async () => {
    for (const [outcome, decision] of [['success', 'pass'], ['partial-success', 'revise'], ['failure', 'reject']] as const) {
      const finalReviewer = { review: () => Promise.resolve(reviewOf(outcome)) };
      const port = createReviewerPort({ finalReviewer });
      const result = await port.review({ nodeId: 'judge', rubricRef: 'r', allowedDecisions: ['pass', 'revise', 'reject'], content: {}, raw: { plan, execution: executionResult() } });
      expect(result.decision).toBe(decision);
      expect(result.reason).toBe(`${outcome} summary`);
      expect(result.findings).toHaveLength(1);
    }
  });

  it('treats a cancelled run as a terminal cancellation, not a verdict', async () => {
    const port = createReviewerPort({ finalReviewer: { review: () => Promise.resolve(reviewOf('cancelled', 'stopped', 0)) } });
    await expect(port.review({ nodeId: 'judge', rubricRef: 'r', allowedDecisions: ['pass'], content: {}, raw: { plan, execution: executionResult() } }))
      .rejects.toMatchObject({ name: 'WorkflowNodeError', options: { category: 'cancelled', code: 'review.cancelled' } });
  });

  it('uses the acceptance checker for a step review and fails closed when nothing can judge', async () => {
    const port = createReviewerPort({
      acceptanceChecker: { checkStep: () => Promise.resolve({ accepted: false, reason: 'criteria unmet' }) },
      stepSelector: () => ({ step: { id: 's1' }, task: { id: 't1' } }),
    });
    expect(await port.review({ nodeId: 'judge', rubricRef: 'r', allowedDecisions: ['pass', 'revise'], content: {}, raw: { step: {}, task: {} } }))
      .toEqual({ decision: 'revise', reason: 'criteria unmet' });

    const broken = createReviewerPort({ acceptanceChecker: { checkStep: () => Promise.resolve({ accepted: false, reason: 'model down', checkerError: true }) }, stepSelector: () => ({ step: {}, task: {} }) });
    await expect(broken.review({ nodeId: 'judge', rubricRef: 'r', allowedDecisions: ['pass'], content: {}, raw: {} })).rejects.toThrow(/acceptance check failed/);

    const unwired = createReviewerPort({});
    await expect(unwired.review({ nodeId: 'judge', rubricRef: 'r', allowedDecisions: ['pass'], content: {}, raw: {} })).rejects.toThrow(/no reviewer wired/);
  });
});

describe('Workflow Profile approval adapter', () => {
  const base = {
    nodeId: 'ask',
    prompt: 'Approve the plan?',
    approvalType: 'continue' as const,
    responseKind: 'decision' as const,
    show: {},
  };

  it('turns a confirmation into an approval and shows bound digests inside the same interaction', async () => {
    const prompts: string[] = [];
    const port = createApprovalPort({ confirm: (text) => { prompts.push(text); return Promise.resolve({ confirmed: true }); } });
    const boundDigest = contentDigest({ plan: 'p1' });
    const approved = await port.request({ ...base, boundPort: 'plan', boundDigest });
    expect(approved).toEqual({ status: 'approved', approvedDigest: boundDigest });
    expect(prompts[0]).toContain(boundDigest);
    expect(DEFAULT_APPROVAL_RENDER({ ...base, boundPort: 'plan', boundDigest, show: {} })).toContain('Bound content digest (plan)');

    const denied = createApprovalPort({ confirm: () => Promise.resolve({ confirmed: false, feedback: 'not yet' }) });
    expect(await denied.request(base)).toEqual({ status: 'denied', reason: 'not yet' });
  });

  it('reports expiry and cancellation instead of treating them as approval', async () => {
    vi.useFakeTimers();
    const expiring = createApprovalPort({ confirm: () => new Promise(() => undefined) });
    const pending = expiring.request({ ...base, timeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ status: 'expired', reason: 'approval timed out' });

    const cancelling = createApprovalPort({ confirm: () => Promise.reject(new Error('interaction cancelled')) });
    expect(await cancelling.request(base)).toEqual({ status: 'cancelled', reason: 'interaction cancelled' });
  });

  it('runs a full approval gate through the kernel with the real port shape', async () => {
    const approvals = createApprovalPort({ confirm: () => Promise.resolve({ confirmed: true }) });
    const document = {
      schemaVersion: '1.0.0',
      profile: { id: 'test.adapter', name: 'Adapter gate', version: '1.0.0', author: 'tests' },
      dependencies: [],
      workflow: {
        startNode: 'start',
        nodes: [
          { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { plan: { type: 'object', required: true } }, config: {} },
          {
            id: 'ask', kind: 'approval', goal: 'ask',
            inputs: { plan: { type: 'object', required: true } },
            outputs: { plan: { type: 'object', required: true }, decision: { type: 'object', required: true } },
            config: { prompt: 'Approve?', approvalType: 'side-effect', responseKind: 'decision', bindsTo: 'plan' },
          },
          { id: 'ok', kind: 'end', goal: 'ok', inputs: { plan: { type: 'object', required: true } }, outputs: { plan: { type: 'object', required: true } }, config: { outcome: 'success', emit: { plan: 'plan' } } },
        ],
        edges: [
          { from: 'start', to: 'ask', map: { plan: '/plan' } },
          { from: 'ask', to: 'ok', map: { plan: '/plan' } },
        ],
      },
      policies: {
        execution: { maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 5, maxToolCalls: 5, onLimit: 'fail' },
        tools: { allowedToolsets: [] },
        approvals: { policy: 'runtime-default' },
      },
      result: [{ fromNode: 'ok', port: 'plan', kind: 'response', outcome: 'success' }],
    } as unknown as WorkflowProfileDocument;

    const handlers = createWorkflowProfileHandlers({ approvals }) as Record<string, never>;
    const result = await runWorkflowProfileKernel({ profile: document, input: { plan: { id: 'p1' } }, handlers });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['start', 'ask', 'ok']);
    expect(UNTRUSTED_CONTENT_POLICY).toContain('<untrusted-data>');
  });
});
