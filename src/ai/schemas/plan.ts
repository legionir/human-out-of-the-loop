import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ─── PlanStep ─────────────────────────────────────────────────────

export const PlanStepStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'done',
  'failed',
  // R1-05: a `failed` step that a successful re-plan replaced with a new
  // step. Kept (never deleted — R1-04) so the abandoned attempt stays
  // visible in the final report, but excluded from both "is the plan
  // stuck/terminal" checks and the done/failed counts that decide
  // success — a superseded step must never keep a plan whose replacement
  // succeeded stuck at `failed-partial`.
  'superseded',
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  /** Unique step identifier within the plan (e.g. "step-1", "step-2") */
  id: z.string().min(1),
  /** What exactly should be done — one clear deliverable */
  description: z.string().min(1),
  /** IDs of steps that must complete before this one can start */
  dependsOn: z.array(z.string()).default([]),
  /** Persona id from PersonaRegistry */
  assignedPersona: z.string().min(1),
  /** Skill ids from SkillRegistry */
  assignedSkills: z.array(z.string()).default([]),
  /** Tool ids — MUST be a subset of persona.allowedTools */
  assignedTools: z.array(z.string()).default([]),
  /** Resources this step will touch (for lock management) */
  claimedResources: z.array(z.string()).default([]),
  /**
   * Testable statement defining when this step is "done".
   * Used by the acceptance check in Phase 11.
   */
  acceptanceCriteria: z.string().min(1),
  /** Current execution status */
  status: PlanStepStatusSchema.default('pending'),
  /** Failure classification (populated on failure) */
  failureType: z.enum(['technical', 'quality']).optional(),
  /** Compact result summary (populated on completion) */
  resultSummary: z.string().optional(),
  /** Task id from TaskRuntime (populated when dispatched) */
  taskId: z.string().optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

// ─── Plan ─────────────────────────────────────────────────────────

export const PlanStatusSchema = z.enum([
  'draft',
  'confirmed',
  'running',
  'cancelling',
  'completed',
  'failed-partial',
  'cancelled',
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSchema = z.object({
  /** Unique plan identifier */
  id: z.string().min(1).optional(),
  /** The user's original goal */
  goal: z.string().min(1),
  /** Ordered list of execution steps */
  steps: z.array(PlanStepSchema).min(1),
  /**
   * Phase 30 (P2): the session that owns this plan.  Persisted so that
   * `hootl plans resume` can close the interaction a crash left open, and
   * so a plan can be traced back to the conversation that produced it.
   */
  sessionId: z.string().optional(),
  /** Clarification questions (populated during ambiguity resolution) */
  clarifications: z.array(z.string()).default([]),
  /** Overall plan status */
  status: PlanStatusSchema.default('draft'),
  /** Timestamps */
  createdAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

// ─── Clarification Response ───────────────────────────────────────

/**
 * Output schema for the Planner's initial assessment.
 * Either the request is clear enough to produce a plan, or
 * clarification questions are returned.
 */
export const PlannerAssessmentSchema = z.object({
  /**
   * What the planner decided to do with the request (v27.17.0):
   *
   *   plan     real work — produce a plan (the pre-v27.17 behaviour);
   *   answer   a greeting, a question, a conversation — reply, never plan;
   *   clarify  the request is too vague to plan or answer — ask questions.
   *
   * Optional on purpose: a provider that does not enforce the schema may omit
   * it (or name it `intent`), and `normalizeAssessment` then derives it from
   * `isClear`/`answer`/`plan` so an older answer keeps working.
   */
  kind: z.enum(['plan', 'answer', 'clarify']).optional(),
  /** Tolerated alias for `kind` — the other word models reach for. */
  intent: z.string().optional(),
  /** True if the request is clear enough to produce a plan */
  isClear: z.boolean(),
  /** Clarification questions (only when isClear=false) */
  needsClarification: z.array(z.string()).default([]),
  /**
   * Tolerated aliases for `needsClarification` — the names models actually use.
   *
   * The response schema asks for `needsClarification`, but a provider that does
   * not enforce it lets the model name the field itself.  zod then (correctly)
   * strips the unknown key, so a real run showed the user
   * `⚠️ Clarification needed:` with *nothing* under it: the model's three
   * questions had been silently dropped during parsing.
   *
   * Declaring the aliases keeps those questions through the parse; the planner
   * merges them (`normalizeAssessment`) and never returns "unclear" with an
   * empty list.
   */
  clarificationQuestions: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  /**
   * The reply itself when `kind` is "answer" (v27.17.0).  A draft is enough:
   * the orchestrator can re-answer with read-only tools, and this text is used
   * when the model classified the request as a conversation.
   */
  answer: z.string().optional(),
  /** Tolerated aliases for `answer`. */
  response: z.string().optional(),
  reply: z.string().optional(),
  /** The plan (only when isClear=true) */
  plan: PlanSchema.optional(),
});

export type PlannerAssessment = z.infer<typeof PlannerAssessmentSchema>;

/**
 * The same fields, all of them optional (v27.17.1).
 *
 * A provider that does not enforce the response schema can return JSON that is
 * valid but *incomplete* — a real run came back with the user's exact question
 * list and `kind: "clarify"`, but without `isClear`, which the schema marks
 * required.  `generateObject` then refuses the object ("No object generated:
 * response did not match schema") and the whole run died at the first call,
 * although everything the runtime needed was in the text.
 *
 * The raw text is re-parsed with this schema after such a failure, and
 * `normalizeAssessment` derives what is missing (the kind from the fields that
 * were filled, `isClear` from the kind).
 */
export const PlannerAssessmentRecoverySchema = PlannerAssessmentSchema.partial();

export type RecoveredAssessment = z.infer<typeof PlannerAssessmentRecoverySchema>;

// ─── Feasibility Gate Result ──────────────────────────────────────

export interface FeasibilityCheckResult {
  feasible: boolean;
  errors: Array<{
    stepId: string;
    field: string;
    message: string;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Create a new Plan with default status and timestamps.
 */
export function createPlan(goal: string, steps: Array<Omit<PlanStep, 'status'> & { status?: PlanStepStatus }>): Plan {
  return {
    id: `plan_${randomUUID()}`,
    goal,
    steps: steps.map((s) => ({
      ...s,
      status: (s.status ?? 'pending') as PlanStepStatus,
    })) as PlanStep[],
    clarifications: [],
    status: 'draft',
    createdAt: Date.now(),
  };
}

/**
 * Check if the plan's execution is terminal.
 *
 * Phase 22: a PLAN-LEVEL terminal status (completed / failed-partial /
 * cancelled) is terminal on its own — a cancelled plan with un-
 * dispatched "pending" steps must not be treated as resumable.
 * When the status is still non-terminal, the per-step check applies.
 */
export function isPlanTerminal(plan: Plan): boolean {
  if (
    plan.status === 'completed' ||
    plan.status === 'failed-partial' ||
    plan.status === 'cancelled'
  ) {
    return true;
  }
  return plan.steps.every(
    (s) => s.status === 'done' || s.status === 'failed' || s.status === 'superseded'
  );
}

/**
 * Get steps that are ready to execute:
 * status is "pending" and all dependsOn steps are "done".
 */
export function getReadySteps(plan: Plan): PlanStep[] {
  const doneIds = new Set(
    plan.steps.filter((s) => s.status === 'done').map((s) => s.id)
  );

  return plan.steps.filter((s) => {
    if (s.status !== 'pending') return false;
    return s.dependsOn.every((dep) => doneIds.has(dep));
  });
}
