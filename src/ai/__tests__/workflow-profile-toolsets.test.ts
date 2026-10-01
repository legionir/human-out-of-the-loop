/**
 * Phase 9 (finding H-3): the toolset registry layer.
 *
 * A profile may pin a `toolset` dependency, but before this the run path never wired a
 * `ToolsetRegistry` into the resolver's sources, so any profile naming a toolset failed with
 * `dependency.source-missing`. The loader follows the same layer convention as personas/skills
 * (`<layer>/toolsets/<id>.json`, project overrides package) and every registration re-checks the
 * tool ids against the live catalog.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolsetRegistry, loadToolsetsFromDirectory } from '../workflow-profiles/toolsets.js';
import { createWorkflowProfileComponentSources } from '../workflow-profiles/profile-sources.js';
import { resolveWorkflowProfileDependencies } from '../workflow-profiles/profile-resolver.js';
import { loadProfileRegistries } from '../../cli/commands/profiles.js';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('Phase 9 — named toolsets from a registry layer', () => {
  let dir: string;
  const catalog = { hasDefinition: (id: string) => ['read_file', 'write_file'].includes(id) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-toolsets-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, record: unknown): void => {
    fs.writeFileSync(path.join(dir, `${id}.json`), typeof record === 'string' ? record : JSON.stringify(record));
  };

  it('loads one file per toolset and reports broken files instead of throwing', () => {
    write('good', { id: 'good', version: '1.0.0', tools: ['read_file'] });
    write('bad-json', '{ nope');
    write('unknown-tool', { id: 'unknown-tool', version: '1.0.0', tools: ['not_a_tool'] });
    const registry = new ToolsetRegistry({ tools: catalog });

    const result = loadToolsetsFromDirectory(dir, registry);

    expect(result.loaded).toBe(1);
    expect(result.errors.map((failure) => failure.file).sort()).toEqual(['bad-json.json', 'unknown-tool.json']);
    expect(registry.get('good')).toBeDefined();
    // A toolset can never introduce a tool the runtime does not have.
    expect(registry.has('unknown-tool')).toBe(false);
  });

  it('tolerates a missing directory unless it is required', () => {
    const registry = new ToolsetRegistry({ tools: catalog });
    const missing = path.join(dir, 'nope');
    expect(loadToolsetsFromDirectory(missing, registry)).toEqual({ loaded: 0, errors: [] });
    expect(loadToolsetsFromDirectory(missing, registry, { required: true }).errors)
      .toEqual([{ file: missing, error: 'Directory does not exist' }]);
  });

  it('lets a higher layer replace a same-id toolset only when asked to', () => {
    write('shared', { id: 'shared', version: '1.0.0', tools: ['read_file'] });
    const registry = new ToolsetRegistry({ tools: catalog });
    loadToolsetsFromDirectory(dir, registry);

    // Overriding is refused by default (a duplicate id is an error the caller sees)…
    write('shared', { id: 'shared', version: '2.0.0', tools: ['read_file', 'write_file'] });
    expect(loadToolsetsFromDirectory(dir, registry).errors).toHaveLength(1);
    expect(registry.get('shared')?.version).toBe('1.0.0');

    // …and allowed for a project layer, which is the documented override direction.
    expect(loadToolsetsFromDirectory(dir, registry, { override: true }).loaded).toBe(1);
    expect(registry.get('shared')?.version).toBe('2.0.0');
    expect(registry.list().map((toolset) => toolset.id)).toEqual(['shared']);
  });

  it('resolves a profile that pins a toolset from a project registry layer (end to end)', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-toolset-project-'));
    try {
      fs.cpSync(path.join(REPO_ROOT, 'registry'), path.join(project, 'registry'), { recursive: true });
      const toolset = { id: 'phase9.read-only', name: 'Read only', version: '1.0.0', tools: ['read_file'] };
      fs.mkdirSync(path.join(project, 'registry', 'toolsets'), { recursive: true });
      fs.writeFileSync(path.join(project, 'registry', 'toolsets', 'phase9.read-only.json'), JSON.stringify(toolset));

      const { personaRegistry, skillRegistry, modelRegistry, toolRegistry, toolsetRegistry } = loadProfileRegistries(project);
      const sources = createWorkflowProfileComponentSources({
        registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry, toolsets: toolsetRegistry },
        toolCatalog: { hasDefinition: (id: string) => toolRegistry.getDefinition(id) !== undefined },
      });
      const planner = personaRegistry.get('planner') as unknown as Record<string, unknown>;
      const stringPort = (required: boolean) => ({ type: 'string', required });
      const document = {
        schemaVersion: '1.0.0',
        profile: { id: 'phase9.toolset-profile', name: 'Toolset profile', version: '1.0.0', author: 'tests' },
        dependencies: [
          { kind: 'persona', id: 'planner', digest: dependencyDigest('persona', 'planner', componentProjection(planner)) },
          { kind: 'toolset', id: 'phase9.read-only', digest: dependencyDigest('toolset', 'phase9.read-only', componentProjection(toolset)) },
        ],
        workflow: {
          startNode: 'request',
          nodes: [
            { id: 'request', kind: 'intake', goal: 'carry', inputs: { request: { type: 'object', required: false } }, outputs: { request: { type: 'object', required: true } }, config: {} },
            {
              id: 'plan', kind: 'planner', goal: 'plan', inputs: { request: { type: 'object', required: false } },
              outputs: { kind: { type: 'string', required: true, enum: ['plan', 'answer', 'clarify'] }, answer: stringPort(false) },
              bindings: { personaRef: 'planner', toolsetRef: 'phase9.read-only' }, config: { mode: 'direct' },
            },
            { id: 'done', kind: 'end', goal: 'finish', inputs: { answer: stringPort(false) }, outputs: { response: stringPort(false) }, config: { outcome: 'success', emit: { response: 'answer' } } },
          ],
          edges: [
            { from: 'request', to: 'plan', map: { request: '/request' } },
            { from: 'plan', to: 'done', default: true, map: { answer: '/answer' } },
          ],
        },
        policies: {
          execution: { maxNodeVisits: 10, maxDurationSeconds: 60, maxModelCalls: 5, maxToolCalls: 5, onLimit: 'fail' },
          tools: { allowedToolsets: ['phase9.read-only'] },
          approvals: { policy: 'runtime-default' },
        },
        result: [{ fromNode: 'done', port: 'response', kind: 'response', outcome: 'success' }],
      } as unknown as WorkflowProfileDocument;

      const resolved = resolveWorkflowProfileDependencies(document, sources);
      expect(resolved.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`).sort())
        .toEqual(['persona:planner', 'toolset:phase9.read-only']);
      expect(resolved.get('toolset', 'phase9.read-only')).toBeDefined();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
