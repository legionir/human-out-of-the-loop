import { randomUUID } from 'node:crypto';
import { generateObject } from 'ai';
import { withLlmTimeout } from '../runtime/llm-timeout.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import {
  PlanSchema,
  PlannerAssessmentSchema,
  type Plan,
  type PlannerAssessment,
} from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface PlannerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  /** Model id to use for planning (default: "gpt-4o") */
  modelId?: string;
  /**
   * Phase 30 (P5): deadline for each structured LLM call.  A provider that
   * never answers must not leave the CLI waiting forever.
   */
  timeoutMs?: number;
}

export interface PlanningResult {
  /** Whether the request was clear enough to produce a plan */
  isClear: boolean;
  /** Clarification questions (when isClear=false) */
  needsClarification: string[];
  /** The generated plan (when isClear=true) */
  plan?: Plan;
  /** Errors encountered during planning */
  errors: string[];
}

// ─── Planner ──────────────────────────────────────────────────────

/**
 * The Planner uses the `planner` persona + `task_decomposition` skill
 * to convert a user request into a structured execution Plan.
 *
 * Uses generateObject for guaranteed schema compliance.
 */
/**
 * Give a model-produced plan the identity and statuses the runtime relies
 * on: an id (`plan_<uuid>` when the model omitted one), `draft` status, a
 * creation timestamp and every step `pending`.
 */
export function finalizePlan(plan: Plan): Plan {
  for (const step of plan.steps) {
    step.status = 'pending';
  }
  return {
    ...plan,
    id: plan.id ?? `plan_${randomUUID()}`,
    status: 'draft',
    createdAt: plan.createdAt ?? Date.now(),
  };
}

export class Planner {
  private readonly config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /**
   * Phase 1: Assess whether the request is clear enough.
   * Uses generateObject for guaranteed schema compliance.
   */
  async assess(userRequest: string): Promise<PlannerAssessment> {
    const agent = this.buildPlannerAgent();

    const assessmentPrompt = `
You are assessing whether the following user request is clear enough
to produce a detailed execution plan.

USER REQUEST:
"""
${userRequest}
"""

If the request is vague, ambiguous, or missing critical information,
set isClear=false and list specific clarification questions.

If the request is clear enough, set isClear=true and provide the full plan.
`.trim();

    try {
      const { object } = await withLlmTimeout(
        'Planner assessment',
        this.config.timeoutMs,
        (abortSignal) =>
          generateObject({
            model: agent.model,
            system: agent.systemPrompt,
            prompt: assessmentPrompt,
            schema: PlannerAssessmentSchema,
            schemaName: 'PlannerAssessment',
            schemaDescription:
              'Assessment of whether a user request is clear enough to plan, ' +
              'with optional clarification questions or a full plan.',
            abortSignal,
          })
      );

      // Phase 30 (P10 follow-up): a plan that arrives inside the assessment
      // must be given the same shape `generatePlan` produces.  Without an id
      // it could not be cancelled/resumed via the CLI or the API, its log
      // entries carried no planId at all, and every id-less plan was written
      // to the SAME store file (`sha256("unknown")`).
      if (object.plan) {
        object.plan = finalizePlan(object.plan);
      }

      return object;
    } catch (err) {
      // Phase 30 (P5): say WHY (a deadline, a provider error, bad output)
      // instead of pretending the request was unclear.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        isClear: false,
        needsClarification: [
          `The planner was unable to process the request: ${reason}. Please provide more details.`,
        ],
      };
    }
  }

  /**
   * Phase 2: Generate a full Plan from a clear (or clarified) request.
   * Uses generateObject for guaranteed schema compliance.
   */
  async generatePlan(
    userRequest: string,
    clarifications?: Record<string, string>
  ): Promise<Plan> {
    const agent = this.buildPlannerAgent();

    let prompt = `
Decompose the following user request into a detailed execution plan.

USER REQUEST:
"""
${userRequest}
"""
`.trim();

    if (clarifications && Object.keys(clarifications).length > 0) {
      prompt += `\n\nCLARIFICATIONS PROVIDED BY USER:\n`;
      for (const [q, a] of Object.entries(clarifications)) {
        prompt += `Q: ${q}\nA: ${a}\n\n`;
      }
    }

    const { object } = await withLlmTimeout(
      'Plan generation',
      this.config.timeoutMs,
      (abortSignal) =>
        generateObject({
          model: agent.model,
          system: agent.systemPrompt,
          prompt,
          schema: PlanSchema,
          schemaName: 'ExecutionPlan',
          schemaDescription: 'A dependency-aware execution plan with atomic steps.',
          abortSignal,
        })
    );

    return finalizePlan(object);
  }

  /**
   * Combined assess + generate in one call.
   */
  async plan(userRequest: string): Promise<PlanningResult> {
    try {
      const assessment = await this.assess(userRequest);

      if (!assessment.isClear) {
        return {
          isClear: false,
          needsClarification: assessment.needsClarification,
          errors: [],
        };
      }

      if (assessment.plan) {
        return {
          isClear: true,
          needsClarification: [],
          plan: assessment.plan,
          errors: [],
        };
      }

      const plan = await this.generatePlan(userRequest);
      return {
        isClear: true,
        needsClarification: [],
        plan,
        errors: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isClear: false,
        needsClarification: [],
        errors: [message],
      };
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  private buildPlannerAgent(): ResolvedAgent {
    const modelId = this.config.modelId ?? 'gpt-4o';

    return createAgent({
      agentDefinition: {
        id: 'planner-runtime',
        name: 'Planner',
        personaId: 'planner',
        skillIds: ['task_decomposition'],
        modelId,
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
