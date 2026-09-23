/**
 * Phase 24 (UI) tests — Express API + SSE against a REAL app instance
 * (supertest for REST, raw fetch for the SSE stream), with the `ai`
 * module mocked (planner / acceptance / review / step execution).
 *
 * Acceptance covered:
 *   - POST /api/run (auto) → plan → execute → report (polling run state)
 *   - interactive confirmation: awaiting-confirmation → modal data →
 *     POST /api/plans/:id/confirm (reject → cancelled; accept → success)
 *   - SSE /api/stream/:planId streams live plan:started … plan:completed
 *   - sessions list/get/delete; plans list/get/cancel
 *   - GET /api/observability filters by planId
 *   - security: projectRoot in the request body is IGNORED (server config wins)
 *   - static frontend served at /
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

import { generateObject, generateText } from 'ai';
import { createApp, type CreatedServer } from '../../server.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

// ─── Mock model ──────────────────────────────────────────────────

function installModelMocks(): void {
  const plan: Plan = {
    id: 'plan_ui_mock',
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
      {
        id: 'step-2',
        description: 'Add unit tests for the login form',
        dependsOn: ['step-1'],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file', 'search_code'],
        claimedResources: ['src/login.test.tsx'],
        acceptanceCriteria: 'Tests cover submit',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };

  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    let object: unknown;
    switch (schemaName) {
      case 'PlannerAssessment':
        object = { isClear: true, needsClarification: [], plan };
        break;
      case 'ExecutionPlan':
        object = plan;
        break;
      case 'AcceptanceJudgment':
        object = { accepted: true, reason: 'Criteria met.' };
        break;
      case 'FinalReview':
        object = {
          planId: 'plan_ui_mock',
          goal: 'Build a login page',
          outcome: 'success',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: 'All steps completed successfully (UI test).',
          usage: { totalPromptTokens: 10, totalCompletionTokens: 5, totalTokens: 15 },
        };
        break;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
    return { object } as never;
  });
  mockGenerateText.mockResolvedValue({
    text: 'Step work complete.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

// ─── Harness ─────────────────────────────────────────────────────

let projectRoot: string;
let created: CreatedServer;
let app: Express;

async function pollRun(
  runId: string,
  predicate: (s: Record<string, unknown>) => boolean,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`).expect(200);
    if (predicate(res.body)) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} did not converge. Last state: ${JSON.stringify(res.body)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase24-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  installModelMocks();
  mockGenerateObject.mockClear();
  mockGenerateText.mockClear();
  created = createApp({ projectRoot, persistent: true });
  app = created.app;
});

afterEach(async () => {
  await created.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────

describe('Phase 24 — API: health + static', () => {
  it('GET /api/health returns ok + the server-configured projectRoot', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.projectRoot).toBe(projectRoot);
  });

  it('GET / serves the HTML frontend', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Human Out of the Loop');
    // Frontend assets exist and are served
    await request(app).get('/app.js').expect(200);
    await request(app).get('/style.css').expect(200);
  });
});

describe('Phase 24 — API: run (auto-confirm e2e)', () => {
  it('POST /api/run with confirm:true plans, executes, and reports', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    expect(started.body.runId).toBeTypeOf('string');
    const runId = started.body.runId as string;

    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('success');
    expect(done.report).toContain('All steps completed successfully (UI test).');
    expect(done.planId).toBe('plan_ui_mock');

    // The step agent really ran (2 steps)
    expect(mockGenerateText).toHaveBeenCalledTimes(2);

    // Persisted artifacts
    const plans = await request(app).get('/api/plans').expect(200);
    expect(plans.body).toHaveLength(1);
    expect(plans.body[0].status).toBe('completed');
    expect(plans.body[0].stepsDone).toBe(2);
    expect(plans.body[0].stepsTotal).toBe(2);

    const plan = await request(app).get('/api/plans/plan_ui_mock').expect(200);
    expect(plan.body.goal).toBe('Build a login page');

    const sessions = await request(app).get('/api/sessions').expect(200);
    expect(sessions.body).toHaveLength(1);
    expect(sessions.body[0].lastOutcome).toBe('success');
  }, 30_000);

  it('POST /api/run rejects invalid bodies', async () => {
    await request(app).post('/api/run').send({}).expect(400);
    await request(app).post('/api/run').send({ message: '   ' }).expect(400);
    await request(app).post('/api/run').send({ message: 'x', sessionId: 42 }).expect(400);
  });

  it('POST /api/run with sessionId:null starts a fresh session (JSON null = absent)', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', sessionId: null, confirm: true })
      .expect(202);
    const done = await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.sessionId).toBeTypeOf('string'); // a NEW session was created
  }, 30_000);

  it('projectRoot in the request body is IGNORED (server config wins)', async () => {
    const attackerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase24-evil-'));
    try {
      const started = await request(app)
        .post('/api/run')
        .send({
          message: 'Build a login page',
          confirm: true,
          projectRoot: attackerDir, // must have no effect
        })
        .expect(202);
      const done = await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');
      expect(done.state).toBe('done');
      // Everything persisted under the CONFIGURED root, never the attacker's
      expect(fs.existsSync(path.join(projectRoot, '.ai-runtime', 'plans'))).toBe(true);
      expect(fs.existsSync(path.join(attackerDir, '.ai-runtime'))).toBe(false);
    } finally {
      fs.rmSync(attackerDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('Phase 24 — API: interactive confirmation + SSE', () => {
  it('confirm:false pauses at the modal; reject cancels the run', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: false })
      .expect(202);
    const runId = started.body.runId as string;

    const awaiting = await pollRun(runId, (s) => s.state === 'awaiting-confirmation');
    expect(awaiting.planId).toBe('plan_ui_mock');
    expect(typeof awaiting.planText).toBe('string');
    expect(awaiting.planText).toContain('Create the login form component');

    // Nothing executed yet
    expect(mockGenerateText).not.toHaveBeenCalled();

    // Modal data: full plan for the steps table
    const plan = await request(app).get('/api/plans/plan_ui_mock').expect(200);
    expect(plan.body.steps).toHaveLength(2);
    expect(plan.body.steps[0].assignedPersona).toBe('coder');

    // Reject with feedback
    await request(app)
      .post('/api/plans/plan_ui_mock/confirm')
      .send({ confirmed: false, feedback: 'Split the steps further' })
      .expect(200);

    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('cancelled');
    expect(mockGenerateText).not.toHaveBeenCalled();
  }, 30_000);

  it('SSE streams live progress once the plan is confirmed', async () => {
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
        .send({ message: 'Build a login page', confirm: false })
        .expect(202);
      const runId = started.body.runId as string;
      const awaiting = await pollRun(runId, (s) => s.state === 'awaiting-confirmation');
      const planId = awaiting.planId as string;

      // Connect the SSE stream while the run is PAUSED (deterministic window)
      const controller = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/stream/${planId}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();

      // Collect frames in the background until the run's final event
      // (events burst in <10ms with the mock model, so we collect
      // concurrently with the confirm + execution instead of reading
      // needle-by-needle).
      const sseTextPromise = new Promise<string>((resolve) => {
        let buffer = '';
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(buffer);
        };
        const timer = setTimeout(finish, 20_000);
        const pump = async (): Promise<void> => {
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              buffer += decoder.decode(r.value, { stream: true });
              if (
                buffer.includes('event: plan:completed') ||
                buffer.includes('event: plan:failed') ||
                buffer.includes('event: plan:cancelled')
              ) {
                finish();
                return;
              }
            }
            finish();
          } catch {
            finish();
          }
        };
        void pump();
      });

      // Give the hub a beat to register the subscriber
      await new Promise((r) => setTimeout(r, 150));

      // Confirm → execution starts → events flow
      await request(app).post(`/api/plans/${planId}/confirm`).send({ confirmed: true }).expect(200);

      const sseText = await sseTextPromise;
      expect(sseText).toContain('event: plan:started');
      expect(sseText).toContain('event: plan:step-started');
      expect(sseText).toContain('event: plan:step-completed');
      expect(sseText).toContain('event: plan:completed');
      expect(sseText).toContain('data: ');

      // The run itself also converges to done/success
      const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
      expect(done.state).toBe('done');
      expect(done.outcome).toBe('success');

      // Event payloads are JSON and carry NO tool arguments (Law 14)
      const idx = sseText.indexOf('event: plan:started');
      const next = sseText.indexOf('event:', idx + 'event: plan:started'.length);
      const startedEvent = sseText.slice(idx, next === -1 ? undefined : next);
      const dataLine = startedEvent.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse(dataLine!.slice('data: '.length));
      expect(parsed.planId).toBe(planId);
      expect(parsed.message).toBeTypeOf('string');
      expect('toolArgs' in parsed).toBe(false);

      controller.abort();
    } finally {
      // The aborted SSE socket lingers as an idle keep-alive connection;
      // server.close() alone would wait for it forever.  Drop idle
      // connections first, then close.
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
  }, 45_000);

  it('confirming a plan that is not awaiting returns 409', async () => {
    await request(app)
      .post('/api/plans/plan_never_started/confirm')
      .send({ confirmed: true })
      .expect(409);
    await request(app).post('/api/plans/plan_x/confirm').send({}).expect(400);
  });
});

describe('Phase 24 — API: plans cancel + observability + sessions', () => {
  function seedRunningPlan(id: string): void {
    const store = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    const plan: Plan = {
      id,
      goal: 'Seeded plan',
      steps: [
        {
          id: 's1',
          description: 'first',
          dependsOn: [],
          assignedPersona: 'coder',
          assignedSkills: [],
          assignedTools: [],
          claimedResources: [],
          acceptanceCriteria: 'done',
          status: 'done',
        },
        {
          id: 's2',
          description: 'second',
          dependsOn: ['s1'],
          assignedPersona: 'coder',
          assignedSkills: [],
          assignedTools: [],
          claimedResources: [],
          acceptanceCriteria: 'done',
          status: 'pending',
        },
      ],
      clarifications: [],
      status: 'running',
      createdAt: Date.now(),
    };
    store.save(plan);
  }

  it('POST /api/plans/:id/cancel cancels a running plan; 409 when terminal', async () => {
    seedRunningPlan('plan_cancel_1');
    const ok = await request(app).post('/api/plans/plan_cancel_1/cancel').expect(200);
    expect(ok.body.success).toBe(true);
    const plan = await request(app).get('/api/plans/plan_cancel_1').expect(200);
    expect(plan.body.status).toBe('cancelled');

    await request(app).post('/api/plans/plan_cancel_1/cancel').expect(409);
    await request(app).post('/api/plans/plan_missing/cancel').expect(409);
  });

  it('GET /api/observability?planId=&tail= filters the jsonl log', async () => {
    // A completed run wrote observability entries
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');

    const all = await request(app).get('/api/observability').expect(200);
    expect(all.body.entries.length).toBeGreaterThanOrEqual(3);

    const filtered = await request(app)
      .get(`/api/observability?planId=plan_ui_mock&tail=50`)
      .expect(200);
    expect(filtered.body.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of filtered.body.entries) {
      expect(e.planId).toBe('plan_ui_mock');
    }
    expect(filtered.body.entries.some((e: { eventType: string }) => e.eventType === 'plan:created')).toBe(true);

    const none = await request(app).get('/api/observability?planId=plan_nope').expect(200);
    expect(none.body.entries).toEqual([]);
  }, 30_000);

  it('sessions: get + delete', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');

    const sessions = await request(app).get('/api/sessions').expect(200);
    expect(sessions.body).toHaveLength(1);
    const id = sessions.body[0].id as string;

    const one = await request(app).get(`/api/sessions/${id}`).expect(200);
    expect(one.body.interactions).toHaveLength(1);
    expect(one.body.interactions[0].userRequest).toBe('Build a login page');

    await request(app).delete(`/api/sessions/${id}`).expect(200);
    await request(app).get(`/api/sessions/${id}`).expect(404);
    await request(app).delete(`/api/sessions/${id}`).expect(404);
  }, 30_000);
});
