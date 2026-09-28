export const PLAN_EXAMPLES_PROMPT_CHARS = 1_200;

export interface PlanExample {
  goal: string;
  stepIds: string[];
  personas: string[];
  tools: string[];
}

/** Render a successful prior plan as a short, structure-only example. */
export function formatPlanExample(example: PlanExample): string {
  const body = [
    'EXAMPLE OF A SUCCESSFUL PLAN (structure only — do not copy ids):',
    `Goal: ${example.goal}`,
    `Steps: ${example.stepIds.join(', ')}`,
    `Personas: ${example.personas.join(', ')}`,
    `Tools: ${example.tools.join(', ')}`,
  ].join('\n');
  return body.length <= PLAN_EXAMPLES_PROMPT_CHARS
    ? body
    : `${body.slice(0, PLAN_EXAMPLES_PROMPT_CHARS - 1)}…`;
}
