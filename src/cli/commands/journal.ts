/**
 * Phase 37 — read the Journal.
 *
 *   human-out-of-the-loop journal [--project-root DIR] [--day YYYY-MM-DD]
 *     [--tool NAME] [--plan ID] [--failed] [--since 24h] [--limit N]
 *     [--json] [--stats]
 *
 * The Journal is the append-only record of what the AI *did* (phase 37): one
 * JSONL line per tool execution and per plan/step transition, written by
 * `<projectRoot>/.ai-runtime/journal/YYYY-MM-DD.jsonl`.  This command is the
 * human/machine view of it — the same relationship `logs` has with
 * `observability.jsonl`, which records the *run* rather than the actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out } from '../utils/output.js';

export interface JournalCommandOptions {
  projectRoot?: string;
  /** Only this day's file (`YYYY-MM-DD`). */
  day?: string;
  /** Only entries whose `tool` matches. */
  tool?: string;
  /** Only entries for this plan. */
  plan?: string;
  /** Only failures (`ok: false`). */
  failed?: boolean;
  /** Only entries newer than this (`30m`, `24h`, `7d` or an ISO timestamp). */
  since?: string;
  /** Trailing entries to print (default 50; 0 = all). */
  limit?: number;
  /** One JSON object per line, no decoration. */
  json?: boolean;
  /** Per-tool summary instead of the entries. */
  stats?: boolean;
  /** Path to the day file, for callers that only need the location. */
  file?: string;
  /** Print the resolved paths and exit. */
  paths?: boolean;
}

export interface JournalRecord {
  ts: string;
  kind: string;
  tool?: string;
  callId?: string;
  planId?: string;
  planStepId?: string;
  taskId?: string;
  agentId?: string;
  ok?: boolean;
  durationMs?: number;
  summary?: string;
  error?: string;
  code?: string;
  artifacts?: Array<{ path: string; bytes?: number }>;
  truncated?: boolean;
  [key: string]: unknown;
}

export function journalDirectory(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'journal');
}

/** Every journal file, oldest first. */
export function journalFiles(projectRoot: string): string[] {
  const dir = journalDirectory(projectRoot);
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort()
      .map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

/**
 * `30m` / `12h` / `7d` / ISO → epoch ms.  Returns undefined for "everything",
 * and `null` for a value that cannot be parsed (the caller reports it).
 */
export function parseSince(value: string | undefined, now = Date.now()): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  const relative = /^(\d+)\s*(m|min|h|d)$/i.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('m')
      ? amount * 60_000
      : unit === 'h'
        ? amount * 3_600_000
        : amount * 86_400_000;
    return now - ms;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Read every record, oldest first.  Corrupt lines are skipped, not fatal. */
export function readJournal(projectRoot: string, day?: string): JournalRecord[] {
  const files = day
    ? [path.join(journalDirectory(projectRoot), `${day}.jsonl`)].filter((file) =>
        fs.existsSync(file)
      )
    : journalFiles(projectRoot);

  const records: JournalRecord[] = [];
  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        // A half-written last line (a crash mid-write) must not hide the rest.
      }
    }
  }
  return records;
}

export function filterRecords(
  records: JournalRecord[],
  options: Pick<JournalCommandOptions, 'tool' | 'plan' | 'failed' | 'since'>
): JournalRecord[] {
  const since = parseSince(options.since);
  const sinceMs = typeof since === 'number' ? since : undefined;
  return records.filter((record) => {
    if (options.tool && record.tool !== options.tool) return false;
    if (options.plan && record.planId !== options.plan) return false;
    if (options.failed && record.ok !== false) return false;
    if (sinceMs !== undefined) {
      const ts = Date.parse(record.ts);
      if (Number.isNaN(ts) || ts < sinceMs) return false;
    }
    return true;
  });
}

function formatRecord(record: JournalRecord): string {
  const time = color.dim((record.ts ?? '').replace('T', ' ').replace(/\..*$/, ''));
  const kind = record.kind === 'tool' ? 'tool' : record.kind;
  const name = record.tool ?? kind;
  const status =
    record.ok === false
      ? color.failed('FAIL')
      : record.ok === true
        ? color.done('ok  ')
        : color.dim('—   ');
  const ms = typeof record.durationMs === 'number' ? color.dim(`${record.durationMs}ms`) : '';
  const plan = record.planId
    ? color.dim(` [${record.planId}${record.planStepId ? `/${record.planStepId}` : ''}]`)
    : '';
  const summary = record.summary ?? record.error ?? '';
  const artifacts =
    record.artifacts && record.artifacts.length > 0
      ? color.dim(` (${record.artifacts.map((a) => a.path).join(', ')})`)
      : '';
  return `${time} ${status} ${name.padEnd(24)}${ms.padStart(8)}${plan} ${summary}${artifacts}`;
}

/** Aggregate per-tool counts — the "what has this thing been doing?" view. */
export function journalStats(records: JournalRecord[]): Array<{
  tool: string;
  calls: number;
  failures: number;
  totalMs: number;
}> {
  const byTool = new Map<
    string,
    { tool: string; calls: number; failures: number; totalMs: number }
  >();
  for (const record of records) {
    if (record.kind !== 'tool' || !record.tool) continue;
    const entry = byTool.get(record.tool) ?? {
      tool: record.tool,
      calls: 0,
      failures: 0,
      totalMs: 0,
    };
    entry.calls++;
    if (record.ok === false) entry.failures++;
    if (typeof record.durationMs === 'number') entry.totalMs += record.durationMs;
    byTool.set(record.tool, entry);
  }
  return [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

export async function journalCommand(opts: JournalCommandOptions): Promise<number> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);

  if (opts.paths) {
    out(color.dim(`journal dir:  ${journalDirectory(projectRoot)}`));
    for (const file of journalFiles(projectRoot)) out(file);
    return 0;
  }

  if (opts.since !== undefined && parseSince(opts.since) === null) {
    err(color.failed(`--since "${opts.since}" is not a duration (30m, 12h, 7d) or a timestamp.`));
    return 2;
  }
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 0) {
    err(color.failed('--limit must be a non-negative integer (0 = all).'));
    return 2;
  }

  const files = journalFiles(projectRoot);
  if (files.length === 0) {
    err(
      color.dim(
        `No journal at ${journalDirectory(projectRoot)} (runs write it in persistent mode).`
      )
    );
    return 0;
  }

  const records = filterRecords(readJournal(projectRoot, opts.day), opts);

  if (opts.stats) {
    const stats = journalStats(records);
    if (opts.json) {
      out(JSON.stringify(stats, null, 2));
      return 0;
    }
    out(
      color.bold('tool'.padEnd(24)) +
        color.bold('calls'.padStart(6)) +
        color.bold('failed'.padStart(8)) +
        color.bold('total'.padStart(9))
    );
    for (const entry of stats) {
      out(
        `${entry.tool.padEnd(24)}${String(entry.calls).padStart(6)}${String(entry.failures).padStart(8)}${`${entry.totalMs}ms`.padStart(9)}`
      );
    }
    return 0;
  }

  // NOTE: `slice(-0)` is `slice(0)` — 0 means "all", so it is special-cased.
  const shown = limit > 0 ? records.slice(-limit) : records;
  for (const record of shown) {
    out(opts.json ? JSON.stringify(record) : formatRecord(record));
  }
  if (!opts.json && shown.length === 0) {
    err(color.dim('No journal entries match the filter.'));
  }
  return 0;
}
