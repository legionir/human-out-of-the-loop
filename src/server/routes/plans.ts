/**
 * Phase 24 (UI): plan routes.
 *
 *   GET    /api/plans                → list (id, status, progress, goal)
 *   GET    /api/plans/:id            → full plan JSON
 *   POST   /api/plans/:id/cancel     → cancel (store + CancellationManager)
 *   POST   /api/plans/:id/resume     → resume a partially done plan (202)
 *   POST   /api/plans/:id/confirm    → resolve a pending interactive
 *                                      confirmation (UI modal decision)
 *   GET    /api/observability        → observability.jsonl entries
 *                                      (?planId=&tail=)
 */
import fs from 'node:fs';
import { Router } from 'express';
import type { LogEntry } from '../../ai/runtime/observability-logger.js';
import type { RunState, ServerContext } from '../types.js';

export function plansRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/plans', (req, res) => {
    const ids = ctx.orchestrator.planStore.list();
    res.json(
      ids.map((id) => {
        const plan = ctx.orchestrator.planStore.load(id);
        const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
        return {
          id,
          status: plan?.status ?? 'unknown',
          goal: plan?.goal ?? '',
          stepsDone: done,
          stepsTotal: plan?.steps.length ?? 0,
          createdAt: plan?.createdAt ?? null,
        };
      }),
    );
  });

  router.get('/api/plans/:id', (req, res) => {
    const plan = ctx.orchestrator.planStore.load(req.params.id);
    if (!plan) {
      res.status(404).json({ error: `Plan "${req.params.id}" not found.` });
      return;
    }
    res.json(plan);
  });

  router.post('/api/plans/:id/cancel', async (req, res) => {
    const result = await ctx.orchestrator.cancelPlan(req.params.id);
    if (!result.success) {
      res.status(409).json({ error: result.message });
      return;
    }
    res.json({ ok: true, ...result });
  });

  router.post('/api/plans/:id/resume', async (req, res) => {
    const plan = ctx.orchestrator.planStore.load(req.params.id);
    if (!plan) {
      res.status(404).json({ error: `Plan "${req.params.id}" not found.` });
      return;
    }
    // Fire-and-track: resume executes in the background; progress flows
    // through the SSE stream for this plan id.
    ctx.orchestrator
      .resumePlan(req.params.id)
      .catch((err: unknown) => {
        ctx.hub.emit(
          req.params.id,
          'plan:error',
          { message: err instanceof Error ? err.message : String(err) },
        );
      });
    res.status(202).json({ ok: true, planId: req.params.id });
  });

  /**
   * Resolve the pending interactive confirmation for a plan.
   * The UI modal calls this with the user's decision:
   *   { confirmed: true }                     → execute
   *   { confirmed: false, feedback?: string } → reject (feedback to planner)
   */
  router.post('/api/plans/:id/confirm', (req, res) => {
    const { confirmed, feedback } = (req.body ?? {}) as {
      confirmed?: boolean;
      feedback?: string;
    };
    if (typeof confirmed !== 'boolean') {
      res.status(400).json({ error: 'Body must include boolean "confirmed".' });
      return;
    }
    const run = findAwaitingRun(ctx, req.params.id);
    if (!run) {
      res
        .status(409)
        .json({ error: `Plan "${req.params.id}" is not awaiting confirmation.` });
      return;
    }
    run.confirmResolver?.({
      confirmed,
      feedback: typeof feedback === 'string' && feedback.trim() !== '' ? feedback.trim() : undefined,
    });
    res.json({ ok: true, planId: req.params.id, confirmed });
  });

  /** Observability log (jsonl) — filter by plan, tail N lines. */
  router.get('/api/observability', (req, res) => {
    const planId = typeof req.query.planId === 'string' ? req.query.planId : undefined;
    const tail = Math.max(1, Number(req.query.tail ?? 100) || 100);

    let content = '';
    try {
      content = fs.readFileSync(ctx.logFilePath, 'utf-8');
    } catch {
      res.json({ entries: [] });
      return;
    }

    const entries = content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is LogEntry => e !== undefined && (!planId || e.planId === planId))
      .slice(-tail);

    res.json({ entries });
  });

  return router;
}

function findAwaitingRun(ctx: ServerContext, planId: string): RunState | undefined {
  for (const run of ctx.runs.values()) {
    if (run.state === 'awaiting-confirmation' && run.planId === planId) {
      return run;
    }
  }
  return undefined;
}
