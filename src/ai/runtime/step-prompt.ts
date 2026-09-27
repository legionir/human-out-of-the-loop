import type { Plan, PlanStep } from '../schemas/plan.js';
import { formatHandoff, extractHandoff } from './handoff.js';

/** Per-field character cap for the compact step context (E-02). */
export const STEP_CONTEXT_CHAR_CAP = 1500;

function clip(text: string, cap = STEP_CONTEXT_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

/**
 * What an executing step actually needs: the plan goal, this step's
 * acceptance criteria, and the result summaries of its dependencies.
 */
export function buildStepPrompt(plan: Plan, step: PlanStep, cap = STEP_CONTEXT_CHAR_CAP): string {
  const depLines: string[] = [];
  for (const depId of step.dependsOn ?? []) {
    const dep = plan.steps.find((candidate) => candidate.id === depId);
    if (!dep) continue;
    const handoff = dep.handoff ?? extractHandoff(dep.resultSummary);
    depLines.push(`- ${dep.id} (${dep.status}):\n${clip(formatHandoff(handoff), cap)}`);
  }

  const parts = [
    `PLAN GOAL:\n${clip(plan.goal, cap)}`,
    `YOUR STEP (${step.id}):\n${clip(step.description, cap)}`,
    `ACCEPTANCE CRITERIA:\n${clip(step.acceptanceCriteria, cap)}`,
  ];
  if (depLines.length > 0) {
    parts.push(`DEPENDENCY HANDOFF:\n${depLines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Done-step summaries for a re-plan prompt (not just descriptions). */
export function formatDoneStepSummaries(plan: Plan, cap = STEP_CONTEXT_CHAR_CAP): string {
  const done = plan.steps.filter((step) => step.status === 'done');
  if (done.length === 0) return '(none)';
  return done
    .map((step) => `- ${step.id}: ${clip(step.resultSummary?.trim() || step.description, cap)}`)
    .join('\n');
}
