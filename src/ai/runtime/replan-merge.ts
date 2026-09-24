/**
 * Phase 30 (P7): merging a REVISED plan into the running one.
 *
 * The old merge kept only the completed steps and took every other step
 * from the revised plan.  Two things went wrong with that:
 *
 *   1. **The abandoned sub-goal disappeared.**  A failed step was dropped
 *      from the plan, so a 12-step goal that lost part 5 reported
 *      "11/11 steps completed" and `plan.status = 'completed'` — the store,
 *      `plans show` and the final report kept no record of what was thrown
 *      away.  Terminal steps (`done` AND `failed`) are now kept, which also
 *      keeps the plan status honest (`failed-partial`).
 *   2. **The replacement could be swallowed.**  The planner is asked to
 *      replace a failed step; when it reuses that id, the "do not re-do
 *      completed steps" rule dropped the replacement entirely.  A colliding
 *      replacement now gets a `~replan<n>` id and dependants are rewired.
 *
 * Dependencies on a kept FAILED step are dropped: the step is terminal but
 * not `done`, so such an edge can never be satisfied — that is the deadlock
 * re-planning exists to avoid.
 */
import type { PlanStep } from '../schemas/plan.js';

export function mergeReplannedSteps(
  currentSteps: PlanStep[],
  revisedSteps: PlanStep[],
  attempt: number
): PlanStep[] {
  const keptSteps = currentSteps.filter((s) => s.status === 'done' || s.status === 'failed');
  const keptById = new Map(keptSteps.map((s) => [s.id, s]));

  const renames = new Map<string, string>();
  const takenIds = new Set(keptById.keys());
  const replacementSteps: PlanStep[] = [];

  for (const step of revisedSteps) {
    if (!takenIds.has(step.id)) {
      takenIds.add(step.id);
      replacementSteps.push(step);
      continue;
    }
    // A completed step is never re-done; a FAILED one may be replaced.
    if (keptById.get(step.id)?.status !== 'failed') continue;
    const replacementId = `${step.id}~replan${attempt}`;
    renames.set(step.id, replacementId);
    takenIds.add(replacementId);
    replacementSteps.push({ ...step, id: replacementId });
  }

  return [
    ...keptSteps,
    ...replacementSteps.map((s) => ({
      ...s,
      dependsOn: s.dependsOn
        .map((d) => renames.get(d) ?? d)
        .filter((d) => keptById.get(d)?.status !== 'failed'),
      status: 'pending' as const,
    })),
  ];
}
