/**
 * U7 acceptance (e2e): session labels + observability follow.
 *
 *   PATCH  /api/sessions/:id { label }        → rename (persisted)
 *   DELETE /api/sessions/:id                  → delete (label goes with it)
 *   GET    /api/observability/stream[?planId] → SSE tail + live lines
 *
 * Covered:
 *   - a label survives a store reload (persist, like the CLI's `sessions label`)
 *   - empty label clears it; over-long label → 400; unknown session → 404
 *   - delete removes the label with the session (regression)
 *   - the follow stream sends the initial backlog and then NEW lines as they
 *     are written (race-free: the assertion is a poll-until-seen, not a sleep)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Server } from 'node:http';
import type { Express } from 'express';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { createApp, type CreatedServer } from '../../server.js';
import { FileSessionStore } from '../../ai/runtime/session-store.js';

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

let projectRoot: string;
let created: CreatedServer;
let app: Express;

function logFilePath(): string {
  return path.join(projectRoot, '.ai-runtime', 'observability.jsonl');
}

function appendLogLine(entry: Record<string, unknown>): void {
  const file = logFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/**
 * Drain the stream into a live buffer (single reader) and wait until the
 * predicate matches — pure polling, so there is never a second reader
 * competing for chunks.
 */
function drainInto(res: Response): { getBuffer: () => string } {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // aborted — the buffer keeps whatever arrived so far
    }
  })();
  return { getBuffer: () => buffer };
}

async function waitFor(
  getBuffer: () => string,
  predicate: (buffer: string) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(getBuffer()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u7-label-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  created = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
  app = created.app;
});

afterEach(async () => {
  await created.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('U7 — session labels', () => {
  it('PATCH sets a label that survives a store reload, and "" clears it', async () => {
    const sessionId = created.ctx.orchestrator.sessionStore.createSession();

    const patched = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ label: '  Deploy pipeline  ' })
      .expect(200);
    expect(patched.body).toMatchObject({ ok: true, id: sessionId, label: 'Deploy pipeline' });

    // Visible in the list endpoint (what the sidebar renders)…
    const list = await request(app).get('/api/sessions').expect(200);
    expect(list.body[0].label).toBe('Deploy pipeline');

    // …and persisted on disk: a brand-new store instance reads it back
    // (setLabel → saveSession is a synchronous write, like the CLI path).
    const sessionsDir = path.join(projectRoot, '.ai-runtime', 'sessions');
    expect(new FileSessionStore(sessionsDir).getSession(sessionId)?.label).toBe('Deploy pipeline');

    // Empty string clears the label (CLI parity: `sessions label <id> ""`).
    const cleared = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ label: '' })
      .expect(200);
    expect(cleared.body.label).toBeNull();
    expect(new FileSessionStore(sessionsDir).getSession(sessionId)?.label).toBeUndefined();
  }, 20_000);

  it('rejects malformed/over-long labels and unknown sessions', async () => {
    const sessionId = created.ctx.orchestrator.sessionStore.createSession();

    await request(app).patch(`/api/sessions/${sessionId}`).send({}).expect(400);
    await request(app).patch(`/api/sessions/${sessionId}`).send({ label: 42 }).expect(400);
    await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ label: 'x'.repeat(121) })
      .expect(400);
    await request(app).patch('/api/sessions/nope').send({ label: 'x' }).expect(404);

    // Nothing was applied.
    expect(created.ctx.orchestrator.sessionStore.getSession(sessionId)?.label).toBeUndefined();
  }, 20_000);

  it('DELETE removes the session (and its label) — regression', async () => {
    const sessionId = created.ctx.orchestrator.sessionStore.createSession();
    await request(app).patch(`/api/sessions/${sessionId}`).send({ label: 'temp' }).expect(200);

    const deleted = await request(app).delete(`/api/sessions/${sessionId}`).expect(200);
    expect(deleted.body).toMatchObject({ ok: true, id: sessionId, label: null });

    await request(app).get(`/api/sessions/${sessionId}`).expect(404);
    expect((await request(app).get('/api/sessions').expect(200)).body).toEqual([]);
    expect(
      new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions')).getSession(sessionId),
    ).toBeUndefined();
  }, 20_000);
});

describe('U7 — observability follow stream', () => {
  it('sends the backlog, then new lines as they appear (planId filtered)', async () => {
    appendLogLine({
      timestamp: new Date().toISOString(),
      level: 'info',
      eventType: 'plan:started',
      message: 'backlog for plan_wanted',
      planId: 'plan_wanted',
    });
    appendLogLine({
      timestamp: new Date().toISOString(),
      level: 'info',
      eventType: 'plan:started',
      message: 'backlog for another plan',
      planId: 'plan_other',
    });

    const { server, baseUrl } = await new Promise<{ server: Server; baseUrl: string }>(
      (resolve, reject) => {
        const srv = app.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          if (typeof addr !== 'object' || addr === null) {
            reject(new Error('no address'));
            return;
          }
          resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
        });
      },
    );

    try {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/observability/stream?planId=plan_wanted`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const { getBuffer } = drainInto(res);

      await waitFor(getBuffer, (b) => b.includes('event: tail-end'));
      expect(getBuffer()).toContain('backlog for plan_wanted');
      expect(getBuffer()).toContain('event: tail-end');
      // Filtered out: another plan's line.
      expect(getBuffer()).not.toContain('backlog for another plan');

      // A NEW line must arrive without reconnecting.
      appendLogLine({
        timestamp: new Date().toISOString(),
        level: 'warn',
        eventType: 'plan:step-failed',
        message: 'live line arrives',
        planId: 'plan_wanted',
      });
      await waitFor(getBuffer, (b) => b.includes('live line arrives'));
      expect(getBuffer()).toContain('live line arrives');

      controller.abort();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('rejects a malformed planId filter', async () => {
    await request(app).get('/api/observability/stream?planId=').expect(400);
  });
});
