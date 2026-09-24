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
 * Usage: node scripts/ci-test.mjs [extra vitest args]
 * Exits with vitest's own exit code.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPORT_DIR = path.resolve('.ci');
const REPORT_FILE = path.join(REPORT_DIR, 'vitest.json');
const MAX_ANNOTATIONS = 40;

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

  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      const message = (assertion.failureMessages ?? []).join('\n').split('\n')[0]?.trim() ?? 'failed';
      failures.push({
        file: path.relative(process.cwd(), String(file.name ?? '')).replace(/\\/g, '/'),
        title: assertion.fullName || assertion.title || 'unnamed test',
        message: message.slice(0, 900),
      });
    }
  }

  const totals = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  console.log(`\n${passed}/${totals} tests passed`);

  if (failures.length === 0) process.exit(code ?? 0);

  console.log(`\n${failures.length} failing test(s):`);
  for (const failure of failures) {
    console.log(`  ${failure.file} :: ${failure.title}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=${failure.file}::${failure.title} — ${failure.message}`);
    }
  }
  if (failures.length > MAX_ANNOTATIONS && process.env.GITHUB_ACTIONS) {
    console.log(`::error::…and ${failures.length - MAX_ANNOTATIONS} more failures (see the log)`);
  }
  process.exit(code === 0 ? 1 : (code ?? 1));
});
