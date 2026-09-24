/**
 * U7 (UI completion plan): follow the observability log live.
 *
 *   GET /api/observability/stream?planId=P  → text/event-stream
 *       event: entry   data: <LogEntry json>
 *       event: tail-end data: {count}          (initial backlog flushed)
 *       : ping                                 (heartbeat)
 *
 * Reuses the CLI's `followLog` (fs.watch + tail re-sync on truncation), so
 * the "follow" semantics are identical to `human-out-of-the-loop logs -f`.
 * The stream is read-only and never rewrites the log file.
 */
import { Router } from 'express';
import type { ServerResponse } from 'node:http';
import { followLog, readEntries } from '../../cli/commands/logs.js';

/** The JSONL shape both the CLI and this route speak. */
type LogLine = {
  timestamp: string;
  level: string;
  eventType: string;
  message: string;
  planId?: string;
};
import type { ServerContext } from '../types.js';

const HEARTBEAT_MS = 15_000;
/** Backlog lines sent before the live tail starts. */
const INITIAL_TAIL = 50;

export function observabilityStreamRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/observability/stream', (req, res: ServerResponse) => {
    const { planId } = req.query as { planId?: string };
    if (planId !== undefined && (typeof planId !== 'string' || planId.trim() === '')) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: '"planId" must be a non-empty string when present.' }));
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': stream-open\n\n');

    const send = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Broken socket — the 'close' handler tears everything down.
      }
    };

    // Initial backlog (bounded) so a freshly-opened panel is never empty.
    const { entries } = readEntries(ctx.logFilePath, planId);
    const backlog = entries.slice(-INITIAL_TAIL);
    for (const entry of backlog) send('entry', entry);
    send('tail-end', { count: backlog.length });

    // Live follow: only entries beyond what we already sent.
    const stop = followLog(
      ctx.logFilePath,
      planId,
      INITIAL_TAIL,
      (entry: LogLine) => send('entry', entry),
      entries.length,
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      stop();
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
