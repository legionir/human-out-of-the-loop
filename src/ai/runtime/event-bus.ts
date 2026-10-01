// ─── Event Types ──────────────────────────────────────────────────

export type AgentEventType =
  | 'agent:running'
  | 'agent:tool_call'
  | 'agent:tool_error'
  | 'agent:completed'
  | 'agent:error';

export interface AgentEventBase {
  type: AgentEventType;
  taskId: string;
  agentId: string;
  timestamp: number;
  /**
   * Phase 20 (CORR-03/CORR-05): plan context carried on every event.
   * Populated by TaskRuntime from the task's planId/planStepId so
   * consumers (UsageAggregator, StreamingManager) no longer guess.
   */
  planId?: string;
  planStepId?: string;
}

export interface AgentRunningEvent extends AgentEventBase {
  type: 'agent:running';
  status: 'running';
  prompt: string;
}

export interface AgentToolCallEvent extends AgentEventBase {
  type: 'agent:tool_call';
  status: 'running';
  /** Tool name only — NOT full arguments (Law 14: compact events) */
  toolName: string;
  /** Opaque call id for correlating with later results */
  callId: string;
}

/**
 * Phase 30 (P3): a tool call that did NOT do what it was asked to do.
 *
 * A tool can fail in three different ways, and all three end up here:
 *   1. `execute` threw                     → the AI SDK emits a `tool-error` part
 *   2. the tool returned a failure result  → `{ success: false, error, code }`
 *      (the contract every `src/ai/tools/implementations/*` tool follows)
 *   3. execution was denied                → `{ type: 'execution-denied' }`
 *
 * Before this event existed, (2) was completely invisible: the run reported
 * `Tools used: write_file` and the acceptance judge was told "Task Errors:
 * None" even when the tool had refused to do anything.
 */
export interface AgentToolErrorEvent extends AgentEventBase {
  type: 'agent:tool_error';
  status: 'error';
  /** Tool name only — NOT full arguments (Law 14: compact events) */
  toolName: string;
  /** Opaque call id for correlating with the originating tool call */
  callId: string;
  /** Compact one-line error message (already truncated by the emitter) */
  error: string;
}

export interface AgentCompletedEvent extends AgentEventBase {
  type: 'agent:completed';
  status: 'completed';
  /** Compact summary — NOT the full transcript */
  summary: string;
  toolsUsed: string[];
  /** Token usage from AI SDK */
  usage?: TokenUsage;
  /**
   * F-12: how many model calls this agent run made (the SDK's step count, which is 1 + one per
   * tool round). Budget accounting counts these, so a multi-step run is charged for every call it
   * made rather than once. Older emitters omit it; consumers treat a missing value as 1.
   */
  modelCalls?: number;
}

export interface AgentErrorEvent extends AgentEventBase {
  type: 'agent:error';
  status: 'error';
  error: string;
  code: string;
  /** C-06: partial token usage collected before the failure. */
  usage?: TokenUsage;
  /** F-12: model calls made before the failure (1 when only the aggregate usage is known). */
  modelCalls?: number;
}

export type AgentEvent =
  | AgentRunningEvent
  | AgentToolCallEvent
  | AgentToolErrorEvent
  | AgentCompletedEvent
  | AgentErrorEvent;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** F-01: tokens served from the provider prompt cache. */
  cacheReadTokens?: number;
  /** F-01: tokens written into the provider prompt cache. */
  cacheWriteTokens?: number;
}

// ─── Subscriber type ─────────────────────────────────────────────

export type EventSubscriber = (event: AgentEvent) => void;

/** Phase 27 (PERF-08): shared empty iterable — no allocation when idle. */
const EMPTY_HANDLERS: readonly EventSubscriber[] = [];

export type UnsubscribeFn = () => void;

// ─── EventBus ────────────────────────────────────────────────────

/**
 * Lightweight in-memory pub/sub for agent lifecycle events.
 *
 * Design decisions:
 *   - Synchronous emission — subscribers run inline so that
 *     TaskRuntime (Phase 8) can update state immediately.
 *   - No event replay — subscribers only receive events emitted
 *     after they subscribe.  Historical data is in TaskRuntime.
 *   - Wildcard support — subscribing to "*" receives all events.
 *   - Thread-safe in the Node.js single-threaded model (no races).
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<EventSubscriber>>();
  /**
   * Phase 27 (PERF-08): reusable dedup buffers, one per re-entrancy
   * depth — the common (non-nested) case is allocation-free.
   */
  private readonly emitBuffers: Array<Set<EventSubscriber>> = [];
  private emitDepth = 0;

  /**
   * Phase 22: optional sink for errors thrown by subscribers.
   * The Orchestrator wires this to the ObservabilityLogger so the
   * runtime never touches the console API directly.  When unset,
   * subscriber errors are swallowed (the bus must stay resilient).
   */
  onSubscriberError?: (event: AgentEvent, error: unknown) => void;

  /**
   * Subscribe to a specific event type or "*" for all events.
   * Returns an unsubscribe function.
   */
  subscribe(eventType: AgentEventType | '*', handler: EventSubscriber): UnsubscribeFn {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);

    return () => {
      this.listeners.get(eventType)?.delete(handler);
    };
  }

  /**
   * Emit an event to all matching subscribers.
   * Subscribers are called synchronously in registration order.
   * Errors in subscribers are caught and logged — one bad subscriber
   * must not prevent others from receiving the event.
   */
  emit(event: AgentEvent): void {
    const targeted = this.listeners.get(event.type);
    const wildcard = this.listeners.get('*');

    // Phase 27 (PERF-08): the old code allocated a fresh `Set` for EVERY
    // emit just to deduplicate type + wildcard subscribers.  Two fast
    // paths removed that allocation for the common cases (only one of the
    // two listener sets is populated); when both exist we reuse a buffer
    // (one per nesting depth, so a handler that emits re-entrantly cannot
    // clobber the set being iterated).
    let handlers: Iterable<EventSubscriber>;
    let usedBuffer = false;
    if (targeted && wildcard) {
      const buffer = this.getEmitBuffer();
      usedBuffer = true;
      for (const h of targeted) buffer.add(h);
      for (const h of wildcard) buffer.add(h);
      handlers = buffer;
    } else {
      handlers = targeted ?? wildcard ?? EMPTY_HANDLERS;
    }

    try {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          // Phase 22: subscriber errors are routed to an injected handler
          // (the Orchestrator wires this to the ObservabilityLogger)
          // instead of the console API.  If none is set, the error is
          // swallowed — one bad subscriber must never break the bus.
          this.onSubscriberError?.(event, err);
        }
      }
    } finally {
      if (usedBuffer) this.releaseEmitBuffer();
    }
  }

  /**
   * Acquire the dedup buffer for the current emit depth.  Buffers are
   * keyed by depth so a re-entrant emit (a handler that emits) uses a
   * different buffer instead of clobbering the one being iterated.
   */
  private getEmitBuffer(): Set<EventSubscriber> {
    const depth = this.emitDepth;
    this.emitDepth++;
    let buffer = this.emitBuffers[depth];
    if (buffer) {
      buffer.clear();
    } else {
      buffer = new Set<EventSubscriber>();
      this.emitBuffers[depth] = buffer;
    }
    return buffer;
  }

  /** Release the buffer after the iteration completes. */
  private releaseEmitBuffer(): void {
    this.emitDepth = Math.max(0, this.emitDepth - 1);
  }

  /**
   * Number of dedup buffers retained (diagnostics/tests).  Stays at 1
   * for non-nested emits — i.e. no per-emit allocation.
   */
  get emitBufferCount(): number {
    return this.emitBuffers.length;
  }

  /** Remove all subscribers. Useful for cleanup in tests. */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of active subscriptions (for diagnostics). */
  get subscriberCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }
}

/**
 * @deprecated Phase 19 (SING-01): a shared bus breaks isolation between
 * Orchestrator instances — events from one run leaked into another.
 * Every Orchestrator now creates its own `new EventBus()` and passes it
 * explicitly to TaskRuntime/AgentRuntime.  This export is kept only so
 * older code keeps compiling; it must NOT be used by new code.
 */
export const globalEventBus = new EventBus();
