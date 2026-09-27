/**
 * Successful-plan examples injected into the planner prompt (J-08).
 *
 * Disabled with HOTL_PLAN_EXAMPLES=0.  The store is capped so a long-lived
 * project cannot grow the prompt without bound.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plan } from '../schemas/plan.js';

export const PLAN_EXAMPLES_MAX = 20;
export const PLAN_EXAMPLES_PROMPT_CHARS = 1_200;

export interface PlanExample {
  goal: string;
  stepIds: string[];
  personas: string[];
  tools: string[];
}

export function planExamplesPath(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'plan-examples.jsonl');
}

export function planExamplesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.HOTL_PLAN_EXAMPLES ?? '');
}

export function exampleFromPlan(plan: Plan): PlanExample {
  return {
    goal: plan.goal,
    stepIds: plan.steps.map((step) => step.id),
    personas: [...new Set(plan.steps.map((step) => step.assignedPersona))],
    tools: [...new Set(plan.steps.flatMap((step) => step.assignedTools))],
  };
}

export function loadPlanExamples(projectRoot: string): PlanExample[] {
  const file = planExamplesPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  const rows: PlanExample[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as PlanExample);
    } catch {
      /* skip */
    }
  }
  return rows.slice(-PLAN_EXAMPLES_MAX);
}

export function savePlanExample(projectRoot: string, plan: Plan): void {
  if (!planExamplesEnabled()) return;
  const file = planExamplesPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = loadPlanExamples(projectRoot);
  existing.push(exampleFromPlan(plan));
  const kept = existing.slice(-PLAN_EXAMPLES_MAX);
  fs.writeFileSync(file, kept.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter((part) => part.length > 2));
}

export function scoreExample(goal: string, example: PlanExample): number {
  const want = tokens(goal);
  const have = tokens(example.goal);
  if (want.size === 0 || have.size === 0) return 0;
  let hit = 0;
  for (const word of want) if (have.has(word)) hit += 1;
  return hit / want.size;
}

export function selectPlanExample(goal: string, examples: PlanExample[]): PlanExample | undefined {
  let best: PlanExample | undefined;
  let bestScore = 0;
  for (const example of examples) {
    const score = scoreExample(goal, example);
    if (score > bestScore) {
      best = example;
      bestScore = score;
    }
  }
  return bestScore >= 0.15 ? best : undefined;
}

export function formatPlanExample(example: PlanExample): string {
  const body = [
    'EXAMPLE OF A SUCCESSFUL PLAN (structure only — do not copy ids):',
    `Goal: ${example.goal}`,
    `Steps: ${example.stepIds.join(', ')}`,
    `Personas: ${example.personas.join(', ')}`,
    `Tools: ${example.tools.join(', ')}`,
  ].join('\n');
  return body.length <= PLAN_EXAMPLES_PROMPT_CHARS ? body : `${body.slice(0, PLAN_EXAMPLES_PROMPT_CHARS - 1)}…`;
}
