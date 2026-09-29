import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateWorkflowProfileJson } from '../workflow-profiles/profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from '../workflow-profiles/profile-semantic-validator.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const fixtures = path.resolve(process.cwd(), 'docs/workflow-profiles');
function fixture(name = 'default-workflow-profile.example.json'): WorkflowProfileDocument {
  const text = fs.readFileSync(path.join(fixtures, name), 'utf8');
  const validated = validateWorkflowProfileJson(text, name);
  if (!validated.ok || !validated.profile) throw new Error(JSON.stringify(validated.diagnostics));
  return structuredClone(validated.profile) as WorkflowProfileDocument;
}
function codes(profile: WorkflowProfileDocument): string[] {
  return validateWorkflowProfileSemantics(profile).map((diagnostic) => diagnostic.code);
}

describe('Workflow Profile semantic validation', () => {
  it('rejects duplicate dependency (kind,id), even when version/digest metadata differs', () => {
    const profile = fixture();
    profile.dependencies.push({ ...profile.dependencies[0]!, version: '99.0.0', digest: `sha256:${'a'.repeat(64)}` });
    expect(codes(profile)).toContain('dependency.duplicate');
  });

  it('rejects duplicate loop counter IDs and an unbounded cycle', () => {
    const duplicate = fixture();
    const bounded = duplicate.workflow.edges.find((edge) => edge.loop)!;
    const second = structuredClone(bounded);
    second.from = 'execute';
    second.to = 'review';
    second.map = { plan: '/plan', request: '/request', result: '/result' };
    duplicate.workflow.edges.push(second);
    expect(codes(duplicate)).toContain('loop.counter-duplicate');

    const unbounded = fixture();
    const loopEdge = unbounded.workflow.edges.find((edge) => edge.loop)!;
    delete loopEdge.loop;
    expect(codes(unbounded)).toContain('workflow.unbounded-cycle');
  });

  it('checks edge endpoints, required mappings, one-level pointers, and type compatibility', () => {
    const missingEndpoint = fixture();
    missingEndpoint.workflow.edges[0]!.to = 'not-present';
    expect(codes(missingEndpoint)).toContain('edge.target-missing');

    const missingInput = fixture();
    delete missingInput.workflow.edges[0]!.map.request;
    expect(codes(missingInput)).toContain('mapping.required-input-missing');

    const deepPointer = fixture();
    deepPointer.workflow.edges[0]!.map.request = '/request/value';
    expect(codes(deepPointer)).toContain('mapping.pointer-depth');

    const mismatch = fixture();
    mismatch.workflow.edges[0]!.map.request = '/needsClarification';
    expect(codes(mismatch)).toContain('mapping.type-mismatch');
  });

  it('rejects unreachable nodes and end nodes', () => {
    const unreachableNode = fixture();
    unreachableNode.workflow.edges = unreachableNode.workflow.edges.filter((edge) => edge.to !== 'clarify');
    expect(codes(unreachableNode)).toContain('node.unreachable');

    const unreachableEnd = fixture();
    // Prevent the bounded loop's exhaustion route from keeping this end reachable.
    const loop = unreachableEnd.workflow.edges.find((edge) => edge.loop)!;
    loop.loop!.onExhausted = { strategy: 'fail' };
    unreachableEnd.workflow.edges = unreachableEnd.workflow.edges.filter((edge) => edge.to !== 'rejected');
    expect(codes(unreachableEnd)).toContain('end.unreachable');
  });

  it('validates condition/review enums, finite-domain exhaustiveness, and permits deterministic overlap', () => {
    const incomplete = fixture();
    incomplete.workflow.edges.splice(0, 1);
    expect(codes(incomplete)).toContain('route.domain-not-exhaustive');

    const overlap = fixture();
    const duplicatedRoute = structuredClone(overlap.workflow.edges[0]!);
    duplicatedRoute.label = 'same-priority-overlap';
    duplicatedRoute.priority = overlap.workflow.edges[0]!.priority ?? 100;
    overlap.workflow.edges.splice(1, 0, duplicatedRoute);
    expect(codes(overlap)).not.toContain('route.domain-not-exhaustive');
    expect(codes(overlap)).not.toContain('route.ambiguous');

    const badReviewEnum = fixture();
    const review = badReviewEnum.workflow.nodes.find((node) => node.kind === 'review')!;
    review.outputs.decision!.enum = ['pass', 'revise'];
    expect(codes(badReviewEnum)).toContain('review.decision-enum-mismatch');
  });

  it('checks end/result parity and sanitized error-route mappings', () => {
    const badResult = fixture();
    badResult.result[0]!.outcome = 'rejected';
    expect(codes(badResult)).toContain('result.outcome-mismatch');

    const goodErrorRoute = fixture('error-route.example.json');
    const work = goodErrorRoute.workflow.nodes.find((node) => node.id === 'work')!;
    work.onError = { strategy: 'route', routeTo: 'failure', routeMap: { category: '/failure/category', request: '/inputs/request' } };
    expect(codes(goodErrorRoute)).not.toContain('error-route.pointer-invalid');
    expect(codes(goodErrorRoute)).not.toContain('error-route.required-input-missing');
    work.onError.routeMap = { request: '/secrets/raw-error' };
    expect(codes(goodErrorRoute)).toContain('error-route.pointer-invalid');
  });

  it('checks digest-shaped references without resolving external registries', () => {
    const profile = fixture();
    profile.dependencies = profile.dependencies.filter((dependency) => dependency.kind !== 'persona');
    expect(codes(profile)).toContain('dependency.reference-missing');
    expect(profile.dependencies.every((dependency) => /^sha256:[0-9a-f]{64}$/.test(dependency.digest))).toBe(true);
  });

  it('enforces exact MCP tool-ID UTF-8 byte and control-character rules', () => {
    const profile = fixture();
    profile.policies.tools.deniedTools = ['MCP:Ä/tool', 'a'.repeat(256)];
    expect(codes(profile)).not.toContain('tool-id.invalid');
    profile.policies.tools.deniedTools = ['é'.repeat(129)];
    expect(codes(profile)).toContain('tool-id.invalid');
    profile.policies.tools.deniedTools = ['safe\u0000unsafe'];
    expect(codes(profile)).toContain('tool-id.invalid');
  });

  it('rejects duplicate node IDs, optional-to-required mappings, and mismatched declared enums', () => {
    const duplicateNode = fixture();
    duplicateNode.workflow.nodes.push(structuredClone(duplicateNode.workflow.nodes[0]!));
    expect(codes(duplicateNode)).toContain('node.duplicate-id');

    const optionalSource = fixture();
    optionalSource.workflow.nodes.find((node) => node.id === 'request')!.outputs.request!.required = false;
    expect(codes(optionalSource)).toContain('mapping.type-mismatch');

    const invalidEnum = fixture();
    invalidEnum.workflow.nodes.find((node) => node.id === 'finish')!.outputs.response!.enum = [42];
    expect(codes(invalidEnum)).toContain('port.enum-type-mismatch');
  });

  it('validates approval references, condition outputs, and allowed toolset bindings', () => {
    const badApproval = fixture();
    const approval = badApproval.workflow.nodes.find((node) => node.kind === 'approval')!;
    approval.config.bindsTo = 'missing';
    approval.config.show = ['missing'];
    expect(codes(badApproval)).toContain('approval.binds-to-port-missing');
    expect(codes(badApproval)).toContain('approval.show-port-missing');

    const badCondition = fixture('bounded-review-fix.example.json');
    const condition = badCondition.workflow.nodes.find((node) => node.kind === 'condition')!;
    condition.outputs.unproduced = { type: 'string' };
    expect(codes(badCondition)).toContain('condition.output-unproduced');

    const disallowedToolset = fixture();
    disallowedToolset.policies.tools.allowedToolsets = [];
    expect(codes(disallowedToolset)).toContain('toolset.not-allowed');
  });

  it('requires finite conditional routes to account for absent optional outputs', () => {
    const profile = fixture();
    profile.workflow.nodes.find((node) => node.id === 'request')!.outputs.needsClarification!.required = false;
    expect(codes(profile)).toContain('route.domain-not-exhaustive');
  });

  it('checks route retries and end/result edge cases at the contract boundary', () => {
    const invalidRetry = fixture();
    const planner = invalidRetry.workflow.nodes.find((node) => node.kind === 'planner')!;
    planner.onError = { strategy: 'retry', maxAttempts: 1, backoffSeconds: 0, retryOn: ['technical'] };
    expect(validateWorkflowProfileJson(JSON.stringify(invalidRetry)).ok).toBe(false);

    const missingResult = fixture();
    missingResult.result = missingResult.result.filter((item) => item.fromNode !== 'finish');
    expect(codes(missingResult)).toContain('result.end-unmapped');

    const badResultPort = fixture();
    badResultPort.result[0]!.port = 'missing';
    expect(codes(badResultPort)).toContain('result.port-missing');

    const incompleteEmit = fixture();
    incompleteEmit.workflow.nodes.find((node) => node.id === 'finish')!.config.emit = {};
    expect(codes(incompleteEmit)).toContain('end.emit-output-missing');
  });

  it('detects cycles through loop-exhaustion and error-route transitions', () => {
    const exhaustionCycle = fixture('bounded-review-fix.example.json');
    const loop = exhaustionCycle.workflow.edges.find((edge) => edge.loop)!;
    loop.loop!.onExhausted = { strategy: 'route', to: 'fix', map: { request: '/request', feedback: '/feedback' } };
    expect(codes(exhaustionCycle)).toContain('workflow.unbounded-cycle');

    const errorCycle = fixture('error-route.example.json');
    errorCycle.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'work', routeMap: {} };
    expect(codes(errorCycle)).toContain('error-route.cycle');
  });

  it('uses saturating visit-bound arithmetic across multiple bounded counters', () => {
    const profile = fixture();
    const edge = profile.workflow.edges.find((candidate) => candidate.from === 'plan' && candidate.to === 'execute')!;
    edge.loop = { maxIterations: 2, counterId: 'second-pass', onExhausted: { strategy: 'fail' } };
    profile.policies.execution.maxNodeVisits = 30;
    expect(codes(profile)).toContain('budget.static-node-visits');
  });

  it('multiplies overlapping bounded-loop limits and accepts the exact visit bound', () => {
    const profile = fixture('bounded-review-fix.example.json');
    const innerTransition = profile.workflow.edges.find((edge) => edge.from === 'fix' && edge.to === 'review')!;
    innerTransition.loop = { maxIterations: 2, counterId: 'review-pass', onExhausted: { strategy: 'fail' } };
    profile.policies.execution.maxNodeVisits = 54; // 6 nodes × (1 + 2) × (1 + 2)
    expect(codes(profile)).not.toContain('workflow.unbounded-cycle');
    expect(codes(profile)).not.toContain('budget.static-node-visits');

    profile.policies.execution.maxNodeVisits = 53;
    expect(codes(profile)).toContain('budget.static-node-visits');
  });
});
