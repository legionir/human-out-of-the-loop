// ─── Event Types ──────────────────────────────────────────────────

export type AgentEventType =
  | 'agent:running'
  | 'agent:tool_call'
  | 'agent:completed'
  | 'agent:error';

export interface AgentEventBase {
  type: AgentEventType;
  taskId: string;
  agentId: string;
  timestamp: number;
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

export interface AgentCompletedEvent extends AgentEventBase {
  type: 'agent:completed';
  status: 'completed';
  /** Compact summary — NOT the full transcript */
  summary: string;
  toolsUsed: string[];
  /** Token usage from AI SDK */
  usage?: TokenUsage;
}

export interface AgentErrorEvent extends AgentEventBase {
  type: 'agent:error';
  status: 'error';
  error: string;
  code: string;
}

export type AgentEvent =
  | AgentRunningEvent
  | AgentToolCallEvent
  | AgentCompletedEvent
  | AgentErrorEvent;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Subscriber type ─────────────────────────────────────────────

export type EventSubscriber = (event: AgentEvent) => void;

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

    const allHandlers = new Set<EventSubscriber>();
    if (targeted) {
      for (const h of targeted) allHandlers.add(h);
    }
    if (wildcard) {
      for (const h of wildcard) allHandlers.add(h);
    }

    for (const handler of allHandlers) {
      try {
        handler(event);
      } catch (err) {
        // Log but don't throw — EventBus must be resilient
        console.error(
          `[EventBus] Subscriber error for event "${event.type}":`,
          err instanceof Error ? err.message : err
        );
      }
    }
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
