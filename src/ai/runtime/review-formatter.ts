import type { Review } from '../schemas/review.js';

// ─── User-facing report formatter ────────────────────────────────

/**
 * Convert a structured Review into a human-readable text report.
 * This is what the user actually sees at the end of a plan execution.
 *
 * The formatter is deterministic and does NOT invoke the model —
 * it purely transforms the Review structure.
 */
export function formatReviewForUser(review: Review): string {
  const lines: string[] = [];

  const outcomeIcon = {
    success: '✅',
    'partial-success': '⚠️ ',
    failure: '❌',
    cancelled: '🛑',
  }[review.outcome];

  lines.push(`═══════════════════════════════════════════════════`);
  lines.push(`  ${outcomeIcon} FINAL REPORT`);
  lines.push(`═══════════════════════════════════════════════════`);
  lines.push(``);
  lines.push(`Plan:    ${review.planId}`);
  lines.push(`Goal:    ${review.goal}`);
  lines.push(`Outcome: ${review.outcome.toUpperCase()}`);

  if (review.usage) {
    lines.push(
      `Usage:   ${review.usage.totalTokens} tokens ` +
        `(${review.usage.totalPromptTokens} prompt + ${review.usage.totalCompletionTokens} completion)`
    );
  }

  lines.push(``);
  lines.push(`───────────────────────────────────────────────────`);
  lines.push(`  Summary`);
  lines.push(`───────────────────────────────────────────────────`);
  lines.push(review.finalSummary);
  lines.push(``);

  // Accepted findings
  if (review.acceptedFindings.length > 0) {
    lines.push(`───────────────────────────────────────────────────`);
    lines.push(`  ✓ Accepted Findings (${review.acceptedFindings.length})`);
    lines.push(`───────────────────────────────────────────────────`);
    for (const f of review.acceptedFindings) {
      const sev =
        f.severity === 'critical' ? '[!]' : f.severity === 'warning' ? '[~]' : '[i]';
      lines.push(`  ${sev} [${f.stepId}] ${f.title}`);
      lines.push(`      ${f.description}`);
      lines.push(``);
    }
  }

  // Rejected findings
  if (review.rejectedFindings.length > 0) {
    lines.push(`───────────────────────────────────────────────────`);
    lines.push(`  ✗ Rejected Findings (${review.rejectedFindings.length})`);
    lines.push(`───────────────────────────────────────────────────`);
    for (const f of review.rejectedFindings) {
      const sev =
        f.severity === 'critical' ? '[!]' : f.severity === 'warning' ? '[~]' : '[i]';
      lines.push(`  ${sev} [${f.stepId}] ${f.title}`);
      lines.push(`      ${f.description}`);
      lines.push(``);
    }
  }

  // Incomplete steps
  if (review.incompleteSteps.length > 0) {
    lines.push(`───────────────────────────────────────────────────`);
    lines.push(`  ⏸ Incomplete Steps (${review.incompleteSteps.length})`);
    lines.push(`───────────────────────────────────────────────────`);
    for (const s of review.incompleteSteps) {
      const type = s.failureType ? ` (${s.failureType})` : '';
      lines.push(`  • [${s.stepId}]${type}: ${s.description}`);
      lines.push(`      Reason: ${s.reason}`);
      lines.push(``);
    }
  }

  lines.push(`═══════════════════════════════════════════════════`);

  return lines.join('\n');
}

/**
 * Compact one-line summary for logging or status displays.
 */
export function formatReviewOneLine(review: Review): string {
  const total =
    review.acceptedFindings.length +
    review.rejectedFindings.length +
    review.incompleteSteps.length;

  return (
    `[${review.outcome}] ${review.planId} — ` +
    `${review.acceptedFindings.length} accepted, ` +
    `${review.rejectedFindings.length} rejected, ` +
    `${review.incompleteSteps.length} incomplete ` +
    `(${total} total findings)`
  );
}
