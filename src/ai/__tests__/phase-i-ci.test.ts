import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectFailures,
  formatGithubAnnotations,
  MAX_ANNOTATIONS,
} from '../../test-utils/github-annotations.js';
import { waitUntil } from '../../test-utils/wait-until.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('I-03 — waitUntil instead of a guessed sleep', () => {
  it('resolves as soon as the predicate is true', async () => {
    let n = 0;
    await waitUntil(() => {
      n += 1;
      return n >= 3;
    });
    expect(n).toBe(3);
  });

  it('times out with a useful message', async () => {
    await expect(waitUntil(() => false, { timeoutMs: 40, intervalMs: 10, message: 'still false' })).rejects.toThrow(
      /still false/,
    );
  });

  it('succeeds twenty times in a row (no hidden sleep flake)', async () => {
    for (let i = 0; i < 20; i += 1) {
      await waitUntil(() => true, { timeoutMs: 50 });
    }
  });
});

describe('I-04 — CI runs once per PR', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('pushes only the default branch (not **)', () => {
    expect(yaml).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(yaml).not.toMatch(/branches:\s*\['\*\*'\]/);
  });

  it('shares a concurrency group across jobs of the same PR', () => {
    expect(yaml).toMatch(/group:\s*\$\{\{\s*github\.workflow\s*\}\}-/);
    expect(yaml).toContain('cancel-in-progress: true');
  });

  it('caches npm', () => {
    expect(yaml).toMatch(/cache:\s*npm/);
  });
});

describe('I-05 — GitHub annotations are capped and include line=', () => {
  it('emits at most MAX_ANNOTATIONS ::error lines, each with line=', () => {
    expect(MAX_ANNOTATIONS).toBe(40);
    const report = {
      testResults: [
        {
          name: `${ROOT}/src/foo.test.ts`,
          assertionResults: Array.from({ length: 45 }, (_, i) => ({
            status: 'failed',
            title: `case ${i}`,
            fullName: `suite case ${i}`,
            failureMessages: [`Error: boom\n    at src/foo.test.ts:${10 + i}:1`],
            location: { line: 10 + i },
          })),
        },
      ],
    };
    const failures = collectFailures(report);
    expect(failures).toHaveLength(45);
    expect(failures[0]!.line).toBe(10);
    const lines = formatGithubAnnotations(failures);
    expect(lines).toHaveLength(MAX_ANNOTATIONS + 1);
    expect(lines[0]).toMatch(/^::error file=.*foo\.test\.ts,line=10::/);
    expect(lines.at(-1)).toMatch(/5 more failures/);
  });
});

describe('I-06 — real-provider workflow', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/real-provider.yml'), 'utf8');

  it('greps Anthropic keys the same way as OpenAI', () => {
    expect(yaml).toContain('ANTHROPIC_API_KEY');
    expect(yaml).toMatch(/The Anthropic API key leaked/);
  });

  it('takes the model id from a variable, not a secret', () => {
    expect(yaml).toMatch(/vars\.HOTL_MODEL/);
    expect(yaml).not.toMatch(/secrets\.HOTL_MODEL/);
  });

  it('forwards HOTL_API_STYLE', () => {
    expect(yaml).toMatch(/HOTL_API_STYLE/);
    expect(yaml).toMatch(/vars\.HOTL_API_STYLE/);
  });

  it('skips a scheduled run that has no secret instead of failing', () => {
    expect(yaml).toMatch(/Scheduled run has no provider secret/);
    expect(yaml).toMatch(/github\.event_name.*schedule/);
  });
});
