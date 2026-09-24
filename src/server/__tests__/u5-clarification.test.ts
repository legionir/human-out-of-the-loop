/**
 * U5 acceptance (e2e, mocked model): interactive clarification.
 *
 * Chain under test:
 *   POST /api/run → state 'awaiting-clarification' (+ questions visible on
 *   GET /api/runs/:runId and via the SSE 'clarification' event) →
 *   POST /api/runs/:runId/clarification { answers } → back to 'planning' →
 *   'awaiting-confirmation' → confirm → 'running' → 'done'.
 *
 * Also covered: declining (cancel), incomplete answers → 400, wrong state →
 * 409, unknown run → 404, and the round cap → reported failure.
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
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

// ─── Mock planner ────────────────────────────────────────────────

/** How many times the planner must stay unclear before it produces a plan. */
let unclearRounds = 0;
/** Permanent-unclear mode (round-cap test). */
let alwaysUnclear = false;
/** Planner failure mode: not clear, but NO questions (e.g. missing key). */
let unclearWithoutQuestions = false;
let lastPlannerPrompt = '';

function validPlan(): Plan {
  return {
    id: 'plan_u5_mock',
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

function installModelMocks(): void {
  let assessCalls = 0;
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const o = opts as { schemaName?: string; prompt?: string };
    switch (o.schemaName) {
      case 'PlannerAssessment': {
        assessCalls++;
        lastPlannerPrompt = o.prompt ?? '';
        const needsClarification =
          alwaysUnclear || assessCalls <= unclearRounds
            ? unclearWithoutQuestions
              ? []
              : ['Which auth provider?', 'Which test framework?']
            : [];
        const unclear = alwaysUnclear || unclearWithoutQuestions || assessCalls <= unclearRounds;
        return {
          object: {
            isClear: !unclear,
            needsClarification,
            ...(!unclear ? { plan: validPlan() } : {}),
          },
        } as never;
      }
      case 'ExecutionPlan':
        return { object: validPlan() } as never;
      case 'AcceptanceJudgment':
        return { object: { accepted: true, reason: 'Criteria met.' } } as never;
      case 'FinalReview':
        return {
          object: {
            planId: 'plan_u5_mock',
            goal: 'Build a login page',
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'All steps completed successfully (U5 test).',
            usage: { totalPromptTokens: 10, totalCompletionTokens: 5, totalTokens: 15 },
          },
        } as never;
      default:
        throw new Error(`Unexpected schemaName in test: ${o.schemaName}`);
    }
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
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u5-clarification-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  unclearRounds = 0;
  alwaysUnclear = false;
  unclearWithoutQuestions = false;
  lastPlannerPrompt = '';
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

// ─── Tests ───────────────────────────────────────────────────────

describe('U5 — interactive clarification', () => {
  it('full chain: run → awaiting-clarification → answers → confirm → done', async () => {
    unclearRounds = 1;

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'build a login page', confirm: false })
      .expect(202);
    const runId = started.body.runId as string;

    // 1. The run pauses on the planner's questions (visible via polling)…
    const awaiting = await pollRun(runId, (s) => s.state === 'awaiting-clarification');
    expect(awaiting.clarificationQuestions).toEqual([
      'Which auth provider?',
      'Which test framework?',
    ]);
    expect(awaiting.clarificationRound).toBe(1);
    // …and the resolver is never serialized to the wire.
    expect(awaiting.clarificationResolver).toBeUndefined();

    // 2. Answer both questions → planning resumes
    const answered = await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({
        answers: {
          'Which auth provider?': 'OAuth via GitHub',
          'Which test framework?': 'vitest',
        },
      })
      .expect(200);
    expect(answered.body).toMatchObject({ ok: true, answered: 2, round: 1 });

    // 3. The answers really reached the planner
    await pollRun(runId, (s) => s.state === 'awaiting-confirmation');
    expect(lastPlannerPrompt).toContain('CLARIFICATIONS FROM USER');
    expect(lastPlannerPrompt).toContain('OAuth via GitHub');

    // 4. Confirm → execution → done
    const planId = (await pollRun(runId, () => true)).planId as string;
    await request(app)
      .post(`/api/plans/${planId}/confirm`)
      .send({ confirmed: true })
      .expect(200);
    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('success');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // The clarification is part of the session's recorded interaction.
    const sessions = await request(app).get('/api/sessions').expect(200);
    expect(sessions.body).toHaveLength(1);
  }, 30_000);

  it('emits the clarification event on the run-id SSE channel', async () => {
    // Round 1 fires before any client can subscribe (the POST that yields the
    // runId also starts planning) — the run state covers that case.  This test
    // asserts the LIVE event by subscribing and then triggering round 2.
    unclearRounds = 2;
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
        .send({ message: 'build a login page', confirm: true })
        .expect(202);
      const runId = started.body.runId as string;

      // Wait for round 1 (already emitted before we could subscribe), then
      // open the stream and answer → round 2 must arrive live.
      const round1 = await pollRun(runId, (s) => s.state === 'awaiting-clarification');
      const questions = round1.clarificationQuestions as string[];

      const controller = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/stream/${runId}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();

      // Give the hub a beat to register the subscriber, then answer round 1.
      await new Promise((r) => setTimeout(r, 150));
      await request(app)
        .post(`/api/runs/${runId}/clarification`)
        .send({ answers: Object.fromEntries(questions.map((q) => [q, 'an answer'])) })
        .expect(200);

      let buffer = '';
      const deadline = Date.now() + 10_000;
      while (!buffer.includes('event: clarification') && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 250)),
        ]);
        if ('value' in chunk && chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      }
      // Release round 2 so the run does not sit waiting on teardown.
      await pollRun(runId, (s) => s.state === 'awaiting-clarification');
      await request(app).post(`/api/runs/${runId}/clarification`).send({ decline: true });
      controller.abort();

      expect(buffer).toContain('event: clarification');
      const frame = buffer.slice(buffer.indexOf('event: clarification'));
      expect(frame).toContain('"questions":["Which auth provider?","Which test framework?"]');
      expect(frame).toContain('"attempt":2');
      expect(frame).toContain(`"runId":"${runId}"`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('declining the questions cancels the run (C4 semantics)', async () => {
    alwaysUnclear = true;

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'do something vague', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;

    await pollRun(runId, (s) => s.state === 'awaiting-clarification');
    await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({ decline: true })
      .expect(200);

    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('cancelled');
    expect(done.report).toContain('clarification questions were not answered');
    expect(mockGenerateText).not.toHaveBeenCalled();
  }, 30_000);

  it('incomplete answers → 400 (nothing resumes), wrong state → 409, unknown run → 404', async () => {
    unclearRounds = 1;

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'build a login page', confirm: false })
      .expect(202);
    const runId = started.body.runId as string;
    await pollRun(runId, (s) => s.state === 'awaiting-clarification');

    // Only one of two questions answered
    const partial = await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({ answers: { 'Which auth provider?': 'OAuth' } })
      .expect(400);
    expect(partial.body.missing).toEqual(['Which test framework?']);
    // …still waiting for the same round
    const still = await request(app).get(`/api/runs/${runId}`).expect(200);
    expect(still.body.state).toBe('awaiting-clarification');

    // Empty answer value
    await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({ answers: { 'Which auth provider?': '  ', 'Which test framework?': 'vitest' } })
      .expect(400);

    // No answers object at all
    await request(app).post(`/api/runs/${runId}/clarification`).send({}).expect(400);

    // Unknown run
    await request(app)
      .post('/api/runs/does-not-exist/clarification')
      .send({ decline: true })
      .expect(404);

    // Now answer properly, then a second POST must be rejected (state moved on)
    await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({
        answers: { 'Which auth provider?': 'OAuth', 'Which test framework?': 'vitest' },
      })
      .expect(200);
    await request(app)
      .post(`/api/runs/${runId}/clarification`)
      .send({ decline: true })
      .expect(409);
    await pollRun(runId, (s) => s.state === 'awaiting-confirmation');
  }, 30_000);

  it('an unclear result with NO questions fails directly (no empty round)', async () => {
    unclearWithoutQuestions = true;

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'do something vague', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;

    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('failure');
    expect(done.report).toContain('Clarification needed');
    // It never opened a round — there was nothing to answer.
    expect(done.clarificationRound).toBeUndefined();
  }, 30_000);

  it('after the round cap the run ends with a report naming the rounds', async () => {
    alwaysUnclear = true;

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'do something vague', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;

    // Answer every round the server asks about (maxClarificationRounds = 3)
    let answered = 0;
    for (let i = 0; i < 3; i++) {
      const state = await pollRun(runId, (s) => s.state === 'awaiting-clarification');
      const questions = state.clarificationQuestions as string[];
      const answers = Object.fromEntries(questions.map((q) => [q, 'some answer']));
      await request(app).post(`/api/runs/${runId}/clarification`).send({ answers }).expect(200);
      answered++;
    }

    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(answered).toBe(3);
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('failure');
    expect(done.report).toContain('3 clarification round(s)');
    expect(mockGenerateText).not.toHaveBeenCalled();
  }, 30_000);
});
