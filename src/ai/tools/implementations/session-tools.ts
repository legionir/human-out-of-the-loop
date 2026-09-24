import { tool } from 'ai';
import { z } from 'zod';
import type { SessionStore } from '../../runtime/session-store.js';

/**
 * Creates the `get_previous_plan_summary` tool that allows the
 * Main Agent / Planner to reference a previous plan's outcome
 * within the same session.
 *
 * This enables conversational continuity: the user can say
 * "continue from where we left off" and the Planner can pull
 * the previous plan's summary for context.
 */
export function createGetPreviousPlanSummaryTool(sessionStore: SessionStore) {
  return tool({
    description:
      'Retrieves the summary of the most recent completed plan in the ' +
      'current session. Use this when the user references previous work ' +
      'or asks to continue from where they left off.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The current session id'),
    }),
    execute: async ({ sessionId }: { sessionId: string }) => {
      const summary = sessionStore.getLatestPlanSummary(sessionId);

      if (!summary) {
        return {
          success: false as const,
          error: 'No previous plan summary found for this session.',
          code: 'NO_PREVIOUS_PLAN',
        };
      }

      return {
        success: true as const,
        sessionId,
        previousPlanSummary: summary,
      };
    },
  });
}
