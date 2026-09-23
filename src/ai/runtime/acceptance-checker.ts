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
import type { TaskRuntime } from './task-runtime.js';

export const AcceptanceResultSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().min(1),
});

export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

export interface AcceptanceCheckerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  modelId?: string;
  eventBus: EventBus;
  planStore: PlanStore;
  taskRuntime?: TaskRuntime;
  onQualityFailure?: (planId: string, stepId: string, reason: string) => void;
}

export class AcceptanceChecker {
  private readonly config: AcceptanceCheckerConfig;
  private readonly modelId: string;
  private unsubscribeFn?: UnsubscribeFn;
  private readonly activePlans = new Map<string, Plan>();

  constructor(config: AcceptanceCheckerConfig) {
    this.config = config;
    this.modelId = config.modelId ?? 'gpt-4o';
  }

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

  stop(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = undefined;
  }

  registerPlan(plan: Plan): void {
    this.activePlans.set(plan.id ?? 'unknown', plan);
  }

  unregisterPlan(planId: string): void {
    this.activePlans.delete(planId);
  }

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
      return {
        accepted: false,
        reason: `Acceptance check itself failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async handleCompletion(taskId: string): Promise<void> {
    const { plan, step } = this.findStepByTaskId(taskId);
    if (!plan || !step) return;
    if (step.status !== 'done') return;

    let taskResult: Task | undefined;
    if (this.config.taskRuntime) {
      const realTask = this.config.taskRuntime.getResult(taskId);
      if (realTask) {
        if (realTask.status !== 'completed') return;
        taskResult = realTask;
      }
    }

    if (!taskResult) {
      taskResult = {
        id: taskId,
        agentDefinitionOrId: step.assignedPersona,
        prompt: step.description,
        status: 'completed',
        summary: step.resultSummary,
        result: step.resultSummary,
        claimedResources: step.claimedResources,
        errors: [],
        createdAt: Date.now(),
      };
    }

    const judgment = await this.checkStep(step, taskResult);

    if (judgment.accepted) {
      step.resultSummary = `${step.resultSummary}\n[Acceptance: PASSED — ${judgment.reason}]`;
    } else {
      step.status = 'failed';
      step.failureType = 'quality';
      step.resultSummary = `[Acceptance: FAILED — ${judgment.reason}]`;
      this.config.onQualityFailure?.(plan.id ?? 'unknown', step.id, judgment.reason);
    }

    this.config.planStore.save(plan);
  }

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
