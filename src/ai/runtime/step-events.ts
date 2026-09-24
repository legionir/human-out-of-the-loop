import type { Plan } from '../schemas/plan.js';
import type { ObservabilityLogger } from './observability-logger.js';

/**
 * Phase 30 (P10 follow-up) — step lifecycle in the observability log.
 *
 * The plan runtime emits `step:<id>:running`, `step:<id>:done` and
 * `step:<id>:failed` through `onStatusChange`, and the logger has always had
 * `logStepStarted`/`logStepCompleted`/`logStepFailed` — but nothing called
 * them, so the JSONL log (and therefore `hootl logs`) never recorded what a
 * step did.  The CLI and the web UI get these events from the streaming
 * manager, which is why the gap only showed up in the log.
 */

export type StepPhase = 'running' | 'done' | 'failed';

export interface StepEvent {
  stepId: string;
  phase: StepPhase;
}

/**
 * Parse `step:<id>:<phase>`.  Returns undefined for every other event —
 * including id shapes that are not a step lifecycle transition.
 */
export function parseStepEvent(event: string): StepEvent | undefined {
  const match = /^step:(.+):(running|done|failed)$/.exec(event);
  if (!match) return undefined;
  return { stepId: match[1], phase: match[2] as StepPhase };
}

/**
 * Write the matching log entry for a step event.  Returns true when the
 * event was a step lifecycle transition.
 *
 * The step is looked up in the CURRENT plan snapshot, so a step that has
 * been replaced by re-planning simply produces nothing rather than a
 * misleading entry.
 */
export function logStepEvent(logger: ObservabilityLogger, plan: Plan, event: string): boolean {
  const parsed = parseStepEvent(event);
  if (!parsed) return false;
  const step = plan.steps.find((s) => s.id === parsed.stepId);
  if (!step) return true;
  if (parsed.phase === 'running') logger.logStepStarted(plan.id ?? '', step);
  else if (parsed.phase === 'done') logger.logStepCompleted(plan.id ?? '', step);
  else logger.logStepFailed(plan.id ?? '', step);
  return true;
}
