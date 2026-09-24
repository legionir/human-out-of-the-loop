/**
 * Phase 24 (UI): session routes.
 *
 *   GET    /api/sessions        → list (id + last-interaction summary)
 *   GET    /api/sessions/:id    → full session JSON
 *   PATCH  /api/sessions/:id    → { label } rename (U7; "" clears it)
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

  /**
   * U7: rename a session inline from the sidebar.  Reuses the C3 store API
   * (`setLabel`) so CLI and UI share one implementation and the label
   * survives a reload (`session.json` is rewritten by the store).
   */
  router.patch('/api/sessions/:id', (req, res) => {
    const session = ctx.orchestrator.sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: `Session "${req.params.id}" not found.` });
      return;
    }
    const { label } = (req.body ?? {}) as { label?: unknown };
    if (label === undefined || label === null) {
      res.status(400).json({ error: 'Body must include a "label" string (empty clears it).' });
      return;
    }
    if (typeof label !== 'string') {
      res.status(400).json({ error: '"label" must be a string.' });
      return;
    }
    const trimmed = label.trim();
    if (trimmed.length > 120) {
      res.status(400).json({ error: '"label" must be at most 120 characters.' });
      return;
    }
    const updated = ctx.orchestrator.sessionStore.setLabel(req.params.id, trimmed);
    if (!updated) {
      res.status(500).json({ error: 'Label could not be applied.' });
      return;
    }
    res.json({ ok: true, id: updated.id, label: updated.label ?? null });
  });

  router.delete('/api/sessions/:id', (req, res) => {
    if (!ctx.orchestrator.sessionStore.getSession(req.params.id)) {
      res.status(404).json({ error: `Session "${req.params.id}" not found.` });
      return;
    }
    ctx.orchestrator.sessionStore.deleteSession(req.params.id);
    // U7 regression: after a delete there is no session (and therefore no
    // label) left behind — the store removes the file, so a re-created id
    // starts clean.
    res.json({
      ok: true,
      id: req.params.id,
      label: ctx.orchestrator.sessionStore.getSession(req.params.id)?.label ?? null,
    });
  });

  return router;
}
