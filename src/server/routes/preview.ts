/**
 * U4 (UI completion plan): `POST /api/preview` — plan WITHOUT side effects.
 *
 *   POST /api/preview { message } → 200 { ok: true, planId: null,
 *                                        plan, planText, feasibility, cycles }
 *                                 | 200 { ok: false, plan?, feasibility?,
 *                                        cycles?, error }   (infeasible plan)
 *                                 | 400 { error, questions }  (needs clarification)
 *
 * Contract (enforced by the deferred `previewPlan` pipeline):
 *   - no session is created, no interaction is recorded
 *   - no plan is written to the plan store (nothing to resume/cancel)
 *   - nothing is executed
 * `planId` is therefore always `null`: the plan is returned to the caller
 * only, and the UI renders it read-only.
 */
import { Router } from 'express';
import type { ServerContext } from '../types.js';

export function previewRouter(ctx: ServerContext): Router {
  const router = Router();

  router.post('/api/preview', async (req, res) => {
    const { message, model } = (req.body ?? {}) as { message?: unknown; model?: unknown };
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'Body must include a non-empty "message".' });
      return;
    }

    try {
      const preview = await ctx.orchestrator.previewPlan(
        message.trim(),
        typeof model === 'string' && model.trim() ? model.trim() : undefined,
      );

      // v27.17.0: a request the planner answers instead of planning.  There is
      // no plan to render — the answer IS the response (ok: true, no planId).
      if (preview.ok && preview.answer !== undefined) {
        res.json({ ok: true, answer: preview.answer, planId: null });
        return;
      }

      // Unclear request: the planner wants clarification before planning.
      // This is a *request* problem, not a planning outcome → 400 + questions.
      if (!preview.ok && preview.needsClarification?.length) {
        res.status(400).json({
          error: preview.error,
          questions: preview.needsClarification,
        });
        return;
      }

      // Feasibility/cycle failures are planning *outcomes*: the caller gets
      // 200 with ok:false so the UI can still render the rejected plan.
      res.json({
        ...preview,
        planId: null,
      });
    } catch (err) {
      res.status(500).json({
        error: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  return router;
}
