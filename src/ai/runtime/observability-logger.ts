import fs from 'node:fs';
import {
  collectSecretValues as _collectSecretValues,
  scrubSecretValues,
  SECRET_NAME_PATTERNS,
  MIN_REDACT_VALUE_LENGTH,
} from './secret-scrub.js';
import path from 'node:path';
import type { AgentEvent, TokenUsage } from './event-bus.js';
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
    | 'plan:clarified'
    | 'plan:confirmed'
    | 'plan:started'
    | 'plan:completed'
    | 'plan:failed'
    | 'plan:cancelled'
    | 'plan:replanning'
    | 'plan:replanned'
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
    | 'task:tool-error'
    | 'task:interrupted'
    | 'llm:usage'
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
  /**
   * Phase 30 (P10): literal secret VALUES to scrub from every entry
   * (API keys, MCP tokens).  `redactKeys` matches field NAMES; a model
   * can echo a value it read from the project into its summary, and the
   * summary is written to the log — so values must be scrubbed too.
   */
  redactValues?: string[];
  /** C-11: rotate the JSONL file when it exceeds this many bytes (default 10 MiB). */
  maxLogBytes?: number;
}

// ─── Default redaction keys ──────────────────────────────────────

/** Field NAMES whose values are always redacted (P10 adds value scrubbing). */
const DEFAULT_REDACT_KEYS = SECRET_NAME_PATTERNS;
export { _collectSecretValues as collectSecretValues };

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
 *   3. **Credential redaction**: every payload key matching the
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
  /** Phase 30 (P10): literal secret values scrubbed from entries. */
  private readonly redactValues: string[];
  private unsubscribeFn?: () => void;
  private readonly maxLogBytes: number;
  /**
   * Phase 21 (PERF-04): the log file descriptor, opened ONCE and
   * reused for every entry.  `fs.appendFileSync` does open+write+close
   * (3 syscalls) per line; `openSync` + `writeSync` reduces that to a
   * single write syscall per entry while keeping synchronous durability
   * (a crash right after `log()` still finds the entry on disk).
   */
  private logFd: number | null = null;
  /** Inode of the file behind `logFd` — detects a deleted/replaced log file. */
  private logIno: number | null = null;

  constructor(config: ObservabilityLoggerConfig) {
    this.logFilePath = config.logFilePath;
    this.consoleOutput = config.consoleOutput ?? false;
    this.redactKeys = new Set(config.redactKeys ?? DEFAULT_REDACT_KEYS);
    // Longest first: a token that contains a shorter one is scrubbed whole.
    this.redactValues = (config.redactValues ?? [])
      .filter((v) => typeof v === 'string' && v.length >= MIN_REDACT_VALUE_LENGTH)
      .sort((a, b) => b.length - a.length);
    this.maxLogBytes = config.maxLogBytes ?? 10 * 1024 * 1024;

    // Ensure the log directory exists
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
  }

  private ensureFd(): number {
    if (this.logFd !== null) {
      // Phase 30 (P9): the log file can be deleted (or replaced) under a
      // long-running process — e.g. `rm -rf .ai-runtime` while the web
      // server is running.  A write to the old fd would land in an
      // unlinked inode and vanish, so reopen whenever the path no longer
      // points at the same file.  One `stat` per entry buys durability;
      // the file is still opened once per file (PERF-04).
      let ino: number | undefined;
      try {
        ino = fs.statSync(this.logFilePath).ino;
      } catch {
        ino = undefined; // deleted, or the whole directory is gone
      }
      if (ino !== undefined && ino === this.logIno) return this.logFd;
      this.close();
    }
    // Recreate the directory too: the file may have gone with it.
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    this.logFd = fs.openSync(this.logFilePath, 'a');
    this.logIno = fs.fstatSync(this.logFd).ino;
    return this.logFd;
  }

  /**
   * Close the underlying file descriptor (flush + release the fd).
   * Safe to call multiple times; call during Orchestrator shutdown.
   */
  get isOpen(): boolean {
    return this.logFd !== null;
  }

  private rotateIfNeeded(): void {
    if (this.maxLogBytes <= 0) return;
    let size = 0;
    try {
      size = fs.existsSync(this.logFilePath) ? fs.statSync(this.logFilePath).size : 0;
    } catch {
      return;
    }
    if (size < this.maxLogBytes) return;
    this.close();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = `${this.logFilePath}.${stamp}`;
    try {
      fs.renameSync(this.logFilePath, rotated);
    } catch {
      // if rename fails, keep appending
    }
  }

  close(): void {
    if (this.logFd !== null) {
      try {
        fs.closeSync(this.logFd);
      } catch {
        // best-effort close
      }
      this.logFd = null;
      this.logIno = null;
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
      message: this.scrubValues(entry.message),
      payload: entry.payload
        ? this.scrubValues(this.redactPayload(entry.payload))
        : undefined,
    };

    const line = JSON.stringify(fullEntry) + '\n';

    try {
      this.rotateIfNeeded();
      // Phase 21 (PERF-04): single write syscall on a reused fd
      fs.writeSync(this.ensureFd(), line, null, 'utf-8');
    } catch {
      // Phase 22: best-effort and SILENT — the log file is the only
      // durable sink and a write failure must never crash the run.
      // (The runtime must not use the console API; the Orchestrator's
      // own failures surface through its callbacks / the review.)
    }

    if (this.consoleOutput) {
      // Phase 22: the configured console-output mode writes straight to
      // stdout — this is an explicit user-facing output channel, not
      // observability, but it must not use the console API either.
      const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌' }[fullEntry.level];
      process.stdout.write(
        `${prefix} [${fullEntry.timestamp}] ${fullEntry.eventType}: ${fullEntry.message}\n`
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
    const abandoned = plan.steps.length - done;
    // Phase 30 (P7): a plan that ends `failed-partial` (or cancelled) is NOT a
    // completion — logging it as `plan:completed` ("Plan completed. 11/12
    // steps done.") told the JSONL reader the opposite of the truth.
    const eventType =
      plan.status === 'cancelled'
        ? 'plan:cancelled'
        : plan.status === 'failed-partial'
          ? 'plan:failed'
          : 'plan:completed';
    this.log({
      planId: plan.id,
      eventType,
      message: `Plan ${plan.status}. ${done}/${plan.steps.length} steps done.`,
      level: plan.status === 'completed' ? 'info' : 'warn',
      payload: { completedSteps: done, totalSteps: plan.steps.length, abandonedSteps: abandoned },
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

  /**
   * Phase 30 (P7): the plan was actually revised by a re-planning attempt.
   * `logPlanReplanning` (below) records the ATTEMPT; this records the RESULT,
   * including the steps that were abandoned and are kept in the plan.
   */
  logPlanReplanned(plan: Plan): void {
    const done = plan.steps.filter((s) => s.status === 'done').length;
    const abandoned = plan.steps.filter((s) => s.status === 'failed').length;
    this.log({
      planId: plan.id,
      eventType: 'plan:replanned',
      message:
        `Plan revised: ${plan.steps.length} step(s) — ${done} done, ` +
        `${abandoned} abandoned step(s) kept in the plan.`,
      level: 'warn',
      payload: { totalSteps: plan.steps.length, completedSteps: done, abandonedSteps: abandoned },
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

  /**
   * Token usage of a structured model call (planning, acceptance, review).
   * Agent turns are logged as `task:completed`; `hootl usage` sums both.
   */
  logLlmUsage(purpose: string, usage: TokenUsage, planId?: string): void {
    this.log({
      planId,
      eventType: 'llm:usage',
      message: `${purpose} call used ${usage.totalTokens} tokens.`,
      level: 'info',
      payload: { purpose, usage },
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
          // C2: task events must carry planId/stepId so per-plan
          // filtering (CLI `tasks --plan`, usage fallback) works.
          planId: event.planId,
          stepId: event.planStepId,
          eventType: 'task:created',
          message: `Agent "${event.agentId}" started for task "${event.taskId}".`,
          level: 'info',
        });
        break;
      case 'agent:tool_call':
        this.log({
          taskId: event.taskId,
          planId: event.planId,
          stepId: event.planStepId,
          eventType: 'task:tool-call',
          message: `Tool "${event.toolName}" called by "${event.agentId}".`,
          level: 'info',
          payload: { toolName: event.toolName, callId: event.callId },
        });
        break;
      case 'agent:completed':
        this.log({
          taskId: event.taskId,
          planId: event.planId,
          stepId: event.planStepId,
          eventType: 'task:completed',
          message: `Task "${event.taskId}" completed. ${event.toolsUsed.length} tools used.`,
          level: 'info',
          payload: {
            toolsUsed: event.toolsUsed,
            usage: event.usage,
          },
        });
        break;
      case 'agent:tool_error':
        // Phase 30 (P3): a refused/failed tool call is a first-class
        // event — previously it left no trace anywhere in the log.
        this.log({
          taskId: event.taskId,
          planId: event.planId,
          stepId: event.planStepId,
          eventType: 'task:tool-error',
          message: `Tool "${event.toolName}" failed in "${event.agentId}": ${event.error}`,
          level: 'warn',
          payload: { toolName: event.toolName, callId: event.callId },
        });
        break;
      case 'agent:error':
        this.log({
          taskId: event.taskId,
          planId: event.planId,
          stepId: event.planStepId,
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
   * Phase 20 (SEC-04): a key is redacted when it CONTAINS any redaction
   * pattern (case-insensitive substring match) — previously exact match
   * only, so `myApiKey` / `dbToken` / `accessToken` leaked through.
   * Over-redaction is acceptable here (safer than leaking).
   */
  private isRedactedKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    for (const pattern of this.redactKeys) {
      if (lowerKey.includes(pattern.toLowerCase())) return true;
    }
    return false;
  }

  /**
   * Recursively redact sensitive keys from a payload object.
   */
  /** Replace every occurrence of a known secret value with the marker. */
  private scrubValues<T>(value: T): T {
    if (this.redactValues.length === 0) return value;
    if (typeof value === 'string') {
      return scrubSecretValues(value, this.redactValues) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.scrubValues(v)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.scrubValues(v);
      return out as T;
    }
    return value;
  }

  private redactPayload(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // Phase 29: numeric counters are metrics, not credentials —
      // `usage.totalTokens` / `promptTokens` matched the `token` pattern
      // and were destroyed in the log, which broke `hootl usage` and the
      // TOKENS column of `hootl tasks`.  Strings and objects are still
      // redacted eagerly (SEC-04 keeps its substring over-redaction).
      const isNumericMetric = typeof value === 'number' && /tokens$/i.test(key);
      if (this.isRedactedKey(key) && !isNumericMetric) {
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
