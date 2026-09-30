import { ABSENT, PORT_POINTER, domainFor, equalScalar, isRecord, predicateMatches, routingDomainFor, scalarMatchesType } from './profile-predicate.js';
import { isJsonCompatibleValue } from './profile-schema-validator.js';
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowPort,
  WorkflowPredicate,
  WorkflowProfileDiagnostic,
  WorkflowProfileDocument,
} from './profile-types.js';

const ERROR_POINTER = /^\/(?:failure\/(?:category|code|retryable)|node\/(?:id|attempt)|inputs\/[a-zA-Z][a-zA-Z0-9_-]{0,63})$/;
const MAX_MCP_TOOL_ID_BYTES = 256;

// Closed Phase 2 contract: result.kind is a semantic output category, not an
// authorization signal. Opaque `any` ports are intentionally excluded.
const RESULT_KIND_PORT_TYPES: Record<string, readonly string[]> = {
  response: ['string', 'number', 'integer', 'boolean', 'object', 'array'],
  artifact: ['artifact', 'file'],
  proposal: ['object'],
  handoff: ['object'],
};

function finiteDomainCovered(domain: unknown[], predicates: WorkflowPredicate[]): boolean {
  return domain.every((value) => predicates.some((predicate) => predicateMatches(predicate, value)));
}

function pathPort(pointer: string): string | undefined {
  return PORT_POINTER.exec(pointer)?.[1];
}

function assignable(source: WorkflowPort, target: WorkflowPort): boolean {
  if (target.required === true && source.required !== true) return false;
  const sourceType = source.type;
  const targetType = target.type;
  // `any` is safe as a target, but an unconstrained `any` source cannot flow
  // into a narrower contract. A finite source enum provides enough evidence
  // for the domain checks below to prove that the mapping is safe.
  const typeCompatible = targetType === 'any'
    || sourceType === targetType
    || (sourceType === 'integer' && targetType === 'number')
    || (sourceType === 'any' && source.enum !== undefined);
  if (!typeCompatible) return false;

  const targetDomain = domainFor(target);
  if (targetDomain) {
    const sourceDomain = domainFor(source);
    if (!sourceDomain || !sourceDomain.every((value) => targetDomain.some((allowed) => equalScalar(value, allowed)))) return false;
  }
  const sourceDomain = domainFor(source);
  if (sourceDomain && !sourceDomain.every((value) => scalarMatchesType(value, targetType))) return false;
  return true;
}

function samePortContract(left: WorkflowPort, right: WorkflowPort): boolean {
  if (left.type !== right.type || (left.required === true) !== (right.required === true)) return false;
  const leftDomain = left.enum;
  const rightDomain = right.enum;
  if (leftDomain === undefined || rightDomain === undefined) return leftDomain === rightDomain;
  return sameSet(leftDomain, rightDomain);
}

function checkMapping(
  profileId: string,
  source: WorkflowNode,
  target: WorkflowNode,
  mapping: Record<string, string>,
  path: string,
  diagnostics: WorkflowProfileDiagnostic[],
  edgeIndex?: number,
): void {
  const mapped = new Set<string>();
  for (const [targetName, pointer] of Object.entries(mapping)) {
    const targetPort = target.inputs[targetName];
    if (!targetPort) {
      diagnostics.push({ stage: 'semantic', code: 'mapping.target-port-missing', message: `Mapping targets undeclared input port "${targetName}" on node "${target.id}"`, profileId, path: `${path}/${targetName}`, nodeId: target.id, edgeIndex });
      continue;
    }
    const sourceName = pathPort(pointer);
    if (!sourceName) {
      diagnostics.push({ stage: 'semantic', code: 'mapping.pointer-depth', message: `Mapping pointer "${pointer}" must address exactly one declared top-level output port`, profileId, path: `${path}/${targetName}`, nodeId: source.id, edgeIndex });
      continue;
    }
    const sourcePort = source.outputs[sourceName];
    if (!sourcePort) {
      diagnostics.push({ stage: 'semantic', code: 'mapping.source-port-missing', message: `Mapping references undeclared output port "${sourceName}" on node "${source.id}"`, profileId, path: `${path}/${targetName}`, nodeId: source.id, edgeIndex });
      continue;
    }
    mapped.add(targetName);
    if (!assignable(sourcePort, targetPort)) {
      diagnostics.push({ stage: 'semantic', code: 'mapping.type-mismatch', message: `Output ${source.id}.${sourceName} (${sourcePort.type}) is not assignable to input ${target.id}.${targetName} (${targetPort.type})`, profileId, path: `${path}/${targetName}`, nodeId: target.id, edgeIndex });
    }
  }
  for (const [name, port] of Object.entries(target.inputs)) {
    if (port.required && !mapped.has(name)) {
      diagnostics.push({ stage: 'semantic', code: 'mapping.required-input-missing', message: `Required input "${name}" on node "${target.id}" is not mapped on this transition`, profileId, path, nodeId: target.id, edgeIndex });
    }
  }
}

function checkPredicate(
  profileId: string,
  predicate: WorkflowPredicate,
  ports: Record<string, WorkflowPort>,
  path: string,
  diagnostics: WorkflowProfileDiagnostic[],
  nodeId?: string,
  edgeIndex?: number,
): WorkflowPort | undefined {
  const name = pathPort(predicate.path);
  if (!name) {
    diagnostics.push({ stage: 'semantic', code: 'predicate.pointer-depth', message: `Predicate pointer "${predicate.path}" must address exactly one declared top-level port`, profileId, path, nodeId, edgeIndex });
    return undefined;
  }
  const port = ports[name];
  if (!port) {
    diagnostics.push({ stage: 'semantic', code: 'predicate.port-missing', message: `Predicate references undeclared port "${name}"`, profileId, path, nodeId, edgeIndex });
    return undefined;
  }
  const operator = predicate.operator;
  const value = predicate.value;
  let compatible = true;
  if (operator === 'greater-than' || operator === 'greater-or-equal' || operator === 'less-than' || operator === 'less-or-equal') {
    compatible = (port.type === 'number' || port.type === 'integer') && typeof value === 'number';
  } else if (operator === 'contains') {
    compatible = (port.type === 'string' || port.type === 'array') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  } else if (operator === 'equals' || operator === 'not-equals') {
    compatible = scalarMatchesType(value, port.type);
  } else if (operator === 'in' || operator === 'not-in') {
    compatible = Array.isArray(value) && value.every((item) => scalarMatchesType(item, port.type));
  }
  if (compatible && Array.isArray(port.enum)) {
    const values = operator === 'in' || operator === 'not-in' ? value as unknown[] : [value];
    if (operator === 'equals' || operator === 'in') compatible = values.every((item) => port.enum!.some((allowed) => equalScalar(item, allowed)));
  }
  if (operator === 'not-exists' && port.required === true) compatible = false;
  if (!compatible) {
    diagnostics.push({ stage: 'semantic', code: 'predicate.type-mismatch', message: `Predicate operator "${operator}" or its value is incompatible with port "${name}" of type "${port.type}"`, profileId, path, nodeId, edgeIndex });
  }
  return port;
}

function hasDirectedCycle(adjacency: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of adjacency.keys()) if (visit(node)) return true;
  return false;
}

function reachableFrom(start: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const node = todo.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) if (!seen.has(next)) todo.push(next);
  }
  return seen;
}

/** Validate graph, port, route, pin-shape, and bounded-loop semantics without resolving external registries or executing anything. */
function validateWorkflowProfileSemanticsUnchecked(profile: WorkflowProfileDocument): WorkflowProfileDiagnostic[] {
  const profileId = profile.profile.id;
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  const nodes = profile.workflow.nodes;
  const edges = profile.workflow.edges;
  const nodeById = new Map<string, WorkflowNode>();
  const dependencyKeys = new Set<string>();
  const dependencyReferences = new Set<string>();
  const counterIds = new Set<string>();
  const allAdjacency = new Map<string, string[]>();
  const unboundedAdjacency = new Map<string, string[]>();
  const errorAdjacency = new Map<string, string[]>();
  const addAdj = (map: Map<string, string[]>, from: string, to: string): void => { map.set(from, [...(map.get(from) ?? []), to]); };
  const addDiagnostic = (code: string, message: string, path: string, nodeId?: string, edgeIndex?: number): void => { diagnostics.push({ stage: 'semantic', code, message, profileId, path, nodeId, edgeIndex }); };

  const checkExtensions = (value: Record<string, unknown>, location: string, nodeId?: string, edgeIndex?: number): void => {
    const extensionKeys = Object.keys(value).filter((key) => key.startsWith('x-'));
    if (extensionKeys.length > 16) addDiagnostic('extension.too-many', `At most 16 x-* extension fields are allowed at ${location}`, location, nodeId, edgeIndex);
  };
  checkExtensions(profile as unknown as Record<string, unknown>, '/');
  checkExtensions(profile.profile, '/profile');
  for (const [index, dependency] of profile.dependencies.entries()) {
    const key = `${dependency.kind}\u0000${dependency.id}`;
    if (dependencyKeys.has(key)) addDiagnostic('dependency.duplicate', `Duplicate dependency (${dependency.kind}, ${dependency.id}) even if version or digest differs`, `/dependencies/${index}`);
    dependencyKeys.add(key);
  }
  const requireDependency = (kind: string, id: string, path: string, nodeId?: string): void => {
    const key = `${kind}\u0000${id}`;
    dependencyReferences.add(key);
    if (!dependencyKeys.has(key)) addDiagnostic('dependency.reference-missing', `Reference "${id}" of kind "${kind}" is not declared in dependencies`, path, nodeId);
  };

  for (const [index, node] of nodes.entries()) {
    checkExtensions(node, `/workflow/nodes/${index}`, node.id);
    if (nodeById.has(node.id)) addDiagnostic('node.duplicate-id', `Duplicate node id "${node.id}"`, `/workflow/nodes/${index}/id`, node.id);
    else nodeById.set(node.id, node);
    for (const [direction, ports] of [['inputs', node.inputs], ['outputs', node.outputs]] as const) {
      for (const [portName, port] of Object.entries(ports)) {
        for (const [enumIndex, value] of (port.enum ?? []).entries()) {
          if (!scalarMatchesType(value, port.type)) addDiagnostic('port.enum-type-mismatch', `Enum value at index ${enumIndex} is incompatible with ${direction} port "${portName}" of type "${port.type}"`, `/workflow/nodes/${index}/${direction}/${portName}/enum/${enumIndex}`, node.id);
        }
      }
    }
    allAdjacency.set(node.id, []);
    unboundedAdjacency.set(node.id, []);
    errorAdjacency.set(node.id, []);

    for (const [field, kind] of [['personaRef', 'persona'], ['toolsetRef', 'toolset'], ['modelProfileRef', 'model-profile']] as const) {
      const value = node.bindings?.[field];
      if (value) requireDependency(kind, value, `/workflow/nodes/${index}/bindings/${field}`, node.id);
    }
    for (const [skillIndex, id] of (node.bindings?.skillRefs ?? []).entries()) requireDependency('skill', id, `/workflow/nodes/${index}/bindings/skillRefs/${skillIndex}`, node.id);
    if (node.kind === 'review' && typeof node.config.rubricRef === 'string') requireDependency('rubric', node.config.rubricRef, `/workflow/nodes/${index}/config/rubricRef`, node.id);
    const personaSource = node.bindings?.personaSource;
    if (personaSource !== undefined) {
      if (personaSource !== 'plan-step') {
        addDiagnostic('bindings.persona-source-invalid', `personaSource must be "plan-step"`, `/workflow/nodes/${index}/bindings/personaSource`, node.id);
      } else if (node.kind !== 'execute') {
        addDiagnostic('bindings.persona-source-unsupported', `Only an "execute" node may declare personaSource "plan-step" (node "${node.id}" is a "${node.kind}" node)`, `/workflow/nodes/${index}/bindings/personaSource`, node.id);
      }
      if (node.bindings?.personaRef !== undefined) {
        addDiagnostic('bindings.persona-binding-ambiguous', `Node "${node.id}" declares both personaRef and personaSource; exactly one is required`, `/workflow/nodes/${index}/bindings`, node.id);
      }
    }
    if (node.kind === 'execute' && node.bindings?.personaRef === undefined && personaSource === undefined) {
      addDiagnostic('bindings.persona-binding-missing', `Execute node "${node.id}" must declare either bindings.personaRef or bindings.personaSource "plan-step"`, `/workflow/nodes/${index}/bindings`, node.id);
    }
    if (typeof node.bindings?.toolsetRef === 'string' && !profile.policies.tools.allowedToolsets.includes(node.bindings.toolsetRef)) {
      addDiagnostic('toolset.not-allowed', `Toolset "${node.bindings.toolsetRef}" is not listed in policies.tools.allowedToolsets`, `/workflow/nodes/${index}/bindings/toolsetRef`, node.id);
    }

    if (node.kind === 'condition') {
      const predicate = node.config.predicate as WorkflowPredicate;
      checkPredicate(profileId, predicate, node.inputs, `/workflow/nodes/${index}/config/predicate`, diagnostics, node.id);
      const matched = node.outputs.matched;
      if (!matched || matched.type !== 'boolean' || matched.required !== true) addDiagnostic('condition.matched-output', `Condition node "${node.id}" must declare a required boolean "matched" output`, `/workflow/nodes/${index}/outputs/matched`, node.id);
      for (const [name, input] of Object.entries(node.inputs)) {
        const output = node.outputs[name];
        if (!output || !samePortContract(input, output)) addDiagnostic('condition.pass-through', `Condition node must pass input port "${name}" through unchanged in outputs`, `/workflow/nodes/${index}/outputs/${name}`, node.id);
      }
      if (Object.hasOwn(node.inputs, 'matched')) addDiagnostic('condition.matched-input-collision', 'Condition input port "matched" conflicts with its required boolean output', `/workflow/nodes/${index}/inputs/matched`, node.id);
      for (const outputName of Object.keys(node.outputs)) {
        if (outputName !== 'matched' && !Object.hasOwn(node.inputs, outputName)) addDiagnostic('condition.output-unproduced', `Condition output "${outputName}" is neither the matched flag nor a pass-through input`, `/workflow/nodes/${index}/outputs/${outputName}`, node.id);
      }
      if (matched && Array.isArray(matched.enum) && !sameSet(matched.enum, [false, true])) addDiagnostic('condition.matched-enum', 'Condition matched output can be both true and false; its enum must be omitted or contain exactly both values', `/workflow/nodes/${index}/outputs/matched/enum`, node.id);
    }

    if (node.kind === 'approval') {
      const config = node.config as Record<string, any>;
      if (typeof config.bindsTo === 'string' && !Object.hasOwn(node.inputs, config.bindsTo)) addDiagnostic('approval.binds-to-port-missing', `Approval bindsTo references undeclared input port "${config.bindsTo}"`, `/workflow/nodes/${index}/config/bindsTo`, node.id);
      for (const [showIndex, portName] of (config.show ?? []).entries()) {
        if (!Object.hasOwn(node.inputs, portName)) addDiagnostic('approval.show-port-missing', `Approval show references undeclared input port "${portName}"`, `/workflow/nodes/${index}/config/show/${showIndex}`, node.id);
      }
      const responseContract = config.responseKind === 'text'
        ? { name: 'answer', type: 'string' }
        : config.responseKind === 'decision'
          ? { name: 'decision', type: 'object' }
          : undefined;
      if (responseContract) {
        const responsePort = node.outputs[responseContract.name];
        const responsePath = `/workflow/nodes/${index}/outputs/${responseContract.name}`;
        if (!responsePort) addDiagnostic('approval.response-output-missing', `Approval responseKind "${config.responseKind}" must declare output "${responseContract.name}"`, responsePath, node.id);
        else {
          if (responsePort.required !== true) addDiagnostic('approval.response-output-optional', `Approval response output "${responseContract.name}" must be required`, `${responsePath}/required`, node.id);
          if (responsePort.type !== responseContract.type) addDiagnostic('approval.response-output-type', `Approval response output "${responseContract.name}" must have type "${responseContract.type}"`, `${responsePath}/type`, node.id);
        }
      }
    }

    if (node.kind === 'review') {
      const configuredDomain = node.config.allowedDecisions;
      const decision = node.outputs.decision;
      // Phase 2 checks the profile's declared decision contract. Comparing it
      // with the actual rubric domain requires resolving the digest-pinned
      // rubric and is a Phase 3 resolver gate, not an inference from its ID.
      if (decision || configuredDomain !== undefined) {
        if (!Array.isArray(configuredDomain) || configuredDomain.length === 0) {
          addDiagnostic('review.decision-domain-missing', `Review node "${node.id}" with a decision output must declare a non-empty allowedDecisions domain`, `/workflow/nodes/${index}/config/allowedDecisions`, node.id);
        }
        if (!decision) addDiagnostic('review.decision-output-missing', `Review node "${node.id}" with allowedDecisions must declare a decision output`, `/workflow/nodes/${index}/outputs/decision`, node.id);
        else {
          if (decision.required !== true) addDiagnostic('review.decision-output-optional', `Review decision output must be required when config.allowedDecisions is set`, `/workflow/nodes/${index}/outputs/decision/required`, node.id);
          if (decision.type !== 'string') addDiagnostic('review.decision-output-type', `Review decision output must have type "string"`, `/workflow/nodes/${index}/outputs/decision/type`, node.id);
          if (!Array.isArray(configuredDomain) || !Array.isArray(decision.enum) || !sameSet(decision.enum, configuredDomain)) addDiagnostic('review.decision-enum-mismatch', `Review decision output enum must exactly match config.allowedDecisions`, `/workflow/nodes/${index}/outputs/decision/enum`, node.id);
        }
      }
    }
  }

  const start = nodeById.get(profile.workflow.startNode);
  if (!start) addDiagnostic('workflow.start-missing', `startNode "${profile.workflow.startNode}" does not exist`, '/workflow/startNode');
  else if (start.kind !== 'intake') addDiagnostic('workflow.start-kind', `startNode "${start.id}" must be an intake node`, '/workflow/startNode', start.id);

  const outBySource = new Map<string, Array<{ edge: WorkflowEdge; index: number }>>();
  const loops: Array<{ edge: WorkflowEdge; index: number }> = [];
  for (const [index, edge] of edges.entries()) {
    checkExtensions(edge, `/workflow/edges/${index}`, undefined, index);
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source) addDiagnostic('edge.source-missing', `Edge source "${edge.from}" does not exist`, `/workflow/edges/${index}/from`, undefined, index);
    if (!target) addDiagnostic('edge.target-missing', `Edge target "${edge.to}" does not exist`, `/workflow/edges/${index}/to`, undefined, index);
    if (!source || !target) continue;
    if (source.kind === 'end') addDiagnostic('edge.from-end', `End node "${source.id}" cannot have outgoing edges`, `/workflow/edges/${index}/from`, source.id, index);
    if (edge.to === profile.workflow.startNode) addDiagnostic('edge.to-start', 'A transition may not target the workflow start node', `/workflow/edges/${index}/to`, source.id, index);
    const group = outBySource.get(source.id) ?? [];
    group.push({ edge, index });
    outBySource.set(source.id, group);
    checkMapping(profileId, source, target, edge.map, `/workflow/edges/${index}/map`, diagnostics, index);
    addAdj(allAdjacency, source.id, target.id);
    if (!edge.loop) addAdj(unboundedAdjacency, source.id, target.id);
    if (edge.loop) {
      loops.push({ edge, index });
      if (counterIds.has(edge.loop.counterId)) addDiagnostic('loop.counter-duplicate', `Duplicate loop counterId "${edge.loop.counterId}"`, `/workflow/edges/${index}/loop/counterId`, source.id, index);
      counterIds.add(edge.loop.counterId);
      const exhausted = edge.loop.onExhausted;
      if (exhausted.strategy === 'route') {
        const exhaustedTarget = exhausted.to ? nodeById.get(exhausted.to) : undefined;
        if (!exhaustedTarget) addDiagnostic('loop.exhaustion-target-missing', `Loop exhaustion target "${exhausted.to ?? ''}" does not exist`, `/workflow/edges/${index}/loop/onExhausted/to`, source.id, index);
        else {
          checkMapping(profileId, source, exhaustedTarget, exhausted.map ?? {}, `/workflow/edges/${index}/loop/onExhausted/map`, diagnostics, index);
          addAdj(allAdjacency, source.id, exhaustedTarget.id);
          // Exhaustion transitions do not consume the counter. Include them in the unbounded-cycle check.
          addAdj(unboundedAdjacency, source.id, exhaustedTarget.id);
        }
      }
    }
  }

  for (const [sourceId, outgoing] of outBySource) {
    const defaults = outgoing.filter(({ edge }) => edge.default === true);
    if (defaults.length > 1) addDiagnostic('route.multiple-defaults', `Source "${sourceId}" has more than one default edge`, '/workflow/edges', sourceId);
    const unconditional = outgoing.filter(({ edge }) => !edge.when && edge.default !== true);
    if (unconditional.length > 0 && (outgoing.length !== 1 || defaults.length > 0)) {
      for (const { index } of unconditional) addDiagnostic('route.implicit-fallback', 'A fallback edge must be explicitly marked default:true; a single unconditional edge is allowed only as the sole outgoing transition', `/workflow/edges/${index}`, sourceId, index);
    }

    const source = nodeById.get(sourceId)!;
    const conditions: Array<{ edge: WorkflowEdge; index: number; port?: WorkflowPort }> = [];
    for (const { edge, index } of outgoing) {
      if (!edge.when) continue;
      const port = checkPredicate(profileId, edge.when, source.outputs, `/workflow/edges/${index}/when`, diagnostics, sourceId, index);
      conditions.push({ edge, index, port });
    }
    if (source.kind === 'condition') {
      if (conditions.length === 0) addDiagnostic('condition.route-output', `Condition node "${sourceId}" must route its result using the required /matched output`, '/workflow/edges', sourceId);
      for (const { edge, index } of conditions) {
        if (edge.when?.path !== '/matched') addDiagnostic('condition.route-output', `Condition node "${sourceId}" routes must inspect /matched rather than a pass-through output`, `/workflow/edges/${index}/when/path`, sourceId, index);
      }
    }
    if (conditions.length === 0) continue;
    const predicatePort = conditions[0]?.port;
    const pointer = conditions[0]?.edge.when?.path;
    if (conditions.some(({ edge }) => edge.when?.path !== pointer)) addDiagnostic('route.mixed-predicate-port', `All first-match conditions from "${sourceId}" must inspect the same source output port`, '/workflow/edges', sourceId);
    if (!defaults.length) {
      const domain = predicatePort ? routingDomainFor(predicatePort) : undefined;
      if (!domain) addDiagnostic('route.open-domain-no-default', `Open or unknown decision domain on "${sourceId}" requires one explicit default edge`, '/workflow/edges', sourceId);
      else if (!finiteDomainCovered(domain, conditions.map(({ edge }) => edge.when!))) addDiagnostic('route.domain-not-exhaustive', `Conditional routes from "${sourceId}" do not cover every value and possible absence of the finite decision domain`, '/workflow/edges', sourceId);
    }

    if (source.kind === 'review' && Array.isArray(source.config.allowedDecisions)) {
      const allowed = source.config.allowedDecisions;
      const decisionConditions = conditions.filter(({ edge }) => edge.when?.path === '/decision').map(({ edge }) => edge.when!);
      if (!defaults.length && !finiteDomainCovered(allowed, decisionConditions)) addDiagnostic('review.decisions-unrouted', `Not every allowed review decision is reachable by a first-match route`, '/workflow/edges', sourceId);
    }
  }

  for (const [index, node] of nodes.entries()) {
    const policy = node.onError;
    if (!policy || policy.strategy !== 'route') continue;
    const target = policy.routeTo ? nodeById.get(policy.routeTo) : undefined;
    if (!target) {
      addDiagnostic('error-route.target-missing', `Error route target "${policy.routeTo ?? ''}" does not exist`, `/workflow/nodes/${index}/onError/routeTo`, node.id);
      continue;
    }
    const map = policy.routeMap ?? {};
    const mapped = new Set<string>();
    for (const [targetName, pointer] of Object.entries(map)) {
      const targetPort = target.inputs[targetName];
      if (!targetPort) {
        addDiagnostic('error-route.target-port-missing', `Error route maps to undeclared input "${targetName}" on "${target.id}"`, `/workflow/nodes/${index}/onError/routeMap/${targetName}`, node.id);
        continue;
      }
      if (!ERROR_POINTER.test(pointer)) {
        addDiagnostic('error-route.pointer-invalid', `Error route pointer "${pointer}" is not in the sanitized failure envelope`, `/workflow/nodes/${index}/onError/routeMap/${targetName}`, node.id);
        continue;
      }
      const sourcePort = errorEnvelopePort(pointer, node);
      if (!sourcePort) {
        addDiagnostic('error-route.input-pointer-missing', `Error route pointer "${pointer}" references an undeclared failed-node input`, `/workflow/nodes/${index}/onError/routeMap/${targetName}`, node.id);
        continue;
      }
      mapped.add(targetName);
      if (!assignable(sourcePort, targetPort)) addDiagnostic('error-route.type-mismatch', `Sanitized failure value at "${pointer}" is not assignable to ${target.id}.${targetName}`, `/workflow/nodes/${index}/onError/routeMap/${targetName}`, node.id);
    }
    for (const [name, port] of Object.entries(target.inputs)) if (port.required && !mapped.has(name)) addDiagnostic('error-route.required-input-missing', `Required error-route input "${name}" on "${target.id}" is not mapped`, `/workflow/nodes/${index}/onError/routeMap`, node.id);
    addAdj(allAdjacency, node.id, target.id);
    addAdj(unboundedAdjacency, node.id, target.id);
    addAdj(errorAdjacency, node.id, target.id);
  }

  for (const [index, toolId] of (profile.policies.tools.deniedTools ?? []).entries()) {
    const bytes = new TextEncoder().encode(toolId).byteLength;
    if (!toolId || bytes > MAX_MCP_TOOL_ID_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(toolId)) addDiagnostic('tool-id.invalid', `Tool ID must be nonempty, contain no control characters, and be at most ${MAX_MCP_TOOL_ID_BYTES} UTF-8 bytes`, `/policies/tools/deniedTools/${index}`);
  }

  if (hasDirectedCycle(errorAdjacency)) addDiagnostic('error-route.cycle', 'Error-route transitions must be acyclic', '/workflow/nodes');
  if (hasDirectedCycle(unboundedAdjacency)) addDiagnostic('workflow.unbounded-cycle', 'Every repeatable control-flow cycle must consume a bounded loop counter; a cycle through only ordinary, exhaustion, or error transitions is not allowed', '/workflow/edges');

  if (start) {
    const reachable = reachableFrom(start.id, allAdjacency);
    for (const node of nodes) if (!reachable.has(node.id)) addDiagnostic('node.unreachable', `Node "${node.id}" is unreachable from the start node`, `/workflow/nodes/${nodes.indexOf(node)}`, node.id);
    const ends = nodes.filter((node) => node.kind === 'end');
    if (!ends.length) addDiagnostic('workflow.end-missing', 'Workflow must declare at least one end node', '/workflow/nodes');
    for (const end of ends) if (!reachable.has(end.id)) addDiagnostic('end.unreachable', `End node "${end.id}" is unreachable from the start node`, `/workflow/nodes/${nodes.indexOf(end)}`, end.id);
  }

  const ends = nodes.filter((node) => node.kind === 'end');
  const results = profile.result;
  const resultByNode = new Map<string, Record<string, any>>();
  for (const [index, result] of results.entries()) {
    if (resultByNode.has(result.fromNode)) addDiagnostic('result.duplicate', `End node "${result.fromNode}" has multiple result declarations`, `/result/${index}/fromNode`);
    resultByNode.set(result.fromNode, result);
    const end = nodeById.get(result.fromNode);
    if (!end || end.kind !== 'end') addDiagnostic('result.not-end', `Result source "${result.fromNode}" is not an end node`, `/result/${index}/fromNode`);
    else {
      const endConfig = end.config as Record<string, any>;
      if (result.outcome !== endConfig.outcome) addDiagnostic('result.outcome-mismatch', `Result outcome must match end node "${end.id}" config.outcome`, `/result/${index}/outcome`, end.id);
      const resultPort = end.outputs[result.port];
      if (!resultPort) {
        addDiagnostic('result.port-missing', `Result port "${result.port}" is not declared on end node "${end.id}"`, `/result/${index}/port`, end.id);
      } else if (!RESULT_KIND_PORT_TYPES[result.kind]?.includes(resultPort.type)) {
        addDiagnostic('result.kind-type-mismatch', `Result kind "${result.kind}" is incompatible with end port type "${resultPort.type}"`, `/result/${index}/kind`, end.id);
      }
    }
  }
  for (const end of ends) {
    if (!resultByNode.has(end.id)) addDiagnostic('result.end-unmapped', `End node "${end.id}" must have exactly one result declaration`, '/result', end.id);
    const emit = (end.config as Record<string, any>).emit as Record<string, string>;
    const emitted = new Set(Object.keys(emit ?? {}));
    for (const outputName of Object.keys(end.outputs)) if (!emitted.has(outputName)) addDiagnostic('end.emit-output-missing', `End node output "${outputName}" is not produced by config.emit`, `/workflow/nodes/${nodes.indexOf(end)}/config/emit`, end.id);
    for (const [outputName, inputName] of Object.entries(emit ?? {})) {
      const output = end.outputs[outputName];
      const input = end.inputs[inputName];
      if (!output) addDiagnostic('end.emit-output-unknown', `config.emit names undeclared output "${outputName}"`, `/workflow/nodes/${nodes.indexOf(end)}/config/emit/${outputName}`, end.id);
      if (!input) addDiagnostic('end.emit-input-unknown', `config.emit references undeclared input "${inputName}"`, `/workflow/nodes/${nodes.indexOf(end)}/config/emit/${outputName}`, end.id);
      if (output && input && !assignable(input, output)) addDiagnostic('end.emit-type-mismatch', `End input "${inputName}" is not assignable to output "${outputName}"`, `/workflow/nodes/${nodes.indexOf(end)}/config/emit/${outputName}`, end.id);
    }
  }

  let visitBound = nodes.length;
  const maxVisits = profile.policies.execution.maxNodeVisits as number;
  for (const { edge } of loops) {
    const factor = 1 + edge.loop!.maxIterations;
    visitBound = visitBound > maxVisits || factor > maxVisits || visitBound > Math.floor(maxVisits / factor)
      ? maxVisits + 1
      : visitBound * factor;
  }
  if (visitBound > maxVisits) addDiagnostic('budget.static-node-visits', `Conservative static visit bound (${visitBound}) exceeds maxNodeVisits (${maxVisits})`, '/policies/execution/maxNodeVisits');

  // Dependency resolution and digest canonicalization require real registries and belong to Phase 3.
  void dependencyReferences;
  return diagnostics;
}

export function validateWorkflowProfileSemantics(profile: WorkflowProfileDocument): WorkflowProfileDiagnostic[] {
  if (!isJsonCompatibleValue(profile)) return [{
    stage: 'semantic', code: 'semantic.input-invalid',
    message: 'Semantic validation requires a plain JSON-compatible profile value', path: '/',
  }];
  try {
    return validateWorkflowProfileSemanticsUnchecked(profile);
  } catch (error) {
    return [{
      stage: 'semantic', code: 'semantic.input-invalid',
      message: `Semantic validation could not inspect the supplied profile: ${error instanceof Error ? error.message : String(error)}`,
      path: '/',
    }];
  }
}

function sameSet(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value) => b.some((other) => equalScalar(value, other)));
}

function errorEnvelopePort(pointer: string, failedNode: WorkflowNode): WorkflowPort | undefined {
  switch (pointer) {
    case '/failure/category':
    case '/failure/code':
    case '/node/id': return { type: 'string', required: true };
    case '/failure/retryable': return { type: 'boolean', required: true };
    case '/node/attempt': return { type: 'integer', required: true };
    default: {
      if (pointer.startsWith('/inputs/')) return failedNode.inputs[pointer.slice('/inputs/'.length)];
      return undefined;
    }
  }
}
