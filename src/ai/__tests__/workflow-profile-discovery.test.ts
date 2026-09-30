import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_WORKFLOW_PROFILE_DIR,
  WORKFLOW_PROFILE_DIR_ENV_VAR,
  discoverWorkflowProfiles,
} from '../workflow-profiles/profile-discovery.js';
import { selectWorkflowProfile } from '../workflow-profiles/profile-registry.js';
import { DEFAULT_WORKFLOW_PROFILE_ID } from '../workflow-profiles/default-profile.js';

/** A minimal valid profile document (intake → end), parameterised by id. */
function document(id: string, { personaId = 'planner' }: { personaId?: string } = {}) {
  const port = () => ({ type: 'string', required: true });
  return {
    schemaVersion: '1.0.0',
    profile: { id, name: `Profile ${id}`, version: '1.0.0', author: 'tests' },
    // The pin is irrelevant for discovery (no resolution happens here); the registry only
    // validates structure and semantics.
    dependencies: [{ kind: 'persona', id: personaId, digest: `sha256:${'0'.repeat(64)}` }],
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
  };
}

describe('workflow profile discovery', () => {
  let projectRoot: string;
  let userDir: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-disc-proj-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-disc-user-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  function writeProjectProfile(name: string, id: string): string {
    const dir = path.join(projectRoot, PROJECT_WORKFLOW_PROFILE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(document(id)));
    return file;
  }

  it('does not read project profiles without the opt-in, and reads them with it', () => {
    writeProjectProfile('project.json', 'acme.project');
    const withoutOptIn = discoverWorkflowProfiles({ projectRoot });
    expect(withoutOptIn.profiles).toHaveLength(0);
    expect(withoutOptIn.diagnostics).toEqual([]);
    expect(withoutOptIn.sources[0]).toMatchObject({ scope: 'project', present: false });

    const optedIn = discoverWorkflowProfiles({ projectRoot, projectOptIn: true });
    expect(optedIn.profiles.map((entry) => entry.profile.profile.id)).toEqual(['acme.project']);
    expect(optedIn.profiles[0]?.scope).toBe('project');
    expect(optedIn.projectDefaultProfileId).toBe('acme.project');
  });

  it('reads the operator directory from the environment and an explicit file with highest precedence', () => {
    fs.writeFileSync(path.join(userDir, 'mine.json'), JSON.stringify(document('mine.user')));
    const env = { [WORKFLOW_PROFILE_DIR_ENV_VAR]: userDir };
    const discovered = discoverWorkflowProfiles({ projectRoot, env });
    expect(discovered.profiles.map((entry) => entry.profile.profile.id)).toEqual(['mine.user']);
    expect(discovered.profiles[0]?.scope).toBe('user-selected');

    const file = path.join(projectRoot, 'single.json');
    fs.writeFileSync(file, JSON.stringify(document('single.user')));
    const withFile = discoverWorkflowProfiles({ projectRoot, env, file });
    expect(withFile.profiles.map((entry) => entry.profile.profile.id)).toEqual(['mine.user', 'single.user']);
  });

  it('reports a broken project profile as a diagnostic instead of throwing', () => {
    writeProjectProfile('broken.json', 'acme.broken');
    const brokenFile = path.join(projectRoot, PROJECT_WORKFLOW_PROFILE_DIR, 'broken.json');
    fs.writeFileSync(brokenFile, '{ not json');
    const discovered = discoverWorkflowProfiles({ projectRoot, projectOptIn: true });
    expect(discovered.profiles).toHaveLength(0);
    expect(discovered.diagnostics.length).toBeGreaterThan(0);
    expect(discovered.diagnostics[0]?.file).toBe(brokenFile);

    // A selected id that failed to load is a fail-closed selection error, not a silent fallback.
    expect(() => selectWorkflowProfile(discovered.registry, { requestedProfileId: 'acme.broken' }))
      .toThrowError(/not discovered/);
  });

  it('names no project default when the project has several profiles', () => {
    writeProjectProfile('a.json', 'acme.a');
    writeProjectProfile('b.json', 'acme.b');
    const discovered = discoverWorkflowProfiles({ projectRoot, projectOptIn: true });
    expect(discovered.profiles).toHaveLength(2);
    expect(discovered.projectDefaultProfileId).toBeUndefined();
  });

  it('reports a missing explicitly named file and a duplicate id across scopes', () => {
    const missing = discoverWorkflowProfiles({ projectRoot, file: path.join(projectRoot, 'nope.json') });
    expect(missing.diagnostics[0]).toMatchObject({ code: 'file.missing' });

    writeProjectProfile('project.json', 'acme.same');
    fs.writeFileSync(path.join(userDir, 'same.json'), JSON.stringify(document('acme.same')));
    const duplicated = discoverWorkflowProfiles({
      projectRoot,
      projectOptIn: true,
      env: { [WORKFLOW_PROFILE_DIR_ENV_VAR]: userDir },
    });
    // The first (project) copy is registered; the duplicate is reported, never merged.
    expect(duplicated.profiles.map((entry) => entry.profile.profile.id)).toEqual(['acme.same']);
    expect(duplicated.diagnostics.some((diagnostic) => diagnostic.code === 'registry.duplicate-id')).toBe(true);
  });

  it('selects with the documented precedence: explicit, then project default, then built-in', () => {
    writeProjectProfile('project.json', 'acme.project');
    fs.writeFileSync(path.join(userDir, 'mine.json'), JSON.stringify(document('mine.user')));
    const discovered = discoverWorkflowProfiles({
      projectRoot,
      projectOptIn: true,
      env: { [WORKFLOW_PROFILE_DIR_ENV_VAR]: userDir },
    });

    const explicit = selectWorkflowProfile(discovered.registry, {
      requestedProfileId: 'mine.user',
      projectOptIn: true,
      projectDefaultProfileId: discovered.projectDefaultProfileId,
      builtInDefaultProfileId: DEFAULT_WORKFLOW_PROFILE_ID,
    });
    expect(explicit.profile.profile.id).toBe('mine.user');

    const projectDefault = selectWorkflowProfile(discovered.registry, {
      projectOptIn: true,
      projectDefaultProfileId: discovered.projectDefaultProfileId,
    });
    expect(projectDefault.profile.profile.id).toBe('acme.project');

    // Without the project opt-in the project profile is not selectable at all.
    expect(() => selectWorkflowProfile(discovered.registry, {
      projectOptIn: false,
      projectDefaultProfileId: discovered.projectDefaultProfileId,
    })).toThrowError(/No workflow profile could be selected|not discovered|opt-in/i);
  });
});
