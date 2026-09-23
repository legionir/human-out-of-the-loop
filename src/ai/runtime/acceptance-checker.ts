import { generateObject } from 'ai';
import { z } from 'zod';
import type { EventBus, UnsubscribeFn } from './event-bus.js';
import type { PlanStore } from './plan-store.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import type { Plan, PlanStep } from '../schemas/plan.js';
import type { Task } from '../schemas/task.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * Schema for the reviewer's acceptance judgment.
 * Uses Output.object() (generateObject) for guaranteed structure.
 */
export const AcceptanceResultSchema = z.object({
  /** Whether the step output meets the acceptance criteria */
  accepted: z.boolean(),
  /** Brief explanation of the judgment */
  reason: z.string().min(1),
});

export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

export interface AcceptanceCheckerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  /** Model id for the reviewer (default: same as planner) */
  modelId?: string;
  /** EventBus to subscribe to agent:completed events */
  eventBus: EventBus;
  /** PlanStore to update step statuses */
  planStore: PlanStore;
  /**
   * Callback invoked when a step fails the acceptance check.
   * PlanRuntime uses this to trigger re-planning.
   */
  onQualityFailure?: (planId: string, stepId: string, reason: string) => void;
}

// ─── AcceptanceChecker ───────────────────────────────────────────

/**
 * Automatically verifies each completed step against its acceptance
 * criteria before marking it as "done".
 *
 * Flow:
 *   1. Subscribes to `agent:completed` events on the EventBus.
 *   2. When a task completes, looks up the associated PlanStep.
 *   3. Runs the `reviewer` persona + `acceptance_check` skill
 *      via `generateObject` to get a structured judgment.
 *   4. If accepted → step stays `done`.
 *   5. If rejected → step changes to `failed` with
 *      `failureType: "quality"` (distinct from `"technical"`
 *      which comes from AgentRuntime/TaskRuntime errors).
 *   6. Notifies PlanRuntime via callback to trigger re-planning.
 *
 * Law 17 compliance: this runs entirely automatically — no
 * human intervention is needed or requested.
 */
export class AcceptanceChecker {
  private readonly config: AcceptanceCheckerConfig;
  private readonly modelId: string;
  private unsubscribeFn?: UnsubscribeFn;

  /**
   * Map from planId → Plan, so we can look up step acceptance
   * criteria when a task completes.  Populated by `registerPlan()`.
   */
  private readonly activePlans = new Map<string, Plan>();

  constructor(config: AcceptanceCheckerConfig) {
    this.config = config;
    this.modelId = config.modelId ?? 'gpt-4o';
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start listening for completed tasks.
   */
  start(): void {
    this.unsubscribeFn = this.config.eventBus.subscribe(
      'agent:completed',
      (event) => {
        this.handleCompletion(event.taskId).catch((err) => {
          console.error(
            `[AcceptanceChecker] Error checking task ${event.taskId}:`,
            err instanceof Error ? err.message : err
          );
        });
      }
    );
  }

  /**
   * Stop listening.
   */
  stop(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = undefined;
  }

  /**
   * Register a plan so the checker can look up acceptance criteria
   * for its steps.
   */
  registerPlan(plan: Plan): void {
    this.activePlans.set(plan.id ?? 'unknown', plan);
  }

  /**
   * Unregister a plan (e.g. after it reaches a terminal state).
   */
  unregisterPlan(planId: string): void {
    this.activePlans.delete(planId);
  }

  // ── Core logic ────────────────────────────────────────────────

  /**
   * Check a single step's output against its acceptance criteria.
   * Can be called directly (for testing) or via the event listener.
   */
  async checkStep(
    step: PlanStep,
    taskResult: Task
  ): Promise<AcceptanceResult> {
    const reviewerAgent = this.buildReviewerAgent();

    const prompt = `
You are verifying whether a completed task meets its acceptance criteria.

## Step Description
${step.description}

## Acceptance Criteria
${step.acceptanceCriteria}

## Task Output Summary
${taskResult.summary ?? 'No summary available.'}

## Task Output (full)
${taskResult.result ?? 'No result available.'}

## Task Errors (if any)
${taskResult.errors.length > 0 ? taskResult.errors.join('\n') : 'None'}

Evaluate the output against the acceptance criteria and respond with
a JSON object containing "accepted" (boolean) and "reason" (string).
`.trim();

    try {
      const { object } = await generateObject({
        model: reviewerAgent.model,
        system: reviewerAgent.systemPrompt,
        prompt,
        schema: AcceptanceResultSchema,
        schemaName: 'AcceptanceJudgment',
        schemaDescription:
          'Whether the step output meets its acceptance criteria, with a reason.',
      });

      return object;
    } catch (err) {
      // If the reviewer itself fails, treat as a quality failure
      // (conservative: better to re-check than to silently pass)
      return {
        accepted: false,
        reason: `Acceptance check itself failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Event handler ─────────────────────────────────────────────

  /**
   * Handle an `agent:completed` event.
   * Finds the associated PlanStep, runs the acceptance check,
   * and updates the step status accordingly.
   */
  private async handleCompletion(taskId: string): Promise<void> {
    // Find the plan and step associated with this task
    const { plan, step } = this.findStepByTaskId(taskId);
    if (!plan || !step) return; // Not a plan-associated task

    // Only check steps that are currently marked as "done"
    // (TaskRuntime sets them to "done" on success)
    if (step.status !== 'done') return;

    // Get the full task result
    // We need to access TaskRuntime — but to avoid circular deps,
    // we reconstruct the task info from the plan step's resultSummary
    const taskResult: Task = {
      id: taskId,
      agentDefinitionOrId: step.assignedPersona,
      prompt: step.description,
      status: 'completed',
      summary: step.resultSummary,
      result: step.resultSummary, // In full integration, this comes from TaskRuntime
      claimedResources: step.claimedResources,
      errors: [],
      createdAt: Date.now(),
    };

    // Run the acceptance check
    const judgment = await this.checkStep(step, taskResult);

    if (judgment.accepted) {
      // Step passes — stays "done"
      step.resultSummary = `${step.resultSummary}\n[Acceptance: PASSED — ${judgment.reason}]`;
    } else {
      // Step fails quality check
      step.status = 'failed';
      step.failureType = 'quality';
      step.resultSummary = `[Acceptance: FAILED — ${judgment.reason}]`;

      // Notify PlanRuntime to trigger re-planning
      this.config.onQualityFailure?.(plan.id ?? 'unknown', step.id, judgment.reason);
    }

    // Persist the updated plan
    this.config.planStore.save(plan);
  }

  // ── Helpers ───────────────────────────────────────────────────

  private findStepByTaskId(
    taskId: string
  ): { plan: Plan | undefined; step: PlanStep | undefined } {
    for (const plan of this.activePlans.values()) {
      const step = plan.steps.find((s) => s.taskId === taskId);
      if (step) return { plan, step };
    }
    return { plan: undefined, step: undefined };
  }

  private buildReviewerAgent(): ResolvedAgent {
    return createAgent({
      agentDefinition: {
        id: 'acceptance-reviewer',
        name: 'Acceptance Reviewer',
        personaId: 'reviewer',
        skillIds: ['acceptance_check'],
        modelId: this.modelId,
      },
      refs: {
        personaRegistry: this.config.personaRegistry,
        skillRegistry: this.config.skillRegistry,
        toolRegistry: this.config.toolRegistry,
        modelRegistry: this.config.modelRegistry,
      },
    });
  }
}
