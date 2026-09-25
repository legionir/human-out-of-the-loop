/**
 * v27.17.0 over HTTP: a request the planner answers instead of planning.
 *
 * `POST /api/run` may carry `mode` (auto/chat/plan); the run's state ends as
 * `done` with the answer as its report and NO planId — the UI has nothing to
 * open, nothing to confirm and nothing to execute, which is the point of chat
 * mode.  `POST /api/preview` answers too, and never touches the project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { createApp, type CreatedServer } from '../../server.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

/** The answer body the fake provider returns for the chat call. */
const CHAT_ANSWER = 'این پروژه یک رانتایم برنامه‌ریزی است.';

function installModelMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    if (schemaName === 'PlannerAssessment') {
      return {
        object: { kind: 'answer', isClear: true, needsClarification: [], answer: 'a draft' },
      } as never;
    }
    throw new Error(`Unexpected schemaName in test: ${schemaName}`);
  });
  mockGenerateText.mockResolvedValue({
    text: CHAT_ANSWER,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

async function pollRun(app: Express, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`).expect(200);
    if (res.body.state === 'done' || res.body.state === 'error') return res.body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish: ${res.body.state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let projectRoot: string;
let created: CreatedServer;
let app: Express;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2717-chat-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  installModelMocks();
  mockGenerateObject.mockClear();
  mockGenerateText.mockClear();
  created = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
  app = created.app;
});

afterEach(async () => {
  await created.close?.();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('v27.17.0 — chat over the API', () => {
  it('answers a greeting: done, report is the answer, no plan', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'سلام', confirm: true })
      .expect(202);
    const run = await pollRun(app, started.body.runId as string);

    expect(run.state).toBe('done');
    expect(run.outcome).toBe('success');
    expect(run.report).toContain('💬 Answer');
    expect(run.report).toContain(CHAT_ANSWER);
    expect(run.planId).toBeUndefined();
    // Nothing was written into the plan store.
    const plansDir = path.join(projectRoot, '.ai-runtime', 'plans');
    const plans = fs.existsSync(plansDir) ? fs.readdirSync(plansDir) : [];
    expect(plans).toEqual([]);
  });

  it('mode:"chat" answers even when the model would plan', async () => {
    mockGenerateObject.mockImplementationOnce(
      async () =>
        ({
          object: {
            kind: 'plan',
            isClear: true,
            needsClarification: [],
            plan: { goal: 'x', steps: [] },
          },
        }) as never
    );
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'do the thing', mode: 'chat', confirm: true })
      .expect(202);
    const run = await pollRun(app, started.body.runId as string);
    expect(run.report).toContain('💬 Answer');
    expect(run.planId).toBeUndefined();
  });

  it('rejects an unknown mode with 400', async () => {
    const res = await request(app)
      .post('/api/run')
      .send({ message: 'hello', mode: 'talk' })
      .expect(400);
    expect(res.body.error).toContain('auto, chat, plan');
  });

  it('preview returns the answer instead of a plan', async () => {
    mockGenerateObject.mockImplementationOnce(
      async () =>
        ({ object: { isClear: true, needsClarification: [], answer: 'preview reply' } }) as never
    );
    const res = await request(app).post('/api/preview').send({ message: 'سلام' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.answer).toBe('preview reply');
    expect(res.body.planId).toBeNull();
    expect(res.body.plan).toBeUndefined();
  });
});
