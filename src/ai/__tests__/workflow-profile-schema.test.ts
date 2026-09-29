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

  it.each(fixtureNames)('accepts %s structurally and semantically', (name) => {
    const result = validateWorkflowProfileJson(fs.readFileSync(path.join(fixturesDirectory, name), 'utf8'), name);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(validateWorkflowProfileSemantics(result.profile!)).toEqual([]);
  });

  it('reports malformed JSON separately from schema-version and structural errors', () => {
    expect(validateWorkflowProfileJson('{', 'broken.json').diagnostics[0]?.stage).toBe('parse');
    expect(validateWorkflowProfileJson('{"schemaVersion":"1.0.0","schemaVersion":"1.0.0"}', 'duplicate.json').diagnostics[0]?.code).toBe('json.duplicate-key');
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
        select: (profile) => { delete profile.$schema; return profile; },
      },
      {
        name: 'profile metadata',
        select: (profile) => { delete profile.profile.description; return profile.profile; },
      },
      {
        name: 'node',
        select: (profile) => profile.workflow.nodes[0],
      },
      {
        name: 'edge',
        select: (profile) => {
          delete profile.workflow.edges[0].label;
          delete profile.workflow.edges[0].when;
          return profile.workflow.edges[0];
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
