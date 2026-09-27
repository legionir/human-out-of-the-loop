/**
 * Phase A — web server auth (A-01), cancel-during-planning (A-04),
 * idle TTL (A-05), and run ownership (A-08).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { useIsolatedHome } from '../../test-utils/isolated-home.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { createApp, type CreatedServer } from '../../server.js';
import {
  assertCanBind,
  DEFAULT_BIND_HOST,
  isLoopbackHost,
  resolveServerTokens,
} from '../auth.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

const PLAN: Plan = {
  id: 'plan_a_mock',
  goal: 'Build a login page',
  steps: [
    {
      id: 'step-1',
      description: 'Create the login form',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file'],
      claimedResources: ['src/login.tsx'],
      acceptanceCriteria: 'form exists',
      status: 'pending',
    },
  ],
  clarifications: [],
  status: 'draft',
};

function installFastMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    let object: unknown;
    switch (schemaName) {
      case 'PlannerAssessment':
        object = { isClear: true, needsClarification: [], plan: PLAN };
        break;
      case 'ExecutionPlan':
        object = PLAN;
        break;
      case 'AcceptanceJudgment':
        object = { accepted: true, reason: 'ok' };
        break;
      case 'FinalReview':
        object = {
          planId: 'plan_a_mock',
          goal: PLAN.goal,
          outcome: 'success',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: 'done',
          usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 },
        };
        break;
      default:
        throw new Error(`Unexpected schemaName: ${schemaName}`);
    }
    return { object } as never;
  });
  mockGenerateText.mockResolvedValue({
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as never);
}

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-'));
  fs.cpSync(REGISTRY_SRC, path.join(dir, 'registry'), { recursive: true });
  return dir;
}

async function pollRun(
  app: Express,
  runId: string,
  predicate: (s: Record<string, unknown>) => boolean,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const req = request(app).get(`/api/runs/${runId}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    const res = await req.expect((r) => {
      if (r.status !== 200 && r.status !== 403) throw new Error(`poll ${r.status}`);
    });
    if (res.status === 200 && predicate(res.body)) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} did not converge. Last: ${JSON.stringify(res.body)}`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('A-01 — bind policy and token middleware', () => {
  it('defaults to loopback and refuses a non-loopback bind without a token', () => {
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(() => assertCanBind('127.0.0.1', [])).not.toThrow();
    expect(() => assertCanBind('0.0.0.0', ['secret'])).not.toThrow();
    expect(() => assertCanBind('0.0.0.0', [])).toThrow(/HOTL_SERVER_TOKEN|--token/);
  });

  it('resolves HOTL_SERVER_TOKEN as a comma-separated list', () => {
    expect(resolveServerTokens({ env: { HOTL_SERVER_TOKEN: 'a, b, a' } as NodeJS.ProcessEnv })).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns 401 on every /api route without a bearer token when a token is configured', async () => {
    const projectRoot = makeProject();
    const created = createApp({ projectRoot, persistent: false, token: 'secret-a' });
    try {
      const gets = [
        '/api/health',
        '/api/models',
        '/api/personas',
        '/api/skills',
        '/api/tools',
        '/api/mcp',
        '/api/plans',
        '/api/sessions',
        '/api/usage',
        '/api/runs/nope',
      ];
      for (const path of gets) {
        const res = await request(created.app).get(path);
        expect(res.status, `GET ${path}`).toBe(401);
        expect(res.body.error).toMatch(/bearer token/i);
      }
      for (const path of ['/api/run', '/api/runs/nope/cancel', '/api/mcp/x/test']) {
        const res = await request(created.app).post(path);
        expect(res.status, `POST ${path}`).toBe(401);
        expect(res.body.error).toMatch(/bearer token/i);
      }
      const ok = await request(created.app)
        .get('/api/health')
        .set('Authorization', 'Bearer secret-a')
        .expect(200);
      expect(ok.body.ok).toBe(true);
    } finally {
      await created.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('A-04 — cancel during planning aborts further LLM calls', () => {
  let projectRoot: string;
  let created: CreatedServer;
  let home: ReturnType<typeof useIsolatedHome>;

  beforeEach(() => {
    home = useIsolatedHome('phase-a-home-');
    projectRoot = makeProject();
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
  });

  afterEach(async () => {
    if (created) await created.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    home.restore();
  });

  it('POST /api/runs/:runId/cancel during planning → cancelled, no later generateObject', async () => {
    let release: (() => void) | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      // settled only by abort
      void reject;
    });
    mockGenerateObject.mockImplementation((opts: unknown) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('aborted')),
          { once: true },
        );
        release = () => reject(new Error('released without abort'));
      });
    });

    created = createApp({ projectRoot, persistent: true, runTtlMs: 0 });
    const app = created.app;
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;

    await pollRun(app, runId, (s) => s.state === 'planning');
    // The first LLM call is in flight.
    const deadline = Date.now() + 3000;
    while (mockGenerateObject.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(mockGenerateObject.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callsAtCancel = mockGenerateObject.mock.calls.length;

    await request(app).post(`/api/runs/${runId}/cancel`).expect(200);

    const done = await pollRun(app, runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('cancelled');
    expect(mockGenerateObject.mock.calls.length).toBe(callsAtCancel);
    void release;
    void hung;
  }, 20_000);
});

describe('A-05 — abandoned confirmation times out', () => {
  let projectRoot: string;
  let created: CreatedServer;

  beforeEach(() => {
    projectRoot = makeProject();
    installFastMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
    created = createApp({ projectRoot, persistent: true, runTtlMs: 80 });
  });

  afterEach(async () => {
    await created.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('TTL on awaiting-confirmation cancels the run and closes the interaction', async () => {
    const app = created.app;
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: false })
      .expect(202);
    const runId = started.body.runId as string;
    await pollRun(app, runId, (s) => s.state === 'awaiting-confirmation');
    const done = await pollRun(app, runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('cancelled');
    expect(done.sessionId).toBeTypeOf('string');
    const session = await request(app).get(`/api/sessions/${done.sessionId}`).expect(200);
    const interaction = session.body.interactions?.[0];
    expect(interaction?.outcome).toBe('cancelled');
    expect(interaction?.completedAt).toEqual(expect.any(Number));
  }, 20_000);
});

describe('A-08 — a second token cannot drive another client\'s run', () => {
  let projectRoot: string;
  let created: CreatedServer;

  beforeEach(() => {
    projectRoot = makeProject();
    installFastMocks();
    created = createApp({
      projectRoot,
      persistent: true,
      authTokens: ['alice', 'bob'],
      runTtlMs: 0,
    });
  });

  afterEach(async () => {
    await created.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('GET /api/runs/:id with a different valid token is 403', async () => {
    const app = created.app;
    const started = await request(app)
      .post('/api/run')
      .set('Authorization', 'Bearer alice')
      .send({ message: 'Build a login page', confirm: false })
      .expect(202);
    const runId = started.body.runId as string;

    await request(app).get(`/api/runs/${runId}`).expect(401);
    await request(app)
      .get(`/api/runs/${runId}`)
      .set('Authorization', 'Bearer bob')
      .expect(403);
    const own = await request(app)
      .get(`/api/runs/${runId}`)
      .set('Authorization', 'Bearer alice')
      .expect(200);
    expect(own.body.runId).toBe(runId);

    await request(app)
      .post(`/api/runs/${runId}/cancel`)
      .set('Authorization', 'Bearer bob')
      .expect(403);
    await request(app)
      .post(`/api/runs/${runId}/cancel`)
      .set('Authorization', 'Bearer alice')
      .expect(200);
  }, 20_000);
});
