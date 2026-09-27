/**
 * C2 (CLI completion): tolerant reader for the observability log
 * (`.ai-runtime/observability.jsonl`).
 *
 * The log is the only DURABLE record of task-level detail (tasks and
 * per-task usage are in-memory in the runtime), so the `usage` and
 * `tasks` commands are built on it.  Malformed lines are counted, not
 * thrown — a partially written last line must never break the CLI.
 */
import fs from 'node:fs';

export interface RawLogEntry {
  timestamp: string;
  epochMs: number;
  planId?: string;
  stepId?: string;
  taskId?: string;
  eventType: string;
  message: string;
  payload?: Record<string, unknown>;
  level: string;
}

export interface LogReadResult {
  entries: RawLogEntry[];
  /** Lines that were not parseable JSON (reported, not fatal). */
  parseErrors: number;
}

export function readLogEntries(file: string): LogReadResult {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { entries: [], parseErrors: 0 };
  }
  const entries: RawLogEntry[] = [];
  let parseErrors = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawLogEntry;
      if (parsed && typeof parsed.eventType === 'string') {
        entries.push(parsed);
      } else {
        parseErrors++;
      }
    } catch {
      parseErrors++;
    }
  }
  return { entries, parseErrors };
}

export function filterEntries(
  entries: RawLogEntry[],
  opts: { planId?: string; taskId?: string; eventTypes?: string[] } = {},
): RawLogEntry[] {
  return entries.filter((e) => {
    if (opts.planId !== undefined && e.planId !== opts.planId) return false;
    if (opts.taskId !== undefined && e.taskId !== opts.taskId) return false;
    if (opts.eventTypes && !opts.eventTypes.includes(e.eventType)) return false;
    return true;
  });
}

/**
 * Usage totals from `task:completed` (agent turns) and `llm:usage`
 * (planning / acceptance / review calls) payloads, both TokenUsage-shaped.
 * Only `task:completed` counts as a task.
 */
export function sumUsageFromEntries(entries: RawLogEntry[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
} {
  const totals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    taskCount: 0,
  };
  for (const e of entries) {
    if (e.eventType === 'task:completed') totals.taskCount++;
    else if (e.eventType !== 'llm:usage') continue;
    const usage = e.payload?.usage as
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined;
    totals.promptTokens += usage?.promptTokens ?? 0;
    totals.completionTokens += usage?.completionTokens ?? 0;
    totals.totalTokens += usage?.totalTokens ?? 0;
    totals.cacheReadTokens += usage?.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
  }
  return totals;
}
