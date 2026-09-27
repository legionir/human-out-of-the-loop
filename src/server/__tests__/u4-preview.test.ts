/**
 * U4 acceptance (e2e, mocked model): `POST /api/preview` — plan only.
 *
 * Contract under test:
 *   - NOTHING is written: no session, no interaction, no plan in the store
 *     (the plan store directory stays empty → `GET /api/plans` and
 *     `GET /api/sessions` are unchanged by a preview)
 *   - the response carries the plan, feasibility and cycle info, and
 *     `planId: null`
 *   - an unclear goal → 400 with the planner's `questions` (not a 500)
 *   - an infeasible plan → 200 `{ok:false, feasibility}` (planning outcome)
 *   - nothing is executed: no agent/model call is made by a preview
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
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

let assessment: { isClear: boolean; needsClarification: string[]; plan?: Plan };

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

function infeasiblePlan(): Plan {
  const plan = validPlan();
  plan.steps[0]!.assignedPersona = 'does-not-exist';
  return plan;
}

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
            finalSummary: 'done',
            usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 },
          },
        } as never;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
  });
  mockGenerateText.mockResolvedValue({
    text: 'Step work complete.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

let projectRoot: string;
let created: CreatedServer;
let app: Express;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u4-preview-'));
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

/** Files under the runtime dir that a preview must not create. */
function runtimeFiles(): string[] {
  const runtimeDir = path.join(projectRoot, '.ai-runtime');
  if (!fs.existsSync(runtimeDir)) return [];
  return fs.readdirSync(runtimeDir, { recursive: true }).map(String).sort();
}

describe('U4 — POST /api/preview (plan only, zero side effects)', () => {
  it('returns the plan + feasibility + cycles with planId:null and writes NOTHING', async () => {
    const before = runtimeFiles();

    const res = await request(app)
      .post('/api/preview')
      .send({ message: 'Build a login page' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.planId).toBeNull();
    expect(res.body.plan.id).toMatch(/^plan_/);
    expect(res.body.plan.steps).toHaveLength(1);
    expect(res.body.planText).toContain('[step-1] Create the login form component');
    expect(res.body.feasibility).toMatchObject({ feasible: true });
    expect(res.body.cycles).toMatchObject({ hasCycle: false });

    // zero side effects: no session, no plan, no interaction recorded
    expect((await request(app).get('/api/sessions').expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/plans').expect(200)).body).toEqual([]);
    expect(runtimeFiles()).toEqual(before);
    // …and nothing was executed
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('is repeatable without accumulating state (two previews, still empty)', async () => {
    await request(app).post('/api/preview').send({ message: 'Build a login page' }).expect(200);
    await request(app).post('/api/preview').send({ message: 'Build a login page' }).expect(200);

    expect((await request(app).get('/api/plans').expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/sessions').expect(200)).body).toEqual([]);
  });

  it('an unclear goal → 400 with the planner questions (not 500, nothing written)', async () => {
    assessment = {
      isClear: false,
      needsClarification: ['Which framework?', 'Which auth provider?'],
    };

    const res = await request(app)
      .post('/api/preview')
      .send({ message: 'build a login page' })
      .expect(400);

    expect(res.body.questions).toEqual(['Which framework?', 'Which auth provider?']);
    expect(res.body.error).toContain('clarification');
    expect((await request(app).get('/api/plans').expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/sessions').expect(200)).body).toEqual([]);
  });

  it('an infeasible plan → 200 {ok:false, feasibility} (outcome, not an error)', async () => {
    assessment = { isClear: true, needsClarification: [], plan: infeasiblePlan() };

    const res = await request(app)
      .post('/api/preview')
      .send({ message: 'Build a login page' })
      .expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.planId).toBeNull();
    expect(res.body.feasibility.feasible).toBe(false);
    expect(res.body.feasibility.errors[0]).toMatchObject({ field: 'assignedPersona' });
    expect(res.body.error).toContain('feasibility');
    // still nothing written / executed
    expect((await request(app).get('/api/plans').expect(200)).body).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('rejects an empty message and does not call the planner', async () => {
    await request(app).post('/api/preview').send({}).expect(400);
    await request(app).post('/api/preview').send({ message: '   ' }).expect(400);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});
