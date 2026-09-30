import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { ModelRegistry } from '../registries/model-registry.js';
import { ToolsetRegistry, effectiveToolIds } from '../workflow-profiles/toolsets.js';
import { canonicalJson, dependencyDigest, dependencyDigestEnvelope, DEPENDENCY_DIGEST_PATTERN, DigestInputError } from '../workflow-profiles/profile-digest.js';
import {
  RubricCatalogue,
  createBuiltInRubricCatalogue,
  resolveWorkflowProfileDependencies,
  type WorkflowProfileComponentSources,
} from '../workflow-profiles/profile-resolver.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const registryDir = path.resolve(process.cwd(), 'registry');

function codes(error: unknown): string[] {
  expect(error).toBeInstanceOf(WorkflowProfileLoadError);
  return (error as WorkflowProfileLoadError).diagnostics.map((diagnostic) => diagnostic.code);
}

// ─── Fixtures ─────────────────────────────────────────────────────

interface FixtureComponents {
  persona: Record<string, unknown>;
  skill: Record<string, unknown>;
  toolset: { id: string; version: string; tools: string[] } | Record<string, unknown>;
  model: Record<string, unknown>;
}

const builtInRubric = createBuiltInRubricCatalogue().get('hootl.default-review') as unknown as Record<string, unknown>;

const components: FixtureComponents = {
  persona: { id: 'hootl.executor', name: 'Executor', system: 'You execute plans.', allowedTools: ['read_file', 'write_file'] },
  skill: { id: 'hootl.write-check', name: 'Write check', version: '1.2.3', instructions: 'SKILL.md', tools: ['read_file'], priority: 50, resolvedInstructions: '# Verify the write', resolvedTools: ['read_file'] },
  toolset: { id: 'hootl.default-tools', version: '1.0.0', tools: ['read_file', 'write_file'] },
  model: { id: 'hootl.model', provider: 'anthropic', model: 'claude-sonnet-5', config: { temperature: 0.3 } },
};

function sourceFor(record: Record<string, unknown>, extras: Partial<{ listIds: () => string[]; isEnabled: (id: string) => boolean }> = {}) {
  return {
    get: (id: string) => (record.id === id ? { ...record } : undefined),
    ...extras,
  };
}

function fakeSources(overrides: Partial<WorkflowProfileComponentSources> = {}): WorkflowProfileComponentSources {
  return {
    personas: sourceFor(components.persona),
    skills: sourceFor(components.skill),
    toolsets: sourceFor(components.toolset as Record<string, unknown>),
    rubrics: createBuiltInRubricCatalogue(),
    models: sourceFor(components.model),
    ...overrides,
  };
}

function pin(kind: string, record: Record<string, unknown>, id = record.id as string, version?: string) {
  const digest = dependencyDigest(kind, id, record);
  return version ? { kind, id, version, digest } : { kind, id, digest };
}

function skillProjection() {
  const { resolvedInstructions, resolvedTools, ...metadata } = components.skill as Record<string, unknown>;
  void resolvedTools;
  return { ...metadata, instructions: resolvedInstructions };
}

function profileDocument(dependencies: unknown[], nodes: unknown[] = []): WorkflowProfileDocument {
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'test.profile', name: 'Test', version: '1.0.0', author: 'tests' },
    dependencies,
    workflow: { startNode: 'start', nodes, edges: [] },
    policies: {},
    result: [],
  } as unknown as WorkflowProfileDocument;
}

// ─── Digest contract ──────────────────────────────────────────────

describe('Workflow Profile dependency digest contract', () => {
  it('canonicalizes object key order but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
    expect(canonicalJson({ a: [3, 2, 1] })).not.toBe(canonicalJson({ a: [1, 2, 3] }));
    expect(canonicalJson({ nested: { z: null, a: true } })).toBe('{"nested":{"a":true,"z":null}}');
  });

  it('rejects values that are not JSON content', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(DigestInputError);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(DigestInputError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(DigestInputError);
    class NotJson { id = 'x'; }
    expect(() => canonicalJson(new NotJson())).toThrow(DigestInputError);
    expect(() => canonicalJson({ value: () => 'x' })).toThrow(DigestInputError);
    const withAccessor: Record<string, unknown> = {};
    Object.defineProperty(withAccessor, 'id', { enumerable: true, get: () => 'x' });
    expect(() => canonicalJson(withAccessor)).toThrow(DigestInputError);
  });

  it('binds the digest to kind and id as well as content', () => {
    const content = { id: 'a', value: 1 };
    expect(dependencyDigest('persona', 'a', content)).toMatch(DEPENDENCY_DIGEST_PATTERN);
    expect(dependencyDigest('persona', 'a', content)).toBe(dependencyDigest('persona', 'a', { value: 1, id: 'a' }));
    expect(dependencyDigest('persona', 'a', content)).not.toBe(dependencyDigest('skill', 'a', content));
    expect(dependencyDigest('persona', 'a', content)).not.toBe(dependencyDigest('persona', 'b', content));
    expect(dependencyDigestEnvelope('persona', 'a', content).startsWith('hootl.workflow-profile.dependency.v1\npersona\na\n')).toBe(true);
  });
});

// ─── Toolsets (Step 2) ────────────────────────────────────────────

describe('Workflow Profile toolsets', () => {
  const catalog = { hasDefinition: (id: string) => ['read_file', 'write_file', 'git_status'].includes(id) };

  it('registers named, versioned toolsets whose tools exist in the runtime catalog', () => {
    const registry = new ToolsetRegistry({ tools: catalog });
    const toolset = registry.register({ id: 'hootl.default-tools', version: '1.0.0', tools: ['read_file', 'write_file'] });
    expect(toolset.id).toBe('hootl.default-tools');
    expect(registry.get('hootl.default-tools')?.version).toBe('1.0.0');
    expect(registry.size).toBe(1);
    expect(Object.isFrozen(registry.get('hootl.default-tools'))).toBe(true);
  });

  it('fails closed for an absent tool, a duplicate id, and an invalid definition', () => {
    const registry = new ToolsetRegistry({ tools: catalog });
    try { registry.register({ id: 'hootl.bad', version: '1.0.0', tools: ['delete_everything'] }); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['toolset.tool-unavailable']); }

    registry.register({ id: 'hootl.default-tools', version: '1.0.0', tools: ['read_file'] });
    try { registry.register({ id: 'hootl.default-tools', version: '2.0.0', tools: ['read_file'] }); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['toolset.duplicate-id']); }

    try { registry.register({ id: 'hootl.empty', version: '1.0.0', tools: [] }); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['toolset.invalid']); }
  });

  it('never expands access: effective tools are the strictest intersection', () => {
    const toolset = { tools: ['read_file', 'write_file', 'git_status'], deniedTools: ['git_status'] };
    expect(effectiveToolIds({
      runtimePermitted: ['read_file', 'write_file', 'git_status'],
      personaAllowedTools: ['read_file', 'write_file'],
      toolset,
    })).toEqual(['read_file', 'write_file']);

    // A toolset may never introduce a tool the runtime or persona does not allow.
    expect(effectiveToolIds({
      runtimePermitted: ['read_file'],
      personaAllowedTools: ['read_file', 'write_file'],
      toolset: { tools: ['read_file', 'write_file'] },
    })).toEqual(['read_file']);

    expect(effectiveToolIds({
      runtimePermitted: ['read_file', 'write_file'],
      personaAllowedTools: ['*'],
      deniedTools: ['write_file'],
    })).toEqual(['read_file']);

    expect(effectiveToolIds({
      runtimePermitted: '*',
      knownToolIds: ['read_file', 'write_file'],
      personaAllowedTools: ['*'],
      toolset: { tools: ['read_file'] },
    })).toEqual(['read_file']);

    try { effectiveToolIds({ runtimePermitted: '*', personaAllowedTools: ['*'] }); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['toolset.runtime-universe-unknown']); }
  });
});

// ─── Rubric catalogue (D-WP-010) ──────────────────────────────────

describe('Workflow Profile rubric catalogue', () => {
  it('exposes the built-in rubric that mirrors the review decision contract', () => {
    const catalogue = createBuiltInRubricCatalogue();
    const rubric = catalogue.get('hootl.default-review');
    expect(rubric?.decisions).toEqual(['pass', 'revise', 'reject']);
    expect(rubric?.version).toBe('1.0.0');
    expect(Object.isFrozen(rubric)).toBe(true);
  });

  it('rejects malformed and duplicate rubric records', () => {
    try { new RubricCatalogue([{ id: 'x', version: '1.0.0', decisions: [], criteria: 'c' }]); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['rubric.invalid']); }
    const record = { id: 'rubric.x', version: '1.0.0', decisions: ['pass'], criteria: 'c' };
    try { new RubricCatalogue([record, record]); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['rubric.duplicate-id']); }
  });
});

// ─── Resolver ─────────────────────────────────────────────────────

describe('Workflow Profile dependency resolver', () => {
  it('resolves every v1 dependency kind to its existing source of truth', () => {
    const dependencies = [
      pin('persona', components.persona),
      { kind: 'skill', id: 'hootl.write-check', version: '1.2.3', digest: dependencyDigest('skill', 'hootl.write-check', skillProjection()) },
      pin('toolset', components.toolset as Record<string, unknown>, 'hootl.default-tools', '1.0.0'),
      { kind: 'rubric', id: 'hootl.default-review', version: '1.0.0', digest: dependencyDigest('rubric', 'hootl.default-review', builtInRubric) },
      pin('model-profile', components.model),
    ];
    const resolved = resolveWorkflowProfileDependencies(profileDocument(dependencies), fakeSources());

    expect(resolved.dependencies.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'persona:hootl.executor', 'skill:hootl.write-check', 'toolset:hootl.default-tools', 'rubric:hootl.default-review', 'model-profile:hootl.model',
    ]);
    for (const entry of resolved.dependencies) {
      expect(entry.contentDigest).toBe(entry.declaredDigest);
      expect(Object.isFrozen(entry.content)).toBe(true);
    }
    expect(resolved.get('skill', 'hootl.write-check')?.resolvedVersion).toBe('1.2.3');
    expect(resolved.get('skill', 'hootl.write-check')?.content.instructions).toBe('# Verify the write');
    expect(resolved.get('model-profile', 'hootl.model')?.resolvedVersion).toBeUndefined();
  });

  it('pins the resolved SKILL.md text, not the on-disk instructions reference', () => {
    const resolvedContent = dependencyDigest('skill', components.skill.id as string, skillProjection());
    const onDiskDigest = dependencyDigest('skill', components.skill.id as string, components.skill);
    expect(resolvedContent).not.toBe(onDiskDigest);

    const ok = resolveWorkflowProfileDependencies(
      profileDocument([{ kind: 'skill', id: components.skill.id, digest: resolvedContent }]),
      fakeSources(),
    );
    expect(ok.dependencies).toHaveLength(1);

    try {
      resolveWorkflowProfileDependencies(profileDocument([{ kind: 'skill', id: components.skill.id, digest: onDiskDigest }]), fakeSources());
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toEqual(['dependency.digest-mismatch']);
    }
  });

  it('fails closed for malformed, mismatched, missing, ambiguous, and disabled dependencies', () => {
    const cases: Array<{ dependency: unknown; sources?: Partial<WorkflowProfileComponentSources>; expected: string }> = [
      { dependency: { kind: 'persona', id: 'hootl.executor', digest: 'sha256:zz' }, expected: 'dependency.digest-invalid' },
      { dependency: { kind: 'persona', id: 'hootl.executor', digest: `sha256:${'0'.repeat(64)}` }, expected: 'dependency.digest-mismatch' },
      { dependency: { kind: 'persona', id: 'hootl.missing', digest: `sha256:${'0'.repeat(64)}` }, expected: 'dependency.missing' },
      { dependency: { kind: 'persona', id: 'hootl.executor', version: 'nope', digest: dependencyDigest('persona', 'hootl.executor', components.persona) }, expected: 'dependency.version-invalid' },
      { dependency: { kind: 'skill', id: components.skill.id, version: '9.9.9', digest: dependencyDigest('skill', components.skill.id as string, skillProjection()) }, expected: 'dependency.version-mismatch' },
      { dependency: pin('model-profile', components.model), sources: { models: { get: () => undefined } }, expected: 'dependency.missing' },
      { dependency: pin('persona', components.persona), sources: { personas: { get: () => 42 } }, expected: 'dependency.content-invalid' },
      {
        dependency: pin('persona', components.persona),
        sources: { personas: sourceFor(components.persona, { listIds: () => ['hootl.executor', 'hootl.executor'] }) },
        expected: 'dependency.ambiguous',
      },
      {
        dependency: pin('persona', components.persona),
        sources: { personas: sourceFor(components.persona, { isEnabled: () => false }) },
        expected: 'dependency.disabled',
      },
      {
        dependency: pin('skill', components.skill, components.skill.id as string),
        sources: { skills: { get: () => ({ ...components.skill, resolvedInstructions: undefined }) } },
        expected: 'dependency.content-invalid',
      },
    ];
    for (const testCase of cases) {
      try {
        resolveWorkflowProfileDependencies(profileDocument([testCase.dependency]), fakeSources(testCase.sources));
        throw new Error(`expected ${testCase.expected}`);
      } catch (error) {
        expect(codes(error)).toEqual([testCase.expected]);
      }
    }
  });

  it('reports a missing source of truth and an unresolvable review rubric', () => {
    try {
      resolveWorkflowProfileDependencies(
        profileDocument([pin('model-profile', components.model)], [
          { id: 'review', kind: 'review', inputs: {}, outputs: {}, config: { rubricRef: 'hootl.default-review' }, goal: 'review' },
        ]),
        fakeSources({ models: undefined as unknown as WorkflowProfileComponentSources['models'] }),
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toEqual(['dependency.source-missing', 'dependency.rubric-unresolved']);
    }
  });

  it('matches the declared review decision domain against the digest-pinned rubric', () => {
    const rubricPin = { kind: 'rubric', id: 'hootl.default-review', version: '1.0.0', digest: dependencyDigest('rubric', 'hootl.default-review', builtInRubric) };
    const reviewNode = {
      id: 'review', kind: 'review', goal: 'review', inputs: {}, config: { rubricRef: 'hootl.default-review', allowedDecisions: ['pass', 'revise', 'reject'] },
      outputs: { decision: { type: 'string', required: true, enum: ['pass', 'revise', 'reject'] } },
    };
    const resolved = resolveWorkflowProfileDependencies(profileDocument([rubricPin], [reviewNode]), fakeSources());
    expect(resolved.reviewDomains).toEqual([{ nodeId: 'review', rubricId: 'hootl.default-review', decisions: ['pass', 'revise', 'reject'] }]);

    const mismatched = { ...reviewNode, config: { rubricRef: 'hootl.default-review', allowedDecisions: ['pass', 'revise'] }, outputs: { decision: { type: 'string', required: true, enum: ['pass', 'revise'] } } };
    try { resolveWorkflowProfileDependencies(profileDocument([rubricPin], [mismatched]), fakeSources()); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['dependency.rubric-decision-mismatch']); }

    const portOnly = { ...reviewNode, config: { rubricRef: 'hootl.default-review' }, outputs: { decision: { type: 'string', required: true, enum: ['pass', 'revise'] } } };
    try { resolveWorkflowProfileDependencies(profileDocument([rubricPin], [portOnly]), fakeSources()); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['dependency.rubric-decision-mismatch']); }
  });

  it('re-verifies toolset membership against the live tool catalog', () => {
    const toolsetPin = pin('toolset', components.toolset as Record<string, unknown>, 'hootl.default-tools');
    const sources = fakeSources({ toolCatalog: { hasDefinition: (id: string) => id === 'read_file' } });
    try { resolveWorkflowProfileDependencies(profileDocument([toolsetPin]), sources); throw new Error('expected failure'); }
    catch (error) { expect(codes(error)).toEqual(['dependency.tool-unavailable']); }
    expect(resolveWorkflowProfileDependencies(
      profileDocument([toolsetPin]),
      fakeSources({ toolCatalog: { hasDefinition: () => true } }),
    ).dependencies).toHaveLength(1);
  });

  it('resolves real repository components: persona, model, toolset, and built-in rubric', () => {
    const personas = new PersonaRegistry();
    personas.loadFromDirectory(path.join(registryDir, 'personas'), false);
    const models = new ModelRegistry();
    models.loadConfigsFromDirectory(path.join(registryDir, 'models'), false);

    const toolIds = fs.readdirSync(path.join(registryDir, 'tools'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => (JSON.parse(fs.readFileSync(path.join(registryDir, 'tools', file), 'utf8')) as { id: string }).id);
    const catalogIds = new Set(toolIds);
    const toolsets = new ToolsetRegistry({ tools: { hasDefinition: (id) => catalogIds.has(id) } });
    toolsets.register({ id: 'hootl.read-only', version: '1.0.0', tools: ['read_file', 'search_code'].filter((id) => catalogIds.has(id)) });

    const persona = personas.get('coder');
    const model = models.getConfig('claude-sonnet');
    const persisted = JSON.parse(fs.readFileSync(path.join(registryDir, 'models', 'claude-sonnet.json'), 'utf8')) as Record<string, unknown>;
    expect(persona).toBeDefined();
    expect(model).toBeDefined();

    const toolset = toolsets.get('hootl.read-only') as unknown as Record<string, unknown>;
    const dependencies = [
      { kind: 'persona', id: 'coder', digest: dependencyDigest('persona', 'coder', persona as unknown as Record<string, unknown>) },
      { kind: 'model-profile', id: 'claude-sonnet', digest: dependencyDigest('model-profile', 'claude-sonnet', { ...persisted, ...(model as unknown as Record<string, unknown>) }) },
      { kind: 'toolset', id: 'hootl.read-only', version: '1.0.0', digest: dependencyDigest('toolset', 'hootl.read-only', toolset) },
      { kind: 'rubric', id: 'hootl.default-review', version: '1.0.0', digest: dependencyDigest('rubric', 'hootl.default-review', createBuiltInRubricCatalogue().get('hootl.default-review') as unknown as Record<string, unknown>) },
    ];
    const resolved = resolveWorkflowProfileDependencies(profileDocument(dependencies), {
      personas: { get: (id) => personas.get(id) },
      skills: { get: () => undefined },
      toolsets: { get: (id) => toolsets.get(id) },
      rubrics: createBuiltInRubricCatalogue(),
      models: { get: (id) => models.getConfig(id) },
      toolCatalog: { hasDefinition: (id) => catalogIds.has(id) },
    });
    expect(resolved.dependencies).toHaveLength(4);
    expect(resolved.get('persona', 'coder')?.declaredDigest).toBe(resolved.get('persona', 'coder')?.contentDigest);
  });

  it('rejects the shipped example pins because their placeholder digests do not match real content', () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/workflow-profiles/bounded-review-fix.example.json'), 'utf8')) as WorkflowProfileDocument;
    const personas = new PersonaRegistry();
    personas.loadFromDirectory(path.join(registryDir, 'personas'), false);
    try {
      resolveWorkflowProfileDependencies(example, {
        personas: { get: (id) => personas.get(id) },
        skills: { get: () => undefined },
        toolsets: { get: () => undefined },
        rubrics: createBuiltInRubricCatalogue(),
        models: { get: () => undefined },
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(codes(error)).toContain('dependency.missing');
    }
  });
});
