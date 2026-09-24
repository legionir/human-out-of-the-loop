/**
 * U3 acceptance (e2e, mocked model): per-run model & execution options.
 *
 *   POST /api/run { model, timeoutMs, maxSteps, maxReplans } → runOverrides
 *
 * Covered:
 *   - `model:'local-llama'` → the resolved execution model really is a
 *     DIFFERENT model (numeric spy on the `model` handed to generateText)
 *   - invalid model id → 400 + the list of valid ids (no run started)
 *   - timeoutMs / maxSteps reach AgentRuntime.run (spy, numeric)
 *   - maxSteps reaches the SDK loop bound (stopWhen → stepCountIs)
 *   - no override fields → today's behaviour (server default model)
 *   - malformed numeric fields → 400
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
import { AgentRuntime } from '../../ai/runtime/agent-runtime.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

const SERVER_DEFAULT_MODEL = 'gpt-4o';

// ─── Mock model ──────────────────────────────────────────────────

function installModelMocks(): void {
  const plan: Plan = {
    id: 'plan_u3_mock',
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
          planId: 'plan_u3_mock',
          goal: 'Build a login page',
          outcome: 'success',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: 'All steps completed successfully (U3 test).',
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

/** The LanguageModel instance handed to generateText on the Nth call. */
function modelOfCall(n: number): { modelId?: string; provider?: string } {
  const call = mockGenerateText.mock.calls[n];
  if (!call) throw new Error(`generateText was not called ${n + 1} time(s)`);
  return (call[0] as { model: { modelId?: string; provider?: string } }).model;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u3-options-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  installModelMocks();
  mockGenerateObject.mockClear();
  mockGenerateText.mockClear();
  // Pin the server default so the "no overrides" assertion is deterministic
  // regardless of ~/.human-out-of-the-loop/config.json on the machine.
  created = createApp({ projectRoot, persistent: true, model: SERVER_DEFAULT_MODEL });
  app = created.app;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await created.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────

describe('U3 — POST /api/run per-run options', () => {
  it("model:'local-llama' executes with THAT model (spy sees a different modelId)", async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true, model: 'local-llama' })
      .expect(202);

    const done = await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('success');

    // Both plan steps executed…
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    // …on the llama model (registry/models/local-llama.json → model: "llama3")
    // and NOT on the server default.
    expect(modelOfCall(0).modelId).toBe('llama3');
    expect(modelOfCall(1).modelId).toBe('llama3');
    expect(modelOfCall(0).modelId).not.toBe(SERVER_DEFAULT_MODEL);
  }, 30_000);

  it('no override fields → today\'s behaviour (server default model)', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');

    expect(modelOfCall(0).modelId).toBe(SERVER_DEFAULT_MODEL);
  }, 30_000);

  // v27.4: a model the provider serves does not need a registry file — the
  // UI picker lists provider models and the server registers them on use.
  it('a model name outside the registry is registered at runtime, not rejected', async () => {
    await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true, model: '@aur/auto' })
      .expect(202);
    const cfg = created.ctx.orchestrator.modelRegistry.getConfig('aur-auto');
    expect(cfg).toMatchObject({ provider: 'openai', model: '@aur/auto' });
  });

  it('an empty model is still a 400', async () => {
    await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true, model: '  ' })
      .expect(400);
  });

  it('timeoutMs and maxSteps reach AgentRuntime.run (spy, numeric)', async () => {
    const spy = vi.spyOn(AgentRuntime.prototype, 'run');
    const started = await request(app)
      .post('/api/run')
      .send({
        message: 'Build a login page',
        confirm: true,
        timeoutMs: 60_000,
        maxSteps: 3,
        maxReplans: 2,
      })
      .expect(202);
    await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');

    expect(spy).toHaveBeenCalledTimes(2); // one per plan step
    const options = spy.mock.calls.map((c) => c[0] as { timeoutMs?: number; maxSteps?: number });
    for (const o of options) {
      expect(o.timeoutMs).toBe(60_000);
      expect(o.maxSteps).toBe(3);
    }
  }, 30_000);

  it('maxSteps is applied as the SDK loop bound (stopWhen → stepCountIs)', async () => {
    await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true, maxSteps: 3 })
      .expect(202);
    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalled());

    const options = mockGenerateText.mock.calls[0]![0] as {
      stopWhen: (arg: { steps: unknown[] }) => boolean;
    };
    // stepCountIs(3): true exactly at 3 steps, false before.
    expect(options.stopWhen({ steps: [1, 2] })).toBe(false);
    expect(options.stopWhen({ steps: [1, 2, 3] })).toBe(true);
  }, 30_000);

  it('malformed numeric fields → 400', async () => {
    const bodies = [
      { message: 'x', timeoutMs: 0 },
      { message: 'x', timeoutMs: 'soon' },
      { message: 'x', maxSteps: 1.5 },
      { message: 'x', maxSteps: 101 },
      { message: 'x', maxReplans: -1 },
      { message: 'x', maxReplans: 11 },
      { message: 'x', model: '   ' },
      { message: 'x', model: 42 },
    ];
    for (const body of bodies) {
      await request(app).post('/api/run').send(body).expect(400);
    }
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
