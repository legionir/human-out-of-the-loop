import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from './event-bus.js';
import type { Plan, PlanStep } from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A single observability log entry.  Written as one JSON line
 * (JSONL format) for easy parsing by log aggregators.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unix epoch ms for sorting */
  epochMs: number;
  /** Plan id (if applicable) */
  planId?: string;
  /** Step id (if applicable) */
  stepId?: string;
  /** Task id (if applicable) */
  taskId?: string;
  /** Event category */
  eventType:
    | 'plan:created'
    | 'plan:confirmed'
    | 'plan:started'
    | 'plan:completed'
    | 'plan:failed'
    | 'plan:cancelled'
    | 'plan:replanning'
    | 'step:started'
    | 'step:completed'
    | 'step:failed'
    | 'step:quality-check'
    | 'step:quality-passed'
    | 'step:quality-failed'
    | 'task:created'
    | 'task:completed'
    | 'task:failed'
    | 'task:tool-call'
    | 'session:created'
    | 'session:interaction'
    | 'system:error'
    | 'system:info';
  /** Human-readable message */
  message: string;
  /** Structured payload (no credentials, no raw transcripts) */
  payload?: Record<string, unknown>;
  /** Log level */
  level: 'info' | 'warn' | 'error';
}

export interface ObservabilityLoggerConfig {
  /** Path to the JSONL log file */
  logFilePath: string;
  /** Whether to also write to console (default: false) */
  consoleOutput?: boolean;
  /**
   * Sensitive keys to redact from payloads.
   * Default: common credential field names.
   */
  redactKeys?: string[];
}

// ─── Default redaction keys ──────────────────────────────────────

const DEFAULT_REDACT_KEYS = [
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'authorization',
  'credential',
  'bearer',
  'cookie',
  'session_key',
];

// ─── ObservabilityLogger ─────────────────────────────────────────

/**
 * Persistent structured logger that writes all key events to a
 * JSONL file for post-execution analysis and debugging.
 *
 * Design decisions:
 *   1. **Append-only**: each entry is a single JSON line appended
 *      to the file.  No overwrites, no deletions.
 *   2. **Synchronous writes**: guarantees durability even if the
 *      process crashes immediately after.
 *   3. **Credential redaction**: any payload key matching the
 *      redact list is replaced with `"***REDACTED***"`.
 *   4. **No raw transcripts**: tool call arguments and results
 *      are never logged — only tool names and status.
 *   5. **EventBus integration**: can subscribe to the global
 *      EventBus to automatically log all agent events.
 */
export class ObservabilityLogger {
  private readonly logFilePath: string;
  private readonly consoleOutput: boolean;
  private readonly redactKeys: Set<string>;
  private unsubscribeFn?: () => void;

  constructor(config: ObservabilityLoggerConfig) {
    this.logFilePath = config.logFilePath;
    this.consoleOutput = config.consoleOutput ?? false;
    this.redactKeys = new Set(config.redactKeys ?? DEFAULT_REDACT_KEYS);

    // Ensure the log directory exists
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ── Core logging ──────────────────────────────────────────────

  /**
   * Write a single log entry.
   */
  log(entry: Omit<LogEntry, 'timestamp' | 'epochMs'>): void {
    const now = Date.now();
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: new Date(now).toISOString(),
      epochMs: now,
      payload: entry.payload ? this.redactPayload(entry.payload) : undefined,
    };

    const line = JSON.stringify(fullEntry) + '\n';

    try {
      fs.appendFileSync(this.logFilePath, line, 'utf-8');
    } catch (err) {
      // If we can't write to the log file, fall back to console
      console.error('[ObservabilityLogger] Failed to write log:', err);
    }

    if (this.consoleOutput) {
      const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌' }[fullEntry.level];
      console.log(
        `${prefix} [${fullEntry.timestamp}] ${fullEntry.eventType}: ${fullEntry.message}`
      );
    }
  }

  // ── Convenience methods ───────────────────────────────────────

  logPlanCreated(plan: Plan): void {
    this.log({
      planId: plan.id,
      eventType: 'plan:created',
      message: `Plan created with ${plan.steps.length} steps. Goal: ${plan.goal.slice(0, 100)}`,
      level: 'info',
      payload: {
        goal: plan.goal,
        stepCount: plan.steps.length,
        stepIds: plan.steps.map((s) => s.id),
      },
    });
  }

  logPlanStarted(plan: Plan): void {
    this.log({
      planId: plan.id,
      eventType: 'plan:started',
      message: `Plan execution started.`,
      level: 'info',
    });
  }

  logPlanCompleted(plan: Plan): void {
    const done = plan.steps.filter((s) => s.status === 'done').length;
    this.log({
      planId: plan.id,
      eventType: 'plan:completed',
      message: `Plan completed. ${done}/${plan.steps.length} steps done.`,
      level: 'info',
      payload: { completedSteps: done, totalSteps: plan.steps.length },
    });
  }

  logPlanFailed(plan: Plan, reason: string): void {
    this.log({
      planId: plan.id,
      eventType: 'plan:failed',
      message: `Plan failed: ${reason}`,
      level: 'error',
      payload: { reason },
    });
  }

  logPlanReplanning(plan: Plan, attempt: number): void {
    this.log({
      planId: plan.id,
      eventType: 'plan:replanning',
      message: `Re-planning attempt ${attempt}.`,
      level: 'warn',
      payload: { attempt },
    });
  }

  logStepStarted(planId: string, step: PlanStep): void {
    this.log({
      planId,
      stepId: step.id,
      eventType: 'step:started',
      message: `Step "${step.id}" started (persona: ${step.assignedPersona}).`,
      level: 'info',
      payload: {
        description: step.description.slice(0, 200),
        persona: step.assignedPersona,
        tools: step.assignedTools,
      },
    });
  }

  logStepCompleted(planId: string, step: PlanStep): void {
    this.log({
      planId,
      stepId: step.id,
      eventType: 'step:completed',
      message: `Step "${step.id}" completed.`,
      level: 'info',
      payload: { resultSummary: (step.resultSummary ?? '').slice(0, 300) },
    });
  }

  logStepFailed(planId: string, step: PlanStep): void {
    this.log({
      planId,
      stepId: step.id,
      eventType: 'step:failed',
      message: `Step "${step.id}" failed (${step.failureType ?? 'unknown'}).`,
      level: 'error',
      payload: {
        failureType: step.failureType,
        resultSummary: (step.resultSummary ?? '').slice(0, 300),
      },
    });
  }

  logQualityCheck(planId: string, stepId: string, accepted: boolean, reason: string): void {
    this.log({
      planId,
      stepId,
      eventType: accepted ? 'step:quality-passed' : 'step:quality-failed',
      message: `Quality check ${accepted ? 'PASSED' : 'FAILED'} for step "${stepId}": ${reason}`,
      level: accepted ? 'info' : 'warn',
      payload: { accepted, reason: reason.slice(0, 300) },
    });
  }

  logSessionCreated(sessionId: string): void {
    this.log({
      eventType: 'session:created',
      message: `Session "${sessionId}" created.`,
      level: 'info',
    });
  }

  logSystemError(context: string, error: string): void {
    this.log({
      eventType: 'system:error',
      message: `[${context}] ${error}`,
      level: 'error',
      payload: { context, error: error.slice(0, 500) },
    });
  }

  // ── EventBus integration ──────────────────────────────────────

  /**
   * Subscribe to an EventBus and automatically log all agent events.
   */
  subscribeToEventBus(eventBus: import('./event-bus.js').EventBus): void {
    this.unsubscribeFn = eventBus.subscribe('*', (event: AgentEvent) => {
      this.logAgentEvent(event);
    });
  }

  unsubscribeFromEventBus(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = undefined;
  }

  private logAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent:running':
        this.log({
          taskId: event.taskId,
          eventType: 'task:created',
          message: `Agent "${event.agentId}" started for task "${event.taskId}".`,
          level: 'info',
        });
        break;
      case 'agent:tool_call':
        this.log({
          taskId: event.taskId,
          eventType: 'task:tool-call',
          message: `Tool "${event.toolName}" called by "${event.agentId}".`,
          level: 'info',
          payload: { toolName: event.toolName, callId: event.callId },
        });
        break;
      case 'agent:completed':
        this.log({
          taskId: event.taskId,
          eventType: 'task:completed',
          message: `Task "${event.taskId}" completed. ${event.toolsUsed.length} tools used.`,
          level: 'info',
          payload: {
            toolsUsed: event.toolsUsed,
            usage: event.usage,
          },
        });
        break;
      case 'agent:error':
        this.log({
          taskId: event.taskId,
          eventType: 'task:failed',
          message: `Task "${event.taskId}" failed: ${event.error.slice(0, 200)}`,
          level: 'error',
          payload: { code: event.code },
        });
        break;
    }
  }

  // ── Reading logs ──────────────────────────────────────────────

  /**
   * Read all log entries from the file.  Useful for post-execution
   * analysis and testing.
   */
  readAll(): LogEntry[] {
    if (!fs.existsSync(this.logFilePath)) return [];

    const content = fs.readFileSync(this.logFilePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LogEntry => e !== null);
  }

  /**
   * Read log entries for a specific plan.
   */
  readForPlan(planId: string): LogEntry[] {
    return this.readAll().filter((e) => e.planId === planId);
  }

  /**
   * Read log entries for a specific step.
   */
  readForStep(planId: string, stepId: string): LogEntry[] {
    return this.readAll().filter(
      (e) => e.planId === planId && e.stepId === stepId
    );
  }

  // ── Private ───────────────────────────────────────────────────

  /**
   * Recursively redact sensitive keys from a payload object.
   */
  private redactPayload(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (this.redactKeys.has(lowerKey) || this.redactKeys.has(key)) {
        result[key] = '***REDACTED***';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redactPayload(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
