import type { PlanRuntime } from './plan-runtime.js';
import type { TaskRuntime } from './task-runtime.js';
import type { PlanStore } from './plan-store.js';

// ─── Types ────────────────────────────────────────────────────────

export interface CancellationResult {
  success: boolean;
  planId: string;
  previousStatus: string;
  newStatus: string;
  completedSteps: number;
  cancelledSteps: number;
  message: string;
}

// ─── CancellationManager ─────────────────────────────────────────

/**
 * Manages explicit plan cancellation (the ONLY permitted human
 * interaction after plan confirmation — Law 17).
 *
 * Cancellation flow:
 *   1. User calls `cancelPlan(planId)`.
 *   2. Plan status → "cancelling".
 *   3. PlanRuntime checks this at each iteration and stops
 *      dispatching new steps.
 *   4. Running tasks are allowed to finish (or timeout).
 *   5. Final status → "cancelled" with report of completed steps.
 */
export class CancellationManager {
  private readonly planStore: PlanStore;
  private readonly taskRuntime: TaskRuntime;
  private readonly activeRuntimes = new Map<string, PlanRuntime>();

  constructor(planStore: PlanStore, taskRuntime: TaskRuntime) {
    this.planStore = planStore;
    this.taskRuntime = taskRuntime;
  }

  /**
   * Register an active PlanRuntime so it can be signalled.
   */
  registerRuntime(planId: string, runtime: PlanRuntime): void {
    this.activeRuntimes.set(planId, runtime);
  }

  /**
   * Unregister when the plan finishes.
   */
  unregisterRuntime(planId: string): void {
    this.activeRuntimes.delete(planId);
  }

  /**
   * Cancel a running plan.
   *
   * This is the public API exposed as `cancel_plan(planId)`.
   */
  async cancelPlan(planId: string): Promise<CancellationResult> {
    const plan = this.planStore.load(planId);

    if (!plan) {
      return {
        success: false,
        planId,
        previousStatus: 'unknown',
        newStatus: 'unknown',
        completedSteps: 0,
        cancelledSteps: 0,
        message: `Plan "${planId}" not found.`,
      };
    }

    const previousStatus = plan.status;

    if (
      plan.status === 'completed' ||
      plan.status === 'cancelled' ||
      plan.status === 'failed-partial'
    ) {
      return {
        success: false,
        planId,
        previousStatus,
        newStatus: previousStatus,
        completedSteps: plan.steps.filter((s) => s.status === 'done').length,
        cancelledSteps: 0,
        message: `Plan is already in terminal state "${previousStatus}".`,
      };
    }

    // Signal the PlanRuntime to stop dispatching
    const runtime = this.activeRuntimes.get(planId);
    if (runtime) {
      runtime.cancel();
    }

    // Cancel pending tasks
    let cancelledCount = 0;
    for (const step of plan.steps) {
      if (step.status === 'pending' && step.taskId) {
        this.taskRuntime.cancelTask(step.taskId);
        step.status = 'failed';
        step.resultSummary = 'Cancelled by user';
        cancelledCount++;
      }
    }

    plan.status = 'cancelled';
    plan.completedAt = Date.now();
    this.planStore.save(plan);

    const completedCount = plan.steps.filter((s) => s.status === 'done').length;

    return {
      success: true,
      planId,
      previousStatus,
      newStatus: 'cancelled',
      completedSteps: completedCount,
      cancelledSteps: cancelledCount,
      message:
        `Plan cancelled. ${completedCount} step(s) completed, ` +
        `${cancelledCount} step(s) cancelled.`,
    };
  }
}
