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

/**
 * Single HTML-escape for every untrusted string that lands in a template.
 * Keep this the only encoder — K-08 / POT-001.
 */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Minimal markdown: escape FIRST, then a small subset of markers.
 */
export function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const parts = escaped.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += `<pre class="code-block"><code>${parts[i].replace(/^\n/, '').replace(/\n$/, '')}</code></pre>`;
      continue;
    }
    const lines = parts[i].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const inline = (s) =>
        s
          .replaceAll(/`([^`]+)`/g, '<code>$1</code>')
          .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replaceAll(/\*([^*]+)\*/g, '<em>$1</em>');
      const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (h) {
        const level = Math.min(h[1].length + 2, 6);
        html += `<h${level}>${inline(h[2])}</h${level}>`;
      } else if (/^[-*]\s+/.test(trimmed)) {
        html += `<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
      } else if (/^─+\s*$/.test(trimmed) || /^═+\s*$/.test(trimmed)) {
        html += '<hr />';
      } else {
        html += `<p>${inline(line)}</p>`;
      }
    }
  }
  return html;
}
