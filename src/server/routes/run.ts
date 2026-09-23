/**
 * Phase 24 (UI): run routes.
 *
 *   POST /api/run          { message, sessionId?, confirm? } → 202 { runId }
 *   GET  /api/runs/:runId  → live run state (UI polls until terminal)
 *
 * The interactive flow:
 *   1. UI posts { message, sessionId?, confirm: false }
 *   2. Server starts Orchestrator.run() in the background; when the plan
 *      is ready the confirmCallback pauses and stores the plan text.
 *   3. UI polls the run → sees 'awaiting-confirmation' + planId → renders
 *      the plan modal (table from GET /api/plans/:id) and subscribes to
 *      SSE /api/stream/:planId.
 *   4. UI posts /api/plans/:id/confirm { confirmed, feedback? } → the
 *      callback resolves and execution proceeds (or the run is cancelled).
 *   5. UI watches SSE for live progress and polls until state 'done'
 *      (report + outcome).
 *
 * `confirm: true` skips the modal entirely (auto-confirm — the
 * Human-Out-Of-Loop mode from the web UI).
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Plan } from '../../ai/schemas/plan.js';
import type { ServerContext } from '../types.js';

export function runRouter(ctx: ServerContext): Router {
  const router = Router();

  router.post('/api/run', async (req, res) => {
    const { message, sessionId, confirm } = (req.body ?? {}) as {
      message?: unknown;
      sessionId?: unknown;
      confirm?: unknown;
    };
    // NOTE (UI security step): `projectRoot` intentionally does NOT come
    // from the request body — it is fixed server-side (config/env).
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'Body must include a non-empty "message".' });
      return;
    }
    // JSON `null` is a natural way to express "no session" — treat it
    // the same as an absent field.
    if (sessionId != null && typeof sessionId !== 'string') {
      res.status(400).json({ error: '"sessionId" must be a string when present.' });
      return;
    }
    const autoConfirm = confirm === true;

    const runId = randomUUID();
    ctx.runs.set(runId, {
      runId,
      sessionId: sessionId as string | undefined,
      state: 'planning',
      createdAt: Date.now(),
    });
    const run = ctx.runs.get(runId)!;

    // Detached: the HTTP response returns immediately (202); the run's
    // lifecycle is observable via GET /api/runs/:runId + SSE.
    void (async () => {
      try {
        const result = await ctx.orchestrator.run(message.trim(), {
          sessionId: run.sessionId,
          confirmCallback: async (planText: string, plan?: Plan) => {
            run.planId = plan?.id ?? run.planId;
            if (autoConfirm) {
              run.state = 'running';
              return { confirmed: true };
            }
            run.state = 'awaiting-confirmation';
            run.planText = planText;
            if (run.planId) {
              ctx.hub.emit(run.planId, 'awaiting-confirmation', {
                planId: run.planId,
                planText,
              });
            }
            return new Promise((resolve) => {
              run.confirmResolver = (decision) => {
                run.state = 'running';
                resolve(decision);
              };
            });
          },
        });

        run.sessionId = result.sessionId;
        run.state = 'done';
        run.outcome = result.review.outcome;
        run.report = result.report;
        if (run.planId) {
          ctx.hub.emit(run.planId, 'run:done', {
            runId,
            outcome: result.review.outcome,
          });
        }
      } catch (err) {
        run.state = 'error';
        run.error = err instanceof Error ? err.message : String(err);
      }
    })();

    res.status(202).json({ runId, autoConfirm });
  });

  router.get('/api/runs/:runId', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    // Never leak the resolver to the wire.
    const { confirmResolver, ...publicState } = run;
    res.json(publicState);
  });

  return router;
}
