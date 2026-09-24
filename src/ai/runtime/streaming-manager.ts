import {
  EventBus,
  type AgentEvent,
} from './event-bus.js';
import type { Plan } from '../schemas/plan.js';

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
    | 'task:tool-error'
    | 'task:status';
  planId: string;
  /** Phase 20 (CORR-05): the task id behind this event (planId is the real plan) */
  taskId?: string;
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

  /**
   * Translate PlanRuntime status changes into ProgressEvents.
   */
  handlePlanStatusChange(plan: Plan, event: string): void {
    const progress = this.translatePlanEvent(plan, event);
    if (progress) {
      this.emit(progress);
    }
  }

  private translatePlanEvent(plan: Plan, event: string): ProgressEvent | null {
    const base = {
      planId: plan.id ?? 'unknown',
      timestamp: Date.now(),
    };

    if (event === 'plan:started') {
      // Phase 23 (CLI): totalSteps in the payload lets the terminal
      // renderer show a "step x/y" progress counter.
      return {
        ...base,
        type: 'plan:started',
        message: `Plan "${plan.goal.slice(0, 60)}" started.`,
        payload: { totalSteps: plan.steps.length },
      };
    }
    if (event === 'plan:replanning') {
      return { ...base, type: 'plan:replanning', message: 'Re-planning in progress...' };
    }
    if (event === 'plan:finished') {
      const done = plan.steps.filter((s) => s.status === 'done').length;
      return {
        ...base,
        type: plan.status === 'completed' ? 'plan:completed' : 'plan:failed',
        message: `Plan ${plan.status}. ${done}/${plan.steps.length} steps completed.`,
      };
    }
    if (event.startsWith('step:')) {
      const stepId = event.split(':')[1]?.split(':')[0];
      const action = event.split(':').pop();
      return {
        ...base,
        type: action === 'done' ? 'plan:step-completed' : action === 'failed' ? 'plan:step-failed' : 'plan:step-started',
        stepId,
        message: `Step ${stepId}: ${action}`,
      };
    }

    return null;
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
    // Phase 20 (CORR-05): events now carry the real plan context from
    // TaskRuntime — no more using the task id as the plan id.
    const base = {
      planId: event.planId ?? event.taskId,
      taskId: event.taskId,
      stepId: event.planStepId,
      timestamp: event.timestamp,
    };

    switch (event.type) {
      case 'agent:running':
        return {
          ...base,
          type: 'plan:step-started',
          message: `Agent "${event.agentId}" started working.`,
          // Phase 29: agent-level lines are a *detail* of the step — the
          // plan lifecycle emits its own step events.  Without this marker
          // the terminal counter counted every step twice ([4/2]).
          payload: { agentLevel: true },
        };

      case 'agent:tool_call':
        return {
          ...base,
          type: 'task:tool-call',
          message: `Tool "${event.toolName}" invoked.`,
          payload: { toolName: event.toolName },
        };

      case 'agent:tool_error':
        // Phase 30 (P3): surfaced to the user immediately — a refused
        // tool call is not a detail, it is the reason a step failed.
        // `agentLevel` keeps it out of the step counter (Phase 29 fix).
        return {
          ...base,
          type: 'task:tool-error',
          message: `Tool "${event.toolName}" failed: ${event.error}`,
          payload: { agentLevel: true, toolName: event.toolName, callId: event.callId },
        };

      case 'agent:completed':
        return {
          ...base,
          type: 'plan:step-completed',
          message: `Agent "${event.agentId}" completed. ${event.toolsUsed.length} tool(s) used.`,
          payload: {
            agentLevel: true,
            toolsUsed: event.toolsUsed,
            usage: event.usage,
          },
        };

      case 'agent:error':
        return {
          ...base,
          type: 'plan:step-failed',
          message: `Agent "${event.agentId}" failed: ${event.error.slice(0, 100)}`,
          payload: { agentLevel: true, code: event.code },
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
