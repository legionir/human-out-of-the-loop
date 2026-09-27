import type { TaskRuntime } from './task-runtime.js';
import type { PlanStore } from './plan-store.js';
import type { Planner } from '../planning/planner.js';
import { runFeasibilityGate, type FeasibilityGateDeps } from '../planning/feasibility-gate.js';
import { detectCycles } from '../planning/cycle-detector.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import { detectLanguage } from '../language.js';
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
import type { AcceptanceChecker } from './acceptance-checker.js';
import type { Task } from '../schemas/task.js';
import { mergeReplannedSteps } from './replan-merge.js';

const ACCEPTANCE_MARK = '[Acceptance:';

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
  /**
   * U3: per-run execution overrides (Orchestrator.run `runOverrides`).
   * Forwarded to every TaskRuntime.createTask of this run; the task
   * runtime falls back to its own config when these are absent.
   */
  agentTimeoutMs?: number;
  maxSteps?: number;
  /** Callback invoked when plan status changes (for streaming — Phase 13) */
  onStatusChange?: (plan: Plan, event: string) => void;
  /**
   * Phase 20 (CORR-04): acceptance checker invoked from an EXPLICIT hook
   * after each status sync — no EventBus subscription, no race with the
   * runtime's own state updates.
   */
  acceptanceChecker?: AcceptanceChecker;
  /** B-10: persistence failures are reported instead of swallowed. */
  onPersistError?: (err: unknown) => void;
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
  /** B-10: at least one persist failed during this run. */
  persistenceDegraded?: boolean;
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
  /** Phase 20 (CORR-04): steps already judged — never check twice */
  private readonly acceptanceChecked = new Set<string>();
  /** B-10 */
  private persistFailures = 0;
  persistenceDegraded = false;

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
    // B-08: a crash after a step was stored `done` but before judgment
    // left it unjudged. Resume must judge, not skip.
    await this.runAcceptanceChecks(plan);

    // 2. Main execution loop
    while (!(await this.shouldExitOrReplan(plan))) {
      // Phase 29: cross-process cancellation.  `hootl plans cancel <id>`
      // runs in ANOTHER process and can only persist the new status, so
      // the loop has to re-read the store to notice it — without this the
      // run ignored the cancellation and even overwrote it with
      // 'completed'.  Running agents are not killed (the step in flight
      // finishes); the loop stops before dispatching more work.
      if (this.persistedStatus(plan) === 'cancelled') {
        plan.status = 'cancelled';
        this.persist(plan);
        this.notify(plan, 'plan:cancelled');
        break;
      }

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

        // Steps are running — wait for them, persisting each completion
        // immediately (B-14) and judging before the next persist (B-08).
        await this.drainRunningSteps(plan);
        continue;
      }

      // 4. Dispatch ready steps as tasks
      const dispatchPromises = ready.map((step) => this.dispatchStep(plan, step));

      // Use allSettled so one failure doesn't block others
      await Promise.allSettled(dispatchPromises);

      // 5–6. Wait for EACH task to complete, persist + judge immediately
      // so a crash mid-wave does not re-run finished work and does not
      // leave an unjudged `done` on disk.
      await this.drainRunningSteps(plan);
      this.notify(plan, 'plan:steps-updated');
    }

    // 7. Determine final status
    // Minimal fix: spec's shouldExit returns true when cancelled, so loop exits
    // without entering the inner cancelled block. Ensure cancelled status is set.
    if (this.cancelled) {
      plan.status = 'cancelled';
    }
    // Phase 29: a cross-process cancel that arrived while the LAST step was
    // still running never re-enters the loop (all steps are done, so
    // shouldExit() is already true) — honour it here too instead of
    // reporting 'completed'.
    if (this.persistedStatus(plan) === 'cancelled') {
      plan.status = 'cancelled';
    }
    if (plan.status === 'running') {
      // R1-05: a `superseded` step (a failed attempt a successful re-plan
      // replaced) must not keep the plan at `failed-partial`.
      const allDone = plan.steps.every((s) => s.status === 'done' || s.status === 'superseded');
      plan.status = allDone ? 'completed' : 'failed-partial';
    }
    if (plan.status === 'cancelled') {
      this.notify(plan, 'plan:cancelled');
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

    // Phase 30 (P10 follow-up): the documented contract of `plans resume`
    // is "re-execute every step that is not done/failed yet".  The old
    // `isPlanTerminal()` short-circuit also swallowed `failed-partial`
    // plans — the one case the command exists for.  A step that is `done`
    // is NEVER dispatched again: `getReadySteps()` only returns `pending`
    // steps, so resuming cannot redo finished work.
    if (plan.status === 'cancelled' || plan.status === 'cancelling') {
      // Cancellation is final and deliberate (documented).  'cancelling'
      // means a cancel was requested; a process that died before it could
      // finish must not silently turn that into "run the rest".
      plan.status = 'cancelled';
      plan.completedAt = plan.completedAt ?? Date.now();
      this.persist(plan);
      return this.buildResult(plan);
    }
    if (plan.status === 'completed') {
      // A plan that was declared complete is not re-opened, even if a step
      // somehow still says `pending` (contradictory data — re-dispatching it
      // would run work the plan already reported as finished).
      return this.buildResult(plan);
    }
    const unfinished = plan.steps.filter(
      (step) => step.status === 'pending' || step.status === 'running'
    );
    if (unfinished.length === 0) {
      // Everything is done or failed — nothing to resume, and no step may
      // be executed twice.
      return this.buildResult(plan);
    }

    // Reset any "running" steps back to "pending" (they were
    // interrupted by the crash and need to be re-dispatched)
    for (const step of unfinished) {
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
      const agent = this.buildAgentForStep(step, plan);

      // Create the task
      const taskId = this.config.taskRuntime.createTask({
        agent,
        prompt: step.description,
        claimedResources: step.claimedResources,
        planStepId: step.id,
        // Phase 20 (CORR-03): plan id so UsageAggregator can bucket
        // token usage per plan instead of "unassigned".
        planId: plan.id,
        // U3: per-run overrides from Orchestrator.run({ runOverrides })
        ...(this.config.agentTimeoutMs !== undefined
          ? { agentTimeoutMs: this.config.agentTimeoutMs }
          : {}),
        ...(this.config.maxSteps !== undefined ? { maxSteps: this.config.maxSteps } : {}),
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
  private buildAgentForStep(step: PlanStep, plan?: Plan): ResolvedAgent {
    // The plan's goal is written in the user's language; the step's summary and
    // notes must come back in it.
    const languageHint = plan ? detectLanguage(plan.goal) : undefined;
    return createAgent({
      agentDefinition: {
        id: `plan-step-${step.id}`,
        name: `Step ${step.id}`,
        personaId: step.assignedPersona,
        skillIds: step.assignedSkills,
        toolIds: step.assignedTools,
        modelId: this.defaultModelId,
      },
      refs: this.config.refs,
      ...(languageHint ? { languageHint } : {}),
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

  // ── Private: acceptance hook (Phase 20, CORR-04) ─────────────

  /**
   * Run the acceptance check for every step that just transitioned
   * to "done", SEQUENTIALLY and AFTER the status sync — so the checker
   * always sees current state and parallel tasks can no longer race.
   *
   * A rejected verdict marks the step `failed` with `failureType:
   * 'quality'` (distinct from 'technical') and fires the checker's
   * onQualityFailure callback.  Downstream steps then see the failure
   * on the next readiness evaluation (→ re-planning path).
   */
  private async runAcceptanceChecks(plan: Plan): Promise<void> {
    const checker = this.config.acceptanceChecker;
    if (!checker) return;

    for (const step of plan.steps) {
      if (step.status !== 'done') continue;
      if (this.acceptanceChecked.has(step.id)) continue;
      if (step.resultSummary?.includes(ACCEPTANCE_MARK)) {
        this.acceptanceChecked.add(step.id);
        continue;
      }
      if (!step.taskId) continue;

      const task =
        this.config.taskRuntime.getResult(step.taskId) ??
        ({
          id: step.taskId,
          status: 'completed',
          summary: step.resultSummary ?? '',
          result: step.resultSummary ?? '',
        } as Task);

      // Mark as checked BEFORE awaiting so an interleaved re-entry
      // (e.g. resume) cannot double-judge the same step.
      this.acceptanceChecked.add(step.id);

      const judgment = await checker.checkStep(step, task, this.defaultModelId);

      if (judgment.checkerError) {
        // R1-07: the judge itself failed (timeout/error), not the step's
        // work — keep the step `done` and its own output, just note that
        // no verdict could be reached.
        step.resultSummary = `${step.resultSummary ?? ''}\n[Acceptance: UNVERIFIED — ${judgment.reason}]`.trim();
        this.persist(plan);
      } else if (judgment.accepted) {
        step.resultSummary = `${step.resultSummary ?? ''}\n[Acceptance: PASSED — ${judgment.reason}]`.trim();
        this.persist(plan);
      } else {
        step.status = 'failed';
        step.failureType = 'quality';
        // R1-07: append the verdict, never overwrite the step's own output.
        step.resultSummary = `${step.resultSummary ?? ''}\n[Acceptance: FAILED — ${judgment.reason}]`.trim();
        this.notify(plan, `step:${step.id}:failed`);
        checker.reportQualityFailure(plan.id ?? 'unknown', step.id, judgment.reason);
        this.persist(plan);
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

    // Phase 21 (PERF-01): compute transitive dependent counts for ALL
    // steps in ONE O(V+E) pass (memoized DFS over the reverse graph)
    // instead of the old O(R·V·E) per-ready-step BFS.
    const dependentCount = this.computeTransitiveDependentCounts(plan);

    return ready.sort((a, b) => {
      const countA = dependentCount.get(a.id) ?? 0;
      const countB = dependentCount.get(b.id) ?? 0;
      if (countB !== countA) return countB - countA; // Higher count first
      return a.id.localeCompare(b.id); // Deterministic tiebreak
    });
  }

  /**
   * Phase 21 (PERF-01): count of distinct transitive dependents for
   * every step, computed in a single memoized DFS (each edge visited
   * at most twice).  Replaces the per-call `countDependents` BFS that
   * re-scanned the whole step list for every ready step on every loop
   * iteration.
   *
   * `memo(stepId)` = the set of all steps that (directly or
   * transitively) depend on `stepId`.  Cycle-safe: the feasibility
   * gate rejects cycles, but a back-edge simply contributes nothing.
   */
  private computeTransitiveDependentCounts(plan: Plan): Map<string, number> {
    // Reverse adjacency: stepId → steps that directly depend on it
    const direct = new Map<string, string[]>();
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        let list = direct.get(dep);
        if (!list) {
          list = [];
          direct.set(dep, list);
        }
        list.push(step.id);
      }
    }

    const memo = new Map<string, Set<string>>();
    const visiting = new Set<string>();

    const dfs = (id: string): Set<string> => {
      const hit = memo.get(id);
      if (hit) return hit;
      if (visiting.has(id)) return new Set(); // cycle guard
      visiting.add(id);

      const all = new Set<string>();
      for (const child of direct.get(id) ?? []) {
        all.add(child);
        for (const transitive of dfs(child)) all.add(transitive);
      }

      visiting.delete(id);
      memo.set(id, all);
      return all;
    };

    const counts = new Map<string, number>();
    for (const step of plan.steps) {
      counts.set(step.id, dfs(step.id).size);
    }
    return counts;
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
   Every failed step MUST have a replacement: either reuse its id or set
   replacesStepId to the failed step's id on the new step so dependants
   are rewired. A re-plan that leaves a failed step with no replacement
   is rejected.
3. Preserves the original goal.
`.trim();

      // A re-plan is always a plan: never answer conversationally here, and
      // never open a chat answer for a request built from a failed plan.
      const result = await this.config.planner.plan(
        replanRequest,
        plan.id,
        this.defaultModelId,
        'plan'
      );

      if (!result.isClear || !result.plan) {
        return false; // Planner couldn't produce a valid revision
      }

      const newPlan = result.plan;

      // Phase 30 (P7): keep terminal steps (done AND failed) so an abandoned
      // sub-goal never disappears from the plan; see `replan-merge.ts`.
      const mergedSteps = mergeReplannedSteps(plan.steps, newPlan.steps, this.replanningCount);
      const mergedPlan: Plan = { ...plan, steps: mergedSteps };

      // R1-06: validate the MERGED plan, not the raw model output — a
      // revision that only lists new/changed steps must still see kept
      // done/failed/pending steps when checking dependsOn and cycles.
      const feasibility = runFeasibilityGate(mergedPlan, this.config.feasibilityDeps);
      if (!feasibility.feasible) {
        return false; // Merged plan is infeasible
      }

      const cycleCheck = detectCycles(mergedPlan);
      if (cycleCheck.hasCycle) {
        return false; // Merged plan has cycles
      }

      plan.steps = mergedSteps;

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
   * R1-02 — `shouldExit()` alone never gives a failed LAST (or only) step a
   * chance at re-planning: once every step is `done` or `failed`,
   * `isPlanTerminal()` is already true, so the loop's `while` guard exits
   * BEFORE the body's `isStuck()` check ever runs (that check only fires
   * for a step blocked on a still-`pending` dependency). Re-planning was
   * therefore unreachable for a single-step plan, or any plan whose last
   * remaining step failed.
   *
   * This wraps `shouldExit()`: when it says "terminal" ONLY because of a
   * failed step (not cancellation, not an externally-set terminal status),
   * and re-planning budget remains, it attempts one re-plan first and only
   * reports "exit" if that attempt could not produce a workable revision.
   */
  private async shouldExitOrReplan(plan: Plan): Promise<boolean> {
    if (this.cancelled) return true;
    if (
      plan.status === 'completed' ||
      plan.status === 'failed-partial' ||
      plan.status === 'cancelled'
    ) {
      return true;
    }

    const hasFailed = plan.steps.some((s) => s.status === 'failed');
    const hasUnresolved = plan.steps.some((s) => s.status === 'pending' || s.status === 'running');
    if (isPlanTerminal(plan) && hasFailed && !hasUnresolved) {
      if (this.replanningCount >= this.maxReplanning) return true;
      const replanned = await this.attemptReplanning(plan);
      return !replanned; // replanned → new pending steps exist, keep looping
    }

    return this.shouldExit(plan);
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

  /**
   * B-14: wait until every currently-running step is terminal, persisting
   * (and judging) after EACH completion so a crash mid-wave keeps finished
   * work and does not store unjudged `done`.
   */
  private async drainRunningSteps(plan: Plan): Promise<void> {
    while (plan.steps.some((s) => s.status === 'running')) {
      const ids = plan.steps
        .filter((s) => s.status === 'running' && s.taskId)
        .map((s) => s.taskId!);
      const waitForAny = this.config.taskRuntime.waitForAny?.bind(this.config.taskRuntime);
      if (waitForAny) await waitForAny(ids);
      else await this.config.taskRuntime.waitForAll();
      this.syncStepStatuses(plan);
      await this.runAcceptanceChecks(plan);
      this.persist(plan);
    }
  }

  private persist(plan: Plan): void {
    try {
      // Phase 29: a cancellation that arrives from ANOTHER process is
      // authoritative.  Without this the loop's own (status 'running')
      // writes raced with `hootl plans cancel` and overwrote it, so the
      // run finished as 'completed' and the human's cancel was lost.
      if (plan.id && this.config.planStore.update) {
        const saved = this.config.planStore.update(plan.id, (stored) => {
          if (stored.status === 'cancelled' && plan.status !== 'cancelled') {
            plan.status = 'cancelled';
          }
          return structuredClone(plan);
        });
        if (!saved) this.config.planStore.save(plan);
      } else {
        if (plan.id) {
          const stored = this.config.planStore.load(plan.id);
          if (stored?.status === 'cancelled' && plan.status !== 'cancelled') {
            plan.status = 'cancelled';
          }
        }
        this.config.planStore.save(plan);
      }
      this.persistFailures = 0;
    } catch (err) {
      this.persistFailures += 1;
      this.persistenceDegraded = true;
      this.config.onPersistError?.(err);
      if (this.persistFailures >= 5) {
        this.config.onPersistError?.(
          new Error(`[PlanRuntime] ${this.persistFailures} consecutive persist failures`),
        );
      }
    }
  }

  private notify(plan: Plan, event: string): void {
    this.config.onStatusChange?.(plan, event);
  }

  /**
   * Phase 29: the status currently on disk (a user may have cancelled the
   * plan from another terminal while this loop is running).
   */
  private persistedStatus(plan: Plan): Plan['status'] | undefined {
    if (!plan.id) return undefined;
    try {
      return this.config.planStore.load(plan.id)?.status;
    } catch {
      return undefined;
    }
  }

  private buildResult(plan: Plan): PlanExecutionResult {
    const doneSteps = plan.steps.filter((s) => s.status === 'done');
    const failedSteps = plan.steps.filter((s) => s.status === 'failed');
    // R1-05: a `superseded` step is a resolved attempt, not an incomplete
    // one — it stays visible in `plan.steps` (the review can list it) but
    // must not count as something the plan left unfinished.
    const incompleteSteps = plan.steps
      .filter((s) => s.status !== 'done' && s.status !== 'superseded')
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
      ...(this.persistenceDegraded ? { persistenceDegraded: true } : {}),
    };
  }
}
