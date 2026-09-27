/**
 * U6 (UI completion plan): usage + live task introspection.
 *
 *   GET  /api/usage                → in-memory aggregate for THIS server
 *                                    process (summary + per-plan breakdown)
 *   GET  /api/usage?planId=P       → that plan's tokens + task count
 *   GET  /api/runs/:runId/tasks    → tasks of the run's plan (with counts)
 *   POST /api/runs/:runId/tasks/:taskId/cancel → cancel ONE task
 *
 * Why this is real (and not a toy): both the UsageAggregator and the
 * TaskRuntime live in the SAME process as the API, so the numbers and the
 * cancellation are authoritative for this server run.  They are in-memory
 * only: restarting the server resets the aggregate (the durable per-plan
 * total stays in `plan.json` → review.usage).
 */
import { Router } from 'express';
import type { Task } from '../../ai/schemas/task.js';
import { collectProjectUsage } from '../../cli/commands/usage.js';
import { sendOwnerForbidden } from '../run-control.js';
import type { ServerContext } from '../types.js';

/** Compact, wire-safe view of a task (no prompts beyond a short preview). */
function toWireTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    agentId: task.agentDefinitionOrId,
    planStepId: task.planStepId ?? null,
    summary: task.summary ?? null,
    usage: task.usage ?? null,
    failureType: task.failureType ?? null,
    errors: task.errors,
    claimedResources: task.claimedResources,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
  };
}

export function usageRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/usage', (req, res) => {
    const { planId } = req.query as { planId?: string };
    const fromLog = collectProjectUsage(ctx.projectRoot);
    const empty = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      taskCount: 0,
    };
    if (planId !== undefined) {
      if (typeof planId !== 'string' || planId.trim() === '') {
        res.status(400).json({ error: '"planId" must be a non-empty string when present.' });
        return;
      }
      const row = fromLog.rows.find((r) => r.planId === planId);
      const usage = row
        ? {
            promptTokens: row.promptTokens,
            completionTokens: row.completionTokens,
            totalTokens: row.totalTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            taskCount: row.taskCount,
          }
        : ctx.orchestrator.usageAggregator.getPlanUsage(planId);
      res.json({ planId, ...usage });
      return;
    }
    // G-14: durable numbers from observability.jsonl (same as `hootl usage`).
    // Overlay in-memory totals when the log is still empty for this process.
    const live = ctx.orchestrator.usageAggregator.getSummary();
    const totals = fromLog.rows.length > 0 ? fromLog.totals : empty;
    const totalTokens = fromLog.rows.length > 0 ? totals.totalTokens : live.totalTokens;
    const byPlan: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number; count: number }> =
      {};
    if (fromLog.rows.length > 0) {
      for (const row of fromLog.rows) {
        byPlan[row.planId] = {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          count: row.taskCount,
        };
      }
    } else {
      Object.assign(byPlan, live.byPlan);
    }
    res.json({
      ...live,
      promptTokens: fromLog.rows.length > 0 ? totals.promptTokens : live.totalPromptTokens,
      completionTokens: fromLog.rows.length > 0 ? totals.completionTokens : live.totalCompletionTokens,
      totalTokens,
      taskCount: fromLog.rows.length > 0 ? totals.taskCount : live.taskCount,
      byPlan,
      plans: fromLog.rows,
      totals,
    });
  });

  router.get('/api/runs/:runId/tasks', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    if (sendOwnerForbidden(ctx, req, res, run.ownerToken)) return;
    // Tasks are owned by the plan (the TaskRuntime is shared across runs —
    // that is what keeps the resource locks meaningful).
    const tasks = run.planId
      ? ctx.orchestrator.taskRuntime.getAllTasks().filter((t) => t.planId === run.planId)
      : [];
    res.json({
      runId: run.runId,
      planId: run.planId ?? null,
      tasks: tasks.map(toWireTask),
      counts: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        running: tasks.filter((t) => t.status === 'running').length,
        completed: tasks.filter((t) => t.status === 'completed').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      },
    });
  });

  router.post('/api/runs/:runId/tasks/:taskId/cancel', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    if (sendOwnerForbidden(ctx, req, res, run.ownerToken)) return;
    const task = ctx.orchestrator.taskRuntime.getDetails(req.params.taskId);
    // Scope check: a task is only cancellable through the run that owns its plan.
    if (!task || !run.planId || task.planId !== run.planId) {
      res
        .status(404)
        .json({ error: `Task "${req.params.taskId}" does not belong to run "${run.runId}".` });
      return;
    }
    if (task.status !== 'pending' && task.status !== 'running') {
      res.status(409).json({
        error: `Task "${task.id}" is already ${task.status} — nothing to cancel.`,
        status: task.status,
      });
      return;
    }
    const cancelled = ctx.orchestrator.taskRuntime.cancelTask(task.id);
    res.json({ ok: cancelled, taskId: task.id, status: cancelled ? 'cancelled' : task.status });
  });

  return router;
}
