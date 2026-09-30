/**
 * Phase 8 Step 2 — `profiles list` / `profiles validate` and the command surface.
 *
 * These tests exercise the command functions directly (the CLI's own contract) plus the
 * commander registration, without constructing an Orchestrator: introspection must not spawn
 * MCP, call a model, or write plans/sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';
import { profilesListCommand, profilesValidateCommand } from '../commands/profiles.js';
import { resolveProfileSelection } from '../commands/run.js';
import { activateWorkflowProfile } from '../../ai/workflow-profiles/profile-activation.js';
import { createWorkflowProfileComponentSources } from '../../ai/workflow-profiles/profile-sources.js';
import { PROJECT_WORKFLOW_PROFILE_DIR } from '../../ai/workflow-profiles/profile-discovery.js';
import { createProgram } from '../../cli.js';
import { PersonaRegistry } from '../../ai/registries/persona-registry.js';
import { ModelRegistry } from '../../ai/registries/model-registry.js';
import { SkillRegistry } from '../../ai/registries/skill-registry.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import { componentProjection, dependencyDigest } from '../../ai/workflow-profiles/profile-digest.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** A valid profile that pins the repository's real `planner` persona (so resolution succeeds). */
function validProfile(id: string): Record<string, unknown> {
  const port = () => ({ type: 'string', required: true });
  return {
    schemaVersion: '1.0.0',
    profile: { id, name: `Profile ${id}`, version: '1.0.0', author: 'tests' },
    // The digest must match the content the CLI's own registry loader exposes.
    dependencies: [{
      kind: 'persona',
      id: 'planner',
      digest: personaPin(),
    }],
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

/** The pin the resolver will compute: digest of the persona record the registry loader yields. */
function personaPin(): string {
  const registry = new PersonaRegistry();
  const { errors } = registry.loadFromDirectory(path.join(REPO_ROOT, 'registry', 'personas'), false, false);
  expect(errors).toEqual([]);
  const record = registry.get('planner') as unknown as Record<string, unknown> | undefined;
  if (!record) throw new Error('the repository registry must ship a planner persona');
  return dependencyDigest('persona', 'planner', componentProjection(record));
}

describe('Phase 8 — profiles CLI', () => {
  let home: HomeHandle;
  let project: string;

  beforeEach(() => {
    home = useIsolatedHome('phase8-home-');
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-proj-'));
    fs.cpSync(path.join(REPO_ROOT, 'registry'), path.join(project, 'registry'), { recursive: true });
  });

  afterEach(() => {
    home.restore();
    fs.rmSync(project, { recursive: true, force: true });
  });

  function writeProjectProfile(name: string, document: unknown): string {
    const dir = path.join(project, PROJECT_WORKFLOW_PROFILE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
    return file;
  }

  it('lists nothing without the trust opt-in, and the project profile with it', async () => {
    const file = writeProjectProfile('acme.json', validProfile('acme.project'));
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    try {
      expect(await profilesListCommand({ projectRoot: project })).toBe(0);
      expect(output.join('')).not.toContain('acme.project');
      output.length = 0;
      expect(await profilesListCommand({ projectRoot: project, trustProject: true })).toBe(0);
      const text = output.join('');
      expect(text).toContain('acme.project');
      expect(text).toContain(file);
      expect(text).toContain('project');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a broken project profile without failing the listing', async () => {
    writeProjectProfile('broken.json', '{ "schemaVersion": "1.0.0", ');
    const output: string[] = [];
    const errOutput: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errOutput.push(String(chunk)); return true; });
    try {
      const json = vi.spyOn(process.stdout, 'write');
      void json;
      expect(await profilesListCommand({ projectRoot: project, trustProject: true, json: true })).toBe(0);
      const payload = JSON.parse(output.join('')) as { profiles: unknown[]; diagnostics: Array<{ code: string }> };
      expect(payload.profiles).toHaveLength(0);
      expect(payload.diagnostics.length).toBeGreaterThan(0);
      expect(errOutput.join('')).toBe('');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('validates a file path: exit 0 when it resolves, exit 1 with diagnostics when it does not', async () => {
    const good = writeProjectProfile('acme.json', validProfile('acme.project'));
    const output: string[] = [];
    const errOutput: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errOutput.push(String(chunk)); return true; });
    try {
      expect(await profilesValidateCommand(good, { projectRoot: project })).toBe(0);
      expect(output.join('')).toContain('is valid');

      const broken = validProfile('acme.broken');
      (broken.dependencies as Array<{ digest: string }>)[0]!.digest = `sha256:${'1'.repeat(64)}`;
      const brokenFile = writeProjectProfile('broken-pin.json', broken);
      output.length = 0;
      errOutput.length = 0;
      expect(await profilesValidateCommand(brokenFile, { projectRoot: project })).toBe(1);
      expect(errOutput.join('')).toContain('dependency.digest-mismatch');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('validates by id against the discovered set and fails closed for an unknown id', async () => {
    writeProjectProfile('acme.json', validProfile('acme.project'));
    const output: string[] = [];
    const errOutput: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errOutput.push(String(chunk)); return true; });
    try {
      expect(await profilesValidateCommand('acme.project', { projectRoot: project, trustProject: true })).toBe(0);
      output.length = 0; errOutput.length = 0;
      expect(await profilesValidateCommand('nope.missing', { projectRoot: project, trustProject: true })).toBe(1);
      expect(errOutput.join('')).toContain('selection.profile-missing');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('turns --profile-file into the flag + explicit selection a run needs', () => {
    const file = writeProjectProfile('acme.json', validProfile('acme.project'));
    const selection = resolveProfileSelection(project, false, { profileFile: file });
    expect(selection.env?.HOOTL_WORKFLOW_PROFILE).toBe('1');
    expect(selection.selection?.registered?.profile.profile.id).toBe('acme.project');
    // The selection the CLI produced is what activation consumes: flag on ⇒ profile path, not legacy.
    const personas = new PersonaRegistry();
    personas.loadFromDirectory(path.join(project, 'registry', 'personas'), false, false);
    const activation = activateWorkflowProfile({
      ...selection,
      sources: createWorkflowProfileComponentSources({
        registries: {
          personas,
          skills: new SkillRegistry({ toolRegistry: new ToolRegistry() }),
          models: new ModelRegistry({ env: process.env }),
        },
        toolCatalog: { hasDefinition: () => true },
      }),
    });
    expect(activation.kind).toBe('profile');
    if (activation.kind === 'profile') expect(activation.profileId).toBe('acme.project');
  });

  it('selects a trusted project profile by id and refuses it without the opt-in', () => {
    writeProjectProfile('acme.json', validProfile('acme.project'));
    const refused = (): unknown => resolveProfileSelection(project, false, { profile: 'acme.project' });
    expect(refused).toThrowError(/opt-in|not discovered/i);
    const selection = resolveProfileSelection(project, true, { profile: 'acme.project' });
    expect(selection.selection?.registered?.profile.profile.id).toBe('acme.project');
  });

  it('fails closed for an unknown id, both flags, and a broken profile file', () => {
    writeProjectProfile('acme.json', validProfile('acme.project'));
    expect(() => resolveProfileSelection(project, true, { profile: 'nope.missing' }))
      .toThrowError(/selection.profile-missing|not discovered/i);
    expect(() => resolveProfileSelection(project, true, { profile: 'acme.project', profileFile: 'x.json' }))
      .toThrowError(/mutually exclusive/);
    const broken = writeProjectProfile('broken.json', '{ nope');
    expect(() => resolveProfileSelection(project, true, { profileFile: broken }))
      .toThrowError(/discovery found problems|not valid JSON|Unexpected/i);
  });

  it('registers the commands and the run selection flags in the CLI surface', () => {
    const program = createProgram();
    const profiles = program.commands.find((command) => command.name() === 'profiles');
    expect(profiles).toBeDefined();
    expect(profiles!.commands.map((command) => command.name()).sort()).toEqual(['list', 'validate']);
    const run = program.commands.find((command) => command.name() === 'run');
    const runFlags = run!.options.map((option) => option.long);
    expect(runFlags).toContain('--profile');
    expect(runFlags).toContain('--profile-file');
    const validate = profiles!.commands.find((command) => command.name() === 'validate');
    expect(validate!.registeredArguments.map((argument) => argument.name())).toEqual(['target']);
  });
});
