import { generateText } from 'ai';
import { z } from 'zod';
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
 * Two-phase process:
 *   1. **Assessment**: Is the request clear enough? If not, return
 *      clarification questions (the ONLY point where human input
 *      is requested before execution — Law 17).
 *   2. **Plan generation**: Produce a Plan via `Output.object()`
 *      with the PlanSchema.
 *
 * The Planner itself runs as a single AI SDK call with structured
 * output — it does NOT use the AgentRuntime loop (no tool calls
 * needed beyond the catalog tools which are injected into the
 * system prompt as context).
 */
export class Planner {
  private readonly config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /**
   * Phase 1: Assess whether the request is clear enough.
   * Returns clarification questions if not.
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

If the request is vague, ambiguous, or missing critical information
(e.g. which files to modify, what the expected output format is,
what constraints apply), set isClear=false and list specific
clarification questions.

If the request is clear enough to decompose into concrete steps,
set isClear=true and provide the full plan.

Respond in the exact JSON schema provided.
`.trim();

    try {
      const result = await generateText({
        model: agent.model,
        system: agent.systemPrompt,
        prompt: assessmentPrompt,
        // Use structured output for reliable parsing
        // Note: In production, use Output.object() from AI SDK.
        // Here we use JSON mode as a compatible fallback.
      });

      // Parse the response as JSON
      const parsed = this.parseJsonResponse(result.text, PlannerAssessmentSchema);
      return parsed;
    } catch (_err) {
      // If structured parsing fails, treat as unclear
      return {
        isClear: false,
        needsClarification: [
          'The planner was unable to parse the request. Please provide more details about what you want to accomplish.',
        ],
      };
    }
  }

  /**
   * Phase 2: Generate a full Plan from a clear (or clarified) request.
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

    prompt += `
Produce a plan with atomic, dependency-aware steps.
Each step must have:
- A unique id (e.g. "step-1", "step-2")
- A clear description of the single deliverable
- dependsOn: array of step ids that must complete first
- assignedPersona: a persona id from the catalog
- assignedSkills: skill ids from the catalog
- assignedTools: tool ids that are in the persona's allowedTools
- claimedResources: files/resources this step will modify
- acceptanceCriteria: a testable statement for when the step is done

Respond in the exact JSON schema provided.
`.trim();

    const result = await generateText({
      model: agent.model,
      system: agent.systemPrompt,
      prompt,
    });

    const parsed = this.parseJsonResponse(result.text, PlanSchema);

    // Ensure all steps start as "pending"
    for (const step of parsed.steps) {
      step.status = 'pending';
    }

    return {
      ...parsed,
      id: parsed.id ?? `plan_${Date.now()}`,
      status: 'draft',
      createdAt: Date.now(),
    };
  }

  /**
   * Combined assess + generate in one call.
   * If the request is unclear, returns clarification questions.
   * If clear, returns the plan directly.
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

      // isClear but no plan in assessment — generate separately
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

  /**
   * Parse a JSON response from the model, extracting the JSON
   * block if it's wrapped in markdown code fences.
   */
  private parseJsonResponse<T>(text: string, schema: z.ZodType<T>): T {
    // Try to extract JSON from markdown code blocks
    let jsonStr = text.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Try to find the first { or [ in the text
    const firstBrace = jsonStr.indexOf('{');
    const firstBracket = jsonStr.indexOf('[');
    if (firstBrace === -1 && firstBracket === -1) {
      throw new Error('No JSON found in model response');
    }

    const startIdx =
      firstBrace === -1
        ? firstBracket
        : firstBracket === -1
          ? firstBrace
          : Math.min(firstBrace, firstBracket);

    jsonStr = jsonStr.slice(startIdx);

    const raw = JSON.parse(jsonStr);
    return schema.parse(raw);
  }
}
