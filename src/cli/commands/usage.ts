/**
 * C2 (CLI completion): token usage reporting.
 *
 *   human-out-of-the-loop usage [--plan <planId>] [--project-root DIR] [--json]
 *
 * Source of truth: the observability log — `task:completed` events carry
 * the per-task usage, and (since the planId threading fix) their planId,
 * so per-plan totals work after the fact, in a different process.
 * The plan store supplies goal/status context for persisted plans.
 */
import path from 'node:path';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { prepareCliEnvironment } from '../utils/config.js';
import {
  filterEntries,
  readLogEntries,
  sumUsageFromEntries,
  type RawLogEntry,
} from '../utils/log-reader.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface UsageCommandOptions {
  projectRoot?: string;
  plan?: string;
  json?: boolean;
}

export interface UsageRow {
  planId: string;
  goal: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export function collectProjectUsage(projectRoot: string): {
  rows: UsageRow[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    taskCount: number;
  };
  runtimeDir: string;
} {
  const root = path.resolve(projectRoot);
  const runtimeDir = path.join(root, '.ai-runtime');
  const { entries } = readLogEntries(path.join(runtimeDir, 'observability.jsonl'));
  const completed = filterEntries(entries, { eventTypes: ['task:completed', 'llm:usage'] });

  // Context from the plan store (may be empty for non-persistent runs).
  let planContext: Map<string, { goal: string; status: string }> = new Map();
  try {
    const store = new FilePlanStore(path.join(runtimeDir, 'plans'));
    for (const id of store.list()) {
      const plan = store.load(id);
      if (plan) planContext.set(plan.id ?? id, { goal: plan.goal, status: plan.status });
    }
  } catch {
    // no store dir → log-only mode
  }

  // Per-plan totals from the log.
  const byPlan = new Map<string, ReturnType<typeof sumUsageFromEntries>>();
  for (const [planId, group] of groupByPlan(completed)) {
    byPlan.set(planId, sumUsageFromEntries(group));
  }

  // A plan may live in the store without any completed task (e.g.
  // cancelled before execution) → zero row, still listed.
  const ids = new Set<string>([...byPlan.keys(), ...planContext.keys()]);

  const rows: UsageRow[] = [...ids]
    .map((id) => {
      const usage = byPlan.get(id) ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        taskCount: 0,
      };
      const ctx = planContext.get(id);
      return {
        planId: id,
        goal: ctx?.goal ?? '(not persisted)',
        status: ctx?.status ?? '—',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        taskCount: usage.taskCount,
      };
    })
    .sort((a, b) => a.planId.localeCompare(b.planId));

  const totals = rows.reduce(
    (acc, r) => ({
      promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      taskCount: acc.taskCount + r.taskCount,
    }),
    {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      taskCount: 0,
    },
  );
  return { rows, totals, runtimeDir };
}

export async function usageCommand(opts: UsageCommandOptions): Promise<number> {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(root);
  const { rows, totals, runtimeDir } = collectProjectUsage(root);

  if (rows.length === 0) {
    out(
      color.dim(
        'No usage recorded yet — run a goal with --persistent, then `usage` ' +
          `(or look in ${runtimeDir}/observability.jsonl).`,
      ),
    );
    return 0;
  }

  if (opts.plan) {
    const row = rows.find((r) => r.planId === opts.plan);
    if (!row) {
      err(color.failed(`No usage found for plan "${opts.plan}".`));
      return 1;
    }
    if (opts.json) {
      out(JSON.stringify(row, null, 2));
    } else {
      out(`Plan ${row.planId}  ${color.dim(`(${row.status})`)}  ${color.dim(row.goal)}`);
      out(renderTable(['PROMPT', 'COMPLETION', 'TOTAL', 'CACHE_READ', 'CACHE_WRITE', 'TASKS'], [[
        row.promptTokens,
        row.completionTokens,
        row.totalTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.taskCount,
      ]]));
    }
    return 0;
  }

  if (opts.json) {
    const grand = rows.reduce(
      (acc, r) => ({
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
        taskCount: acc.taskCount + r.taskCount,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        taskCount: 0,
      },
    );
    out(JSON.stringify({ plans: rows, totals: grand }, null, 2));
    return 0;
  }

  out(
    renderTable(
      ['PLAN', 'STATUS', 'GOAL', 'PROMPT', 'COMPLETION', 'TOTAL', 'CACHE_READ', 'CACHE_WRITE', 'TASKS'],
      rows.map((r) => [
        shortId(r.planId),
        r.status,
        truncate(r.goal, 40),
        r.promptTokens,
        r.completionTokens,
        r.totalTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.taskCount,
      ]),
    ),
  );
  const grand = rows.reduce(
    (acc, r) => ({
      prompt: acc.prompt + r.promptTokens,
      completion: acc.completion + r.completionTokens,
      total: acc.total + r.totalTokens,
      cacheRead: acc.cacheRead + r.cacheReadTokens,
      cacheWrite: acc.cacheWrite + r.cacheWriteTokens,
      tasks: acc.tasks + r.taskCount,
    }),
    { prompt: 0, completion: 0, total: 0, cacheRead: 0, cacheWrite: 0, tasks: 0 },
  );
  out(
    color.dim(
      `Totals: ${grand.prompt} prompt + ${grand.completion} completion = ${grand.total} tokens` +
        ` (cache ${grand.cacheRead} read / ${grand.cacheWrite} write) across ${grand.tasks} task(s)`,
    ),
  );
  return 0;
}

function groupByPlan(entries: RawLogEntry[]): Map<string, RawLogEntry[]> {
  const map = new Map<string, RawLogEntry[]>();
  for (const e of entries) {
    const key = e.planId ?? '(unattributed)';
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  return map;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 15)}…` : id;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
