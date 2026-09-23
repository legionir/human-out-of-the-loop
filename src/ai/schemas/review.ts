import { z } from 'zod';

// ─── Finding schema ───────────────────────────────────────────────

/**
 * A single finding produced during plan execution.
 * Findings come from step outputs (via their resultSummary) and
 * are categorised by the reviewer as accepted or rejected.
 */
export const FindingSchema = z.object({
  /** Which plan step produced this finding */
  stepId: z.string().min(1),
  /** Short title (one line) */
  title: z.string().min(1),
  /** Detailed description */
  description: z.string().min(1),
  /** Severity classification */
  severity: z.enum(['critical', 'warning', 'info']).default('info'),
});

export type Finding = z.infer<typeof FindingSchema>;

// ─── Incomplete step schema ──────────────────────────────────────

/**
 * A step that could not be completed.  Used when the plan finished
 * in "failed-partial" or "cancelled" state.
 */
export const IncompleteStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1),
  failureType: z.enum(['technical', 'quality']).optional(),
});

export type IncompleteStep = z.infer<typeof IncompleteStepSchema>;

// ─── Review schema (final output) ────────────────────────────────

/**
 * The final review of a plan execution.  Produced by the Main Agent
 * using `Output.object()` after PlanRuntime terminates.
 *
 * This is the ONLY structured output returned to the user (Law 15).
 */
export const ReviewSchema = z.object({
  /** The plan id being reviewed */
  planId: z.string().min(1),
  /** The user's original goal */
  goal: z.string().min(1),
  /** Overall outcome */
  outcome: z.enum(['success', 'partial-success', 'failure', 'cancelled']),
  /** Findings that were verified and accepted */
  acceptedFindings: z.array(FindingSchema).default([]),
  /** Findings that were rejected during review */
  rejectedFindings: z.array(FindingSchema).default([]),
  /** Steps that never completed (from failed-partial or cancelled runs) */
  incompleteSteps: z.array(IncompleteStepSchema).default([]),
  /** Human-readable summary of what was accomplished and what wasn't */
  finalSummary: z.string().min(1),
  /** Usage/cost aggregation (populated in Phase 13) */
  usage: z
    .object({
      totalPromptTokens: z.number(),
      totalCompletionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
});

export type Review = z.infer<typeof ReviewSchema>;
