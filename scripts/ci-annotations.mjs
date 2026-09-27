/**
 * Turn a Vitest JSON report into GitHub Actions error annotations.
 *
 * The Actions UI caps annotations per check; emitting hundreds of
 * `::error` lines just hides the rest.  We print at most MAX_ANNOTATIONS
 * and always include `line=` when Vitest (or the stack) names one.
 *
 * Keep behaviour in sync with `src/test-utils/github-annotations.ts`.
 */

export const MAX_ANNOTATIONS = 40;

function firstLine(text) {
  return String(text ?? '')
    .split('\n')[0]
    ?.trim() ?? 'failed';
}

function lineFromAssertion(assertion) {
  const loc = assertion.location ?? assertion.meta?.location;
  const fromLoc = loc?.line ?? loc?.start?.line ?? assertion.line;
  if (Number.isFinite(fromLoc) && fromLoc > 0) return Number(fromLoc);
  const stack = (assertion.failureMessages ?? []).join('\n');
  const match = /:(\d+)(?::\d+)?/.exec(stack);
  return match ? Number(match[1]) : undefined;
}

export function collectFailures(report) {
  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      const message = firstLine((assertion.failureMessages ?? []).join('\n'));
      failures.push({
        file: String(file.name ?? '').replace(/\\/g, '/'),
        title: assertion.fullName || assertion.title || 'unnamed test',
        message: message.slice(0, 900),
        line: lineFromAssertion(assertion),
      });
    }
  }
  return failures;
}

export function formatGithubAnnotations(failures, { max = MAX_ANNOTATIONS } = {}) {
  const lines = [];
  for (const failure of failures.slice(0, max)) {
    const linePart = failure.line ? `,line=${failure.line}` : '';
    lines.push(`::error file=${failure.file}${linePart}::${failure.title} — ${failure.message}`);
  }
  if (failures.length > max) {
    lines.push(`::error::…and ${failures.length - max} more failures (see the log)`);
  }
  return lines;
}
