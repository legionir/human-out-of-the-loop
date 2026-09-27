import { generateObject, NoObjectGeneratedError } from 'ai';
import { withLlmTimeout, withStructuredRetry } from './llm-timeout.js';
import { languageSection } from '../language.js';
import { reportLlmUsage, type LlmUsageReporter } from './llm-usage.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import { DEFAULT_MODEL_ID } from '../models/defaults.js';
import { withGenerationSettings } from '../models/generation-settings.js';
import { ReviewSchema, emptyReviewUsage, type Review } from '../schemas/review.js';
import type { Plan } from '../schemas/plan.js';
import type { PlanExecutionResult } from './plan-runtime.js';

// ─── Types ────────────────────────────────────────────────────────

export interface FinalReviewerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  /** Model id for the final reviewer (DEFAULT_MODEL_ID) */
  modelId?: string;
  /** Phase 30 (P5): deadline for the review call (default 120s). */
  timeoutMs?: number;
  /** Token usage of the review call. */
  onUsage?: LlmUsageReporter;
}

/**
 * Compact summary of a completed step, safe to send to the reviewer.
 * Excludes raw tool transcripts (Law 14).
 */
interface StepSummary {
  id: string;
  description: string;
  status: string;
  acceptanceCriteria: string;
  resultSummary: string;
  failureType?: 'technical' | 'quality';
  persona: string;
}

// ─── FinalReviewer ───────────────────────────────────────────────

/**
 * Produces the final structured review at the end of PlanRuntime
 * execution (regardless of whether the plan succeeded, failed
 * partially, or was cancelled).
 *
 * Key design decisions:
 *   1. **Fully automatic** (Law 17): triggered by PlanRuntime when
 *      the execution loop exits — no user prompt required.
 *   2. **Compact input** (Law 14): the reviewer receives step
 *      summaries only, never raw tool-call transcripts.
 *   3. **Structured output** (Law 15): uses `generateObject` with
 *      `ReviewSchema` for guaranteed schema compliance.
 *   4. **Handles all outcomes**: success, partial-success, failure,
 *      and cancellation all produce a valid Review — the schema
 *      always parses cleanly.
 */
export class FinalReviewer {
  private readonly config: FinalReviewerConfig;
  private readonly modelId: string;

  constructor(config: FinalReviewerConfig) {
    this.config = config;
    this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
  }

  /**
   * Generate a final review for a completed (or terminated) plan.
   */
  async review(
    plan: Plan,
    executionResult: PlanExecutionResult,
    /** The run's model (a per-run override); default: the configured one. */
    modelId?: string
  ): Promise<Review> {
    const outcome = this.classifyOutcome(plan, executionResult);
    const stepSummaries = this.buildStepSummaries(plan);

    // If the plan produced no results at all (e.g. cancelled before
    // any step ran), return a minimal review without calling the model
    if (stepSummaries.length === 0 || outcome === 'cancelled') {
      return this.buildMinimalReview(plan, executionResult, outcome);
    }

    // Otherwise, ask the reviewer to synthesise the final report
    try {
      const review = await this.generateReviewViaModel(
        plan,
        executionResult,
        stepSummaries,
        outcome,
        modelId
      );
      return review;
    } catch (err) {
      // If model-based review fails, fall back to a mechanical review
      // built directly from the plan state.  This guarantees the
      // caller ALWAYS gets a valid Review.
      return this.buildFallbackReview(
        plan,
        executionResult,
        outcome,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── Private: model-based review ──────────────────────────────

  private async generateReviewViaModel(
    plan: Plan,
    executionResult: PlanExecutionResult,
    stepSummaries: StepSummary[],
    outcome: Review['outcome'],
    modelId?: string
  ): Promise<Review> {
    const reviewerAgent = this.buildReviewerAgent(modelId);

    const prompt = this.buildReviewPrompt(
      plan,
      executionResult,
      stepSummaries,
      outcome
    );

    const { object, usage } = await withStructuredRetry(() =>
      withLlmTimeout(
        'Final review',
        this.config.timeoutMs,
        (abortSignal) =>
          generateObject(withGenerationSettings({
            model: reviewerAgent.model,
            system: reviewerAgent.systemPrompt,
            prompt,
            schema: ReviewSchema,
            schemaName: 'FinalReview',
            schemaDescription:
              'Structured review of a completed plan execution, including ' +
              'accepted findings, rejected findings, incomplete steps, and ' +
              'a human-readable summary.',
            abortSignal,
          }, reviewerAgent.generationSettings))
      ),
      2,
      (err) => {
        if (NoObjectGeneratedError.isInstance(err)) {
          reportLlmUsage(this.config.onUsage, 'review', err.usage, plan.id);
        }
      }
    );
    reportLlmUsage(this.config.onUsage, 'review', usage, plan.id);

    // Ensure planId and goal match (the model might hallucinate)
    return {
      ...object,
      planId: plan.id ?? 'unknown',
      goal: plan.goal,
      outcome,
      incompleteSteps:
        object.incompleteSteps.length > 0
          ? object.incompleteSteps
          : executionResult.incompleteSteps,
    };
  }

  private buildReviewPrompt(
    plan: Plan,
    result: PlanExecutionResult,
    steps: StepSummary[],
    outcome: Review['outcome']
  ): string {
    const stepsBlock = steps
      .map(
        (s) =>
          `### Step ${s.id} (persona: ${s.persona})\n` +
          `Description: ${s.description}\n` +
          `Acceptance criteria: ${s.acceptanceCriteria}\n` +
          `Status: ${s.status}` +
          (s.failureType ? ` (${s.failureType} failure)` : '') +
          `\nResult: ${s.resultSummary}\n`
      )
      .join('\n---\n');

    const incompleteBlock =
      result.incompleteSteps.length > 0
        ? `\n## Incomplete Steps\n${result.incompleteSteps
            .map(
              (s) =>
                `- ${s.stepId} (${s.failureType ?? 'unknown'}): ${s.description} — ${s.reason}`
            )
            .join('\n')}\n`
        : '';

    return `
You are producing the final review of a plan execution.

## User's Goal
${plan.goal}

${languageSection(plan.goal)}

## Execution Summary
- Plan id: ${plan.id ?? 'unknown'}
- Outcome: ${outcome}
- Completed steps: ${result.completedSteps} / ${result.totalSteps}
- Failed steps: ${result.failedSteps}
- Re-planning attempts: ${result.replanningAttempts}

## Step Results
${stepsBlock}
${incompleteBlock}

## Your Task
Produce a structured review as a JSON object. Populate:
- **acceptedFindings**: Meaningful positive results from completed steps
  (e.g. successfully implemented features, verified findings, produced
  reports). Include a stepId, title, description, and severity.
- **rejectedFindings**: Results that were produced but should NOT be
  trusted (e.g. steps that failed quality check with specific problems).
- **incompleteSteps**: Copy the incomplete steps from above.
- **finalSummary**: A clear 2-4 sentence summary for the user explaining
  what was accomplished, what wasn't, and any important caveats.
  If outcome is "failed-partial", explicitly state what remains unfinished.
  If outcome is "cancelled", state when it was cancelled.

Be honest and specific. Do not invent findings that aren't in the results.
`.trim();
  }

  private buildReviewerAgent(modelId?: string): ResolvedAgent {
    return createAgent({
      agentDefinition: {
        id: 'final-reviewer',
        name: 'Final Reviewer',
        personaId: 'reviewer',
        skillIds: [],
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

  // ── Private: fallback / minimal reviews ──────────────────────

  /**
   * Build a review without calling the model.  Used when:
   *   - The plan has no completed steps to summarise.
   *   - The plan was cancelled before meaningful work.
   *   - The model-based review itself fails.
   *
   * This guarantees the caller always receives a valid Review.
   */
  private buildMinimalReview(
    plan: Plan,
    result: PlanExecutionResult,
    outcome: Review['outcome']
  ): Review {
    const summary =
      outcome === 'cancelled'
        ? `Plan was cancelled before completion. ${result.completedSteps} of ${result.totalSteps} steps had finished.`
        : outcome === 'failure'
          ? `Plan failed entirely. No steps completed successfully.`
          : `Plan produced no reportable results.`;

    return {
      planId: plan.id ?? 'unknown',
      goal: plan.goal,
      outcome,
      acceptedFindings: [],
      rejectedFindings: [],
      incompleteSteps: result.incompleteSteps,
      finalSummary: summary,
      // Phase 22: usage is required — zero until the orchestrator
      // overwrites it with the real aggregation.
      usage: emptyReviewUsage,
    };
  }

  private buildFallbackReview(
    plan: Plan,
    result: PlanExecutionResult,
    outcome: Review['outcome'],
    errorMessage: string
  ): Review {
    // Mechanical review from plan state — no model needed
    const accepted = plan.steps
      .filter((s) => s.status === 'done')
      .map((s) => ({
        stepId: s.id,
        title: s.description.slice(0, 80),
        description: s.resultSummary ?? 'Step completed successfully.',
        severity: 'info' as const,
      }));

    const rejected = plan.steps
      .filter((s) => s.status === 'failed' && s.failureType === 'quality')
      .map((s) => ({
        stepId: s.id,
        title: `Quality check failed: ${s.description.slice(0, 60)}`,
        description: s.resultSummary ?? 'Quality check failed without details.',
        severity: 'warning' as const,
      }));

    const summary =
      `${result.completedSteps} of ${result.totalSteps} steps completed. ` +
      (result.failedSteps > 0
        ? `${result.failedSteps} step(s) failed. `
        : '') +
      (result.incompleteSteps.length > 0
        ? `${result.incompleteSteps.length} step(s) remain incomplete. `
        : '') +
      `[Note: model-based review was unavailable (${errorMessage}); this is a fallback summary.]`;

    return {
      planId: plan.id ?? 'unknown',
      goal: plan.goal,
      outcome,
      acceptedFindings: accepted,
      rejectedFindings: rejected,
      incompleteSteps: result.incompleteSteps,
      finalSummary: summary,
      // Phase 22: usage is required — zero until the orchestrator
      // overwrites it with the real aggregation.
      usage: emptyReviewUsage,
    };
  }

  // ── Private: helpers ─────────────────────────────────────────

  private classifyOutcome(
    plan: Plan,
    result: PlanExecutionResult
  ): Review['outcome'] {
    if (result.status === 'cancelled') return 'cancelled';
    if (result.status === 'completed') return 'success';
    if (
      result.completedSteps > 0 &&
      result.completedSteps < result.totalSteps
    ) {
      return 'partial-success';
    }
    if (result.completedSteps === 0) return 'failure';
    return 'partial-success';
  }

  private buildStepSummaries(plan: Plan): StepSummary[] {
    return plan.steps
      // R1-05: a superseded step stays in the model-facing review too, so
      // the record of what was replaced during re-planning is not silently
      // dropped from the summary the reviewer/model sees.
      .filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'superseded')
      .map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        acceptanceCriteria: s.acceptanceCriteria,
        resultSummary: (s.resultSummary ?? '').slice(0, 800), // Compact
        failureType: s.failureType,
        persona: s.assignedPersona,
      }));
  }
}
