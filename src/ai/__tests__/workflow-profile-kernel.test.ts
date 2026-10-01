import { describe, expect, it, vi } from 'vitest';
import { runWorkflowProfileKernel, WorkflowNodeError, effectiveMaxNodeVisits, TERMINAL_FAILURE_CATEGORIES } from '../workflow-profiles/profile-kernel.js';
import { isWorkflowProfileExecutionEnabled, prepareWorkflowProfileRun, WORKFLOW_PROFILE_FLAG_ENV_VAR } from '../workflow-profiles/profile-runner.js';
import { validateWorkflowProfileSemantics } from '../workflow-profiles/profile-semantic-validator.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';
import type { WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import { dependencyDigest } from '../workflow-profiles/profile-digest.js';

const PERSONA_ID = 'test.persona';
const STUB_PERSONA = { id: PERSONA_ID, name: 'Stub persona', system: 'Stub executor persona.', allowedTools: [] };
const personaDependency = { kind: 'persona', id: PERSONA_ID, digest: dependencyDigest('persona', PERSONA_ID, { ...STUB_PERSONA }) };

// ─── Fixtures ─────────────────────────────────────────────────────

const policies = (maxNodeVisits = 30) => ({
  execution: { maxNodeVisits, maxDurationSeconds: 60, maxModelCalls: 10, maxToolCalls: 10, onLimit: 'fail' },
  tools: { allowedToolsets: [] },
  approvals: { policy: 'runtime-default' },
});

function profile(nodes: unknown[], edges: unknown[], result: unknown[], startNode = 'start', maxNodeVisits = 30): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.profile', name: 'Kernel fixture', version: '1.0.0', author: 'tests' },
    dependencies: [personaDependency],
    workflow: { startNode, nodes, edges },
    policies: policies(maxNodeVisits),
    result,
  } as unknown as WorkflowProfileDocument;
}

const stringPort = (required = true) => ({ type: 'string', required });
const boolPort = (required = true) => ({ type: 'boolean', required });
const intPort = (required = true) => ({ type: 'integer', required });

function endNode(id: string, outcome: string, portName: string, port: Record<string, unknown>) {
  // Distinct objects per position: aliased references are rejected as non-JSON input.
  return { id, kind: 'end', goal: id, inputs: { [portName]: structuredClone(port) }, outputs: { [portName]: structuredClone(port) }, config: { outcome, emit: { [portName]: portName } } };
}

function linearProfile(): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
      endNode('finish', 'success', 'summary', stringPort()),
    ],
    [{ from: 'start', to: 'finish', map: { summary: '/goal' } }],
    [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  );
}

/** Condition with two overlapping `true` edges: priority decides, declaration order breaks ties. */
function firstMatchProfile(priorities: { winner: number; shadowed: number }, declaredOrder: 'shadowed-first' | 'winner-first'): WorkflowProfileDocument {
  const winnerEdge = { from: 'check', to: 'accepted', map: { matched: '/matched' }, when: { path: '/matched', operator: 'equals', value: true }, priority: priorities.winner };
  const shadowedEdge = { from: 'check', to: 'shadowed', map: { matched: '/matched' }, when: { path: '/matched', operator: 'equals', value: true }, priority: priorities.shadowed };
  const falseEdge = { from: 'check', to: 'rejected', map: { matched: '/matched' }, when: { path: '/matched', operator: 'equals', value: false } };
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { flag: boolPort() }, config: {} },
      { id: 'check', kind: 'condition', goal: 'check', inputs: { flag: boolPort() }, outputs: { flag: boolPort(), matched: boolPort() }, config: { predicate: { path: '/flag', operator: 'equals', value: true } } },
      endNode('accepted', 'success', 'matched', boolPort()),
      endNode('shadowed', 'handoff', 'matched', boolPort()),
      endNode('rejected', 'rejected', 'matched', boolPort()),
    ],
    [
      { from: 'start', to: 'check', map: { flag: '/flag' } },
      ...(declaredOrder === 'shadowed-first' ? [shadowedEdge, winnerEdge] : [winnerEdge, shadowedEdge]),
      falseEdge,
    ],
    [
      { fromNode: 'accepted', port: 'matched', kind: 'response', outcome: 'success' },
      { fromNode: 'shadowed', port: 'matched', kind: 'response', outcome: 'handoff' },
      { fromNode: 'rejected', port: 'matched', kind: 'response', outcome: 'rejected' },
    ],
  );
}

/** Enum decision with an explicit default fallback. */
function defaultFallbackProfile(): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { mode: { type: 'string', required: true, enum: ['ok', 'retry'] } }, config: {} },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { mode: { type: 'string', required: true, enum: ['ok', 'retry'] } }, outputs: { result: { type: 'string', required: true, enum: ['ok', 'retry'] } }, bindings: { personaRef: PERSONA_ID }, config: {} },
      endNode('okEnd', 'success', 'value', { type: 'string', required: true, enum: ['ok', 'retry'] }),
      endNode('retryEnd', 'handoff', 'value', { type: 'string', required: true, enum: ['ok', 'retry'] }),
    ],
    [
      { from: 'start', to: 'work', map: { mode: '/mode' } },
      { from: 'work', to: 'okEnd', map: { value: '/result' }, when: { path: '/result', operator: 'equals', value: 'ok' } },
      { from: 'work', to: 'retryEnd', map: { value: '/result' }, default: true },
    ],
    [
      { fromNode: 'okEnd', port: 'value', kind: 'response', outcome: 'success' },
      { fromNode: 'retryEnd', port: 'value', kind: 'response', outcome: 'handoff' },
    ],
  );
}

/** Bounded fix loop whose exhaustion either routes to a handoff end node or fails closed. */
function loopProfile(exhaustion: 'route' | 'fail' = 'route'): WorkflowProfileDocument {
  const routing = exhaustion === 'route';
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
      { id: 'check', kind: 'condition', goal: 'check', inputs: { goal: stringPort() }, outputs: { goal: stringPort(), matched: boolPort() }, config: { predicate: { path: '/goal', operator: 'exists' } } },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { goal: stringPort(), done: boolPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
      endNode('finish', 'success', 'summary', stringPort()),
      ...(routing ? [endNode('handoff', 'handoff', 'flag', boolPort())] : []),
    ],
    [
      { from: 'start', to: 'check', map: { goal: '/goal' } },
      { from: 'check', to: 'work', map: { goal: '/goal' }, when: { path: '/matched', operator: 'equals', value: true } },
      { from: 'check', to: 'finish', map: { summary: '/goal' }, default: true },
      {
        from: 'work', to: 'check', map: { goal: '/goal' },
        loop: routing
          ? { maxIterations: 2, counterId: 'fix-loop', onExhausted: { strategy: 'route', to: 'handoff', map: { flag: '/done' } } }
          : { maxIterations: 2, counterId: 'fix-loop', onExhausted: { strategy: 'fail' } },
      },
    ],
    [
      { fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' },
      ...(routing ? [{ fromNode: 'handoff', port: 'flag', kind: 'response', outcome: 'handoff' }] : []),
    ],
  );
}

/**
 * Two overlapping bounded cycles with distinct counters: outer `plan-loop` around
 * `work` and inner `inner-loop` around `draft`, sharing the `check` node.
 */
function nestedLoopProfile(): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
      { id: 'check', kind: 'condition', goal: 'check', inputs: { goal: stringPort() }, outputs: { goal: stringPort(), matched: boolPort() }, config: { predicate: { path: '/goal', operator: 'exists' } } },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { goal: stringPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
      { id: 'draft', kind: 'execute', goal: 'draft', inputs: { goal: stringPort() }, outputs: { goal: stringPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
      endNode('finish', 'success', 'summary', stringPort()),
    ],
    [
      { from: 'start', to: 'check', map: { goal: '/goal' } },
      { from: 'check', to: 'draft', map: { goal: '/goal' }, when: { path: '/matched', operator: 'equals', value: true } },
      { from: 'check', to: 'finish', map: { summary: '/goal' }, default: true },
      { from: 'draft', to: 'work', map: { goal: '/goal' }, loop: { maxIterations: 3, counterId: 'inner-loop', onExhausted: { strategy: 'route', to: 'work', map: { goal: '/goal' } } } },
      { from: 'work', to: 'check', map: { goal: '/goal' }, loop: { maxIterations: 5, counterId: 'plan-loop', onExhausted: { strategy: 'fail' } } },
    ],
    [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  );
}

/** A cycle whose declared bounds are far above the runtime cap: only the hard cap can stop it. */
function runawayProfile(): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
      { id: 'check', kind: 'condition', goal: 'check', inputs: { goal: stringPort() }, outputs: { goal: stringPort(), matched: boolPort() }, config: { predicate: { path: '/goal', operator: 'exists' } } },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { goal: stringPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
      endNode('finish', 'success', 'summary', stringPort()),
    ],
    [
      { from: 'start', to: 'check', map: { goal: '/goal' } },
      { from: 'check', to: 'work', map: { goal: '/goal' }, when: { path: '/matched', operator: 'equals', value: true } },
      { from: 'check', to: 'finish', map: { summary: '/goal' }, default: true },
      { from: 'work', to: 'check', map: { goal: '/goal' }, loop: { maxIterations: 20, counterId: 'runaway', onExhausted: { strategy: 'route', to: 'check', map: { goal: '/goal' } } } },
    ],
    [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  );
}

function retryProfile(policy: Record<string, unknown>): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { n: intPort() }, config: {} },
      { id: 'work', kind: 'execute', goal: 'work', inputs: { n: intPort() }, outputs: { done: boolPort() }, bindings: { personaRef: PERSONA_ID }, onError: policy, config: {} },
      endNode('finish', 'success', 'done', boolPort()),
    ],
    [
      { from: 'start', to: 'work', map: { n: '/n' } },
      { from: 'work', to: 'finish', map: { done: '/done' } },
    ],
    [{ fromNode: 'finish', port: 'done', kind: 'response', outcome: 'success' }],
  );
}

function errorRouteProfile(): WorkflowProfileDocument {
  return profile(
    [
      { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { n: intPort() }, config: {} },
      {
        id: 'work', kind: 'execute', goal: 'work', inputs: { n: intPort() }, outputs: { done: boolPort() },
        bindings: { personaRef: PERSONA_ID },
        onError: { strategy: 'route', routeTo: 'recover', routeMap: { code: '/failure/code', attempt: '/node/attempt' } },
        config: {},
      },
      { id: 'recover', kind: 'execute', goal: 'recover', inputs: { code: stringPort(), attempt: intPort() }, outputs: { ok: boolPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
      endNode('finish', 'success', 'ok', boolPort()),
    ],
    [
      { from: 'start', to: 'work', map: { n: '/n' } },
      { from: 'work', to: 'finish', map: { ok: '/done' } },
      { from: 'recover', to: 'finish', map: { ok: '/ok' } },
    ],
    [{ fromNode: 'finish', port: 'ok', kind: 'response', outcome: 'success' }],
  );
}

const sources: WorkflowProfileComponentSources = {
  personas: { get: (id: string) => (id === PERSONA_ID ? { ...STUB_PERSONA } : undefined) },
  skills: { get: () => undefined },
  models: { get: () => undefined },
  toolsets: { get: () => undefined },
  rubrics: { get: () => undefined },
};

function expectContractValid(document: WorkflowProfileDocument): void {
  expect(validateWorkflowProfileSemantics(document)).toEqual([]);
}

function codes(error: unknown): string[] {
  expect(error).toBeInstanceOf(WorkflowProfileLoadError);
  const diagnostics = (error as WorkflowProfileLoadError).diagnostics;
  return diagnostics.map((diagnostic) => diagnostic.code);
}

// ─── Kernel ───────────────────────────────────────────────────────

describe('Workflow Profile kernel', () => {
  it('runs a linear profile and emits the declared end result', async () => {
    const document = linearProfile();
    expectContractValid(document);
    const result = await runWorkflowProfileKernel({
      profile: document,
      input: {},
      handlers: { intake: () => ({ goal: 'ship it' }) },
    });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['start', 'finish']);
    expect(result.results).toEqual([{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }]);
    expect(result.visits).toBe(2);
  });

  it('selects the first matching predicate by ascending priority, then declaration order', async () => {
    const priorityFirst = firstMatchProfile({ winner: 10, shadowed: 20 }, 'shadowed-first');
    expectContractValid(priorityFirst);
    const won = await runWorkflowProfileKernel({ profile: priorityFirst, handlers: { intake: () => ({ flag: true }) } });
    expect(won.status).toBe('success');
    expect(won.nodeSequence).toEqual(['start', 'check', 'accepted']);

    const tie = firstMatchProfile({ winner: 100, shadowed: 100 }, 'winner-first');
    expectContractValid(tie);
    const declaredFirst = await runWorkflowProfileKernel({ profile: tie, handlers: { intake: () => ({ flag: true }) } });
    expect(declaredFirst.status).toBe('success');
    expect(declaredFirst.nodeSequence.at(-1)).toBe('accepted');

    const falsePath = await runWorkflowProfileKernel({ profile: priorityFirst, handlers: { intake: () => ({ flag: false }) } });
    expect(falsePath.status).toBe('rejected');
    expect(falsePath.nodeSequence.at(-1)).toBe('rejected');
  });

  it('uses the default edge only when no conditional edge matched', async () => {
    const document = defaultFallbackProfile();
    expectContractValid(document);
    const matched = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ mode: 'ok' }), execute: () => ({ result: 'ok' }) } });
    expect(matched.status).toBe('success');
    expect(matched.nodeSequence.at(-1)).toBe('okEnd');

    const fallback = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ mode: 'retry' }), execute: () => ({ result: 'retry' }) } });
    expect(fallback.status).toBe('handoff');
    expect(fallback.nodeSequence.at(-1)).toBe('retryEnd');
  });

  it('enforces the loop bound, routes exhaustion, and counts iterations monotonically', async () => {
    const document = loopProfile();
    expectContractValid(document);
    const work = vi.fn(() => ({ goal: 'g', done: true }));
    const result = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ goal: 'g' }), execute: work } });
    expect(result.status).toBe('handoff');
    // The third `work` visit happens because first-match routing still selects the matching
    // conditional edge; the loop edge then observes exhausted maxIterations and routes instead.
    expect(result.nodeSequence).toEqual(['start', 'check', 'work', 'check', 'work', 'check', 'work', 'handoff']);
    expect(result.visits).toBe(8);
    expect(result.loopCounters).toEqual({ 'fix-loop': 2 });
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the loop exhausts with strategy fail', async () => {
    const document = loopProfile('fail');
    expectContractValid(document);
    const result = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ goal: 'g' }), execute: () => ({ goal: 'g', done: true }) } });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('loop.exhausted');
  });

  it('keeps overlapping loop counters separate and monotonic through an inner cycle', async () => {
    const calls: string[] = [];
    const result = await runWorkflowProfileKernel({
      profile: nestedLoopProfile(),
      handlers: {
        intake: () => ({ goal: 'g' }),
        execute: (invocation) => { calls.push(invocation.node.id); return { goal: 'g' }; },
      },
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('loop.exhausted');
    // Each counter saturates on its own declared bound and is never reset by the other loop.
    expect(result.loopCounters).toEqual({ 'inner-loop': 3, 'plan-loop': 5 });
    // After inner-loop exhausts, its route still reaches `draft` via the exhaustion
    // transition, but only the plan loop keeps incrementing; the outer loop then fails.
    expect(calls.filter((id) => id === 'draft')).toHaveLength(6);
    expect(calls.filter((id) => id === 'work')).toHaveLength(6);
    expect(result.nodeSequence).toEqual(['start', 'check', 'draft', 'work', 'check', 'draft', 'work', 'check', 'draft', 'work', 'check', 'draft', 'work', 'check', 'draft', 'work', 'check', 'draft', 'work']);
  });

  it('stops a runaway cycle with the runtime hard cap even when declared bounds allow it', async () => {
    const visited: string[] = [];
    const result = await runWorkflowProfileKernel({
      profile: runawayProfile(),
      maxNodeVisits: 7,
      handlers: {
        intake: () => ({ goal: 'g' }),
        execute: (invocation) => { visited.push(invocation.node.id); return { goal: 'g' }; },
      },
    });
    expect(result.status).toBe('failure');
    expect(result.terminalFailure?.code).toBe('max-node-visits');
    expect(result.terminalFailure?.category).toBe('visit-cap');
    expect(result.visits).toBe(7);
    expect(visited).toHaveLength(3);
    // The cap is terminal: no profile error policy can retry or route it.
    expect(TERMINAL_FAILURE_CATEGORIES.has('visit-cap')).toBe(true);
  });

  it('applies retry attempts, retryOn categories, and terminal failures', async () => {
    const retrying = retryProfile({ strategy: 'retry', retryOn: ['provider'], maxAttempts: 3, backoffSeconds: 0 });
    expectContractValid(retrying);
    let calls = 0;
    const flaky = await runWorkflowProfileKernel({
      profile: retrying,
      handlers: {
        intake: () => ({ n: 1 }),
        execute: () => {
          calls += 1;
          if (calls < 3) throw new WorkflowNodeError('provider busy', { category: 'provider', code: 'provider.busy', retryable: true });
          return { done: true };
        },
      },
    });
    expect(flaky.status).toBe('success');
    expect(calls).toBe(3);

    const exhausted = await runWorkflowProfileKernel({
      profile: retrying,
      handlers: { intake: () => ({ n: 1 }), execute: () => { throw new WorkflowNodeError('provider busy', { category: 'provider', code: 'provider.busy', retryable: true }); } },
    });
    expect(exhausted.status).toBe('failure');
    expect(exhausted.terminalFailure).toMatchObject({ category: 'provider', attempt: 3 });

    const nonMatching = await runWorkflowProfileKernel({
      profile: retrying,
      handlers: { intake: () => ({ n: 1 }), execute: () => { throw new WorkflowNodeError('tool blew up', { category: 'tool', code: 'tool.error', retryable: true }); } },
    });
    expect(nonMatching.terminalFailure).toMatchObject({ category: 'tool', attempt: 1 });

    const denial = await runWorkflowProfileKernel({
      profile: retryProfile({ strategy: 'retry', retryOn: ['security-denied'], maxAttempts: 3, backoffSeconds: 0 }),
      handlers: { intake: () => ({ n: 1 }), execute: () => { throw new WorkflowNodeError('policy denied', { category: 'security-denied', code: 'policy.denied', retryable: true }); } },
    });
    expect(denial.terminalFailure).toMatchObject({ category: 'security-denied', attempt: 1 });
    expect(denial.nodeSequence).toEqual(['start', 'work']);

    // Terminal failures are never routed either, even when a route policy declares them.
    const routedDenial = await runWorkflowProfileKernel({
      profile: retryProfile({ strategy: 'route', routeTo: 'finish', routeMap: { done: '/failure/retryable' } }),
      handlers: { intake: () => ({ n: 1 }), execute: () => { throw new WorkflowNodeError('approval denied', { category: 'approval-denied', code: 'approval.denied', retryable: true }); } },
    });
    expect(routedDenial.status).toBe('failure');
    expect(routedDenial.terminalFailure).toMatchObject({ category: 'approval-denied', attempt: 1 });
    expect(routedDenial.nodeSequence).toEqual(['start', 'work']);
    expect(routedDenial.results).toEqual([]);
  });

  it('routes errors with only the sanitized failure envelope', async () => {
    const document = errorRouteProfile();
    expectContractValid(document);
    const seen: Array<Record<string, unknown>> = [];
    const result = await runWorkflowProfileKernel({
      profile: document,
      handlers: {
        intake: () => ({ n: 1 }),
        execute: (invocation) => {
          if (invocation.node.id === 'work') throw new WorkflowNodeError('secret-provider-detail', { category: 'provider', code: 'provider.down', retryable: true });
          seen.push(invocation.inputs as Record<string, unknown>);
          return { ok: true };
        },
      },
    });
    expect(result.status).toBe('success');
    expect(result.nodeSequence).toEqual(['start', 'work', 'recover', 'finish']);
    expect(seen).toEqual([{ code: 'provider.down', attempt: 1 }]);
    expect(JSON.stringify(result)).not.toContain('secret-provider-detail');
  });

  it('fails closed when no route matches and the runtime visit cap is reached', async () => {
    const noDefault = defaultFallbackProfile();
    (noDefault.workflow.edges as any[]).pop(); // drop the explicit default edge: only one condition remains
    const unrouted = await runWorkflowProfileKernel({ profile: noDefault, handlers: { intake: () => ({ mode: 'retry' }), execute: () => ({ result: 'retry' }) } });
    expect(unrouted.status).toBe('failure');
    expect(unrouted.terminalFailure?.code).toBe('route.missing');

    const capped = loopProfile();
    const cappedResult = await runWorkflowProfileKernel({ profile: capped, maxNodeVisits: 3, handlers: { intake: () => ({ goal: 'g' }), execute: () => ({ goal: 'g', done: true }) } });
    expect(cappedResult.status).toBe('failure');
    expect(cappedResult.terminalFailure?.code).toBe('max-node-visits');
    expect(cappedResult.visits).toBe(3);
    expect(effectiveMaxNodeVisits(capped, 3)).toBe(3);
    expect(effectiveMaxNodeVisits(capped, 10_000)).toBe(30);
  });

  it('rejects undeclared or mistyped handler outputs and unknown node kinds fail closed', async () => {
    const document = linearProfile();
    const mistyped = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ goal: 42 }) } });
    expect(mistyped.terminalFailure?.code).toBe('output.type-mismatch');

    const missing = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({}) } });
    expect(missing.terminalFailure?.code).toBe('output.missing');

    const stray = await runWorkflowProfileKernel({ profile: document, handlers: { intake: () => ({ goal: 'ok', extra: 'ignored' }) } });
    expect(stray.status).toBe('success');

    const noHandler = defaultFallbackProfile();
    const dispatched = await runWorkflowProfileKernel({ profile: noHandler, handlers: { intake: () => ({ mode: 'ok' }) } });
    expect(dispatched.terminalFailure?.code).toBe('handler.missing');
  });

  it('stops at the next transition when the run is cancelled', async () => {
    const controller = new AbortController();
    const document = linearProfile();
    const result = await runWorkflowProfileKernel({
      profile: document,
      signal: controller.signal,
      handlers: { intake: () => { controller.abort(); return { goal: 'g' }; } },
    });
    expect(result.status).toBe('cancelled');
    expect(result.terminalFailure?.category).toBe('cancelled');
    expect(result.nodeSequence).toEqual(['start']);
  });
});

// ─── Feature flag and prepared runs (Step 5) ──────────────────────

describe('Workflow Profile feature flag', () => {
  it('is off by default and only opts in explicitly', () => {
    expect(isWorkflowProfileExecutionEnabled({})).toBe(false);
    expect(isWorkflowProfileExecutionEnabled({ [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '0' })).toBe(false);
    expect(isWorkflowProfileExecutionEnabled({ [WORKFLOW_PROFILE_FLAG_ENV_VAR]: 'yes' })).toBe(false);
    expect(isWorkflowProfileExecutionEnabled({ [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' })).toBe(true);
    expect(isWorkflowProfileExecutionEnabled({ [WORKFLOW_PROFILE_FLAG_ENV_VAR]: 'TRUE' })).toBe(true);
  });

  it('refuses to prepare a run while the flag is off', () => {
    try {
      prepareWorkflowProfileRun({ document: linearProfile(), sources, env: {} });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toEqual(['profile-flag.disabled']);
    }
  });

  it('rejects invalid, unsupported, and unknown profiles before any handler dispatch', () => {
    const flag = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' };
    try {
      prepareWorkflowProfileRun({ document: { schemaVersion: '9.0.0' }, sources, env: flag });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toEqual(['schema-version.unsupported']);
    }

    const structurallyBroken = linearProfile();
    (structurallyBroken as any).policies = {};
    try {
      prepareWorkflowProfileRun({ document: structurallyBroken, sources, env: flag });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error).every((code) => code.startsWith('schema.'))).toBe(true);
    }

    const semanticallyBroken = loopProfile();
    (semanticallyBroken.workflow.edges[3] as any).loop.counterId = 'changed-after-validation';
    (semanticallyBroken.workflow.edges[3] as any).loop.maxIterations = 20;
    (semanticallyBroken.workflow.edges[3] as any).loop.onExhausted = { strategy: 'fail' };
    // Two edges must not silently become an unbounded cycle: the static visit bound must reject it.
    try {
      prepareWorkflowProfileRun({ document: semanticallyBroken, sources, env: flag });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toContain('budget.static-node-visits');
    }

    try {
      prepareWorkflowProfileRun({ document: undefined, sources, env: flag });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toEqual(['profile.missing']);
    }
  });

  it('prepares and runs a valid profile only after explicit opt-in', async () => {
    const prepared = prepareWorkflowProfileRun({
      document: linearProfile(),
      sources,
      env: { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' },
      maxNodeVisits: 5,
    });
    expect(prepared.profileId).toBe('test.profile');
    expect(Object.isFrozen(prepared.profile)).toBe(true);
    const result = await prepared.run({ handlers: { intake: () => ({ goal: 'ok' }) } });
    expect(result.status).toBe('success');
  });
});
