/**
 * Turn a Vitest JSON report into GitHub Actions error annotations.
 *
 * The Actions UI caps annotations per check; emitting hundreds of
 * `::error` lines just hides the rest.  We print at most MAX_ANNOTATIONS
 * and always include `line=` when Vitest (or the stack) names one.
 */

export const MAX_ANNOTATIONS = 40;

export interface TestFailure {
  file: string;
  title: string;
  message: string;
  line?: number;
}

function firstLine(text: unknown): string {
  return String(text ?? '')
    .split('\n')[0]
    ?.trim() ?? 'failed';
}

function lineFromAssertion(assertion: Record<string, unknown>): number | undefined {
  const loc = (assertion.location ?? (assertion.meta as { location?: unknown } | undefined)?.location) as
    | { line?: number; start?: { line?: number } }
    | undefined;
  const fromLoc = loc?.line ?? loc?.start?.line ?? assertion.line;
  if (typeof fromLoc === 'number' && Number.isFinite(fromLoc) && fromLoc > 0) return fromLoc;
  const stack = ((assertion.failureMessages as string[] | undefined) ?? []).join('\n');
  const match = /:(\d+)(?::\d+)?/.exec(stack);
  return match ? Number(match[1]) : undefined;
}

export function collectFailures(report: { testResults?: Array<Record<string, unknown>> }): TestFailure[] {
  const failures: TestFailure[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of (file.assertionResults as Array<Record<string, unknown>> | undefined) ?? []) {
      if (assertion.status !== 'failed') continue;
      const message = firstLine(((assertion.failureMessages as string[] | undefined) ?? []).join('\n'));
      failures.push({
        file: String(file.name ?? '').replace(/\\/g, '/'),
        title: String(assertion.fullName || assertion.title || 'unnamed test'),
        message: message.slice(0, 900),
        line: lineFromAssertion(assertion),
      });
    }
  }
  return failures;
}

export function formatGithubAnnotations(
  failures: TestFailure[],
  { max = MAX_ANNOTATIONS }: { max?: number } = {},
): string[] {
  const lines: string[] = [];
  for (const failure of failures.slice(0, max)) {
    const linePart = failure.line ? `,line=${failure.line}` : '';
    lines.push(`::error file=${failure.file}${linePart}::${failure.title} — ${failure.message}`);
  }
  if (failures.length > max) {
    lines.push(`::error::…and ${failures.length - max} more failures (see the log)`);
  }
  return lines;
}
