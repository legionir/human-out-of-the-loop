import type { Plan, PlanStep } from '../schemas/plan.js';
import { formatHandoff, extractHandoff } from '../runtime/handoff.js';

export const STEP_CONTEXT_CHAR_CAP = 1500;

function clip(text: string, cap = STEP_CONTEXT_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

/** Build the user message for an execution agent's plan step. */
export function buildStepPrompt(plan: Plan, step: PlanStep, cap = STEP_CONTEXT_CHAR_CAP): string {
  const depLines: string[] = [];
  for (const depId of step.dependsOn ?? []) {
    const dependency = plan.steps.find((candidate) => candidate.id === depId);
    if (!dependency) continue;
    const handoff = dependency.handoff ?? extractHandoff(dependency.resultSummary);
    depLines.push(`- ${dependency.id} (${dependency.status}):\n${clip(formatHandoff(handoff), cap)}`);
  }
  const parts = [
    `PLAN GOAL:\n${clip(plan.goal, cap)}`,
    `YOUR STEP (${step.id}):\n${clip(step.description, cap)}`,
    `ACCEPTANCE CRITERIA:\n${clip(step.acceptanceCriteria, cap)}`,
  ];
  if (depLines.length > 0) parts.push(`DEPENDENCY HANDOFF:\n${depLines.join('\n')}`);
  return parts.join('\n\n');
}

/** Build the step message plus the standard final-answer instruction. */
export function buildStepExecutionPrompt(plan: Plan, step: PlanStep, cap = STEP_CONTEXT_CHAR_CAP): string {
  return `${buildStepPrompt(plan, step, cap)}\n\nSummarise your final answer in at most 8 sentences. Do not repeat tool transcripts.`;
}

/** Done-step summaries included in a re-plan prompt. */
export function formatDoneStepSummaries(plan: Plan, cap = STEP_CONTEXT_CHAR_CAP): string {
  const done = plan.steps.filter((step) => step.status === 'done');
  if (done.length === 0) return '(none)';
  return done
    .map((step) => `- ${step.id}: ${clip(step.resultSummary?.trim() || step.description, cap)}`)
    .join('\n');
}
