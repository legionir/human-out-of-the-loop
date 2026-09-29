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

  it('applies the same bounded scalar extension policy at the document root', () => {
    const profile = readFixture(fixtureNames[0]!);
    profile['x-note'] = 'safe scalar';
    expect(validateWorkflowProfileStructure(profile)).toEqual([]);
    profile['x-nested'] = { executable: 'no' };
    expect(validateWorkflowProfileStructure(profile).some((diagnostic) => diagnostic.path === '/x-nested')).toBe(true);
    delete profile['x-nested'];
    delete profile['x-note'];
    for (let index = 0; index < 16; index++) profile[`x-extra-${index}`] = index;
    expect(validateWorkflowProfileStructure(profile)).toEqual([]);
    profile['x-extra-16'] = 16;
    expect(validateWorkflowProfileStructure(profile).length).toBeGreaterThan(0);
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
