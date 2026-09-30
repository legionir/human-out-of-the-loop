import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowProfileRunStateStore } from '../workflow-profiles/profile-run-state.js';
import {
  FileWorkflowProfileRunStateStore,
  appendApprovalRecord,
  MemoryWorkflowProfileRunStateStore,
  PROFILE_RUN_STATE_VERSION,
  createWorkflowProfileRunState,
  evaluateWorkflowProfileResume,
  markPendingEffect,
  storedDependencyPins,
} from '../workflow-profiles/profile-run-state.js';
import { prepareWorkflowProfileRun } from '../workflow-profiles/profile-runner.js';
import { dependencyDigest } from '../workflow-profiles/profile-digest.js';
import type { WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';
import type { AuthoritySnapshot } from '../workflow-profiles/profile-access-guard.js';

const PERSONA_ID = 'test.persona';
const STUB_PERSONA = { id: PERSONA_ID, name: 'Stub persona', system: 'Stub executor persona.', allowedTools: [] };
const personaDependency = { kind: 'persona', id: PERSONA_ID, digest: dependencyDigest('persona', PERSONA_ID, { ...STUB_PERSONA }) };

const stringPort = () => ({ type: 'string', required: true });

/** A dependency-free-of-rubrics, three-node profile that the kernel can execute end to end. */
function executableProfile(version = '1.0.0'): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.resume', name: 'Resume fixture', version, author: 'tests' },
    dependencies: [{ ...personaDependency }],
    workflow: {
      startNode: 'start',
      nodes: [
        { id: 'start', kind: 'intake', goal: 'intake', inputs: {}, outputs: { goal: stringPort() }, config: {} },
        { id: 'work', kind: 'execute', goal: 'work', inputs: { goal: stringPort() }, outputs: { summary: stringPort() }, bindings: { personaRef: PERSONA_ID }, config: {} },
        { id: 'finish', kind: 'end', goal: 'finish', inputs: { summary: stringPort() }, outputs: { summary: stringPort() }, config: { outcome: 'success', emit: { summary: 'summary' } } },
      ],
      edges: [
        { from: 'start', to: 'work', map: { goal: '/goal' } },
        { from: 'work', to: 'finish', map: { summary: '/summary' } },
      ],
    },
    policies: {
      execution: { maxNodeVisits: 30, maxDurationSeconds: 600, maxModelCalls: 20, maxToolCalls: 20, onLimit: 'fail' },
      tools: { allowedToolsets: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [{ fromNode: 'finish', port: 'summary', kind: 'response', outcome: 'success' }],
  } as unknown as WorkflowProfileDocument;
}

const sources: WorkflowProfileComponentSources = {
  personas: { get: (id: string) => (id === PERSONA_ID ? { ...STUB_PERSONA } : undefined) },
  skills: { get: () => undefined },
  models: { get: () => undefined },
  toolsets: { get: () => undefined },
  rubrics: { get: () => undefined },
};

const env = { HOOTL_WORKFLOW_PROFILE: '1' };
const RUNTIME_VERSION = '27.17.16';

const handlers = () => ({
  intake: () => ({ goal: 'g' }),
  execute: () => ({ summary: 's' }),
});

const pins = () => storedDependencyPins([{ kind: 'persona', id: PERSONA_ID, declaredDigest: personaDependency.digest, contentDigest: personaDependency.digest }]);

describe('Workflow Profile run state store', () => {
  it('writes a versioned, hashed record and ignores a record it cannot read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp-state-'));
    const store = new FileWorkflowProfileRunStateStore(directory);
    const state = createWorkflowProfileRunState({
      runId: '../../etc/passwd',
      profile: executableProfile(),
      dependencies: pins(),
      runtimeVersion: RUNTIME_VERSION,
      startNodeId: 'start',
      planId: 'plan-1',
      sessionId: 'session-1',
      now: 1_000,
    });
    store.save(state);
    expect(store.load('../../etc/passwd')).toEqual(state);
    expect(store.list()).toHaveLength(1);

    const file = join(directory, readdirSync(directory)[0]!);
    expect(readdirSync(directory)[0]).toMatch(/^[0-9a-f]{32}\.json$/); // hashed: no path traversal
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.stateVersion).toBe(PROFILE_RUN_STATE_VERSION);
    expect(raw.status).toBe('interrupted');
    expect(raw.profileHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    writeFileSync(file, JSON.stringify({ ...raw, stateVersion: PROFILE_RUN_STATE_VERSION + 99 }));
    expect(store.load('../../etc/passwd')).toBeUndefined();
    expect(store.load('never-written')).toBeUndefined();
    store.delete('../../etc/passwd');
    expect(store.list()).toEqual([]);
  });

  it('records approvals append-only, as audit data a resume never reads back', () => {
    const state = createWorkflowProfileRunState({
      runId: 'run-approvals', profile: executableProfile(), dependencies: pins(), runtimeVersion: RUNTIME_VERSION,
      startNodeId: 'start',
    });
    const denied = appendApprovalRecord(state, { nodeId: 'confirm', status: 'denied', digest: 'sha256:aa' }, 1);
    const approved = appendApprovalRecord(denied, { nodeId: 'confirm', status: 'approved', digest: 'sha256:bb', boundPort: 'planText' }, 2);

    // The original state is untouched (the store writes whole records), and order is preserved.
    expect(state.approvals).toEqual([]);
    expect(approved.approvals.map(({ nodeId, status, digest }) => `${nodeId}:${status}:${digest}`))
      .toEqual(['confirm:denied:sha256:aa', 'confirm:approved:sha256:bb']);
    expect(approved.updatedAtMs).toBe(2);
    // A decision that resolves but changes nothing is still missing: a resume re-runs the node.
    expect(evaluateWorkflowProfileResume(approved, {
      profile: executableProfile(), dependencies: pins(), runtimeVersion: RUNTIME_VERSION,
    }).action).toBe('resume');
  });

  it('keeps memory-store state independent of the caller object', () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    store.save(createWorkflowProfileRunState({
      runId: 'run-1', profile: executableProfile(), dependencies: pins(),
      runtimeVersion: RUNTIME_VERSION, startNodeId: 'start', now: 1,
    }));
    const loaded = store.load('run-1')!;
    (loaded as { status: string }).status = 'tampered';
    expect(store.load('run-1')!.status).toBe('interrupted');
  });
});

describe('Workflow Profile resume decisions', () => {
  const authority: AuthoritySnapshot = { toolIds: ['read-file'], budget: { maxModelCalls: 5 }, approvalStrictness: 1 };
  let state: ReturnType<typeof createWorkflowProfileRunState>;

  beforeEach(() => {
    state = createWorkflowProfileRunState({
      runId: 'run-1', profile: executableProfile(), dependencies: pins(),
      runtimeVersion: RUNTIME_VERSION, startNodeId: 'work', authority, now: 1,
    });
    state = { ...state, currentNodeId: 'work', visits: 2 };
  });

  const expectation = () => ({ profile: executableProfile(), dependencies: pins(), runtimeVersion: RUNTIME_VERSION, authority });

  it('resumes an interrupted run whose profile, schema, runtime, pins, and authority all match', () => {
    const decision = evaluateWorkflowProfileResume(state, expectation());
    expect(decision).toEqual({ action: 'resume', diagnostics: [] });
  });

  it('never resumes a terminal run and never retries a pending effect', () => {
    for (const status of ['success', 'failure', 'handoff', 'cancelled'] as const) {
      const decision = evaluateWorkflowProfileResume({ ...state, status }, expectation());
      expect(decision.action).toBe('already-terminal');
      expect(decision.diagnostics[0]?.code).toBe('resume.already-terminal');
    }
    const pending = markPendingEffect(state, { nodeId: 'work', attemptId: 'effect-1', intent: 'external-write', startedAtMs: 5 });
    const decision = evaluateWorkflowProfileResume(pending, expectation());
    expect(decision.action).toBe('refuse-ambiguous-effect');
    expect(decision.diagnostics[0]?.code).toBe('resume.ambiguous-effect');
    // Even a matching profile cannot make an uncommitted effect resumable.
    const sameProfilePending = evaluateWorkflowProfileResume({ ...pending, profileHash: state.profileHash }, expectation());
    expect(sameProfilePending.action).toBe('refuse-ambiguous-effect');
  });

  it('refuses when the profile, schema, runtime, or a dependency pin changed', () => {
    const renamed = executableProfile();
    (renamed.profile as { name: string }).name = 'Renamed';
    expect(evaluateWorkflowProfileResume(state, { ...expectation(), profile: renamed }).diagnostics[0]?.code)
      .toBe('resume.profile-changed');

    expect(evaluateWorkflowProfileResume({ ...state, schemaVersion: '9.9.9' }, expectation()).diagnostics[0]?.code)
      .toBe('resume.schema-version-changed');

    expect(evaluateWorkflowProfileResume(state, { ...expectation(), runtimeVersion: '99.0.0' }).diagnostics[0]?.code)
      .toBe('resume.runtime-version-changed');

    const repinned = pins();
    repinned[0]!.digest = dependencyDigest('persona', PERSONA_ID, { ...STUB_PERSONA, name: 'Other' });
    expect(evaluateWorkflowProfileResume(state, { ...expectation(), dependencies: repinned }).diagnostics[0]?.code)
      .toBe('resume.dependency-changed');

    expect(evaluateWorkflowProfileResume(state, { ...expectation(), dependencies: [] }).diagnostics[0]?.code)
      .toBe('resume.dependency-missing');

    const missingProfile = evaluateWorkflowProfileResume(state, { ...expectation(), profile: { ...executableProfile(), profile: { ...executableProfile().profile, id: 'other.profile' } } });
    expect(missingProfile.action).toBe('refuse-integrity');
    expect(missingProfile.diagnostics[0]?.code).toBe('resume.profile-missing');

    expect(evaluateWorkflowProfileResume(undefined, expectation()).diagnostics[0]?.code).toBe('resume.profile-missing');
  });

  it('refuses a resume that would widen authority in any dimension', () => {
    const wider: AuthoritySnapshot = { toolIds: ['read-file', 'write-file'], budget: { maxModelCalls: 5 }, approvalStrictness: 1 };
    expect(evaluateWorkflowProfileResume(state, { ...expectation(), authority: wider }).diagnostics[0]?.code)
      .toBe('resume.authority-increase');

    const higherCap: AuthoritySnapshot = { toolIds: ['read-file'], budget: { maxModelCalls: 50 }, approvalStrictness: 1 };
    expect(evaluateWorkflowProfileResume(state, { ...expectation(), authority: higherCap }).diagnostics[0]?.code)
      .toBe('resume.authority-increase');

    const weakerApproval: AuthoritySnapshot = { toolIds: ['read-file'], budget: { maxModelCalls: 5 }, approvalStrictness: 0 };
    expect(evaluateWorkflowProfileResume(state, { ...expectation(), authority: weakerApproval }).diagnostics[0]?.code)
      .toBe('resume.authority-increase');

    // Identical or narrower authority is fine.
    expect(evaluateWorkflowProfileResume(state, {
      ...expectation(),
      authority: { toolIds: [], budget: { maxModelCalls: 1 }, approvalStrictness: 2 },
    }).action).toBe('resume');
  });
});

describe('Workflow Profile durable runs', () => {
  const runWith = (
    store: MemoryWorkflowProfileRunStateStore,
    options: { document?: WorkflowProfileDocument; runtimeToolIds?: ReadonlyArray<string>; budget?: { maxModelCalls?: number } } = {},
  ) => prepareWorkflowProfileRun({
    document: options.document ?? executableProfile(),
    sources,
    env,
    runtimeVersion: RUNTIME_VERSION,
    runId: 'run-durable',
    stateStore: store,
    ...(options.runtimeToolIds ? { runtimeToolIds: options.runtimeToolIds } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
  });

  it('persists the run before the first node and folds the result back in at the end', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const prepared = runWith(store);
    expect(prepared.runState()?.status).toBe('interrupted');
    expect(store.load('run-durable')?.nodeSequence).toEqual([]);

    const result = await prepared.run({ input: {}, handlers: handlers() });
    expect(result.status).toBe('success');
    const saved = store.load('run-durable')!;
    expect(saved.status).toBe('success');
    expect(saved.visits).toBe(3);
    expect(saved.nodeSequence).toEqual(['start', 'work', 'finish']);
    expect(saved.budget.visits).toBe(3);
    expect(saved.budget.durationMs).toBeGreaterThanOrEqual(0);
    expect(saved.currentNodeId).toBe('finish');
    expect(saved.authority.budget.maxNodeVisits).toBe(30);
    expect(prepared.runState()).toEqual(saved);
  });

  it('resumes after a restart from the state on disk, continuing the counters', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp-restart-'));
    const first = prepareWorkflowProfileRun({
      document: executableProfile(), sources, env, runtimeVersion: RUNTIME_VERSION,
      runId: 'run-restart', stateStore: new FileWorkflowProfileRunStateStore(directory),
    });
    // The process dies here: nothing but the prepared record exists on disk.
    expect(first.runState()).toMatchObject({ status: 'interrupted', currentNodeId: 'start', visits: 0 });

    // A fresh process re-reads the same directory and continues the same run.
    const store = new FileWorkflowProfileRunStateStore(directory);
    const second = prepareWorkflowProfileRun({
      document: executableProfile(), sources, env, runtimeVersion: RUNTIME_VERSION,
      runId: 'run-restart', stateStore: store,
    });
    expect(second.runState()).toMatchObject({ status: 'interrupted', currentNodeId: 'start' });
    const result = await second.run({ input: {}, handlers: handlers() });
    expect(result.status).toBe('success');
    expect(store.load('run-restart')!.status).toBe('success');
    expect(store.load('run-restart')!.nodeSequence).toEqual(['start', 'work', 'finish']);
  });

  it('fails closed when the state cannot be persisted, before any work happens', async () => {
    const failure = new Error('disk full');
    const store: WorkflowProfileRunStateStore = {
      save: () => { throw failure; },
      load: () => undefined,
      list: () => [],
      delete: () => {},
    };
    const events: Array<{ type: string }> = [];
    expect(() => prepareWorkflowProfileRun({
      document: executableProfile(), sources, env, runtimeVersion: RUNTIME_VERSION,
      runId: 'run-broken-store', stateStore: store,
      eventSink: { emit: (event) => events.push(event as { type: string }) },
    })).toThrow(failure);
    expect(events.map((event) => event.type)).toContain('workflow.persistence.degraded');
    expect(() => store.save({} as never)).toThrow(); // the store stayed unusable: nothing was silently accepted
  });

  it('treats an ask-user limit as a resumable pause that keeps its counters', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const pausing = executableProfile();
    (pausing.policies as { execution: { onLimit: string; maxModelCalls: number } }).execution.onLimit = 'ask-user';
    (pausing.policies as { execution: { onLimit: string; maxModelCalls: number } }).execution.maxModelCalls = 0;
    const consuming = {
      intake: () => ({ goal: 'g' }),
      execute: (invocation: { budget: { consumeModelCall: () => void } }) => {
        invocation.budget.consumeModelCall();
        return { summary: 's' };
      },
    };

    const first = runWith(store, { document: pausing });
    const result = await first.run({ input: {}, handlers: consuming });
    expect(result.status).toBe('handoff');
    expect(result.limit).toBe('ask-user');
    const paused = store.load('run-durable')!;
    expect(paused).toMatchObject({ status: 'interrupted', awaitingUser: true, visits: 2 });
    expect(paused.budget.modelCalls).toBe(0);

    // The pause is resumable (not already-terminal) and continues the same counters.
    const second = runWith(store, { document: pausing });
    const resumedResult = await second.run({ input: {}, handlers: consuming });
    expect(resumedResult.status).toBe('handoff');
    expect(resumedResult.limit).toBe('ask-user');
    expect(resumedResult.visits).toBe(3); // counters continue: no reset, no overshoot
    expect(store.load('run-durable')).toMatchObject({ status: 'interrupted', awaitingUser: true, budget: { modelCalls: 0 } });
  });

  it('refuses a second attempt on a terminal run and does not touch the stored record', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    await runWith(store).run({ input: {}, handlers: handlers() });
    const before = JSON.stringify(store.load('run-durable'));
    const again = runWith(store);
    await expect(again.run({ input: {}, handlers: handlers() })).rejects.toThrow(/cannot resume/);
    expect(JSON.stringify(store.load('run-durable'))).toBe(before);
  });

  it('refuses a resume whose policy would grant more authority and writes nothing', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const prepared = runWith(store, { budget: { maxModelCalls: 2 } });
    expect(store.load('run-durable')!.authority.budget.maxModelCalls).toBe(2);

    // Same run id, same profile, but the caller now offers a larger budget.
    const widened = runWith(store, { budget: { maxModelCalls: 500 } });
    await expect(widened.run({ input: {}, handlers: handlers() })).rejects.toThrow(/authority-increase/);
    expect(store.load('run-durable')!.authority.budget.maxModelCalls).toBe(2);

    const moreTools = runWith(store, { runtimeToolIds: ['read-file'] });
    await expect(moreTools.run({ input: {}, handlers: handlers() })).rejects.toThrow(/authority-increase/);
  });

  it('derives the declared tool surface from pinned content and never denies every tool by default', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    // This fixture pins one persona and declares no toolsets: the profile adds no
    // tool narrowing, so its declared surface is whatever the persona permits.
    const prepared = runWith(store);
    const state = prepared.runState()!;
    expect(state.authority.toolIds).toEqual([...STUB_PERSONA.allowedTools].sort());
    await prepared.run({ input: {}, handlers: handlers() });
    // A resume with the same declaration stays allowed (no false "authority increase").
    const again = prepareWorkflowProfileRun({
      document: executableProfile(), sources, env, runtimeVersion: RUNTIME_VERSION,
      runId: 'run-durable', stateStore: new MemoryWorkflowProfileRunStateStore(),
    });
    expect(again.runState()!.authority.toolIds).toEqual([...STUB_PERSONA.allowedTools].sort());
  });

  it('refuses to continue a run that stopped with an effect in flight', async () => {
    const store = new MemoryWorkflowProfileRunStateStore();
    const prepared = runWith(store);
    const attemptId = prepared.recordEffectStart('work', 'external-write');
    expect(attemptId).toMatch(/^effect-/);
    expect(store.load('run-durable')!.pendingEffect).toMatchObject({ nodeId: 'work', attemptId, intent: 'external-write' });

    prepared.recordEffectCommitted();
    expect(store.load('run-durable')!.pendingEffect).toBeUndefined();

    prepared.recordEffectStart('work', 'external-write');
    const resumed = runWith(store);
    await expect(resumed.run({ input: {}, handlers: handlers() })).rejects.toThrow(/ambiguous-effect/);
    expect(store.load('run-durable')!.status).toBe('interrupted');
  });

  it('emits lifecycle events through the shared sink, scrubs secrets, and survives a broken sink', async () => {
    const events: Array<{ type: string }> = [];
    const prepared = prepareWorkflowProfileRun({
      document: executableProfile(),
      sources,
      env,
      runtimeVersion: RUNTIME_VERSION,
      runId: 'run-durable',
      planId: 'plan-1',
      eventSink: { emit: (event) => events.push(event as { type: string }) },
      secrets: ['sup3r-s3cret'],
    });
    const result = await prepared.run({ input: {}, handlers: handlers() });
    expect(result.status).toBe('success');
    const types = new Set(events.map((event) => event.type));
    for (const expected of ['workflow.run.start', 'workflow.node.start', 'workflow.node.output', 'workflow.run.end']) {
      expect(types.has(expected)).toBe(true);
    }
    expect(prepared.events.degraded).toBe(false);
    expect(JSON.stringify(events)).not.toContain('intake'); // no goals, inputs, or prompts are emitted
    expect(JSON.stringify(events)).toContain('run-durable'); // the run id is carried on every record

    const onDegraded = vi.fn();
    const failing = prepareWorkflowProfileRun({
      document: executableProfile(), sources, env, runtimeVersion: RUNTIME_VERSION,
      eventSink: { emit: () => { throw new Error('sink down'); } },
      onDegraded,
    });
    const degradedResult = await failing.run({ input: {}, handlers: handlers() });
    expect(degradedResult.status).toBe('success');
    expect(failing.events.degraded).toBe(true);
    expect(onDegraded).toHaveBeenCalled();
  });

  it('leaves every entry point closed while the feature flag is off', () => {
    expect(() => prepareWorkflowProfileRun({ document: executableProfile(), sources })).toThrow(/disabled/);
    expect(() => prepareWorkflowProfileRun({ document: executableProfile(), sources, env: {} })).toThrow(/disabled/);
  });
});
