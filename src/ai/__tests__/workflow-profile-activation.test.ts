import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_DEFAULT_APPROVAL,
  activateWorkflowProfile,
  type WorkflowProfileActivationOptions,
} from '../workflow-profiles/profile-activation.js';
import { dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR } from '../workflow-profiles/profile-runner.js';
import { createBuiltInRubricCatalogue, type WorkflowProfileComponentSources } from '../workflow-profiles/profile-resolver.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const PERSONA_ID = 'test.persona';
const STUB_PERSONA = { id: PERSONA_ID, name: 'Stub persona', system: 'Stub persona system prompt.', allowedTools: [] };

/** A minimal, resolvable profile: intake → end. */
function fixtureDocument(): WorkflowProfileDocument {
  const port = () => ({ type: 'string', required: true });
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.profile', name: 'Activation fixture', version: '1.0.0', author: 'tests' },
    dependencies: [{ kind: 'persona', id: PERSONA_ID, digest: dependencyDigest('persona', PERSONA_ID, { ...STUB_PERSONA }) }],
    workflow: {
      startNode: 'start',
      nodes: [
        { id: 'start', kind: 'intake', goal: 'start', inputs: { request: port() }, outputs: { request: port() }, config: {} },
        { id: 'done', kind: 'end', goal: 'done', inputs: { request: structuredClone(port()) }, outputs: { response: structuredClone(port()) }, config: { outcome: 'success', emit: { response: 'request' } } },
      ],
      edges: [{ from: 'start', to: 'done', map: { request: '/request' } }],
    },
    policies: {
      execution: { maxNodeVisits: 5, maxDurationSeconds: 60, maxModelCalls: 5, maxToolCalls: 5, onLimit: 'fail' },
      tools: { allowedToolsets: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [{ fromNode: 'done', port: 'response', kind: 'response', outcome: 'success' }],
  } as unknown as WorkflowProfileDocument;
}

const FLAG_ON = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' } as const;

/** Counts every registry read, so a test can prove nothing resolved. */
function sources(hits: { count: number }): WorkflowProfileComponentSources {
  const registered: Record<string, unknown> = {
    [PERSONA_ID]: { ...STUB_PERSONA },
    // The built-in default profile pins these two personas and the built-in rubric.
    planner: { id: 'planner', name: 'Task Planner', system: 'Plan.', allowedTools: ['create_task'] },
    reviewer: { id: 'reviewer', name: 'Code Reviewer', system: 'Review.', allowedTools: ['read_file'] },
  };
  const read = (id: string): unknown => {
    hits.count += 1;
    return registered[id] ? { ...(registered[id] as object) } : undefined;
  };
  return {
    personas: { get: read },
    skills: { get: read },
    models: { get: read },
    toolsets: { get: read },
    rubrics: { get: (id: string) => (hits.count += 1, createBuiltInRubricCatalogue().get(id)) },
  } as unknown as WorkflowProfileComponentSources;
}

function options(hits: { count: number }, overrides: Partial<WorkflowProfileActivationOptions> = {}): WorkflowProfileActivationOptions {
  return { env: FLAG_ON, sources: sources(hits), ...overrides };
}

describe('workflow profile activation', () => {
  it('keeps the legacy path and resolves nothing while the flag is off', () => {
    const hits = { count: 0 };
    for (const env of [{}, { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '0' }, { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: 'yes' }, { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '' }]) {
      expect(activateWorkflowProfile({ ...options(hits), env })).toEqual({ kind: 'legacy', reason: 'flag-disabled' });
    }
    expect(hits.count).toBe(0);
  });

  it('fails closed when the flag is on but nothing was selected and the default was not opted into', () => {
    const hits = { count: 0 };
    expect(() => activateWorkflowProfile(options(hits)))
      .toThrowError(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'profile-activation.not-selected' })] }));
    expect(hits.count).toBe(0);
  });

  it('refuses the built-in default until its activation approval is recorded', () => {
    const hits = { count: 0 };
    expect(BUILT_IN_DEFAULT_APPROVAL.approved).toBe(false);
    try {
      activateWorkflowProfile(options(hits, { allowBuiltInDefault: true }));
      throw new Error('expected the unapproved default to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]).toMatchObject({
        code: 'profile-activation.not-approved',
        profileId: 'hootl.default',
      });
    }
    // No component was read: the refusal happens before resolution, so a missing or
    // unreadable registry can never be mistaken for an activation failure.
    expect(hits.count).toBe(0);
  });

  it('activates an explicit selection and prepares it for the run', () => {
    const hits = { count: 0 };
    const activation = activateWorkflowProfile(options(hits, { selection: { document: fixtureDocument() } }));
    expect(activation.kind).toBe('profile');
    if (activation.kind !== 'profile') throw new Error('unreachable');
    expect(activation.profileId).toBe('test.profile');
    expect(Object.isFrozen(activation.prepared.profile)).toBe(true);
    expect(hits.count).toBeGreaterThan(0);
  });

  it('activates the built-in default only when the approval is recorded', () => {
    const hits = { count: 0 };
    const activation = activateWorkflowProfile(options(hits, {
      allowBuiltInDefault: true,
      builtInDefaultApproval: { approved: true, reference: 'test approval' },
    }));
    expect(activation.kind).toBe('profile');
    if (activation.kind !== 'profile') throw new Error('unreachable');
    expect(activation.profileId).toBe('hootl.default');
  });

  it('fails closed with diagnostics instead of falling back when the selected profile is invalid', () => {
    const hits = { count: 0 };
    const broken = fixtureDocument();
    (broken as { schemaVersion: string }).schemaVersion = '9.0.0';
    try {
      activateWorkflowProfile(options(hits, { selection: { document: broken } }));
      throw new Error('expected an unsupported schema version to fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]).toMatchObject({ code: 'schema-version.unsupported' });
    }
    expect(hits.count).toBe(0);
  });

  it('does not fall back to legacy when a selected profile cannot resolve its dependencies', () => {
    const hits = { count: 0 };
    const missing = fixtureDocument();
    (missing.dependencies as Array<{ id: string }>)[0]!.id = 'does.not.exist';
    expect(() => activateWorkflowProfile(options(hits, { selection: { document: missing } })))
      .toThrowError(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'dependency.missing' })] }));
  });

  it('never lets a caller turn activation into a silent bypass', () => {
    const hits = { count: 0 };
    const spy = vi.fn(() => { throw new Error('must not be called'); });
    expect(() => activateWorkflowProfile({
      env: FLAG_ON,
      sources: new Proxy(sources(hits), { get: spy as never }),
      allowBuiltInDefault: false,
    })).toThrowError(/no profile was selected/);
    expect(spy).not.toHaveBeenCalled();
  });
});
