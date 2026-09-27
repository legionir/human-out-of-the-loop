import { randomUUID } from 'node:crypto';
import { EventBus, type AgentEvent } from './event-bus.js';
import { AgentRuntime, type AgentRunResult } from './agent-runtime.js';
import type { ThoughtSink } from './thought-stream.js';
import type { ToolCallLogOptions, ToolCallSink } from './tool-call-log.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import { createTaskRecord, type Task, type TaskStatus } from '../schemas/task.js';

// ─── Types ────────────────────────────────────────────────────────

export interface TaskRuntimeConfig {
  /** Maximum number of tasks running concurrently (default: 5) */
  maxConcurrentTasks: number;
  /**
   * EventBus instance.
   * Phase 19 (SING-01): now REQUIRED — no global fallback, so events
   * stay isolated per Orchestrator.
   */
  eventBus: EventBus;
  /**
   * AgentRuntime instance.  Phase 19 (SING-02): when omitted a FRESH
   * `new AgentRuntime()` is created (never the shared singleton).
   */
  agentRuntime?: AgentRuntime;
  /**
   * Phase 19 (CFG-05): per-agent timeout in ms, forwarded to every
   * `AgentRuntime.run()` call.  Sourced from
   * `OrchestratorConfig.agentTimeoutMs`.
   */
  agentTimeoutMs?: number;
  /**
   * U3: max tool-call iterations per agent run.  Sourced from
   * `OrchestratorConfig.maxSteps` — BEFORE U3 this config value was
   * never wired to the runtime (AgentRuntime silently used its own
   * default); now it actually applies.
   */
  maxSteps?: number;
  /**
   * Phase 32: default sink for the model's thinking text, forwarded to
   * every `AgentRuntime.run()` call that does not carry its own.  When it
   * is absent, agent turns use the non-streaming call exactly as before.
   */
  onThought?: ThoughtSink;
  /**
   * v27.17.3: default sink for structured tool-call records, forwarded to
   * every `AgentRuntime.run()` call that does not carry its own.
   */
  onToolCall?: ToolCallSink;
  /** v27.17.3: category resolver + secrets for those records. */
  toolCallOptions?: ToolCallLogOptions;
  /** C-09: max retained task records (default 500). */
  maxTaskRecords?: number;
}

export interface CreateTaskOptions {
  /** Resolved agent ready for execution */
  agent: ResolvedAgent;
  /** The prompt to execute */
  prompt: string;
  /** Resources this task will touch (for lock management) */
  claimedResources?: string[];
  /** Optional plan step id (Phase 10) */
  planStepId?: string;
  /** Phase 20 (CORR-03): owning plan id (for usage aggregation) */
  planId?: string;
  /**
   * U3: per-run overrides (from `Orchestrator.run({ runOverrides })`).
   * Fall back to the runtime's own config values when absent.
   */
  agentTimeoutMs?: number;
  maxSteps?: number;
  /**
   * Phase 32: per-task thinking sink (wins over `TaskRuntimeConfig.onThought`).
   */
  onThought?: ThoughtSink;
  /** v27.17.3: per-task tool-call sink (wins over the runtime default). */
  onToolCall?: ToolCallSink;
  /** C-03/C-07: parent task that spawned this one (delegate_task). */
  parentTaskId?: string;
}

/**
 * C-01: longest a timed-out task keeps its locks while its abandoned work
 * settles.  Past this, the work is assumed dead and the locks are freed.
 */
export const LINGER_RELEASE_MS = 30_000;

// ─── Resource Lock Manager ───────────────────────────────────────

/**
 * Manages exclusive resource claims to prevent race conditions
 * when multiple tasks try to modify the same files.
 *
 * Strategy:
 *   - Each task declares `claimedResources` (e.g. file paths) at creation.
 *   - Before a task transitions from `pending` → `running`, the lock
 *     manager checks for overlap with currently-running tasks.
 *   - If overlap exists, the task stays `pending` (queued).
 *   - When a task completes/fails, its resources are released and
 *     queued tasks are re-evaluated.
 *
 * This is a simple in-memory lock — sufficient for single-process
 * Node.js.  For multi-process, upgrade to Redis/file-based locks.
 */
class ResourceLockManager {
  /** Map from resource path → taskId that currently holds the lock */
  private readonly locks = new Map<string, string>();

  /**
   * Try to acquire locks for all claimed resources.
   * Returns true if ALL resources were acquired, false if any conflict.
   */
  tryAcquire(taskId: string, resources: string[]): boolean {
    // Check for conflicts first (all-or-nothing)
    for (const resource of resources) {
      const holder = this.locks.get(resource);
      if (holder && holder !== taskId) {
        return false; // Conflict
      }
    }

    // No conflicts — acquire all
    for (const resource of resources) {
      this.locks.set(resource, taskId);
    }
    return true;
  }

  /**
   * Release all resources held by a task.
   */
  release(taskId: string): void {
    for (const [resource, holder] of this.locks.entries()) {
      if (holder === taskId) {
        this.locks.delete(resource);
      }
    }
  }

  /**
   * Check if a task's resources conflict with any running task.
   */
  hasConflict(taskId: string, resources: string[]): boolean {
    for (const resource of resources) {
      const holder = this.locks.get(resource);
      if (holder && holder !== taskId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the set of currently locked resources (for diagnostics).
   */
  getLockedResources(): ReadonlyMap<string, string> {
    return this.locks;
  }
}

// ─── TaskRuntime ─────────────────────────────────────────────────

/**
 * Manages the lifecycle of tasks: creation, scheduling, execution,
 * and status tracking.
 *
 * Key responsibilities:
 *   1. **Concurrency cap**: never runs more than `maxConcurrentTasks`
 *      simultaneously.  Excess tasks queue as `pending`.
 *   2. **Resource locking**: tasks with overlapping `claimedResources`
 *      are serialized to prevent race conditions.
 *   3. **Event-driven status sync**: subscribes to EventBus events
 *      from AgentRuntime to keep task status up to date.
 *   4. **Four control tools**: exposes `create_task`, `get_agent_status`,
 *      `get_agent_result`, `get_task_details` for Main Agent use.
 *
 * Law 17 compliance: once tasks are created, they execute to
 * completion (or failure) without human intervention.
 */
export class TaskRuntime {
  private readonly tasks = new Map<string, Task>();
  private readonly agents = new Map<string, ResolvedAgent>();
  private readonly lockManager = new ResourceLockManager();
  private readonly maxConcurrentTasks: number;
  private readonly agentTimeoutMs?: number;
  private readonly maxSteps?: number;
  /** Phase 32: default thinking sink for every task of this runtime. */
  private readonly onThought?: ThoughtSink;
  /** v27.17.3: default sink for structured tool-call records. */
  private readonly onToolCall?: ToolCallSink;
  /** v27.17.3: how those records resolve a tool's type, and what to redact. */
  private readonly toolCallOptions?: ToolCallLogOptions;
  private readonly eventBus: EventBus;
  /** U3: per-task execution overrides (runOverrides from Orchestrator.run). */
  private readonly taskOverrides = new Map<
    string,
    Pick<CreateTaskOptions, 'agentTimeoutMs' | 'maxSteps' | 'onThought' | 'onToolCall'>
  >();
  private readonly runtime: AgentRuntime;
  private readonly runningPromises = new Map<string, Promise<AgentRunResult>>();
  // Phase 21 (PERF-03): O(1) count helpers + O(k) pending iteration.
  // Maintained at every status transition — no tasks.values() scans.
  private readonly pendingIds = new Set<string>();
  private readonly runningIds = new Set<string>();
  // Phase 22: per-task abort controllers — cancelTask on a RUNNING task
  // now truly aborts the in-flight generateText (not just bookkeeping).
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly children = new Map<string, Set<string>>();
  /**
   * C-07: parents blocked in `delegate_task` waiting for their child.  They
   * lend their concurrency slot to the child — otherwise N parents that all
   * delegate at once fill every slot and no child can ever start.
   */
  private readonly suspendedParents = new Set<string>();
  /** Waiters for the next task state change (start, finish, cancel). */
  private changeWaiters: Array<() => void> = [];
  /** C-01: lock releases waiting for a timed-out task's work to settle. */
  private readonly lingering = new Set<Promise<void>>();
  private readonly completedOrder: string[] = [];
  private readonly maxTaskRecords: number;
  private unsubscribeFn?: () => void;

  constructor(config: Pick<TaskRuntimeConfig, 'eventBus'> & Partial<TaskRuntimeConfig>) {
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 5;
    this.maxTaskRecords = config.maxTaskRecords ?? 500;
    this.agentTimeoutMs = config.agentTimeoutMs;
    this.maxSteps = config.maxSteps;
    this.onThought = config.onThought;
    this.onToolCall = config.onToolCall;
    this.toolCallOptions = config.toolCallOptions;
    this.eventBus = config.eventBus;
    this.runtime = config.agentRuntime ?? new AgentRuntime();

    // Subscribe to agent events for status sync
    this.unsubscribeFn = this.eventBus.subscribe('*', (event) =>
      this.handleAgentEvent(event)
    );
  }

  // ── Task creation ─────────────────────────────────────────────

  /**
   * Create a new task and schedule it for execution.
   * Returns the task id immediately; execution happens asynchronously.
   */
  createTask(options: CreateTaskOptions): string {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const task = createTaskRecord({
      id: taskId,
      agentDefinitionOrId: options.agent.agentId,
      prompt: options.prompt,
      claimedResources: options.claimedResources,
      planStepId: options.planStepId,
      planId: options.planId,
      parentTaskId: options.parentTaskId,
    });

    this.tasks.set(taskId, task);
    this.agents.set(taskId, options.agent);
    this.pendingIds.add(taskId);
    if (options.parentTaskId) {
      const set = this.children.get(options.parentTaskId) ?? new Set<string>();
      set.add(taskId);
      this.children.set(options.parentTaskId, set);
    }

    // U3: remember per-run execution overrides for this task
    if (
      options.agentTimeoutMs !== undefined ||
      options.maxSteps !== undefined ||
      options.onThought !== undefined ||
      options.onToolCall !== undefined
    ) {
      this.taskOverrides.set(taskId, {
        agentTimeoutMs: options.agentTimeoutMs,
        maxSteps: options.maxSteps,
        ...(options.onThought !== undefined ? { onThought: options.onThought } : {}),
        ...(options.onToolCall !== undefined ? { onToolCall: options.onToolCall } : {}),
      });
    }

    // Try to start immediately (respecting concurrency + locks)
    this.scheduleNext();

    return taskId;
  }

  // ── Status queries ────────────────────────────────────────────

  getStatus(taskId: string): { status: TaskStatus; summary?: string } | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return { status: task.status, summary: task.summary };
  }

  getResult(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getDetails(taskId: string): Task | undefined {
    // In Phase 14 this would pull from persistent storage.
    // For now, returns the full in-memory task record.
    return this.tasks.get(taskId);
  }

  getAllTasks(): ReadonlyArray<Task> {
    return Array.from(this.tasks.values());
  }

  /** Resolve every `nextChange()` waiter — a task started, ended or was cancelled. */
  private notifyChange(): void {
    const waiters = this.changeWaiters;
    this.changeWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves on the next task state change (replaces fixed-interval polling). */
  private nextChange(): Promise<void> {
    return new Promise((resolve) => this.changeWaiters.push(resolve));
  }

  getRunningCount(): number {
    return this.runningIds.size;
  }

  /** Running tasks that hold a slot (a parent waiting on its child does not). */
  private activeSlotCount(): number {
    let suspended = 0;
    for (const id of this.suspendedParents) if (this.runningIds.has(id)) suspended += 1;
    return this.runningIds.size - suspended;
  }

  getPendingCount(): number {
    return this.pendingIds.size;
  }

  // ── Scheduling ────────────────────────────────────────────────

  /**
   * Try to start pending tasks up to the concurrency limit,
   * respecting resource locks.
   */
  private scheduleNext(): void {
    const before = this.runningIds.size;
    this.startPending();
    if (this.runningIds.size !== before) this.notifyChange();
  }

  private startPending(): void {
    const availableSlots = this.maxConcurrentTasks - this.activeSlotCount();

    if (availableSlots <= 0) return;

    const pendingTasks: Task[] = [];
    for (const id of this.pendingIds) {
      // Phase 21 (PERF-03): iterate the pending index, not the whole map
      const task = this.tasks.get(id);
      if (task && task.status === 'pending') pendingTasks.push(task);
    }

    let started = 0;
    for (const task of pendingTasks) {
      if (started >= availableSlots) break;

      // Check resource locks
      if (
        task.claimedResources.length > 0 &&
        this.lockManager.hasConflict(task.id, task.claimedResources)
      ) {
        continue; // Stay pending — resource conflict
      }

      // Acquire locks and start
      if (task.claimedResources.length > 0) {
        this.lockManager.tryAcquire(task.id, task.claimedResources);
      }

      task.status = 'running';
      task.startedAt = Date.now();
      this.pendingIds.delete(task.id);
      this.runningIds.add(task.id);
      started++;

      // Fire-and-forget execution
      const agent = this.agents.get(task.id);
      if (agent) {
        // Phase 22: every running task gets its own AbortController so
        // cancelTask can truly abort the in-flight model call.
        const controller = new AbortController();
        this.abortControllers.set(task.id, controller);
        // U3: per-run overrides (Orchestrator.run runOverrides) win over
        // the runtime-level config; the maxSteps config value is wired for
        // the first time here (previously ignored — see TaskRuntimeConfig).
        const overrides = this.taskOverrides.get(task.id) ?? {};
        const timeoutMs = overrides.agentTimeoutMs ?? this.agentTimeoutMs;
        const maxSteps = overrides.maxSteps ?? this.maxSteps;
        // Phase 32: live thinking text (per-task sink wins over the default).
        const onThought = overrides.onThought ?? this.onThought;
        const onToolCall = overrides.onToolCall ?? this.onToolCall;
        this.taskOverrides.delete(task.id);
        const promise = this.runtime
          .run({
            agent,
            taskId: task.id,
            prompt: task.prompt,
            eventBus: this.eventBus,
            signal: controller.signal,
            // Phase 19 (CFG-05): the configured agent timeout actually applies
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            // U3: max tool-call iterations (config or per-run override)
            ...(maxSteps !== undefined ? { maxSteps } : {}),
            // Phase 20 (CORR-03/05): carry plan context on emitted events
            ...(task.planId !== undefined ? { planId: task.planId } : {}),
            ...(task.planStepId !== undefined ? { planStepId: task.planStepId } : {}),
            // Phase 32: none/undefined keeps the turn non-streaming
            ...(onThought ? { onThought } : {}),
            // v27.17.3: structured tool-call records for this step
            ...(onToolCall ? { onToolCall } : {}),
            ...(this.toolCallOptions ? { toolCallOptions: this.toolCallOptions } : {}),
          })
          .then((result) => {
            this.handleRunResult(task.id, result);
            return result;
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            const failed: AgentRunResult = {
              taskId: task.id,
              agentId: agent.agentId,
              success: false,
              summary: `Agent execution failed: ${message}`,
              result: '',
              toolsUsed: [],
              errors: [message],
              failureType: 'technical',
            };
            this.handleRunResult(task.id, failed);
            return failed;
          });
        this.runningPromises.set(task.id, promise);
      }
    }
  }

  // ── Event handling ────────────────────────────────────────────

  private handleAgentEvent(event: AgentEvent): void {
    const task = this.tasks.get(event.taskId);
    if (!task) return;

    switch (event.type) {
      case 'agent:running':
        task.status = 'running';
        task.startedAt = event.timestamp;
        break;
      case 'agent:completed':
        // Status update happens in handleRunResult for consistency
        break;
      case 'agent:error':
        // Status update happens in handleRunResult for consistency
        break;
    }
  }

  private handleRunResult(taskId: string, result: AgentRunResult): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.runningPromises.delete(taskId);
    // C-01: a run that timed out may still have a tool writing to the
    // claimed resources; keep the lock and the concurrency slot until that
    // work settles (bounded, so a call that never ends cannot wedge them).
    if (result.settled) {
      const release = (): void => {
        if (!this.runningIds.has(taskId)) return;
        this.lockManager.release(taskId);
        this.runningIds.delete(taskId);
        this.scheduleNext();
        this.notifyChange();
      };
      let cap: ReturnType<typeof setTimeout> | undefined;
      const lingering: Promise<void> = new Promise<void>((resolve) => {
        cap = setTimeout(resolve, LINGER_RELEASE_MS);
        cap.unref?.();
        void result.settled!.then(resolve);
      }).then(() => {
        if (cap) clearTimeout(cap);
        this.lingering.delete(lingering);
        release();
      });
      this.lingering.add(lingering);
    } else {
      this.lockManager.release(taskId);
      this.runningIds.delete(taskId);
    }
    // Phase 22: drop the (now settable) controller
    this.abortControllers.delete(taskId);

    // Phase 22: a task cancelled by the user is ALREADY in its final
    // state — the aborted run's failure result must not overwrite it.
    if (task.status !== 'cancelled') {
      if (result.success) {
        task.status = 'completed';
        task.summary = result.summary;
        task.result = result.result;
        task.usage = result.usage;
        // Phase 30 (P3): a successful agent run can still contain failed
        // tool calls (e.g. a write refused by the workspace sandbox).
        // They are kept on the task so the acceptance check and
        // `hootl tasks show` see them.
        task.errors = result.errors;
      } else {
        task.status = 'failed';
        task.summary = result.summary;
        task.errors = result.errors;
        task.failureType = result.failureType ?? 'technical';
        if (result.usage) task.usage = result.usage;
      }
    } else if (result.usage && !task.usage) {
      task.usage = result.usage;
    }
    task.completedAt = Date.now();

    this.pruneTaskMaps(taskId);

    // Try to start queued tasks now that a slot is free
    this.scheduleNext();
    this.notifyChange();
  }

  private pruneTaskMaps(taskId: string): void {
    this.agents.delete(taskId);
    this.taskOverrides.delete(taskId);
    this.abortControllers.delete(taskId);
    this.runningPromises.delete(taskId);
    this.completedOrder.push(taskId);
    while (this.completedOrder.length > this.maxTaskRecords) {
      const old = this.completedOrder.shift();
      if (!old) break;
      if (this.runningIds.has(old) || this.pendingIds.has(old)) continue;
      this.tasks.delete(old);
      this.children.delete(old);
    }
  }

  /** Test/diagnostics: sizes of internal maps. */
  debugMapSizes(): { tasks: number; agents: number; taskOverrides: number } {
    return {
      tasks: this.tasks.size,
      agents: this.agents.size,
      taskOverrides: this.taskOverrides.size,
    };
  }

  isResourceHeld(resource: string): boolean {
    return this.lockManager.getLockedResources().has(resource);
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /**
   * Wait for all running tasks to complete.
   * Useful for graceful shutdown and testing.
   * Loops until no pending or running tasks remain (handles queued tasks that start after others complete).
   */
  /**
   * B-14: resolve as soon as ANY of `taskIds` is terminal so the plan
   * loop can persist that step without waiting for the rest of the wave.
   */
  async waitForAny(taskIds: string[]): Promise<void> {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    const ids = taskIds.filter(Boolean);
    if (ids.length === 0) return;
    while (true) {
      let anyRunning = false;
      for (const id of ids) {
        const task = this.tasks.get(id);
        if (task && terminal.has(task.status)) return;
        if (this.runningPromises.has(id) || task?.status === 'running' || task?.status === 'pending') {
          anyRunning = true;
        }
      }
      if (!anyRunning) return;
      const promises = ids
        .map((id) => this.runningPromises.get(id))
        .filter((p): p is Promise<AgentRunResult> => p !== undefined);
      if (promises.length === 0) {
        await this.nextChange();
        continue;
      }
      await Promise.race(promises);
    }
  }

  async waitForAll(): Promise<void> {
    // Loop until quiescent — pending tasks may become running after each batch completes
    while (true) {
      const promises = Array.from(this.runningPromises.values());
      if (promises.length === 0) {
        // No running tasks — check if any pending remain that could be scheduled
        if (this.getPendingCount() === 0) break;
        // A pending task may be waiting for a timed-out task's lock.
        if (this.lingering.size > 0) {
          await Promise.race(this.lingering);
          continue;
        }
        // Pending exists but not running (maybe blocked) — try scheduling and wait a tick
        this.scheduleNext();
        if (this.runningPromises.size === 0 && this.getPendingCount() > 0) {
          // Deadlock: pending tasks cannot proceed (resource conflict with no holder? shouldn't happen)
          // Break to avoid infinite loop
          break;
        }
        continue;
      }
      await Promise.allSettled(promises);
      // After batch completes, scheduleNext is called in handleRunResult, so loop again
    }
  }

  /** C-08: wait only for tasks belonging to one plan. */
  async waitFor(planId: string): Promise<void> {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    for (;;) {
      const inflight: Promise<AgentRunResult>[] = [];
      let pending = false;
      for (const [id, task] of this.tasks) {
        if (task.planId !== planId) continue;
        if (terminal.has(task.status)) continue;
        const p = this.runningPromises.get(id);
        if (p) inflight.push(p);
        else if (task.status === 'pending' || task.status === 'running') pending = true;
      }
      if (inflight.length === 0 && !pending) return;
      if (inflight.length === 0) {
        await this.nextChange();
        continue;
      }
      await Promise.allSettled(inflight);
    }
  }

  async waitForTask(taskId: string, parentTaskId?: string): Promise<Task | undefined> {
    const lend = parentTaskId !== undefined && this.runningIds.has(parentTaskId);
    if (lend) {
      this.suspendedParents.add(parentTaskId);
      this.scheduleNext();
    }
    try {
      return await this.waitForTaskSettled(taskId);
    } finally {
      if (lend) this.suspendedParents.delete(parentTaskId);
    }
  }

  private async waitForTaskSettled(taskId: string): Promise<Task | undefined> {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    for (;;) {
      const task = this.tasks.get(taskId);
      if (!task) return undefined;
      if (terminal.has(task.status)) return task;
      const p = this.runningPromises.get(taskId);
      if (p) {
        await p.then(
          () => undefined,
          () => undefined
        );
        continue;
      }
      await this.nextChange();
    }
  }

  /**
   * Cancel a pending or running task.
   * Phase 13 extends this with full cancellation support.
   */
  cancelTask(taskId: string): boolean {
    const cancelled = this.cancelTaskInner(taskId);
    if (cancelled) this.notifyChange();
    return cancelled;
  }

  private cancelTaskInner(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.pendingIds.delete(taskId);
      for (const child of this.children.get(taskId) ?? []) {
        this.cancelTask(child);
      }
      return true;
    }

    if (task.status === 'running') {
      // Phase 22: REAL cancellation — abort the in-flight model call.
      // C-01: do NOT release the resource lock or the concurrency slot
      // here — handleRunResult does that when executionPromise settles.
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.abortControllers.get(taskId)?.abort();
      for (const child of this.children.get(taskId) ?? []) {
        this.cancelTask(child);
      }
      return true;
    }

    for (const child of this.children.get(taskId) ?? []) {
      this.cancelTask(child);
    }
    return false; // Already completed/failed/cancelled
  }

  destroy(): void {
    this.unsubscribeFn?.();
  }
}
