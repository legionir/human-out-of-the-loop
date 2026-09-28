import { generateObject } from 'ai';
import { finalizePlan, type PlannerConfig } from './planner.js';
import { PlanModelSchema, type Plan } from '../schemas/plan.js';
import { createAgent } from '../agents/agent-factory.js';
import { withLlmTimeout, withStructuredRetry } from '../runtime/llm-timeout.js';
import { reportLlmUsage } from '../runtime/llm-usage.js';
import { DEFAULT_MODEL_ID } from '../models/defaults.js';
import { withGenerationSettings } from '../models/generation-settings.js';
import { buildCatalogBlock } from '../prompts/catalog.js';
import { buildStructuredPlanPrompt } from '../prompts/planner.js';

/**
 * Generate a Plan using AI SDK's `generateObject` for guaranteed
 * schema compliance (Output.object() equivalent).
 *
 * This is the preferred method in production — it uses the model's
 * structured output mode to ensure the response always matches
 * PlanSchema, eliminating JSON parsing errors.
 */
export async function generatePlanStructured(
  userRequest: string,
  config: PlannerConfig,
  clarifications?: Record<string, string>
): Promise<Plan> {
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  const agent = createAgent({
    agentDefinition: {
      id: 'planner-structured',
      name: 'Planner',
      personaId: 'planner',
      skillIds: ['task_decomposition'],
      modelId,
    },
    refs: {
      personaRegistry: config.personaRegistry,
      skillRegistry: config.skillRegistry,
      toolRegistry: config.toolRegistry,
      modelRegistry: config.modelRegistry,
    },
    includeEnvironment: false,
  });

  const catalog = buildCatalogBlock({
    personaRegistry: config.personaRegistry,
    skillRegistry: config.skillRegistry,
    toolRegistry: config.toolRegistry,
  });

  const prompt = buildStructuredPlanPrompt(userRequest, catalog, clarifications);

  const { object, usage } = await withStructuredRetry(() =>
    withLlmTimeout(
      'Plan generation',
      config.timeoutMs,
      (abortSignal) =>
        generateObject(withGenerationSettings({
          model: agent.model,
          system: agent.systemPrompt,
          prompt,
          schema: PlanModelSchema,
          schemaName: 'ExecutionPlan',
          schemaDescription:
            'A dependency-aware execution plan with atomic steps, each assigned ' +
            'to a persona with specific skills and tools.',
          abortSignal,
        }, agent.generationSettings))
    )
  );
  const plan = finalizePlan(object);
  reportLlmUsage(config.onUsage, 'planning', usage, plan.id);
  return plan;
}
