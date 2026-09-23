import { randomUUID } from 'node:crypto';
import { EventBus, type AgentEvent } from './event-bus.js';
import { AgentRuntime, type AgentRunResult } from './agent-runtime.js';
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
}

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
  private readonly eventBus: EventBus;
  private readonly runtime: AgentRuntime;
  private readonly runningPromises = new Map<string, Promise<AgentRunResult>>();
  private unsubscribeFn?: () => void;

  constructor(config: Pick<TaskRuntimeConfig, 'eventBus'> & Partial<TaskRuntimeConfig>) {
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 5;
    this.agentTimeoutMs = config.agentTimeoutMs;
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
    });

    this.tasks.set(taskId, task);
    this.agents.set(taskId, options.agent);

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

  getRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  getPendingCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') count++;
    }
    return count;
  }

  // ── Scheduling ────────────────────────────────────────────────

  /**
   * Try to start pending tasks up to the concurrency limit,
   * respecting resource locks.
   */
  private scheduleNext(): void {
    const runningCount = this.getRunningCount();
    const availableSlots = this.maxConcurrentTasks - runningCount;

    if (availableSlots <= 0) return;

    const pendingTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'pending'
    );

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
      started++;

      // Fire-and-forget execution
      const agent = this.agents.get(task.id);
      if (agent) {
        const promise = this.runtime
          .run({
            agent,
            taskId: task.id,
            prompt: task.prompt,
            eventBus: this.eventBus,
            // Phase 19 (CFG-05): the configured agent timeout actually applies
            ...(this.agentTimeoutMs !== undefined
              ? { timeoutMs: this.agentTimeoutMs }
              : {}),
            // Phase 20 (CORR-03/05): carry plan context on emitted events
            ...(task.planId !== undefined ? { planId: task.planId } : {}),
            ...(task.planStepId !== undefined ? { planStepId: task.planStepId } : {}),
          })
          .then((result) => {
            this.handleRunResult(task.id, result);
            return result;
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

    // Release resource locks
    this.lockManager.release(taskId);
    this.runningPromises.delete(taskId);

    if (result.success) {
      task.status = 'completed';
      task.summary = result.summary;
      task.result = result.result;
      task.usage = result.usage;
    } else {
      task.status = 'failed';
      task.summary = result.summary;
      task.errors = result.errors;
      task.failureType = result.failureType ?? 'technical';
    }
    task.completedAt = Date.now();

    // Try to start queued tasks now that a slot is free
    this.scheduleNext();
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /**
   * Wait for all running tasks to complete.
   * Useful for graceful shutdown and testing.
   * Loops until no pending or running tasks remain (handles queued tasks that start after others complete).
   */
  async waitForAll(): Promise<void> {
    // Loop until quiescent — pending tasks may become running after each batch completes
    while (true) {
      const promises = Array.from(this.runningPromises.values());
      if (promises.length === 0) {
        // No running tasks — check if any pending remain that could be scheduled
        if (this.getPendingCount() === 0) break;
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

  /**
   * Cancel a pending or running task.
   * Phase 13 extends this with full cancellation support.
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      return true;
    }

    if (task.status === 'running') {
      // In Phase 13 this will signal the AgentRuntime to abort.
      // For now, mark as cancelled and release locks.
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.lockManager.release(taskId);
      this.scheduleNext();
      return true;
    }

    return false; // Already completed/failed/cancelled
  }

  destroy(): void {
    this.unsubscribeFn?.();
  }
}
