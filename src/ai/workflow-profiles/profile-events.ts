/**
 * Phase 6 (WP-R-007): lifecycle events for a profile run.
 *
 * Events go through the existing observability surface (`EventBus.emit`): the
 * emitter takes any object with an `emit(event)` method, so the real bus and a
 * test sink are interchangeable. What is emitted is deliberately narrow:
 * identifiers, statuses, counters, loop/retry/failure codes, and the approval
 * record — never node inputs, never profile or untrusted text, never a prompt.
 * Every string is additionally passed through the repository's secret scrubber
 * before it leaves the process.
 *
 * A failing sink must not corrupt a run: emission is best-effort, the failure is
 * recorded as a degraded flag plus an `onDegraded` callback, and the run
 * continues with its state intact (an event sink is observability, not
 * authority). A persistence failure is the caller's decision — `profile-runner`
 * treats it as fail-closed and keeps the previous state file.
 */
import { scrubSecretValues } from '../runtime/secret-scrub.js';
import type { WorkflowKernelEvent } from './profile-kernel.js';

export interface EventSinkLike {
  emit(event: unknown): void;
}

export type WorkflowProfileEventType =
  | 'workflow.run.start'
  | 'workflow.node.start'
  | 'workflow.node.output'
  | 'workflow.node.error'
  | 'workflow.node.retry'
  | 'workflow.edge.select'
  | 'workflow.loop.iteration'
  | 'workflow.loop.exhausted'
  | 'workflow.route.error'
  | 'workflow.approval'
  | 'workflow.budget'
  | 'workflow.run.end'
  | 'workflow.run.resume-refused'
  | 'workflow.persistence.degraded';

export interface WorkflowProfileEvent {
  type: WorkflowProfileEventType;
  runId: string;
  atMs: number;
  nodeId?: string;
  edgeIndex?: number;
  counterId?: string;
  count?: number;
  attempt?: number;
  visit?: number;
  status?: string;
  code?: string;
  failureCategory?: string;
  approval?: { nodeId: string; status: string; digest?: string; boundPort?: string };
  budget?: { visits: number; durationMs: number; modelCalls: number; toolCalls: number };
  degraded?: boolean;
}

const KERNEL_EVENT_TYPES: Record<WorkflowKernelEvent['type'], WorkflowProfileEventType> = {
  'run.start': 'workflow.run.start',
  'run.end': 'workflow.run.end',
  'node.start': 'workflow.node.start',
  'node.output': 'workflow.node.output',
  'node.error': 'workflow.node.error',
  'node.retry': 'workflow.node.retry',
  'edge.select': 'workflow.edge.select',
  'loop.iteration': 'workflow.loop.iteration',
  'loop.exhausted': 'workflow.loop.exhausted',
  'route.error': 'workflow.route.error',
};

export interface WorkflowProfileEventEmitterOptions {
  runId: string;
  sink?: EventSinkLike;
  /** Literal secret values to scrub from every emitted string. */
  secrets?: ReadonlyArray<string>;
  now?: () => number;
  /** Called once per failed emission; never throws into the run. */
  onDegraded?: (error: unknown) => void;
}

export interface WorkflowProfileEventEmitter {
  /** Emit a lifecycle event; never throws. */
  emit(event: WorkflowProfileEvent): void;
  /** Map a kernel event onto the narrow lifecycle shape and emit it. */
  emitKernelEvent(event: WorkflowKernelEvent): void;
  /** True once any emission failed; the run's state is unaffected. */
  readonly degraded: boolean;
}

function scrub(event: WorkflowProfileEvent, secrets: ReadonlyArray<string>): WorkflowProfileEvent {
  const clean: WorkflowProfileEvent = { ...event };
  for (const key of ['nodeId', 'counterId', 'status', 'code', 'failureCategory'] as const) {
    const value = clean[key];
    if (typeof value === 'string') clean[key] = scrubSecretValues(value, secrets);
  }
  if (clean.approval) {
    clean.approval = { ...clean.approval, nodeId: scrubSecretValues(clean.approval.nodeId, secrets) };
  }
  return clean;
}

export function createWorkflowProfileEventEmitter(options: WorkflowProfileEventEmitterOptions): WorkflowProfileEventEmitter {
  const secrets = options.secrets ?? [];
  const now = options.now ?? (() => Date.now());
  let degraded = false;

  const emit = (event: WorkflowProfileEvent): void => {
    if (!options.sink) return;
    try {
      options.sink.emit(scrub({ ...event, runId: scrubSecretValues(event.runId, secrets), atMs: event.atMs || now() }, secrets));
    } catch (error) {
      degraded = true;
      options.onDegraded?.(error);
    }
  };

  return {
    emit,
    emitKernelEvent: (event: WorkflowKernelEvent): void => {
      emit({
        type: KERNEL_EVENT_TYPES[event.type],
        runId: options.runId,
        atMs: now(),
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(event.edgeIndex !== undefined ? { edgeIndex: event.edgeIndex } : {}),
        ...(event.counterId ? { counterId: event.counterId } : {}),
        ...(event.count !== undefined ? { count: event.count } : {}),
        ...(event.visit !== undefined ? { visit: event.visit } : {}),
        ...(event.failure
          ? {
            attempt: event.failure.attempt,
            code: event.failure.code,
            failureCategory: event.failure.category,
          }
          : {}),
      });
    },
    get degraded(): boolean {
      return degraded;
    },
  };
}
