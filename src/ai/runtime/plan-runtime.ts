import type { TaskRuntime } from './task-runtime.js';
import type { PlanStore } from './plan-store.js';
import type { Planner } from '../planning/planner.js';
import { runFeasibilityGate, type FeasibilityGateDeps } from '../planning/feasibility-gate.js';
import { detectCycles } from '../planning/cycle-detector.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import {
  type Plan,
  type PlanStep,
  type PlanStatus,
  isPlanTerminal,
  getReadySteps,
} from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface PlanRuntimeConfig {
  taskRuntime: TaskRuntime;
  planStore: PlanStore;
  planner: Planner;
  feasibilityDeps: FeasibilityGateDeps;
  refs: {
    personaRegistry: PersonaRegistry;
    skillRegistry: SkillRegistry;
    toolRegistry: ToolRegistry;
    modelRegistry: ModelRegistry;
  };
  /** Maximum total re-planning attempts across the entire plan (default: 3) */
  maxReplanningAttempts?: number;
  /** Default model id for dynamically composed agents (default: "gpt-4o") */
  defaultModelId?: string;
  /** Callback invoked when plan status changes (for streaming — Phase 13) */
  onStatusChange?: (plan: Plan, event: string) => void;
}

export interface PlanExecutionResult {
  planId: string;
  status: PlanStatus;
  completedSteps: number;
  failedSteps: number;
  totalSteps: number;
  /** Steps that could not be completed (when status is "failed-partial") */
  incompleteSteps: Array<{
    stepId: string;
    description: string;
    reason: string;
    failureType?: 'technical' | 'quality';
  }>;
  replanningAttempts: number;
}

// ─── PlanRuntime ─────────────────────────────────────────────────

/**
 * The core execution loop that drives a Plan from start to finish
 * **without any human intervention** (Law 17: Human-Out-Of-Loop).
 *
 * Once the user confirms the Plan (Phase 9, Step 7), this runtime:
 *   1. Persists the plan.
 *   2. Enters a `while` loop that dispatches ready steps as tasks.
 *   3. Waits for tasks to complete, updates step statuses.
 *   4. On failure, triggers automatic re-planning (up to a ceiling).
 *   5. Exits only when all steps are done or progress is impossible.
 *
 * The loop NEVER pauses to ask the user "continue?" — it runs to
 * completion or definitive failure.
 */
export class PlanRuntime {
  private readonly config: Required<
    Pick<PlanRuntimeConfig, 'taskRuntime' | 'planStore' | 'planner' | 'feasibilityDeps' | 'refs'>
  > &
    PlanRuntimeConfig;
  private readonly maxReplanning: number;
  private readonly defaultModelId: string;
  private replanningCount = 0;
  private cancelled = false;

  constructor(config: PlanRuntimeConfig) {
    this.config = config as Required<
      Pick<PlanRuntimeConfig, 'taskRuntime' | 'planStore' | 'planner' | 'feasibilityDeps' | 'refs'>
    > &
      PlanRuntimeConfig;
    this.maxReplanning = config.maxReplanningAttempts ?? 3;
    this.defaultModelId = config.defaultModelId ?? 'gpt-4o';
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Execute a confirmed plan to completion.
   *
   * This method blocks (async) until the plan is fully done or
   * has definitively failed.  It does NOT return early or ask
   * for human input.
   */
  async execute(plan: Plan): Promise<PlanExecutionResult> {
    // 1. Mark as running and persist
    plan.status = 'running';
    this.persist(plan);
    this.notify(plan, 'plan:started');

    // 2. Main execution loop
    while (!this.shouldExit(plan)) {
      // Check cancellation (Phase 13)
      if (this.cancelled) {
        plan.status = 'cancelled';
        this.persist(plan);
        this.notify(plan, 'plan:cancelled');
        break;
      }

      // 3. Get ready steps and prioritize
      const ready = this.getReadyStepsPrioritized(plan);

      if (ready.length === 0) {
        // No steps are ready — check if we're stuck
        if (this.isStuck(plan)) {
          // Try re-planning
          const replanned = await this.attemptReplanning(plan);
          if (!replanned) {
            // Re-planning exhausted or failed — exit with failed-partial
            plan.status = 'failed-partial';
            this.persist(plan);
            this.notify(plan, 'plan:failed-partial');
            break;
          }
          continue; // Re-evaluate with the patched plan
        }

        // Steps are running — wait for them
        await this.config.taskRuntime.waitForAll();
        this.syncStepStatuses(plan);
        this.persist(plan);
        continue;
      }

      // 4. Dispatch ready steps as tasks
      const dispatchPromises = ready.map((step) => this.dispatchStep(plan, step));

      // Use allSettled so one failure doesn't block others
      await Promise.allSettled(dispatchPromises);

      // 5. Wait for all dispatched tasks to complete
      await this.config.taskRuntime.waitForAll();

      // 6. Sync statuses from TaskRuntime back to PlanSteps
      this.syncStepStatuses(plan);
      this.persist(plan);
      this.notify(plan, 'plan:steps-updated');
    }

    // 7. Determine final status
    // Minimal fix: spec's shouldExit returns true when cancelled, so loop exits
    // without entering the inner cancelled block. Ensure cancelled status is set.
    if (this.cancelled) {
      plan.status = 'cancelled';
    }
    if (plan.status === 'running') {
      const allDone = plan.steps.every((s) => s.status === 'done');
      plan.status = allDone ? 'completed' : 'failed-partial';
    }
    plan.completedAt = Date.now();
    this.persist(plan);
    this.notify(plan, 'plan:finished');

    return this.buildResult(plan);
  }

  /**
   * Resume a previously persisted plan from its last saved state.
   * Used after a crash to continue from where we left off (Step 5).
   */
  async resume(planId: string): Promise<PlanExecutionResult> {
    const plan = this.config.planStore.load(planId);
    if (!plan) {
      throw new Error(`[PlanRuntime] Plan "${planId}" not found in store.`);
    }

    if (isPlanTerminal(plan)) {
      return this.buildResult(plan);
    }

    // Reset any "running" steps back to "pending" (they were
    // interrupted by the crash and need to be re-dispatched)
    for (const step of plan.steps) {
      if (step.status === 'running') {
        step.status = 'pending';
        step.taskId = undefined;
      }
    }

    return this.execute(plan);
  }

  /**
   * Signal cancellation.  The loop will stop dispatching new
   * steps at the next iteration (Phase 13).
   */
  cancel(): void {
    this.cancelled = true;
  }

  // ── Private: dispatch ─────────────────────────────────────────

  /**
   * Dispatch a single PlanStep as a Task via TaskRuntime.
   */
  private async dispatchStep(plan: Plan, step: PlanStep): Promise<void> {
    try {
      step.status = 'running';
      this.persist(plan);
      this.notify(plan, `step:${step.id}:running`);

      // Build a resolved agent for this step
      const agent = this.buildAgentForStep(step);

      // Create the task
      const taskId = this.config.taskRuntime.createTask({
        agent,
        prompt: step.description,
        claimedResources: step.claimedResources,
        planStepId: step.id,
      });

      step.taskId = taskId;
      this.persist(plan);
    } catch (err) {
      step.status = 'failed';
      step.failureType = 'technical';
      step.resultSummary = err instanceof Error ? err.message : String(err);
      this.persist(plan);
      this.notify(plan, `step:${step.id}:failed`);
    }
  }

  /**
   * Build a ResolvedAgent for a plan step using the step's
   * persona, skills, tools, and the default model.
   */
  private buildAgentForStep(step: PlanStep): ResolvedAgent {
    return createAgent({
      agentDefinition: {
        id: `plan-step-${step.id}`,
        name: `Step ${step.id}`,
        personaId: step.assignedPersona,
        skillIds: step.assignedSkills,
        modelId: this.defaultModelId,
      },
      refs: this.config.refs,
    });
  }

  // ── Private: status sync ──────────────────────────────────────

  /**
   * Read task results from TaskRuntime and update PlanStep statuses.
   */
  private syncStepStatuses(plan: Plan): void {
    for (const step of plan.steps) {
      if (step.status !== 'running' || !step.taskId) continue;

      const task = this.config.taskRuntime.getResult(step.taskId);
      if (!task) continue;

      switch (task.status) {
        case 'completed':
          step.status = 'done';
          step.resultSummary = task.summary;
          this.notify(plan, `step:${step.id}:done`);
          break;
        case 'failed':
          step.status = 'failed';
          step.failureType = task.failureType ?? 'technical';
          step.resultSummary = task.summary;
          this.notify(plan, `step:${step.id}:failed`);
          break;
        case 'cancelled':
          step.status = 'failed';
          step.failureType = 'technical';
          step.resultSummary = 'Task was cancelled';
          break;
        // pending/running — no change yet
      }
    }
  }

  // ── Private: priority queue ───────────────────────────────────

  /**
   * Get ready steps sorted by priority (Step 3).
   *
   * Priority heuristic: steps that have the most downstream
   * dependents are executed first (they unblock the most work).
   * Ties are broken by step id (lexicographic, for determinism).
   */
  private getReadyStepsPrioritized(plan: Plan): PlanStep[] {
    const ready = getReadySteps(plan);

    // Count how many steps (transitively) depend on each ready step
    const dependentCount = new Map<string, number>();
    for (const step of ready) {
      dependentCount.set(step.id, this.countDependents(plan, step.id));
    }

    return ready.sort((a, b) => {
      const countA = dependentCount.get(a.id) ?? 0;
      const countB = dependentCount.get(b.id) ?? 0;
      if (countB !== countA) return countB - countA; // Higher count first
      return a.id.localeCompare(b.id); // Deterministic tiebreak
    });
  }

  /**
   * Count the total number of steps that (directly or transitively)
   * depend on the given step id.
   */
  private countDependents(plan: Plan, stepId: string): number {
    const visited = new Set<string>();
    const queue = [stepId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const step of plan.steps) {
        if (step.dependsOn.includes(current) && !visited.has(step.id)) {
          visited.add(step.id);
          queue.push(step.id);
        }
      }
    }

    return visited.size;
  }

  // ── Private: re-planning ──────────────────────────────────────

  /**
   * Attempt to re-plan around failed steps (Step 4).
   *
   * Calls the Planner with context about what failed and why,
   * then validates the patched plan through the Feasibility Gate.
   *
   * Returns true if re-planning succeeded and the plan was patched.
   * Returns false if re-planning is exhausted or the new plan
   * is also infeasible.
   */
  private async attemptReplanning(plan: Plan): Promise<boolean> {
    if (this.replanningCount >= this.maxReplanning) {
      return false; // Ceiling reached
    }

    this.replanningCount++;
    this.notify(plan, `plan:replanning-attempt-${this.replanningCount}`);

    try {
      // Gather failure context
      const failedSteps = plan.steps.filter((s) => s.status === 'failed');
      const failureContext = failedSteps
        .map(
          (s) =>
            `Step "${s.id}" (${s.description}) failed with ${s.failureType ?? 'unknown'} error: ${s.resultSummary ?? 'no details'}`
        )
        .join('\n');

      // Ask the Planner to produce a patch
      const replanRequest = `
The following execution plan has encountered failures. Please produce
a REVISED plan that works around these failures.

ORIGINAL GOAL: ${plan.goal}

FAILED STEPS:
${failureContext}

COMPLETED STEPS (do not re-do these):
${plan.steps
  .filter((s) => s.status === 'done')
  .map((s) => `- ${s.id}: ${s.description}`)
  .join('\n')}

PENDING STEPS (may need re-ordering):
${plan.steps
  .filter((s) => s.status === 'pending')
  .map((s) => `- ${s.id}: ${s.description}`)
  .join('\n')}

Produce a new plan that:
1. Keeps completed steps as-is (status "done").
2. Replaces failed steps with new approaches or decomposes them further.
3. Preserves the original goal.
`.trim();

      const result = await this.config.planner.plan(replanRequest);

      if (!result.isClear || !result.plan) {
        return false; // Planner couldn't produce a valid revision
      }

      const newPlan = result.plan;

      // Validate the new plan
      const feasibility = runFeasibilityGate(newPlan, this.config.feasibilityDeps);
      if (!feasibility.feasible) {
        return false; // New plan is also infeasible
      }

      const cycleCheck = detectCycles(newPlan);
      if (cycleCheck.hasCycle) {
        return false; // New plan has cycles
      }

      // Merge: keep completed steps from old plan, replace the rest
      const completedSteps = plan.steps.filter((s) => s.status === 'done');
      const newSteps = newPlan.steps.filter(
        (s) => !completedSteps.some((c) => c.id === s.id)
      );

      plan.steps = [
        ...completedSteps,
        ...newSteps.map((s) => ({ ...s, status: 'pending' as const })),
      ];

      this.persist(plan);
      this.notify(plan, 'plan:replanned');
      return true;
    } catch {
      return false; // Re-planning itself failed
    }
  }

  // ── Private: exit conditions ──────────────────────────────────

  private shouldExit(plan: Plan): boolean {
    // Exit if all steps are terminal
    if (isPlanTerminal(plan)) return true;

    // Exit if cancelled
    if (this.cancelled) return true;

    // Exit if status was externally set to a terminal state
    if (
      plan.status === 'completed' ||
      plan.status === 'failed-partial' ||
      plan.status === 'cancelled'
    ) {
      return true;
    }

    return false;
  }

  /**
   * Check if the plan is stuck: no steps are running, no steps
   * are ready, and there are still non-terminal steps.
   */
  private isStuck(plan: Plan): boolean {
    const hasRunning = plan.steps.some((s) => s.status === 'running');
    const ready = getReadySteps(plan);
    const hasPending = plan.steps.some((s) => s.status === 'pending');

    return !hasRunning && ready.length === 0 && hasPending;
  }

  // ── Private: helpers ──────────────────────────────────────────

  private persist(plan: Plan): void {
    try {
      this.config.planStore.save(plan);
    } catch {
      // Persistence failure should not crash the loop
      // In production, this goes to the observability log (Phase 14)
    }
  }

  private notify(plan: Plan, event: string): void {
    this.config.onStatusChange?.(plan, event);
  }

  private buildResult(plan: Plan): PlanExecutionResult {
    const doneSteps = plan.steps.filter((s) => s.status === 'done');
    const failedSteps = plan.steps.filter((s) => s.status === 'failed');
    const incompleteSteps = plan.steps
      .filter((s) => s.status !== 'done')
      .map((s) => ({
        stepId: s.id,
        description: s.description,
        reason:
          s.resultSummary ??
          (s.status === 'pending'
            ? 'Never started (blocked or cancelled)'
            : `Status: ${s.status}`),
        failureType: s.failureType,
      }));

    return {
      planId: plan.id ?? 'unknown',
      status: plan.status,
      completedSteps: doneSteps.length,
      failedSteps: failedSteps.length,
      totalSteps: plan.steps.length,
      incompleteSteps,
      replanningAttempts: this.replanningCount,
    };
  }
}
