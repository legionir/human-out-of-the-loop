/**
 * Phase 23 (CLI): terminal output helpers.
 *
 * All CLI output funnels through `out()` so tests can capture it with a
 * single spy on process.stdout.write.  (The CLI — unlike the src/ai
 * runtime — is user-facing and may use any output channel it likes.)
 *
 * Phase 32: `out()` also erases the line an active activity spinner
 * (`utils/activity.ts`) draws on, so the "still working" line can never
 * eat or duplicate a real line of output.
 */
import chalk, { type ChalkInstance } from 'chalk';
import { clearActiveActivityLine } from './activity.js';

/** Write a line to stdout (the single capture point for tests). */
export function out(text = ''): void {
  clearActiveActivityLine();
  process.stdout.write(text + '\n');
}

/** Write to stderr (errors, usage hints). */
export function err(text = ''): void {
  process.stderr.write(text + '\n');
}

/** Colored status glyphs, per the plan: done=green, failed=red, running=yellow. */
export const color = {
  done: chalk.green,
  failed: chalk.red,
  running: chalk.yellow,
  info: chalk.cyan,
  warn: chalk.magenta,
  dim: chalk.dim,
  bold: chalk.bold,
  /**
   * Phase 32: the model's own thinking text — italic and violet, so it is
   * never mistaken for the run's status lines (which are yellow/cyan).
   *
   * A getter on purpose: `chalk.hex()` resolves the escape codes against
   * `chalk.level` when it is called, and `chalk.level` is only known once
   * stdout has been inspected (0 under a test runner, 3 in a colour
   * terminal).  Building it eagerly would freeze whatever the level was at
   * import time.
   */
  get thinking(): ChalkInstance {
    return chalk.italic.hex('#a78bfa');
  },
};

/**
 * Simple column table renderer (no dependency): pads each column to the
 * max width across rows.  `header` is rendered bold.
 */
export function renderTable(header: string[], rows: Array<Array<string | number>>): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells: Array<string | number>): string =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
