import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateWorkflowProfileJson, validateWorkflowProfileStructure, WORKFLOW_PROFILE_SCHEMA } from '../workflow-profiles/profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from '../workflow-profiles/profile-semantic-validator.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const fixturesDirectory = path.resolve(process.cwd(), 'docs/workflow-profiles');
const fixtureNames = [
  'default-workflow-profile.example.json',
  'bounded-review-fix.example.json',
  'error-route.example.json',
];

function readFixture(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(fixturesDirectory, name), 'utf8')) as Record<string, any>;
}

describe('Workflow Profile v1 structural contract', () => {
  it('loads a valid Draft 2020-12 Schema with the canonical Ajv validator', () => {
    expect(WORKFLOW_PROFILE_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(validateWorkflowProfileStructure(readFixture(fixtureNames[0]!))).toEqual([]);
  });

  it('keeps Workflow Runtime compatibility metadata optional and non-operative in Phase 2', () => {
    const profileWithoutRuntime = readFixture(fixtureNames[0]!);
    delete profileWithoutRuntime.profile.runtime;
    const noRuntimeResult = validateWorkflowProfileJson(JSON.stringify(profileWithoutRuntime));
    expect(noRuntimeResult.ok, JSON.stringify(noRuntimeResult.diagnostics)).toBe(true);
    expect(validateWorkflowProfileSemantics(noRuntimeResult.profile!)).toEqual([]);

    const profileWithUnresolvedRuntimeMetadata = readFixture(fixtureNames[0]!);
    profileWithUnresolvedRuntimeMetadata.profile.runtime = { minVersion: '999.0.0' };
    const unresolvedResult = validateWorkflowProfileJson(JSON.stringify(profileWithUnresolvedRuntimeMetadata));
    expect(unresolvedResult.ok, JSON.stringify(unresolvedResult.diagnostics)).toBe(true);
    expect(validateWorkflowProfileSemantics(unresolvedResult.profile!)).toEqual([]);
  });

  it.each(fixtureNames)('accepts %s structurally and semantically', (name) => {
    const result = validateWorkflowProfileJson(fs.readFileSync(path.join(fixturesDirectory, name), 'utf8'), name);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(validateWorkflowProfileSemantics(result.profile!)).toEqual([]);
  });

  it('reports malformed JSON separately from schema-version and structural errors', () => {
    expect(validateWorkflowProfileJson('{', 'broken.json').diagnostics[0]?.stage).toBe('parse');
    expect(validateWorkflowProfileJson('{"schemaVersion":"1.0.0","schemaVersion":"1.0.0"}', 'duplicate.json').diagnostics[0]?.code).toBe('json.duplicate-key');
    const duplicatePort = validateWorkflowProfileJson('{"workflow":{"nodes":[{"inputs":{"request":1,"request":2}}]}}', 'duplicate-port.json');
    expect(duplicatePort.diagnostics[0]?.code).toBe('json.duplicate-key');
    expect(duplicatePort.diagnostics[0]?.path).toBe('/workflow/nodes/0/inputs/request');
    const unknownVersion = validateWorkflowProfileJson(JSON.stringify({ schemaVersion: '2.0.0' }), 'future.json');
    expect(unknownVersion.diagnostics[0]?.stage).toBe('schema-version');
    const invalid = readFixture(fixtureNames[0]!);
    invalid.workflow.nodes[0].config = { arbitraryExecutableField: 'not allowed' };
    const diagnostic = validateWorkflowProfileJson(JSON.stringify(invalid)).diagnostics[0]!;
    expect(diagnostic.stage).toBe('structural');
    expect(diagnostic.path).toContain('arbitraryExecutableField');
    expect(diagnostic.nodeId).toBe('request');
  });

  it('rejects unsupported executable extension values and unbounded extension keys', () => {
    const profile = readFixture(fixtureNames[0]!);
    profile.profile['x-note'] = 'safe scalar';
    expect(validateWorkflowProfileStructure(profile)).toEqual([]);
    profile.profile['x-nested'] = { run: 'no code' };
    expect(validateWorkflowProfileStructure(profile).some((diagnostic) => diagnostic.path === '/profile/x-nested')).toBe(true);
    delete profile.profile['x-nested'];
    profile.profile['x-' + 'a'.repeat(65)] = true;
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);
  });

  it('enforces the 16-field x-* cap on every extension-enabled object and limits strings to 1024 characters', () => {
    const extensionTargets: Array<{ name: string; select: (profile: Record<string, any>) => Record<string, any> }> = [
      {
        name: 'document root',
        select: (profile) => profile,
      },
      {
        name: 'profile metadata',
        select: (profile) => {
          profile.profile.runtime = { minVersion: '1.0.0' };
          profile.profile.license = 'MIT';
          profile.profile.tags = [];
          return profile.profile;
        },
      },
      {
        name: 'node',
        select: (profile) => {
          const node = profile.workflow.nodes.find((candidate: { id: string }) => candidate.id === 'plan')!;
          node.name = 'Plan node';
          return node;
        },
      },
      {
        name: 'edge',
        select: (profile) => {
          const edge = profile.workflow.edges.find((candidate: { from: string; to: string }) => candidate.from === 'review' && candidate.to === 'execute')!;
          edge.default = false;
          edge.priority = 100;
          return edge;
        },
      },
    ];

    for (const target of extensionTargets) {
      const withinLimit = readFixture(fixtureNames[0]!);
      const withinTarget = target.select(withinLimit);
      for (let index = 0; index < 16; index++) withinTarget[`x-extra-${index}`] = index;
      expect(validateWorkflowProfileStructure(withinLimit), target.name).toEqual([]);

      const overLimit = readFixture(fixtureNames[0]!);
      const overTarget = target.select(overLimit);
      for (let index = 0; index < 17; index++) overTarget[`x-extra-${index}`] = index;
      expect(validateWorkflowProfileStructure(overLimit).length, target.name).toBeGreaterThan(0);
    }

    // The aggregate Schema property cap cannot count only x-* members; the
    // semantic validator must still reject 17 extensions when optional standard
    // properties are absent and the aggregate cap alone would allow them.
    const sparseOverLimit = readFixture(fixtureNames[0]!);
    for (let index = 0; index < 17; index++) sparseOverLimit.profile[`x-sparse-${index}`] = index;
    const sparseResult = validateWorkflowProfileJson(JSON.stringify(sparseOverLimit));
    expect(sparseResult.ok).toBe(true);
    expect(validateWorkflowProfileSemantics(sparseResult.profile!).some((diagnostic) => diagnostic.code === 'extension.too-many')).toBe(true);

    const scalarValues = readFixture(fixtureNames[0]!);
    scalarValues.profile['x-string'] = 'bounded';
    scalarValues.profile['x-number'] = 42;
    scalarValues.profile['x-boolean'] = true;
    scalarValues.profile['x-null'] = null;
    expect(validateWorkflowProfileStructure(scalarValues)).toEqual([]);

    const exactLength = readFixture(fixtureNames[0]!);
    exactLength.profile['x-long'] = 'a'.repeat(1024);
    expect(validateWorkflowProfileStructure(exactLength)).toEqual([]);

    const longString = readFixture(fixtureNames[0]!);
    longString.profile['x-long'] = 'a'.repeat(1025);
    expect(validateWorkflowProfileStructure(longString).some((diagnostic) => diagnostic.path === '/profile/x-long')).toBe(true);

    const nonScalar = readFixture(fixtureNames[0]!);
    nonScalar.profile['x-array'] = ['not', 'a', 'scalar'];
    expect(validateWorkflowProfileStructure(nonScalar).some((diagnostic) => diagnostic.path === '/profile/x-array')).toBe(true);
  });

  it('validates retry and route policy shapes without executing retry behavior', () => {
    const profile = readFixture(fixtureNames[0]!);
    const planner = profile.workflow.nodes.find((node: { kind: string }) => node.kind === 'planner')!;

    planner.onError = { strategy: 'retry', maxAttempts: 2 };
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);

    planner.onError = { strategy: 'retry', maxAttempts: 6, backoffSeconds: 0, retryOn: ['technical'] };
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);

    planner.onError = { strategy: 'retry', maxAttempts: 2, backoffSeconds: 0, retryOn: ['technical', 'technical'] };
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);

    planner.onError = { strategy: 'retry', maxAttempts: 2, backoffSeconds: 0, retryOn: ['unknown'] };
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);

    planner.onError = { strategy: 'route', routeTo: 'review', routeMap: {}, retryOn: ['technical'] };
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);
  });

  it('keeps structural validation independent from semantic graph checks', () => {
    const profile = readFixture(fixtureNames[0]!);
    profile.workflow.edges[0].to = 'missing-node';
    expect(validateWorkflowProfileStructure(profile)).toEqual([]);
    const validated = validateWorkflowProfileJson(JSON.stringify(profile));
    expect(validated.ok).toBe(true);
    expect(validateWorkflowProfileSemantics(validated.profile as WorkflowProfileDocument).some((d) => d.code === 'edge.target-missing')).toBe(true);
  });
});
