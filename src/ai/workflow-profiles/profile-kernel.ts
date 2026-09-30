/**
 * Phase 4 (WP-R-005): the deterministic workflow-graph kernel.
 *
 * The kernel owns only the OUTER control graph: node dispatch order, data-only
 * predicate routing, bounded loops, typed fail/retry/route handling, and the hard
 * visit cap. It never schedules plan steps, calls a model, or authorizes a tool:
 * those handlers arrive in Phase 5 and re-check Runtime policy at the real call
 * site (Phase 6).
 *
 * Determinism contract (shared with the semantic validator):
 *   - conditional edges are evaluated by ascending `priority`, then declaration order;
 *   - the first matching predicate wins, even when later predicates also match;
 *   - the single `default` edge is used only when no conditional edge matched;
 *   - with no match and no default the run fails closed;
 *   - one loop iteration is one successful traversal of that edge; the counter is
 *     monotonic, run-scoped, and shared across retries;
 *   - `maxNodeVisits` is enforced hard on every transition, independently of the
 *     static bound computed by the semantic validator.
 *
 * Prohibited semantics: authorization denial, approval denial, and cancellation are
 * terminal. A profile can never retry or route them, and a failure envelope never
 * carries raw exception text.
 */
import { evaluatePredicate, readPort, scalarMatchesType, ABSENT } from './profile-predicate.js';
import type {
  ProfileDependency,
  WorkflowEdge,
  WorkflowNode,
  WorkflowProfileDocument,
  WorkflowResult,
} from './profile-types.js';

export type WorkflowNodeKind = WorkflowNode['kind'];

export type WorkflowFailureCategory =
  | 'handler' | 'internal' | 'timeout' | 'provider' | 'rate-limit' | 'tool' | 'validation'
  | 'security-denied' | 'approval-denied' | 'cancelled'
  | 'route' | 'loop-exhausted' | 'visit-cap' | 'budget';

/** Categories that no profile policy may retry or route. */
export const TERMINAL_FAILURE_CATEGORIES: ReadonlySet<WorkflowFailureCategory> = new Set([
  'security-denied', 'approval-denied', 'cancelled', 'visit-cap', 'budget',
]);

export interface WorkflowFailure {
  category: WorkflowFailureCategory;
  code: string;
  retryable: boolean;
  nodeId: string;
  attempt: number;
}

/** Thrown by handlers to classify a failure for the profile's error policy. */
export class WorkflowNodeError extends Error {
  constructor(
    message: string,
    public readonly options: { category: WorkflowFailureCategory; code: string; retryable?: boolean },
  ) {
    super(message);
    this.name = 'WorkflowNodeError';
  }
}

export interface WorkflowNodeInvocation {
  node: WorkflowNode;
  inputs: Readonly<Record<string, unknown>>;
  attempt: number;
  visit: number;
  signal?: AbortSignal;
}

export type WorkflowNodeHandler = (
  invocation: WorkflowNodeInvocation,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface WorkflowKernelEvent {
  type:
    | 'run.start' | 'run.end' | 'node.start' | 'node.output' | 'node.error' | 'node.retry'
    | 'edge.select' | 'route.error' | 'loop.iteration' | 'loop.exhausted';
  nodeId?: string;
  edgeIndex?: number;
  counterId?: string;
  count?: number;
  failure?: WorkflowFailure;
  visit?: number;
}

export interface WorkflowKernelOptions {
  profile: WorkflowProfileDocument;
  handlers?: Partial<Record<WorkflowNodeKind, WorkflowNodeHandler>>;
  /** Initial inputs handed to the start node. */
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: (event: WorkflowKernelEvent) => void;
  /** Injected for deterministic tests; defaults to a real timer. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Runtime hard cap; the effective cap is the strictest of profile, runtime, and the schema maximum. */
  maxNodeVisits?: number;
}

export type WorkflowRunStatus = 'success' | 'rejected' | 'handoff' | 'cancelled' | 'failure';

export interface WorkflowRunResult {
  status: WorkflowRunStatus;
  results: ReadonlyArray<WorkflowResult>;
  terminalFailure?: WorkflowFailure;
  visits: number;
  loopCounters: Readonly<Record<string, number>>;
  nodeSequence: ReadonlyArray<string>;
}

const SCHEMA_MAX_NODE_VISITS = 1000;

/** Strictest applicable visit cap; Runtime and profile can only lower the schema maximum. */
export function effectiveMaxNodeVisits(profile: WorkflowProfileDocument, runtimeCap?: number): number {
  const profileCap = profile?.policies?.execution?.maxNodeVisits ?? SCHEMA_MAX_NODE_VISITS;
  const caps = [SCHEMA_MAX_NODE_VISITS, profileCap, runtimeCap].filter((cap): cap is number => typeof cap === 'number' && Number.isFinite(cap) && cap > 0);
  return Math.min(...caps);
}

function failureFrom(error: unknown, nodeId: string, attempt: number): WorkflowFailure {
  if (error instanceof WorkflowNodeError) {
    return {
      category: error.options.category,
      code: error.options.code,
      retryable: error.options.retryable === true,
      nodeId,
      attempt,
    };
  }
  return { category: 'handler', code: 'handler.error', retryable: false, nodeId, attempt };
}

/** Sanitized failure envelope: never carries raw exception text. */
function failureEnvelope(failure: WorkflowFailure, inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    failure: { category: failure.category, code: failure.code, retryable: failure.retryable },
    node: { id: failure.nodeId, attempt: failure.attempt },
    inputs: { ...inputs },
  };
}

function readEnvelopePointer(envelope: Record<string, unknown>, pointer: string): unknown {
  const segments = pointer.split('/').slice(1);
  let current: unknown = envelope;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return ABSENT;
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return ABSENT;
    current = record[segment];
  }
  return current;
}

interface KernelState {
  visits: number;
  counters: Map<string, number>;
  sequence: string[];
  results: WorkflowResult[];
  events: WorkflowKernelEvent[];
}

export async function runWorkflowProfileKernel(options: WorkflowKernelOptions): Promise<WorkflowRunResult> {
  const { profile, handlers = {}, signal } = options;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const emit = (event: WorkflowKernelEvent): void => {
    options.onEvent?.(event);
  };

  const nodeById = new Map<string, WorkflowNode>();
  for (const node of profile.workflow?.nodes ?? []) nodeById.set(node.id, node);
  const edges = (profile.workflow?.edges ?? []).map((edge, index) => ({ edge, index }));
  const maxVisits = effectiveMaxNodeVisits(profile, options.maxNodeVisits);

  const state: KernelState = { visits: 0, counters: new Map(), sequence: [], results: [], events: [] };

  const finish = (status: WorkflowRunStatus, terminalFailure?: WorkflowFailure): WorkflowRunResult => {
    const result: WorkflowRunResult = {
      status,
      results: Object.freeze([...state.results]),
      ...(terminalFailure ? { terminalFailure } : {}),
      visits: state.visits,
      loopCounters: Object.freeze(Object.fromEntries([...state.counters.entries()].sort())),
      nodeSequence: Object.freeze([...state.sequence]),
    };
    emit({ type: 'run.end', nodeId: terminalFailure?.nodeId, failure: terminalFailure });
    return result;
  };

  const cancelled = (nodeId: string): WorkflowRunResult | undefined => {
    if (!signal?.aborted) return undefined;
    return finish('cancelled', { category: 'cancelled', code: 'run.cancelled', retryable: false, nodeId, attempt: 1 });
  };

  /** Validate a handler/computed result against the node's declared output ports. */
  const validateOutputs = (node: WorkflowNode, candidate: Record<string, unknown>, attempt: number): void => {
    for (const [portName, port] of Object.entries(node.outputs ?? {})) {
      const value = candidate[portName];
      if (value === undefined) {
        if (port.required === true) {
          throw new WorkflowNodeError(`Node "${node.id}" did not produce required output port "${portName}"`, {
            category: 'handler', code: 'output.missing', retryable: false,
          });
        }
        continue;
      }
      if (!scalarMatchesType(value, port.type)) {
        throw new WorkflowNodeError(`Node "${node.id}" output port "${portName}" does not satisfy its declared type`, {
          category: 'handler', code: 'output.type-mismatch', retryable: false,
        });
      }
    }
  };

  /** Evaluate a condition node: pass inputs through and compute `matched` from the data-only predicate. */
  const runConditionNode = (node: WorkflowNode, inputs: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const outputs: Record<string, unknown> = {};
    for (const portName of Object.keys(node.inputs ?? {})) {
      if (Object.hasOwn(inputs, portName)) outputs[portName] = inputs[portName];
    }
    outputs.matched = evaluatePredicate((node.config as Record<string, any>).predicate, inputs);
    return outputs;
  };

  /** Build an end node's emitted outputs from config.emit (output port -> input port). */
  const runEndNode = (node: WorkflowNode, inputs: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const emitMap = ((node.config as Record<string, any>).emit ?? {}) as Record<string, string>;
    const outputs: Record<string, unknown> = {};
    for (const [outputName, inputName] of Object.entries(emitMap)) {
      const value = Object.hasOwn(inputs, inputName) ? inputs[inputName] : ABSENT;
      if (value === ABSENT) {
        const port = node.outputs?.[outputName];
        if (port?.required === true) {
          throw new WorkflowNodeError(`End node "${node.id}" has no value for required emitted output "${outputName}"`, {
            category: 'validation', code: 'end.emit-missing-input', retryable: false,
          });
        }
        continue;
      }
      outputs[outputName] = value;
    }
    validateOutputs(node, outputs, 1);
    return outputs;
  };

  /** Map an edge's `map` against the source node's outputs. Required target inputs must be produced. */
  const applyEdgeMap = (
    map: Record<string, string> | undefined,
    outputs: Readonly<Record<string, unknown>>,
    target: WorkflowNode,
    onFailure: (code: string, message: string) => never,
  ): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const [targetPort, pointer] of Object.entries(map ?? {})) {
      const declaration = target.inputs?.[targetPort];
      if (!declaration) onFailure('route.target-port-missing', `Mapping targets undeclared input port "${targetPort}" on node "${target.id}"`);
      const value = readPort(outputs, pointer);
      if (value === ABSENT) {
        if (declaration.required === true) onFailure('route.required-input-missing', `Mapping produced no value for required input "${targetPort}" of node "${target.id}"`);
        continue;
      }
      if (!scalarMatchesType(value, declaration.type)) onFailure('route.input-type-mismatch', `Value for input "${targetPort}" of node "${target.id}" does not satisfy its declared type`);
      inputs[targetPort] = value;
    }
    return inputs;
  };

  const selectEdge = (
    node: WorkflowNode,
    outputs: Readonly<Record<string, unknown>>,
    onFailure: (code: string, message: string) => never,
  ): { edge: WorkflowEdge; index: number } | undefined => {
    const outgoing = edges.filter((candidate) => candidate.edge.from === node.id);
    if (outgoing.length === 0) return undefined;
    const conditional = outgoing
      .filter((candidate) => candidate.edge.when && candidate.edge.default !== true)
      .sort((left, right) => (left.edge.priority ?? 100) - (right.edge.priority ?? 100) || left.index - right.index);
    for (const candidate of conditional) {
      if (evaluatePredicate(candidate.edge.when!, outputs)) {
        emit({ type: 'edge.select', nodeId: node.id, edgeIndex: candidate.index });
        return candidate;
      }
    }
    const defaults = outgoing.filter((candidate) => candidate.edge.default === true);
    if (defaults.length > 1) onFailure('route.multiple-defaults', `Node "${node.id}" has ${defaults.length} default edges`);
    if (defaults.length === 1) {
      emit({ type: 'edge.select', nodeId: node.id, edgeIndex: defaults[0].index });
      return defaults[0];
    }
    const unconditional = outgoing.filter((candidate) => !candidate.edge.when && candidate.edge.default !== true);
    if (conditional.length === 0 && unconditional.length === 1 && outgoing.length === 1) {
      emit({ type: 'edge.select', nodeId: node.id, edgeIndex: unconditional[0].index });
      return unconditional[0];
    }
    onFailure('route.missing', `No edge of node "${node.id}" matched and no default edge is declared`);
  };

  emit({ type: 'run.start', nodeId: profile.workflow?.startNode });

  let current = nodeById.get(profile.workflow?.startNode);
  if (!current) {
    return finish('failure', { category: 'validation', code: 'workflow.start-missing', retryable: false, nodeId: profile.workflow?.startNode ?? '<none>', attempt: 1 });
  }
  let inputs: Record<string, unknown> = { ...(options.input ?? {}) };

  for (;;) {
    const abortResult = cancelled(current.id);
    if (abortResult) return abortResult;

    if (state.visits >= maxVisits) {
      return finish('failure', {
        category: 'visit-cap', code: 'max-node-visits', retryable: false, nodeId: current.id, attempt: 1,
      });
    }
    state.visits += 1;
    state.sequence.push(current.id);

    const node = current;
    emit({ type: 'node.start', nodeId: node.id, visit: state.visits });
    let attempt = 1;
    let outputs: Record<string, unknown> | undefined;
    let failure: WorkflowFailure | undefined;
    let routed = false;

    for (;;) {
      try {
        const produced = node.kind === 'condition'
          ? runConditionNode(node, inputs)
          : node.kind === 'end'
            ? runEndNode(node, inputs)
            : (() => {
                const handler = handlers[node.kind];
                if (!handler) {
                  throw new WorkflowNodeError(`No handler is registered for node kind "${node.kind}"`, {
                    category: 'handler', code: 'handler.missing', retryable: false,
                  });
                }
                return handler({ node, inputs, attempt, visit: state.visits, ...(signal ? { signal } : {}) });
              })();
        outputs = await Promise.resolve(produced as Record<string, unknown> | Promise<Record<string, unknown>>);
        if (node.kind !== 'condition' && node.kind !== 'end') validateOutputs(node, outputs, attempt);
        emit({ type: 'node.output', nodeId: node.id, visit: state.visits });
        // A successful attempt clears any failure recorded by an earlier attempt.
        failure = undefined;
        break;
      } catch (error) {
        failure = failureFrom(error, node.id, attempt);
        emit({ type: 'node.error', nodeId: node.id, failure, visit: state.visits });
        if (signal?.aborted || TERMINAL_FAILURE_CATEGORIES.has(failure.category)) break;

        const policy = node.onError;
        if (policy?.strategy === 'retry' && failure.retryable && (policy.retryOn ?? []).includes(failure.category) && attempt < (policy.maxAttempts ?? 1)) {
          emit({ type: 'node.retry', nodeId: node.id, failure, count: attempt });
          const backoffMs = (policy.backoffSeconds ?? 0) * 1000;
          if (backoffMs > 0) {
            const abortResult = cancelled(node.id);
            if (abortResult) return abortResult;
            await sleep(backoffMs);
            const afterSleep = cancelled(node.id);
            if (afterSleep) return afterSleep;
          }
          attempt += 1;
          continue;
        }
        if (policy?.strategy === 'route' && typeof policy.routeTo === 'string') {
          const target = nodeById.get(policy.routeTo);
          if (!target) break;
          try {
            const envelope = failureEnvelope(failure, inputs);
            const routeInputs: Record<string, unknown> = {};
            for (const [targetPort, pointer] of Object.entries(policy.routeMap ?? {})) {
              const declaration = target.inputs?.[targetPort];
              if (!declaration) throw new WorkflowNodeError(`Route mapping targets undeclared input port "${targetPort}"`, { category: 'route', code: 'route.target-port-missing' });
              const value = readEnvelopePointer(envelope, pointer);
              if (value === ABSENT) {
                if (declaration.required === true) throw new WorkflowNodeError(`Route mapping produced no value for required input "${targetPort}"`, { category: 'route', code: 'route.required-input-missing' });
                continue;
              }
              routeInputs[targetPort] = value;
            }
            emit({ type: 'route.error', nodeId: node.id, failure });
            inputs = routeInputs;
            current = target;
            routed = true;
            break;
          } catch (routeError) {
            failure = failureFrom(routeError, node.id, attempt);
            emit({ type: 'node.error', nodeId: node.id, failure, visit: state.visits });
            break;
          }
        }
        break;
      }
    }

    if (routed) continue;
    if (failure) return finish('failure', failure);
    const produced = outputs ?? {};

    if (node.kind === 'end') {
      const outcome = (node.config as Record<string, any>).outcome as WorkflowRunStatus;
      for (const declaration of profile.result ?? []) {
        if (declaration.fromNode === node.id) state.results.push(Object.freeze({ ...declaration }) as WorkflowResult);
      }
      return finish(outcome ?? 'success');
    }

    const onRouteFailure = (code: string, message: string): never => {
      throw new WorkflowNodeError(message, { category: 'route', code });
    };

    let selected: { edge: WorkflowEdge; index: number } | undefined;
    try {
      selected = selectEdge(node, produced, onRouteFailure);
    } catch (error) {
      return finish('failure', failureFrom(error, node.id, attempt));
    }
    if (!selected) {
      return finish('failure', { category: 'route', code: 'route.missing', retryable: false, nodeId: node.id, attempt });
    }

    let targetId = selected.edge.to;
    let nextInputs: Record<string, unknown>;
    try {
      const target = nodeById.get(targetId);
      if (!target) throw new WorkflowNodeError(`Edge target "${targetId}" does not exist`, { category: 'route', code: 'route.target-missing' });

      if (selected.edge.loop) {
        const { counterId, maxIterations, onExhausted } = selected.edge.loop;
        const used = state.counters.get(counterId) ?? 0;
        if (used >= maxIterations) {
          emit({ type: 'loop.exhausted', nodeId: node.id, counterId, count: used });
          if (onExhausted.strategy === 'fail') {
            return finish('failure', { category: 'loop-exhausted', code: 'loop.exhausted', retryable: false, nodeId: node.id, attempt });
          }
          const exhaustedTarget = nodeById.get(onExhausted.to ?? '');
          if (!exhaustedTarget) {
            return finish('failure', { category: 'route', code: 'route.target-missing', retryable: false, nodeId: node.id, attempt });
          }
          nextInputs = applyEdgeMap(onExhausted.map, produced, exhaustedTarget, onRouteFailure);
          targetId = exhaustedTarget.id;
        } else {
          state.counters.set(counterId, used + 1);
          emit({ type: 'loop.iteration', nodeId: node.id, counterId, count: used + 1 });
          nextInputs = applyEdgeMap(selected.edge.map, produced, target, onRouteFailure);
        }
      } else {
        nextInputs = applyEdgeMap(selected.edge.map, produced, target, onRouteFailure);
      }
    } catch (error) {
      return finish('failure', failureFrom(error, node.id, attempt));
    }

    const next = nodeById.get(targetId);
    if (!next) return finish('failure', { category: 'route', code: 'route.target-missing', retryable: false, nodeId: node.id, attempt });
    inputs = nextInputs;
    current = next;
  }
}

/** Marker used by documentation/tests: the kernel never authorizes a dependency. */
export type KernelDependencyVisibility = ReadonlyArray<ProfileDependency>;
