import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ─── Session entry ────────────────────────────────────────────────

/**
 * A single interaction within a session: one user request and
 * its associated plan(s) and final review.
 */
export const SessionInteractionSchema = z.object({
  /** Unique interaction id */
  id: z.string().min(1),
  /** The user's original request text */
  userRequest: z.string().min(1),
  /** Plan id(s) generated for this request */
  planIds: z.array(z.string()).default([]),
  /** Final outcome (populated after plan execution) */
  outcome: z
    .enum(['success', 'partial-success', 'failure', 'cancelled', 'pending'])
    .default('pending'),
  /** Compact summary of the final review (for quick reference) */
  reviewSummary: z.string().optional(),
  /** Timestamps */
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

export type SessionInteraction = z.infer<typeof SessionInteractionSchema>;

// ─── Session ──────────────────────────────────────────────────────

export const SessionSchema = z.object({
  /** Unique session identifier */
  id: z.string().min(1),
  /** Human-readable label (optional) */
  label: z.string().optional(),
  /** All interactions in chronological order */
  interactions: z.array(SessionInteractionSchema).default([]),
  /** Session-level metadata */
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Timestamps */
  createdAt: z.number(),
  lastActiveAt: z.number(),
});

export type Session = z.infer<typeof SessionSchema>;

// ─── Helpers ──────────────────────────────────────────────────────

export function createSession(label?: string): Session {
  const now = Date.now();
  return {
    id: `session_${randomUUID()}`,
    label,
    interactions: [],
    metadata: {},
    createdAt: now,
    lastActiveAt: now,
  };
}

export function createInteraction(userRequest: string): SessionInteraction {
  return {
    id: `interaction_${randomUUID()}`,
    userRequest,
    planIds: [],
    outcome: 'pending',
    createdAt: Date.now(),
  };
}
