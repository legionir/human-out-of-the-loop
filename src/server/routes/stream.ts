/**
 * Phase 24 (UI): SSE stream route.
 *
 *   GET /api/stream/:planId → text/event-stream
 *
 * Event names are the ProgressEvent types (plan:started,
 * plan:step-started, plan:step-completed, plan:step-failed,
 * plan:replanning, plan:completed, plan:failed, plan:cancelled,
 * task:tool-call, task:status) plus server-level 'awaiting-confirmation'
 * and 'run:done'.  Payloads are compact: tool NAMES, never arguments
 * (Law 14), no credentials (step 4).
 */
import { Router } from 'express';
import { canAccessStream } from '../run-control.js';
import type { ServerContext } from '../types.js';

const HEARTBEAT_MS = 15_000;

export function streamRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/stream/:planId', (req, res) => {
    const planId = req.params.planId;
    if (!canAccessStream(ctx, req, planId)) {
      res.status(403).json({ error: 'Forbidden: this resource belongs to another client.' });
      return;
    }

    if (ctx.hub.atCapacity()) {
      res.status(503).json({ error: 'SSE connection limit reached' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Initial comment frame — lets clients (and proxies) see the stream open.
    res.write(': stream-open\n\n');

    const rawLast =
      req.get('last-event-id') ??
      (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined);
    const lastEventId =
      rawLast !== undefined && rawLast !== '' && Number.isFinite(Number(rawLast))
        ? Number(rawLast)
        : undefined;

    const unsubscribe = ctx.hub.subscribe(planId, res, lastEventId);
    if (!unsubscribe) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
      return;
    }

    // Heartbeat keeps idle connections (proxies) from timing out.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // already closed
      }
    };

    req.on('close', cleanup);
  });

  return router;
}
