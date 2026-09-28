import { detectLanguage } from '../language.js';
import { languageSection } from './language.js';
import type { Plan, PlanStep } from '../schemas/plan.js';
import type { Task } from '../schemas/task.js';
import type { Review } from '../schemas/review.js';

export function buildAcceptancePrompt(
  step: PlanStep,
  taskResult: Pick<Task, 'summary' | 'result' | 'errors'>,
): string {
  return `
You are verifying whether a completed task meets its acceptance criteria.

${languageSection(step.description, detectLanguage(step.description))}

## Step Description
${step.description}

## Acceptance Criteria
${step.acceptanceCriteria}

## Task Output Summary
${taskResult.summary ?? 'No summary available.'}

## Task Output (full)
${(taskResult.result ?? 'No result available.').slice(0, 4_000)}

## Task Errors (if any)
${(taskResult.errors ?? []).length > 0 ? (taskResult.errors ?? []).join('\n') : 'None'}

Evaluate the output against the acceptance criteria and respond with
a JSON object containing "accepted" (boolean) and "reason" (string).
`.trim();
}

export interface ReviewPromptStep {
  id: string;
  description: string;
  status: string;
  acceptanceCriteria: string;
  resultSummary: string;
  failureType?: 'technical' | 'quality';
  persona: string;
}

export interface ReviewPromptExecution {
  completedSteps: number;
  totalSteps: number;
  failedSteps: number;
  replanningAttempts: number;
  incompleteSteps: Array<{ stepId: string; failureType?: string; description: string; reason: string }>;
}

export function buildFinalReviewPrompt(
  plan: Plan,
  result: ReviewPromptExecution,
  steps: ReviewPromptStep[],
  outcome: Review['outcome'],
): string {
  const stepsBlock = steps
    .map((step) =>
      `### Step ${step.id} (persona: ${step.persona})\n` +
      `Description: ${step.description}\n` +
      `Acceptance criteria: ${step.acceptanceCriteria}\n` +
      `Status: ${step.status}` +
      (step.failureType ? ` (${step.failureType} failure)` : '') +
      `\nResult: ${step.resultSummary}\n`,
    )
    .join('\n---\n');
  const incompleteBlock = result.incompleteSteps.length > 0
    ? `\n## Incomplete Steps\n${result.incompleteSteps
        .map((step) => `- ${step.stepId} (${step.failureType ?? 'unknown'}): ${step.description} — ${step.reason}`)
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
