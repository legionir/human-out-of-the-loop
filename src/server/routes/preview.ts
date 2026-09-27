/**
 * U4 (UI completion plan): `POST /api/preview` — plan WITHOUT side effects.
 *
 *   POST /api/preview { message, model?, mode? } → 200 { ok: true, planId: null,
 *                                        previewId?, plan, planText, feasibility, cycles }
 *                                 | 200 { ok: true, answer, planId: null }
 *                                 | 200 { ok: false, plan?, feasibility?,
 *                                        cycles?, error }   (infeasible plan)
 *                                 | 400 { error, questions }  (needs clarification)
 *                                 | 400 { error }             (provider/planning failure)
 *
 * Contract (enforced by the deferred `previewPlan` pipeline):
 *   - no session is created, no interaction is recorded
 *   - no plan is written to the plan store (nothing to resume/cancel)
 *   - nothing is executed
 * `planId` is therefore always `null`: the plan is returned to the caller
 * only.  H-08: a successful plan also gets an in-memory `previewId` so
 * `POST /api/run { previewId }` can execute the same steps.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { parseRunMode, type RunMode } from '../../ai/modes.js';
import { parseModePrefix, resolveRunMode } from '../../cli/utils/mode-prefix.js';
import { loadGlobalConfig } from '../../cli/utils/config.js';
import type { ServerContext } from '../types.js';

export function previewRouter(ctx: ServerContext): Router {
  const router = Router();

  router.post('/api/preview', async (req, res) => {
    const { message, model, mode } = (req.body ?? {}) as {
      message?: unknown;
      model?: unknown;
      mode?: unknown;
    };
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'Body must include a non-empty "message".' });
      return;
    }

    let runMode: RunMode | undefined;
    if (mode != null) {
      if (typeof mode !== 'string' || !parseRunMode(mode)) {
        res.status(400).json({ error: '"mode" must be one of: auto, chat, plan.' });
        return;
      }
      runMode = parseRunMode(mode);
    }

    const prefix = parseModePrefix(message);
    let text = message.trim();
    if (prefix.mode) {
      runMode = prefix.mode;
      text = prefix.text;
    } else if (!runMode) {
      runMode = resolveRunMode({ config: loadGlobalConfig() }).resolved.mode;
    }

    try {
      const preview = await ctx.orchestrator.previewPlan(
        text,
        typeof model === 'string' && model.trim() ? model.trim() : undefined,
        runMode,
      );

      // v27.17.0: a request the planner answers instead of planning.  There is
      // no plan to render — the answer IS the response (ok: true, no planId).
      if (preview.ok && preview.answer !== undefined) {
        res.json({ ok: true, answer: preview.answer, planId: null, previewId: null });
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

      // H-07: a provider/planning failure is an error, not a clarification.
      if (!preview.ok && !preview.plan) {
        res.status(400).json({ error: preview.error ?? 'Preview failed.' });
        return;
      }

      let previewId: string | null = null;
      if (preview.ok && preview.plan) {
        previewId = randomUUID();
        ctx.previews.set(previewId, {
          plan: preview.plan,
          planText: preview.planText,
          message: text,
          mode: runMode,
          createdAt: Date.now(),
        });
      }

      // Feasibility/cycle failures are planning *outcomes*: the caller gets
      // 200 with ok:false so the UI can still render the rejected plan.
      res.json({
        ...preview,
        planId: null,
        previewId,
      });
    } catch (err) {
      res.status(500).json({
        error: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  return router;
}
