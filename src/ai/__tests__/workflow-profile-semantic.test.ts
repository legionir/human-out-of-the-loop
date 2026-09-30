import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateWorkflowProfileJson } from '../workflow-profiles/profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from '../workflow-profiles/profile-semantic-validator.js';
import type { WorkflowProfileDocument, WorkflowResultKind } from '../workflow-profiles/profile-types.js';

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
  it('returns diagnostics rather than throwing for malformed direct inputs', () => {
    expect(codes(null as any)).toContain('semantic.input-invalid');
    expect(codes({} as any)).toContain('semantic.input-invalid');
  });

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

    const makeAnySource = (withFiniteEnum: boolean): WorkflowProfileDocument => {
      const profile = fixture();
      // Keep only the intake→plan mapping under test. Removing the edge into
      // `clarify` alone would leave clarify→plan and create a second, unrelated
      // object→string mismatch.
      profile.workflow.edges = profile.workflow.edges.filter((edge) => edge.from !== 'clarify' && edge.to !== 'clarify');
      profile.workflow.nodes = profile.workflow.nodes.filter((node) => node.id !== 'clarify');
      profile.workflow.nodes.find((node) => node.id === 'plan')!.inputs.request!.type = 'string';
      const intake = profile.workflow.nodes.find((node) => node.id === 'request')!;
      intake.outputs.request!.type = 'any';
      if (withFiniteEnum) intake.outputs.request!.enum = ['a concrete request'];
      else delete intake.outputs.request!.enum;
      return profile;
    };
    const isAnyToStringMismatch = (profile: WorkflowProfileDocument): boolean =>
      validateWorkflowProfileSemantics(profile).some((diagnostic) =>
        diagnostic.code === 'mapping.type-mismatch'
        && diagnostic.message.includes('Output request.request (any) is not assignable to input plan.request (string)'));
    expect(isAnyToStringMismatch(makeAnySource(false))).toBe(true);
    expect(isAnyToStringMismatch(makeAnySource(true))).toBe(false);

    const incompatibleFiniteEnum = makeAnySource(true);
    incompatibleFiniteEnum.workflow.nodes.find((node) => node.id === 'request')!.outputs.request!.enum = [42];
    expect(isAnyToStringMismatch(incompatibleFiniteEnum)).toBe(true);

    const mixedFiniteEnum = makeAnySource(true);
    mixedFiniteEnum.workflow.nodes.find((node) => node.id === 'request')!.outputs.request!.enum = ['a concrete request', 42];
    expect(isAnyToStringMismatch(mixedFiniteEnum)).toBe(true);

    const anyToAny = makeAnySource(false);
    anyToAny.workflow.nodes.find((node) => node.id === 'plan')!.inputs.request!.type = 'any';
    expect(isAnyToStringMismatch(anyToAny)).toBe(false);
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

    const missingDeclaredReviewDomain = fixture();
    delete missingDeclaredReviewDomain.workflow.nodes.find((node) => node.kind === 'review')!.config.allowedDecisions;
    expect(codes(missingDeclaredReviewDomain)).toContain('review.decision-domain-missing');

    const missingReviewRoute = fixture();
    missingReviewRoute.workflow.edges = missingReviewRoute.workflow.edges.filter((edge) => !(edge.from === 'review' && edge.label === 'reject'));
    expect(codes(missingReviewRoute)).toContain('review.decisions-unrouted');
  });

  it('enforces the closed result-kind to end-port type mapping', () => {
    const allowed: Record<string, string[]> = {
      response: ['string', 'number', 'integer', 'boolean', 'object', 'array'],
      artifact: ['artifact', 'file'],
      proposal: ['object'],
      handoff: ['object'],
    };
    const allPortTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'artifact', 'file', 'any'];

    for (const [kind, acceptedTypes] of Object.entries(allowed)) {
      for (const type of acceptedTypes) {
        const profile = fixture();
        profile.result[0]!.kind = kind as WorkflowResultKind;
        const end = profile.workflow.nodes.find((node) => node.id === profile.result[0]!.fromNode)!;
        end.outputs[profile.result[0]!.port]!.type = type;
        end.inputs.result!.type = type;
        expect(codes(profile)).not.toContain('result.kind-type-mismatch');
      }
      for (const type of allPortTypes.filter((candidate) => !acceptedTypes.includes(candidate))) {
        const profile = fixture();
        profile.result[0]!.kind = kind as WorkflowResultKind;
        const end = profile.workflow.nodes.find((node) => node.id === profile.result[0]!.fromNode)!;
        end.outputs[profile.result[0]!.port]!.type = type;
        end.inputs.result!.type = type;
        expect(codes(profile)).toContain('result.kind-type-mismatch');
      }
    }

    const mismatch = fixture();
    mismatch.workflow.nodes.find((node) => node.id === 'finish')!.outputs.response!.type = 'file';
    mismatch.workflow.nodes.find((node) => node.id === 'finish')!.inputs.result!.type = 'file';
    expect(validateWorkflowProfileJson(JSON.stringify(mismatch)).ok).toBe(true);
    const diagnostic = validateWorkflowProfileSemantics(mismatch).find((item) => item.code === 'result.kind-type-mismatch');
    expect(diagnostic).toMatchObject({ stage: 'semantic', path: '/result/0/kind', nodeId: 'finish' });
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

  it('enforces required Approval, Condition, and Review output contracts', () => {
    const missingText = fixture();
    const textApproval = missingText.workflow.nodes.find((node) => node.kind === 'approval')!;
    delete textApproval.outputs.answer;
    expect(codes(missingText)).toContain('approval.response-output-missing');

    const optionalText = fixture();
    optionalText.workflow.nodes.find((node) => node.kind === 'approval')!.outputs.answer!.required = false;
    expect(codes(optionalText)).toContain('approval.response-output-optional');

    const wrongText = fixture();
    wrongText.workflow.nodes.find((node) => node.kind === 'approval')!.outputs.answer!.type = 'object';
    expect(codes(wrongText)).toContain('approval.response-output-type');

    const decisionApproval = fixture();
    const decision = decisionApproval.workflow.nodes.find((node) => node.kind === 'approval')!;
    decision.config.responseKind = 'decision';
    delete decision.outputs.answer;
    decision.outputs.decision = { type: 'object', required: true };
    expect(codes(decisionApproval)).not.toContain('approval.response-output-missing');
    expect(codes(decisionApproval)).not.toContain('approval.response-output-type');
    decision.outputs.decision.required = false;
    expect(codes(decisionApproval)).toContain('approval.response-output-optional');
    decision.outputs.decision = { type: 'string', required: true };
    expect(codes(decisionApproval)).toContain('approval.response-output-type');

    const optionalMatched = fixture('bounded-review-fix.example.json');
    const condition = optionalMatched.workflow.nodes.find((node) => node.kind === 'condition')!;
    condition.outputs.matched!.required = false;
    expect(codes(optionalMatched)).toContain('condition.matched-output');

    const opaquePassThrough = fixture('bounded-review-fix.example.json');
    const opaqueCondition = opaquePassThrough.workflow.nodes.find((node) => node.kind === 'condition')!;
    opaqueCondition.inputs.request!.type = 'any';
    opaqueCondition.outputs.request!.type = 'string';
    expect(codes(opaquePassThrough)).toContain('condition.pass-through');

    const requiredMismatch = fixture('bounded-review-fix.example.json');
    const requiredCondition = requiredMismatch.workflow.nodes.find((node) => node.kind === 'condition')!;
    requiredCondition.outputs.request!.required = false;
    expect(codes(requiredMismatch)).toContain('condition.pass-through');

    const enumMismatch = fixture('bounded-review-fix.example.json');
    const enumCondition = enumMismatch.workflow.nodes.find((node) => node.kind === 'condition')!;
    enumCondition.inputs.request!.enum = ['a', 'b'];
    enumCondition.outputs.request!.enum = ['a'];
    expect(codes(enumMismatch)).toContain('condition.pass-through');

    const optionalReview = fixture();
    optionalReview.workflow.nodes.find((node) => node.kind === 'review')!.outputs.decision!.required = false;
    expect(codes(optionalReview)).toContain('review.decision-output-optional');

    const missingReview = fixture();
    delete missingReview.workflow.nodes.find((node) => node.kind === 'review')!.outputs.decision;
    expect(codes(missingReview)).toContain('review.decision-output-missing');
  });

  it('requires condition routes to use the computed matched output', () => {
    const bypassed = fixture('bounded-review-fix.example.json');
    const gateEdges = bypassed.workflow.edges.filter((edge) => edge.from === 'gate');
    expect(gateEdges).toHaveLength(2);
    gateEdges[0]!.when!.path = '/severity';
    expect(codes(bypassed)).toContain('condition.route-output');

    const unconditional = fixture('bounded-review-fix.example.json');
    for (const edge of unconditional.workflow.edges.filter((candidate) => candidate.from === 'gate')) delete edge.when;
    expect(codes(unconditional)).toContain('condition.route-output');
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

  it('rejects predicate operators and values incompatible with their source port', () => {
    const profile = fixture();
    const route = profile.workflow.edges.find((edge) => edge.from === 'request')!;
    route.when = { path: '/needsClarification', operator: 'contains', value: 'yes' };
    expect(codes(profile)).toContain('predicate.type-mismatch');
  });

  it('rejects not-exists predicates on required ports even when a fallback route exists', () => {
    const profile = fixture();
    const conditionalRoute = profile.workflow.edges.find((edge) => edge.from === 'request')!;
    conditionalRoute.when = { path: '/needsClarification', operator: 'not-exists' };
    const fallback = structuredClone(profile.workflow.edges.find((edge) => edge.from === 'request')!);
    fallback.default = true;
    delete fallback.when;
    profile.workflow.edges.push(fallback);
    expect(codes(profile)).toContain('predicate.type-mismatch');
  });

  it('requires a default for open conditional domains and rejects mixed predicate paths', () => {
    const openDomain = fixture();
    const requestRoutes = openDomain.workflow.edges.filter((edge) => edge.from !== 'request');
    const oneRoute = structuredClone(openDomain.workflow.edges.find((edge) => edge.from === 'request')!);
    oneRoute.when = { path: '/request', operator: 'exists' };
    openDomain.workflow.edges = [...requestRoutes, oneRoute];
    expect(codes(openDomain)).toContain('route.open-domain-no-default');

    const mixedPaths = fixture();
    mixedPaths.workflow.edges.find((edge) => edge.from === 'request' && edge.to === 'clarify')!.when!.path = '/request';
    expect(codes(mixedPaths)).toContain('route.mixed-predicate-port');
  });

  it('rejects multiple defaults and implicit fallback edges', () => {
    const multipleDefaults = fixture();
    const requestRoutes = multipleDefaults.workflow.edges.filter((edge) => edge.from === 'request');
    for (const edge of requestRoutes) edge.default = true;
    expect(codes(multipleDefaults)).toContain('route.multiple-defaults');

    const implicitFallback = fixture();
    const route = structuredClone(implicitFallback.workflow.edges.find((edge) => edge.from === 'request' && edge.to === 'plan')!);
    delete route.when;
    implicitFallback.workflow.edges.push(route);
    expect(codes(implicitFallback)).toContain('route.implicit-fallback');
  });

  it('validates error-route destination, target ports, sanitized inputs, types, and required mappings', () => {
    const missingTarget = fixture('error-route.example.json');
    missingTarget.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'missing', routeMap: { category: '/failure/category', request: '/inputs/request' } };
    expect(codes(missingTarget)).toContain('error-route.target-missing');

    const missingTargetPort = fixture('error-route.example.json');
    missingTargetPort.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'failure', routeMap: { unknown: '/failure/category' } };
    expect(codes(missingTargetPort)).toContain('error-route.target-port-missing');

    const missingFailedInput = fixture('error-route.example.json');
    missingFailedInput.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'failure', routeMap: { category: '/failure/category', request: '/inputs/absent' } };
    expect(codes(missingFailedInput)).toContain('error-route.input-pointer-missing');

    const wrongType = fixture('error-route.example.json');
    wrongType.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'failure', routeMap: { category: '/failure/category', request: '/failure/category' } };
    expect(codes(wrongType)).toContain('error-route.type-mismatch');

    const missingRequired = fixture('error-route.example.json');
    missingRequired.workflow.nodes.find((node) => node.id === 'work')!.onError = { strategy: 'route', routeTo: 'failure', routeMap: { category: '/failure/category' } };
    expect(codes(missingRequired)).toContain('error-route.required-input-missing');
  });

  it('rejects duplicate results and invalid or incomplete end emits', () => {
    const duplicateResult = fixture();
    duplicateResult.result.push(structuredClone(duplicateResult.result[0]!));
    expect(codes(duplicateResult)).toContain('result.duplicate');

    const unknownOutput = fixture();
    unknownOutput.workflow.nodes.find((node) => node.id === 'finish')!.config.emit = { unknown: 'result' };
    expect(codes(unknownOutput)).toContain('end.emit-output-unknown');

    const unknownInput = fixture();
    unknownInput.workflow.nodes.find((node) => node.id === 'finish')!.config.emit = { response: 'unknown' };
    expect(codes(unknownInput)).toContain('end.emit-input-unknown');

    const wrongEmitType = fixture();
    wrongEmitType.workflow.nodes.find((node) => node.id === 'finish')!.inputs.result!.type = 'string';
    expect(codes(wrongEmitType)).toContain('end.emit-type-mismatch');
  });

  it('rejects missing/wrong-kind starts, missing edge sources, and edges back to start', () => {
    const missingStart = fixture();
    missingStart.workflow.startNode = 'absent';
    expect(codes(missingStart)).toContain('workflow.start-missing');

    const wrongStartKind = fixture();
    wrongStartKind.workflow.startNode = 'plan';
    expect(codes(wrongStartKind)).toContain('workflow.start-kind');

    const missingSource = fixture();
    missingSource.workflow.edges[0]!.from = 'absent';
    expect(codes(missingSource)).toContain('edge.source-missing');

    const targetsStart = fixture();
    const edge = structuredClone(targetsStart.workflow.edges.find((candidate) => candidate.from === 'clarify')!);
    edge.to = 'request';
    targetsStart.workflow.edges.push(edge);
    expect(codes(targetsStart)).toContain('edge.to-start');
  });

  it('accepts a structurally valid positive retry policy and rejects malformed dependency pins', () => {
    const retry = fixture();
    const planner = retry.workflow.nodes.find((node) => node.id === 'plan')!;
    planner.onError = { strategy: 'retry', maxAttempts: 3, backoffSeconds: 1, retryOn: ['technical'] };
    const validatedRetry = validateWorkflowProfileJson(JSON.stringify(retry));
    expect(validatedRetry.ok).toBe(true);
    expect(codes(retry)).toEqual([]);

    const badDigest = fixture();
    badDigest.dependencies[0]!.digest = 'sha256:not-hex';
    expect(validateWorkflowProfileJson(JSON.stringify(badDigest)).ok).toBe(false);

    const badVersion = fixture();
    badVersion.dependencies[0]!.version = 'v1';
    expect(validateWorkflowProfileJson(JSON.stringify(badVersion)).ok).toBe(false);
  });
});
