/**
 * Pure UI helpers shared by `app.js` and Phase H tests.
 * No DOM — every decision the poller/SSE layer makes lives here so it can
 * be unit-tested without a browser.
 */

/** Event names the server may emit on `/api/stream/:id`. */
export const SSE_EVENT_TYPES = Object.freeze([
  'plan:started',
  'plan:step-started',
  'plan:step-completed',
  'plan:step-failed',
  'plan:replanning',
  'plan:replanned',
  'plan:completed',
  'plan:failed',
  'plan:cancelled',
  'plan:error',
  'task:tool-call',
  'task:tool-error',
  'task:status',
  'awaiting-confirmation',
  'run:done',
  'clarification',
]);

/** Open the confirm modal once per planId (H-01). */
export function shouldOpenPlanModal(run) {
  if (!run || !run.planId) return false;
  return run.planModalOpenFor !== run.planId;
}

/**
 * Close the confirm modal only when THIS run owns it.
 * A preview opened while a run is executing must stay up (H-01).
 */
export function shouldClosePlanModalOnRunning(opts) {
  if (opts.modalPreview) return false;
  if (!opts.modalPlanId) return false;
  return opts.modalPlanId === opts.runPlanId;
}

/** Do not reopen a round the user already answered (H-14). */
export function shouldOpenClarifyModal(run, round) {
  if (!run) return false;
  if (run.clarifySubmittedFor === round) return false;
  if (run.clarifyOpenFor === round) return false;
  return true;
}

/** Agent-level SSE lines must not draw a second step row (H-04). */
export function isAgentLevelPayload(payload) {
  return Boolean(payload && payload.agentLevel === true);
}

/** Session the next goal should continue (H-05). */
export function nextSessionId(runState, currentSessionId) {
  return runState?.sessionId || currentSessionId || null;
}

/** Chat history: keep the live text or mark a clip (H-13). */
export const REVIEW_TRUNCATED_MARK = '… [truncated]';

export function formatReviewSummary(summary, liveText) {
  if (typeof summary !== 'string') return '';
  if (liveText && summary === liveText) return summary;
  if (summary.endsWith(REVIEW_TRUNCATED_MARK) || summary.includes('[truncated]')) {
    return summary;
  }
  return summary;
}

export function errorBubbleText(message) {
  return `error: ${message}`;
}
