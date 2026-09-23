import {
  EventBus,
  type AgentEvent,
} from './event-bus.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A compact progress event sent to the user's observation channel.
 * These are lightweight — no raw transcripts, no credentials.
 */
export interface ProgressEvent {
  type:
    | 'plan:started'
    | 'plan:step-started'
    | 'plan:step-completed'
    | 'plan:step-failed'
    | 'plan:replanning'
    | 'plan:completed'
    | 'plan:cancelled'
    | 'plan:failed'
    | 'task:tool-call'
    | 'task:status';
  planId: string;
  stepId?: string;
  timestamp: number;
  /** Human-readable one-line message */
  message: string;
  /** Optional structured payload (e.g. step status, tool name) */
  payload?: Record<string, unknown>;
}

export type ProgressSubscriber = (event: ProgressEvent) => void;
export type UnsubscribeProgress = () => void;

export interface StreamingManagerConfig {
  /** EventBus to listen to agent events */
  eventBus: EventBus;
}

// ─── StreamingManager ────────────────────────────────────────────

/**
 * Translates internal EventBus events into user-facing progress
 * events and distributes them to subscribers (SSE, WebSocket,
 * CLI output, etc.).
 *
 * Key design:
 *   - Subscribers receive ProgressEvent objects, NOT raw AgentEvents.
 *   - Messages are human-readable one-liners.
 *   - No raw tool arguments, results, or credentials leak.
 *   - Multiple subscribers supported (e.g. SSE + logging).
 */
export class StreamingManager {
  private readonly eventBus: EventBus;
  private readonly subscribers = new Set<ProgressSubscriber>();
  private unsubscribes: Array<() => void> = [];

  constructor(config: StreamingManagerConfig) {
    this.eventBus = config.eventBus;
  }

  /**
   * Start listening to the EventBus and translating events.
   */
  start(): void {
    const unsub = this.eventBus.subscribe('*', (event) => {
      const progress = this.translateEvent(event);
      if (progress) {
        this.emit(progress);
      }
    });
    this.unsubscribes.push(unsub);
  }

  /**
   * Stop listening.
   */
  stop(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
  }

  /**
   * Subscribe to progress events.
   */
  subscribe(handler: ProgressSubscriber): UnsubscribeProgress {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /**
   * Manually emit a progress event (e.g. from PlanRuntime).
   */
  emitProgress(event: ProgressEvent): void {
    this.emit(event);
  }

  // ── Private ───────────────────────────────────────────────────

  private emit(event: ProgressEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch {
        // Subscriber errors must not break the stream
      }
    }
  }

  private translateEvent(event: AgentEvent): ProgressEvent | null {
    const base = {
      planId: event.taskId, // Will be mapped to planId by the caller
      timestamp: event.timestamp,
    };

    switch (event.type) {
      case 'agent:running':
        return {
          ...base,
          type: 'plan:step-started',
          stepId: event.taskId,
          message: `Agent "${event.agentId}" started working.`,
        };

      case 'agent:tool_call':
        return {
          ...base,
          type: 'task:tool-call',
          stepId: event.taskId,
          message: `Tool "${event.toolName}" invoked.`,
          payload: { toolName: event.toolName },
        };

      case 'agent:completed':
        return {
          ...base,
          type: 'plan:step-completed',
          stepId: event.taskId,
          message: `Agent "${event.agentId}" completed. ${event.toolsUsed.length} tool(s) used.`,
          payload: {
            toolsUsed: event.toolsUsed,
            usage: event.usage,
          },
        };

      case 'agent:error':
        return {
          ...base,
          type: 'plan:step-failed',
          stepId: event.taskId,
          message: `Agent "${event.agentId}" failed: ${event.error.slice(0, 100)}`,
          payload: { code: event.code },
        };

      default:
        return null;
    }
  }
}

// ─── SSE Adapter (example) ───────────────────────────────────────

/**
 * Example adapter that formats ProgressEvents as Server-Sent Events.
 * In a real app, this would be wired to an HTTP response stream.
 */
export function formatAsSSE(event: ProgressEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

/**
 * Collect all progress events into an array (useful for testing
 * and for CLI output).
 */
export function createArrayCollector(): {
  handler: ProgressSubscriber;
  events: ProgressEvent[];
} {
  const events: ProgressEvent[] = [];
  return {
    handler: (event) => events.push(event),
    events,
  };
}
