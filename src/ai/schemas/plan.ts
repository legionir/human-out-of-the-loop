import { z } from 'zod';

// ─── PlanStep ─────────────────────────────────────────────────────

export const PlanStepStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'done',
  'failed',
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
  /** True if the request is clear enough to produce a plan */
  isClear: z.boolean(),
  /** Clarification questions (only when isClear=false) */
  needsClarification: z.array(z.string()).default([]),
  /** The plan (only when isClear=true) */
  plan: PlanSchema.optional(),
});

export type PlannerAssessment = z.infer<typeof PlannerAssessmentSchema>;

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
    id: `plan_${Date.now()}`,
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
 * Check if all steps are in a terminal state (done or failed).
 */
export function isPlanTerminal(plan: Plan): boolean {
  return plan.steps.every(
    (s) => s.status === 'done' || s.status === 'failed'
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
