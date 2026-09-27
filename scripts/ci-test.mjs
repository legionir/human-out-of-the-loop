#!/usr/bin/env node
/**
 * Run the suite and turn failures into GitHub **annotations**.
 *
 * A red job whose log nobody can open is not much use: the Windows/macOS
 * runners are the only place some bugs appear, and the log download can be
 * unavailable (it is a blob-storage redirect).  Annotations are attached to
 * the check run itself, so every failing test is readable from the API and
 * from the PR's Checks tab, in one line each:
 *
 *     ::error file=src/foo.test.ts,line=42::test name — assertion message
 *
 * At most MAX_ANNOTATIONS `::error` lines are emitted so the Checks UI
 * does not drop the rest; each includes `line=` when Vitest names one.
 *
 * Usage: node scripts/ci-test.mjs [extra vitest args]
 * Exits with vitest's own exit code.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collectFailures, formatGithubAnnotations, MAX_ANNOTATIONS } from './ci-annotations.mjs';

const REPORT_DIR = path.resolve('.ci');
const REPORT_FILE = path.join(REPORT_DIR, 'vitest.json');

fs.rmSync(REPORT_DIR, { recursive: true, force: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

const args = [
  'vitest',
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${REPORT_FILE}`,
  ...process.argv.slice(2),
];

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('close', (code) => {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
  } catch {
    // No report (collection error, crash): the log already carries it.
    process.exit(code ?? 1);
  }

  const failures = collectFailures(report).map((failure) => ({
    ...failure,
    file: path.relative(process.cwd(), failure.file).replace(/\\/g, '/'),
  }));

  const totals = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  console.log(`\n${passed}/${totals} tests passed`);

  if (failures.length === 0) process.exit(code ?? 0);

  const shown = Math.min(failures.length, MAX_ANNOTATIONS);
  console.log(`\n${failures.length} failing test(s) (annotating ${shown}):`);
  for (const failure of failures.slice(0, shown)) {
    console.log(`  ${failure.file}${failure.line ? `:${failure.line}` : ''} :: ${failure.title}`);
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const line of formatGithubAnnotations(failures)) {
      console.log(line);
    }
  }
  process.exit(code === 0 ? 1 : (code ?? 1));
});
