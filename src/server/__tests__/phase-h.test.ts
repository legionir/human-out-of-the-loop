/**
 * Phase H — UI ↔ server (H-02 dual-emit, H-07 preview, H-08 previewId,
 * H-09 @plan, H-11 unknown session).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'node:http';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { createApp, type CreatedServer } from '../../server.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

function validPlan(): Plan {
  return {
    id: 'plan_preview_mock',
    goal: 'Build a login page',
    steps: [
      {
        id: 'step-1',
        description: 'Create the login form component',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: ['src/login.tsx'],
        acceptanceCriteria: 'A login form component exists',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };
}

let assessment: { isClear: boolean; needsClarification?: string[]; plan?: Plan; answer?: string };

function installModelMocks(): void {
  assessment = { isClear: true, needsClarification: [], plan: validPlan() };
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    switch (schemaName) {
      case 'PlannerAssessment':
        return { object: assessment } as never;
      case 'ExecutionPlan':
        return { object: assessment.plan ?? validPlan() } as never;
      case 'AcceptanceJudgment':
        return { object: { accepted: true, reason: 'Criteria met.' } } as never;
      case 'FinalReview':
        return {
          object: {
            planId: 'plan_preview_mock',
            goal: 'Build a login page',
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'Done.',
          },
        } as never;
      default:
        return { object: {} } as never;
    }
  });
  mockGenerateText.mockResolvedValue({
    text: 'Step work complete.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

function plannerAssessmentCalls(): number {
  return mockGenerateObject.mock.calls.filter(
    (call) => (call[0] as { schemaName?: string } | undefined)?.schemaName === 'PlannerAssessment',
  ).length;
}

let projectRoot: string;
let created: CreatedServer;
let app: Express;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-h-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  installModelMocks();
  mockGenerateObject.mockClear();
  mockGenerateText.mockClear();
  created = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
  app = created.app;
});

afterEach(async () => {
  await created.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

async function pollRun(
  runId: string,
  pred: (s: { state: string }) => boolean,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`);
    if (res.status === 200 && pred(res.body as { state: string })) return res.body as Record<string, unknown>;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out polling run ${runId}: ${JSON.stringify(res.body)}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('H-07 — preview answer vs provider error', () => {
  it('returns a chat answer for hello instead of a plan', async () => {
    assessment = { isClear: true, needsClarification: [], answer: 'hello there' };
    const res = await request(app).post('/api/preview').send({ message: 'hello' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.answer).toBe('hello there');
    expect(res.body.planId).toBeNull();
    expect(res.body.questions).toBeUndefined();
  });

  it('does not turn a provider key error into clarification questions', async () => {
    mockGenerateObject.mockImplementation(async () => {
      throw new Error('Incorrect API key provided: sk-test');
    });
    const res = await request(app).post('/api/preview').send({ message: 'hello' }).expect(400);
    expect(res.body.questions).toBeUndefined();
    expect(res.body.error).toMatch(/API key|could not be planned|Incorrect/i);
  });
});

describe('H-08 — previewId executes the same steps without planning again', () => {
  it('POST /api/run { previewId } skips a second PlannerAssessment', async () => {
    const preview = await request(app)
      .post('/api/preview')
      .send({ message: 'Build a login page' })
      .expect(200);
    expect(preview.body.previewId).toEqual(expect.any(String));
    const planned = plannerAssessmentCalls();
    expect(planned).toBeGreaterThan(0);
    mockGenerateObject.mockClear();

    const started = await request(app)
      .post('/api/run')
      .send({
        message: 'Build a login page',
        confirm: true,
        previewId: preview.body.previewId,
      })
      .expect(202);
    const done = await pollRun(started.body.runId as string, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(plannerAssessmentCalls()).toBe(0);
  }, 30_000);
});

describe('H-09 — @plan prefix', () => {
  it('forces planning even when the model would answer', async () => {
    assessment = { isClear: true, needsClarification: [], answer: 'hey' };
    const res = await request(app).post('/api/preview').send({ message: '@plan hi' }).expect(200);
    expect(res.body.answer).toBeUndefined();
    expect(res.body.plan).toBeDefined();
    expect(res.body.plan.steps).toHaveLength(1);
  });
});

describe('H-11 — unknown sessionId is 404 without a model call', () => {
  it('POST /api/run { sessionId: "nope" } → 404', async () => {
    mockGenerateObject.mockClear();
    const res = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', sessionId: 'nope', confirm: true })
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});

describe('H-02 — runId SSE sees plan:started (auto-confirm)', () => {
  it('replays plan:started on the run channel', async () => {
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
      const started = await request(app)
        .post('/api/run')
        .send({ message: 'Build a login page', confirm: true })
        .expect(202);
      const runId = started.body.runId as string;
      const controller = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/stream/${runId}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 15_000;
      while (!buffer.includes('event: plan:started') && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200)),
        ]);
        if (next.value) buffer += decoder.decode(next.value, { stream: true });
        if (next.done && !buffer.includes('event: plan:started')) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      expect(buffer).toContain('event: plan:started');
      controller.abort();
    } finally {
      await new Promise((r) => setTimeout(r, 50));
      server.closeIdleConnections();
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 3000);
        server.close(() => {
          clearTimeout(guard);
          resolve();
        });
      });
    }
  }, 30_000);
});

describe('H-05 — two goals share a session', () => {
  it('reuses result.sessionId for the next run', async () => {
    const first = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const done1 = await pollRun(first.body.runId as string, (s) => s.state === 'done' || s.state === 'error');
    expect(done1.state).toBe('done');
    const sessionId = done1.sessionId as string;
    expect(sessionId).toBeTruthy();

    const second = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', sessionId, confirm: true })
      .expect(202);
    const done2 = await pollRun(second.body.runId as string, (s) => s.state === 'done' || s.state === 'error');
    expect(done2.state).toBe('done');
    expect(done2.sessionId).toBe(sessionId);
    const session = await request(app).get(`/api/sessions/${encodeURIComponent(sessionId)}`).expect(200);
    expect(session.body.interactions.length).toBe(2);
  }, 30_000);
});

describe('Phase H static assets', () => {
  it('serves ui-logic.js for the module frontend', async () => {
    await request(app).get('/ui-logic.js').expect(200);
    const html = await request(app).get('/').expect(200);
    expect(html.text).toContain('type="module"');
    expect(html.text).toContain('id="run-mode"');
  });
});
