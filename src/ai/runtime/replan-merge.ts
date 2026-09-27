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
 * B-05: a replacement may also declare `replacesStepId` (a new id that
 * supersedes a failed step). Dependants of the old id are redirected onto
 * the replacement. A failed step with no replacement at all is rejected —
 * dropping those edges used to leave later steps with nothing to wait on.
 */
import type { PlanStep } from '../schemas/plan.js';

export class ReplanMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplanMergeError';
  }
}

export function mergeReplannedSteps(
  currentSteps: PlanStep[],
  revisedSteps: PlanStep[],
  attempt: number
): PlanStep[] {
  const keptSteps = currentSteps.filter((s) => s.status === 'done' || s.status === 'failed');
  const keptById = new Map(keptSteps.map((s) => [s.id, s]));

  // R1-06: a pending step the model forgot to re-list is still live work,
  // not something the re-plan implicitly cancelled. Keep it unless the
  // revised plan explicitly replaces it (same id present in revisedSteps
  // or named via replacesStepId).
  const revisedIds = new Set(revisedSteps.map((s) => s.id));
  const replacedExplicitly = new Set(
    revisedSteps.map((s) => s.replacesStepId).filter((id): id is string => Boolean(id)),
  );
  const forgottenPending = currentSteps.filter(
    (s) => s.status === 'pending' && !revisedIds.has(s.id) && !replacedExplicitly.has(s.id),
  );

  const renames = new Map<string, string>();
  const takenIds = new Set(keptById.keys());
  const replacementSteps: PlanStep[] = [];

  for (const step of revisedSteps) {
    const targetFailedId =
      step.replacesStepId && keptById.get(step.replacesStepId)?.status === 'failed'
        ? step.replacesStepId
        : undefined;

    if (targetFailedId && !takenIds.has(step.id)) {
      renames.set(targetFailedId, step.id);
      takenIds.add(step.id);
      replacementSteps.push(step);
      continue;
    }

    if (!takenIds.has(step.id)) {
      takenIds.add(step.id);
      replacementSteps.push(step);
      continue;
    }
    const kept = keptById.get(step.id);
    // A completed step is never re-done in place. If the model merely
    // resubmitted the same step (identical description — a harmless no-op,
    // e.g. an unmodified plan echoed back), drop it as before. If it is
    // actually DIFFERENT new work under a done step's id, giving it a fresh
    // id keeps that work instead of silently discarding it (R1-04).
    if (kept?.status !== 'failed') {
      if (kept === undefined || kept.description === step.description) continue;
      const newId = `${step.id}-r${attempt}`;
      takenIds.add(newId);
      replacementSteps.push({ ...step, id: newId });
      continue;
    }
    const replacementId = `${step.id}~replan${attempt}`;
    renames.set(step.id, replacementId);
    takenIds.add(replacementId);
    replacementSteps.push({ ...step, id: replacementId });
  }

  const failedIds = currentSteps.filter((s) => s.status === 'failed').map((s) => s.id);
  const unreplaced = failedIds.filter((id) => !renames.has(id) && !replacedExplicitly.has(id));
  if (unreplaced.length > 0) {
    throw new ReplanMergeError(
      `re-plan did not replace failed step(s): ${unreplaced.join(', ')}`,
    );
  }

  // R1-05: a kept FAILED step that got an actual replacement (the `renames`
  // branch above) is no longer just "abandoned" — it was superseded by a
  // step that IS going to run. Marking it `superseded` (not `failed`) keeps
  // it out of `isPlanTerminal`'s and the final status's failure count, so a
  // plan whose replacement succeeds reports `completed`, not
  // `failed-partial`, while the record of what was replaced stays in the
  // plan (R1-04's "never delete a terminal step").
  const supersededIds = new Set(renames.keys());

  return [
    ...keptSteps.map((s) => (supersededIds.has(s.id) ? { ...s, status: 'superseded' as const } : s)),
    ...forgottenPending,
    ...replacementSteps.map((s) => ({
      ...s,
      dependsOn: s.dependsOn
        .map((d) => renames.get(d) ?? d)
        .filter((d) => keptById.get(d)?.status !== 'failed'),
      status: 'pending' as const,
    })),
  ];
}
