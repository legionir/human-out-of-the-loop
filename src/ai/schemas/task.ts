import { z } from 'zod';

/**
 * Task lifecycle statuses:
 *   pending   → created but not yet started (waiting for concurrency slot or resource lock)
 *   running   → actively executing via AgentRuntime
 *   completed → finished successfully (pending acceptance check in Phase 11)
 *   failed    → finished with error (technical or quality)
 *   cancelled → explicitly cancelled by user (Phase 13)
 */
export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  /** Either a pre-registered agentId or a dynamic composition descriptor */
  agentDefinitionOrId: z.string().min(1),
  /** The prompt given to the agent */
  prompt: z.string().min(1),
  status: TaskStatusSchema.default('pending'),
  /** Compact summary from AgentRuntime (populated on completion) */
  summary: z.string().optional(),
  /** Full result text (populated on completion) */
  result: z.string().optional(),
  /** Resources this task claims exclusive access to (e.g. file paths) */
  claimedResources: z.array(z.string()).default([]),
  /** Token usage from the agent run */
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  /** Errors encountered during execution */
  errors: z.array(z.string()).default([]),
  /** Failure classification (Phase 11 distinguishes technical vs quality) */
  failureType: z.enum(['technical', 'quality']).optional(),
  /** Timestamps */
  createdAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  /** Optional plan step id this task is associated with (Phase 10) */
  planStepId: z.string().optional(),
  /**
   * Phase 20 (CORR-03): the plan this task belongs to.  Used by the
   * UsageAggregator for correct per-plan token breakdowns.
   */
  planId: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

/**
 * Create a new Task with sensible defaults.
 */
export function createTaskRecord(params: {
  id: string;
  agentDefinitionOrId: string;
  prompt: string;
  claimedResources?: string[];
  planStepId?: string;
  planId?: string;
}): Task {
  return {
    id: params.id,
    agentDefinitionOrId: params.agentDefinitionOrId,
    prompt: params.prompt,
    status: 'pending',
    claimedResources: params.claimedResources ?? [],
    errors: [],
    createdAt: Date.now(),
    planStepId: params.planStepId,
    planId: params.planId,
  };
}
