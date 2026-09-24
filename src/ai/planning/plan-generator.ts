import { randomUUID } from 'node:crypto';
import { generateObject } from 'ai';
import type { PlannerConfig } from './planner.js';
import { PlanSchema, type Plan } from '../schemas/plan.js';
import { createAgent } from '../agents/agent-factory.js';
import { withLlmTimeout, withStructuredRetry } from '../runtime/llm-timeout.js';
import { reportLlmUsage } from '../runtime/llm-usage.js';

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
  const modelId = config.modelId ?? 'gpt-4o';

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
  });

  let prompt = `
Decompose the following user request into a detailed execution plan.

USER REQUEST:
"""
${userRequest}
"""
`.trim();

  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt += `\n\nCLARIFICATIONS:\n`;
    for (const [q, a] of Object.entries(clarifications)) {
      prompt += `Q: ${q}\nA: ${a}\n\n`;
    }
  }

  const { object, usage } = await withStructuredRetry(() =>
    withLlmTimeout(
      'Plan generation',
      config.timeoutMs,
      (abortSignal) =>
        generateObject({
          model: agent.model,
          system: agent.systemPrompt,
          prompt,
          schema: PlanSchema,
          schemaName: 'ExecutionPlan',
          schemaDescription:
            'A dependency-aware execution plan with atomic steps, each assigned ' +
            'to a persona with specific skills and tools.',
          abortSignal,
        })
    )
  );
  const id = object.id ?? `plan_${randomUUID()}`;
  reportLlmUsage(config.onUsage, 'planning', usage, id);

  return {
    ...object,
    id,
    status: 'draft',
    createdAt: Date.now(),
    steps: object.steps.map((s) => ({ ...s, status: 'pending' as const })),
  };
}
