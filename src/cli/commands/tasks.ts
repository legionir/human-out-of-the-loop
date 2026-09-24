/**
 * C2 (CLI completion): task introspection (read-only).
 *
 *   human-out-of-the-loop tasks list [--plan <planId>] [--project-root DIR] [--json]
 *   human-out-of-the-loop tasks show <taskId> [--project-root DIR]
 *
 * Tasks live in memory inside a running runtime, so cross-process
 * introspection reads the observability log: `task:created` →
 * `task:completed` / `task:failed` (with per-task usage in the payload).
 * (Cancelling a single task from another process is impossible by
 * design — in-process only.)
 */
import path from 'node:path';
import { prepareCliEnvironment } from '../utils/config.js';
import { filterEntries, readLogEntries, type RawLogEntry } from '../utils/log-reader.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface TasksCommandOptions {
  projectRoot?: string;
  plan?: string;
  json?: boolean;
}

interface TaskInfo {
  taskId: string;
  planId?: string;
  stepId?: string;
  status: 'done' | 'failed' | 'running';
  toolsUsed: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  startedAt?: string;
  endedAt?: string;
  lastMessage?: string;
}

function buildTaskMap(entries: RawLogEntry[]): Map<string, TaskInfo> {
  const tasks = new Map<string, TaskInfo>();
  for (const e of entries) {
    if (!e.taskId) continue;
    let t = tasks.get(e.taskId);
    if (!t) {
      t = {
        taskId: e.taskId,
        planId: e.planId,
        stepId: e.stepId,
        status: 'running',
        toolsUsed: [],
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        startedAt: e.timestamp,
        lastMessage: e.message,
      };
      tasks.set(e.taskId, t);
    }
    // planId/stepId may appear first on a later event (older logs)
    t.planId ??= e.planId;
    t.stepId ??= e.stepId;
    t.lastMessage = e.message;
    switch (e.eventType) {
      case 'task:tool-call':
        t.toolCalls++;
        break;
      case 'task:completed': {
        t.status = 'done';
        t.endedAt = e.timestamp;
        const tools = e.payload?.toolsUsed;
        if (Array.isArray(tools)) t.toolsUsed = tools as string[];
        const usage = e.payload?.usage as
          | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
          | undefined;
        t.promptTokens = usage?.promptTokens ?? 0;
        t.completionTokens = usage?.completionTokens ?? 0;
        t.totalTokens = usage?.totalTokens ?? 0;
        break;
      }
      case 'task:failed':
        t.status = 'failed';
        t.endedAt = e.timestamp;
        break;
      default:
        break;
    }
  }
  return tasks;
}

function logFileFor(root: string): string {
  return path.join(root, '.ai-runtime', 'observability.jsonl');
}

export async function tasksListCommand(opts: TasksCommandOptions): Promise<number> {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(root);
  const { entries, parseErrors } = readLogEntries(logFileFor(root));

  const scoped = opts.plan
    ? filterEntries(entries, { planId: opts.plan })
    : entries;

  const tasks = [...buildTaskMap(scoped).values()].sort((a, b) =>
    (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
  );

  if (opts.plan && tasks.length === 0) {
    out(
      color.dim(
        `No task events for plan "${opts.plan}".` +
          (entries.some((e) => e.planId === undefined && e.taskId)
            ? ' Note: task events in logs written before the planId threading fix carry no planId and cannot be filtered.'
            : ''),
      ),
    );
    return 0;
  }

  if (tasks.length === 0) {
    out(color.dim('No tasks recorded yet (nothing in the observability log).'));
    return 0;
  }

  if (opts.json) {
    out(JSON.stringify(tasks, null, 2));
    if (parseErrors > 0) out(color.dim(`(${parseErrors} unparseable log line(s) skipped)`));
    return 0;
  }

  out(
    renderTable(
      ['TASK', 'PLAN', 'STEP', 'STATUS', 'TOOLS USED', 'CALLS', 'TOKENS'],
      tasks.map((t) => [
        shortId(t.taskId),
        t.planId ? shortId(t.planId) : '—',
        t.stepId ?? '—',
        t.status === 'done' ? color.done(t.status) : t.status === 'failed' ? color.failed(t.status) : color.running(t.status),
        t.toolsUsed.join(', ') || '—',
        t.toolCalls,
        t.totalTokens,
      ]),
    ),
  );
  const done = tasks.filter((t) => t.status === 'done').length;
  out(color.dim(`${tasks.length} task(s): ${done} done, ${tasks.length - done} other`));
  if (parseErrors > 0) out(color.dim(`(${parseErrors} unparseable log line(s) skipped)`));
  return 0;
}

export async function tasksShowCommand(taskId: string, opts: TasksCommandOptions): Promise<number> {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(root);
  const { entries } = readLogEntries(logFileFor(root));
  const mine = filterEntries(entries, { taskId });
  if (mine.length === 0) {
    err(color.failed(`No log entries for task "${taskId}".`));
    return 1;
  }
  for (const e of mine) {
    out(
      color.dim(e.timestamp) +
        `  ${e.eventType}` +
        (e.planId ? color.dim(` [${shortId(e.planId)}]`) : '') +
        `  ${e.message}`,
    );
    if (e.payload && Object.keys(e.payload).length > 0) {
      out(color.dim(`    payload: ${JSON.stringify(e.payload)}`));
    }
  }
  return 0;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 15)}…` : id;
}
