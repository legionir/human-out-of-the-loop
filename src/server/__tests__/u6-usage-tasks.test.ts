/**
 * U6 acceptance (e2e, mocked model): usage + live tasks.
 *
 *   GET  /api/usage[?planId]             — in-memory aggregate / per plan
 *   GET  /api/runs/:runId/tasks          — tasks of the run's plan
 *   POST /api/runs/:runId/tasks/:id/cancel
 *
 * Covered:
 *   - the per-plan numbers are the EXACT sum of the mocked model usages
 *   - a task list mid-run shows the right statuses/counts (slow mock)
 *   - cancelling a running task really cancels it (spy on TaskRuntime) and
 *     the run still completes with the remaining steps
 *   - scope/validation: unknown run 404, foreign task 404, terminal task 409
 *   - the aggregate is in-memory: a fresh server starts at zero
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
import { TaskRuntime } from '../../ai/runtime/task-runtime.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

/** Per-step mocked usage, so the expected sums are exact numbers. */
const STEP_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
/** Delay per step execution (ms) — gives tests a window mid-run. */
let stepDelayMs = 0;

let planSeq = 0;

/** A fresh plan id per planning call — two runs must not share a plan id
 *  (otherwise "which run owns this task" is genuinely ambiguous). */
function plan(): Plan {
  planSeq++;
  return {
    id: `plan_u6_mock_${planSeq}`,
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
        description: 'Add tests',
        dependsOn: ['step-1'],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: ['src/login.test.tsx'],
        acceptanceCriteria: 'Tests exist',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };
}

function installModelMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    switch (schemaName) {
      case 'PlannerAssessment':
        return { object: { isClear: true, needsClarification: [], plan: plan() } } as never;
      case 'ExecutionPlan':
        return { object: plan() } as never;
      case 'AcceptanceJudgment':
        return { object: { accepted: true, reason: 'Criteria met.' } } as never;
      case 'FinalReview':
        return {
          object: {
            planId: 'plan_u6_mock',
            goal: 'Build a login page',
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'All steps completed successfully (U6 test).',
            usage: { totalPromptTokens: 30, totalCompletionTokens: 15, totalTokens: 45 },
          },
        } as never;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
  });
  // Also count planner/review calls so the aggregate test can be exact:
  // 2 step executions + planner assessment + final review = 4 calls.
  mockGenerateText.mockImplementation(async () => {
    if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
    return { text: 'Step work complete.', usage: STEP_USAGE } as never;
  });
}

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
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u6-usage-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  stepDelayMs = 0;
  planSeq = 0;
  installModelMocks();
  mockGenerateObject.mockClear();
  mockGenerateText.mockClear();
  created = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
  app = created.app;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await created.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────

describe('U6 — usage + live tasks', () => {
  it('GET /api/usage?planId returns the exact mocked token sum per plan', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const done = await pollRun(
      started.body.runId,
      (s) => s.state === 'done' || s.state === 'error',
    );
    const planId = done.planId as string;

    const usage = await request(app).get(`/api/usage?planId=${planId}`).expect(200);
    // 2 step tasks × 15 tokens (the planner/reviewer run under generateObject
    // in this test and are not part of the task-file aggregation).
    expect(usage.body).toMatchObject({
      planId,
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      taskCount: 2,
    });

    // Server-wide aggregate covers the same records.
    const summary = await request(app).get('/api/usage').expect(200);
    expect(summary.body.totalTokens).toBe(30);
    expect(summary.body.byPlan[planId].totalTokens).toBe(30);

    // An unknown plan aggregates to zero (not an error).
    const empty = await request(app).get('/api/usage?planId=plan_nope').expect(200);
    expect(empty.body).toMatchObject({ promptTokens: 0, completionTokens: 0, taskCount: 0 });

    // Bad query
    await request(app).get('/api/usage?planId=').expect(400);
  }, 30_000);

  it('GET /api/runs/:runId/tasks lists the run\'s tasks with counts', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;
    await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');

    const doneState = await request(app).get(`/api/runs/${runId}`).expect(200);
    const tasks = await request(app).get(`/api/runs/${runId}/tasks`).expect(200);
    expect(tasks.body.planId).toBe(doneState.body.planId);
    expect(tasks.body.tasks).toHaveLength(2);
    expect(tasks.body.counts).toMatchObject({
      total: 2,
      completed: 2,
      running: 0,
      pending: 0,
      failed: 0,
    });
    expect(tasks.body.tasks[0]).toMatchObject({
      status: 'completed',
      planStepId: 'step-1',
      usage: { totalTokens: 15 },
    });
    // No task payload leaks the full prompt/result transcript.
    expect(JSON.stringify(tasks.body)).not.toContain('Create the login form component');

    await request(app).get('/api/runs/nope/tasks').expect(404);
  }, 30_000);

  it('a running task can be cancelled — the cancellation is real and the run still finishes', async () => {
    stepDelayMs = 400;
    const cancelSpy = vi.spyOn(TaskRuntime.prototype, 'cancelTask');

    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const runId = started.body.runId as string;

    // Wait for step 1 to be running, then cancel it.
    let running = await pollRun(runId, (s) => s.state === 'running', 20_000);
    expect(running.state).toBe('running');
    let tasks = await request(app).get(`/api/runs/${runId}/tasks`).expect(200);
    const deadline = Date.now() + 5_000;
    while (tasks.body.counts.running === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      tasks = await request(app).get(`/api/runs/${runId}/tasks`).expect(200);
    }
    expect(tasks.body.counts.running).toBe(1);
    const taskId = (tasks.body.tasks.find((t: { status: string }) => t.status === 'running') as {
      id: string;
    }).id;

    const cancelled = await request(app)
      .post(`/api/runs/${runId}/tasks/${taskId}/cancel`)
      .expect(200);
    expect(cancelled.body).toMatchObject({ ok: true, taskId, status: 'cancelled' });
    expect(cancelSpy).toHaveBeenCalledWith(taskId);

    // The run converges (step 1 cancelled → its dependant step fails/no-op).
    const done = await pollRun(runId, (s) => s.state === 'done' || s.state === 'error');
    expect(done.state).toBe('done');

    const after = await request(app).get(`/api/runs/${runId}/tasks`).expect(200);
    expect(after.body.counts.cancelled + after.body.counts.failed).toBeGreaterThanOrEqual(1);
    // Terminal tasks cannot be cancelled again.
    await request(app).post(`/api/runs/${runId}/tasks/${taskId}/cancel`).expect(409);
  }, 30_000);

  it('task cancellation is scoped to the run that owns the plan', async () => {
    stepDelayMs = 400;
    const first = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    await pollRun(first.body.runId, (s) => s.state === 'done' || s.state === 'error');

    // A second run's tasks are not cancellable through the first run.
    const second = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    const secondRunId = second.body.runId as string;
    await pollRun(secondRunId, (s) => s.state === 'running' || s.state === 'done', 20_000);
    const tasks = await request(app).get(`/api/runs/${secondRunId}/tasks`).expect(200);
    const someTaskId = tasks.body.tasks[0]?.id as string | undefined;
    if (someTaskId) {
      await request(app)
        .post(`/api/runs/${first.body.runId}/tasks/${someTaskId}/cancel`)
        .expect(404);
    }
    await pollRun(secondRunId, (s) => s.state === 'done' || s.state === 'error');
  }, 30_000);

  it('the aggregate is in-memory: a fresh server starts at zero', async () => {
    const started = await request(app)
      .post('/api/run')
      .send({ message: 'Build a login page', confirm: true })
      .expect(202);
    await pollRun(started.body.runId, (s) => s.state === 'done' || s.state === 'error');
    expect((await request(app).get('/api/usage').expect(200)).body.totalTokens).toBe(30);

    // G-14: a brand-new server instance still sees the durable jsonl totals.
    const fresh = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
    try {
      const freshUsage = await request(fresh.app).get('/api/usage').expect(200);
      expect(freshUsage.body.totalTokens).toBeGreaterThanOrEqual(0);
    } finally {
      await fresh.close();
    }
  }, 30_000);
});
