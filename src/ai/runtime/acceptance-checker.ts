import { generateObject, NoObjectGeneratedError } from 'ai';
import { withLlmTimeout, withStructuredRetry } from './llm-timeout.js';
import { detectLanguage, languageSection } from '../language.js';
import { reportLlmUsage, type LlmUsageReporter } from './llm-usage.js';
import { z } from 'zod';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import type { PlanStep } from '../schemas/plan.js';
import type { Task } from '../schemas/task.js';

export const AcceptanceResultSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().min(1),
});

export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema> & {
  /**
   * R1-07: set when the judgment itself could not be obtained (timeout or
   * reviewer error), as opposed to a real quality verdict. The caller must
   * NOT fail the step for this — the step's own output is still good; the
   * judgment is simply unknown.
   */
  checkerError?: boolean;
};

export interface AcceptanceCheckerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  modelId?: string;
  /**
   * Phase 20 (CORR-04): invoked synchronously by the PlanRuntime hook
   * when a step's output is rejected.
   */
  onQualityFailure?: (planId: string, stepId: string, reason: string) => void;
  /** Phase 30 (P5): deadline for the judgment call (default 120s). */
  timeoutMs?: number;
  /** Token usage of every judgment call. */
  onUsage?: LlmUsageReporter;
}

/**
 * Phase 20 (CORR-04) — REDESIGNED.
 *
 * Before: this checker SUBSCRIBED to the EventBus (`agent:completed`)
 * and mutated plan state from an async event handler that ran
 * CONCURRENTLY with PlanRuntime's own status sync — a race where
 * parallel tasks could double-check, check stale state, or have their
 * quality verdict applied after dependents were already dispatched.
 *
 * Now: this is a PURE judgment service.  It has NO EventBus listener.
 * PlanRuntime calls `checkStep()` from an explicit hook after its
 * `syncStepStatuses()` (deterministic, sequential, always current
 * state) and applies the verdict itself.
 *
 * Public API:
 *   - `checkStep(step, task)` → AcceptanceResult
 *   - `reportQualityFailure(planId, stepId, reason)` → fires the
 *     configured callback (observability + streaming).
 */
export class AcceptanceChecker {
  private readonly config: AcceptanceCheckerConfig;
  private readonly modelId: string;

  constructor(config: AcceptanceCheckerConfig) {
    this.config = config;
    this.modelId = config.modelId ?? 'gpt-4o';
  }

  /**
   * Judge one completed step against its acceptance criteria.
   * NEVER throws — a reviewer failure yields `accepted: false` with a
   * descriptive reason (fail-closed).
   */
  async checkStep(
    step: PlanStep,
    taskResult: Task,
    /** The run's model (a per-run override); default: the configured one. */
    modelId?: string
  ): Promise<AcceptanceResult> {
    const reviewerAgent = this.buildReviewerAgent(modelId);

    const prompt = `
You are verifying whether a completed task meets its acceptance criteria.

${languageSection(step.description, detectLanguage(step.description))}

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

    const attempt = () =>
      withStructuredRetry(
        () =>
          withLlmTimeout(
            'Acceptance check',
            this.config.timeoutMs,
            (abortSignal) =>
              generateObject({
                model: reviewerAgent.model,
                system: reviewerAgent.systemPrompt,
                prompt,
                schema: AcceptanceResultSchema,
                schemaName: 'AcceptanceJudgment',
                schemaDescription:
                  'Whether the step output meets its acceptance criteria, with a reason.',
                abortSignal,
              })
          ),
        2,
        (err) => {
          if (NoObjectGeneratedError.isInstance(err)) {
            reportLlmUsage(this.config.onUsage, 'acceptance', err.usage, taskResult.planId);
          }
        }
      );

    // R1-07: a timeout or reviewer error is an infrastructure failure, not
    // a quality verdict — it gets one extra retry (on top of
    // `withStructuredRetry`'s own schema-parse retry) before being reported
    // as `checkerError` so the caller leaves the step's own result alone.
    let lastErr: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        const { object, usage } = await attempt();
        reportLlmUsage(this.config.onUsage, 'acceptance', usage, taskResult.planId);
        return object;
      } catch (err) {
        lastErr = err;
      }
    }

    return {
      accepted: false,
      reason: `Acceptance check itself failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      checkerError: true,
    };
  }

  /**
   * Fire the configured onQualityFailure callback.  Called by the
   * PlanRuntime hook after a rejected verdict is applied to the step.
   */
  reportQualityFailure(planId: string, stepId: string, reason: string): void {
    this.config.onQualityFailure?.(planId, stepId, reason);
  }

  private buildReviewerAgent(modelId?: string): ResolvedAgent {
    return createAgent({
      agentDefinition: {
        id: 'acceptance-reviewer',
        name: 'Acceptance Reviewer',
        personaId: 'reviewer',
        skillIds: ['acceptance_check'],
        modelId: modelId ?? this.modelId,
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
