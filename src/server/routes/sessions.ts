/**
 * Phase 24 (UI): session routes.
 *
 *   GET    /api/sessions        → list (id + last-interaction summary)
 *   GET    /api/sessions/:id    → full session JSON
 *   DELETE /api/sessions/:id    → delete
 */
import { Router } from 'express';
import type { ServerContext } from '../types.js';

export function sessionsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/sessions', (req, res) => {
    const ids = ctx.orchestrator.sessionStore.listSessions();
    res.json(
      ids.map((id) => {
        const s = ctx.orchestrator.sessionStore.getSession(id);
        const last = s?.interactions[s.interactions.length - 1];
        return {
          id,
          label: s?.label ?? null,
          createdAt: s?.createdAt ?? null,
          lastActiveAt: s?.lastActiveAt ?? null,
          interactionCount: s?.interactions.length ?? 0,
          lastOutcome: last?.outcome ?? null,
          lastSummary: last?.reviewSummary ?? null,
        };
      }),
    );
  });

  router.get('/api/sessions/:id', (req, res) => {
    const session = ctx.orchestrator.sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: `Session "${req.params.id}" not found.` });
      return;
    }
    res.json(session);
  });

  router.delete('/api/sessions/:id', (req, res) => {
    if (!ctx.orchestrator.sessionStore.getSession(req.params.id)) {
      res.status(404).json({ error: `Session "${req.params.id}" not found.` });
      return;
    }
    ctx.orchestrator.sessionStore.deleteSession(req.params.id);
    res.json({ ok: true, id: req.params.id });
  });

  return router;
}
