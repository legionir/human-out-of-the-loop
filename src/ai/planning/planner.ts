import fs from 'node:fs';
import path from 'node:path';
import { environmentBullets } from '../environment-context.js';
import { randomUUID } from 'node:crypto';
import { generateObject } from 'ai';
import { withLlmTimeout, withStructuredRetry } from '../runtime/llm-timeout.js';
import { reportLlmUsage, type LlmUsageReporter } from '../runtime/llm-usage.js';
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
  /**
   * Phase 32: the directory the run works in.  It is put in front of the
   * model as PROJECT CONTEXT — without it the planner has no idea which
   * project "scan this project" means and answers with questions the user
   * already answered by standing in that directory.
   */
  projectRoot?: string;
  /** Token usage of every planning call (assessment, generation, re-planning). */
  onUsage?: LlmUsageReporter;
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

// ─── Project context (Phase 32) ───────────────────────────────────

/** Directory entries never worth a model's attention (and often huge). */
const CONTEXT_SKIP = new Set([
  'node_modules', '.git', '.ai-runtime', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.venv', '__pycache__', '.turbo', '.svelte-kit',
]);

/** How many top-level entries the context block lists. */
export const PROJECT_CONTEXT_MAX_ENTRIES = 40;

/** Shallow listing of `projectRoot`: directories first, heavy ones dropped. */
export function projectTopLevelEntries(projectRoot: string, max = PROJECT_CONTEXT_MAX_ENTRIES): string[] {
  try {
    return fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !CONTEXT_SKIP.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => {
        const dirA = a.endsWith('/');
        const dirB = b.endsWith('/');
        if (dirA !== dirB) return dirA ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, max);
  } catch {
    return [];
  }
}

/**
 * The PROJECT CONTEXT block prepended to every planner prompt.
 *
 * It answers the two questions the model otherwise asks the user: *which*
 * project, and *where* it lives.  Paths in a plan are relative to this
 * root, and the file tools refuse to leave it (see path-security.ts).
 */
export function buildProjectContext(projectRoot: string | undefined): string {
  if (!projectRoot) return '';
  const root = path.resolve(projectRoot);
  const entries = projectTopLevelEntries(root);
  const lines = [
    'PROJECT CONTEXT (known — never ask the user for it):',
    `- project root: ${root}`,
    // Phase 36: the machine, not just its name — which shell a command will run
    // in, which separator to build paths with, GNU vs BSD.  The planner writes
    // the commands the agent will later run, so it needs this at plan time.
    ...environmentBullets(),
    '- every path in the plan is relative to that root; read_file/write_file/search_code work inside it and nowhere else',
    '- the project already exists: questions like "which project?" or "what is the current directory?" are already answered by this block',
  ];
  if (entries.length > 0) {
    lines.push(`- top-level entries: ${entries.join('  ')}`);
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    lines.push('- package.json is present (Node.js project)');
  }
  return lines.join('\n');
}

/**
 * The assessment prompt — exported so the PROJECT CONTEXT it carries can
 * be asserted without a model call.
 */
export function buildAssessmentPrompt(userRequest: string, projectRoot?: string): string {
  const context = buildProjectContext(projectRoot);
  const note = context
    ? `${context}\n\nA request that only lacks the project, its location or its technology stack is CLEAR: the context above supplies them.\n`
    : '';
  return `
You are assessing whether the following user request is clear enough
to produce a detailed execution plan.
${note ? `\n${note}` : ''}USER REQUEST:
"""
${userRequest}
"""

If the request is vague, ambiguous, or missing critical information,
set isClear=false and list specific clarification questions.

If the request is clear enough, set isClear=true and provide the full plan.
`.trim();
}

/**
 * The plan-generation prompt (same PROJECT CONTEXT, plus the answers the
 * user gave during clarification).
 */
export function buildPlanPrompt(
  userRequest: string,
  clarifications?: Record<string, string>,
  projectRoot?: string
): string {
  const context = buildProjectContext(projectRoot);
  let prompt = `
Decompose the following user request into a detailed execution plan.
${context ? `\n${context}\n` : ''}
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
  return prompt;
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
  /**
   * @param usagePlanId plan the call's token usage is billed to — set when
   *   re-planning an existing plan; otherwise the new plan's own id is used.
   */
  async assess(
    userRequest: string,
    usagePlanId?: string,
    modelId?: string
  ): Promise<PlannerAssessment> {
    const agent = this.buildPlannerAgent(modelId);

    const assessmentPrompt = buildAssessmentPrompt(userRequest, this.config.projectRoot);

    try {
      const { object, usage } = await withStructuredRetry(() =>
        withLlmTimeout(
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
        )
      );

      // Phase 30 (P10 follow-up): a plan that arrives inside the assessment
      // must be given the same shape `generatePlan` produces.  Without an id
      // it could not be cancelled/resumed via the CLI or the API, its log
      // entries carried no planId at all, and every id-less plan was written
      // to the SAME store file (`sha256("unknown")`).
      if (object.plan) {
        object.plan = finalizePlan(object.plan);
      }
      reportLlmUsage(this.config.onUsage, 'planning', usage, usagePlanId ?? object.plan?.id);

      return object;
    } catch (err) {
      // Phase 30 (P5): say WHY (a deadline, a provider error, bad output).
      // It is a failure, not a question for the user — `plan()` reports it
      // as an error, so the run ends with "Planning failed: <reason>"
      // instead of asking the user to "provide more details".
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`The planner was unable to process the request: ${reason}`);
    }
  }

  /**
   * Phase 2: Generate a full Plan from a clear (or clarified) request.
   * Uses generateObject for guaranteed schema compliance.
   */
  async generatePlan(
    userRequest: string,
    clarifications?: Record<string, string>,
    usagePlanId?: string,
    modelId?: string
  ): Promise<Plan> {
    const agent = this.buildPlannerAgent(modelId);

    const prompt = buildPlanPrompt(userRequest, clarifications, this.config.projectRoot);

    const { object, usage } = await withStructuredRetry(() =>
      withLlmTimeout(
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
      )
    );
    const plan = finalizePlan(object);
    reportLlmUsage(this.config.onUsage, 'planning', usage, usagePlanId ?? plan.id);
    return plan;
  }

  /**
   * Combined assess + generate in one call.
   */
  /**
   * @param modelId model for this call (a per-run override); default: the
   *   planner's configured model.
   */
  async plan(userRequest: string, usagePlanId?: string, modelId?: string): Promise<PlanningResult> {
    try {
      const assessment = await this.assess(userRequest, usagePlanId, modelId);

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

      const plan = await this.generatePlan(userRequest, undefined, usagePlanId, modelId);
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

  private buildPlannerAgent(override?: string): ResolvedAgent {
    const modelId = override ?? this.config.modelId ?? 'gpt-4o';

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
