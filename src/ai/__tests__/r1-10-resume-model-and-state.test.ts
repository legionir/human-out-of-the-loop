/**
 * R1-10 — `Orchestrator.resumePlan` used to review the PRE-resume plan
 * snapshot (loaded once at the top of the method, before `resume()` ran)
 * and never passed the run's own model to the reviewer, silently falling
 * back to the server default. This pins both fixes:
 *
 *   - the review sees step statuses AS THEY ARE AFTER resume runs, and
 *   - the reviewer is called with the model recorded on the plan
 *     (`plan.modelId`, set when the plan was first created), not the
 *     orchestrator's default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText, generateObject } from 'ai';
import { Orchestrator } from '../orchestrator.js';
import { createPlan, type Plan } from '../schemas/plan.js';

const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('R1-10 — resumePlan reviews post-resume state with the run model', () => {
  let tmpDir: string;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
    process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-r1-10-'));
    orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
      defaultModelId: 'gpt-4o',
    });
    mockGenerateText.mockReset();
    mockGenerateObject.mockReset();
    mockGenerateText.mockResolvedValue({
      text: 'step-2 redone',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      steps: [],
    } as any);
    // No acceptance checker / reviewer configured on this Orchestrator
    // instance for structured calls other than the (mocked) final review,
    // which is itself spied on below and never reaches the real model.
    mockGenerateObject.mockResolvedValue({
      object: { accepted: true, reason: 'ok' },
    } as any);
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reviews with plan.modelId and sees the post-resume step statuses', async () => {
    const plan: Plan = createPlan('finish the interrupted job', [
      {
        id: 'step-1',
        description: 'already finished before the crash',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'done',
        resultSummary: 'finished earlier',
      },
      {
        id: 'step-2',
        description: 'was interrupted, must be redone',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);
    plan.id = 'plan_r1_10';
    plan.status = 'failed-partial';
    // Recorded at plan-creation time by `Orchestrator.run` (R1-10).
    plan.modelId = 'claude-not-the-default';
    orchestrator.planStore.save(plan);

    const seenPlans: Plan[] = [];
    const seenModelIds: (string | undefined)[] = [];
    const originalReview = orchestrator.finalReviewer.review.bind(orchestrator.finalReviewer);
    vi.spyOn(orchestrator.finalReviewer, 'review').mockImplementation(
      async (reviewedPlan, executionResult, modelId) => {
        seenPlans.push(reviewedPlan);
        seenModelIds.push(modelId);
        return originalReview(reviewedPlan, executionResult, modelId);
      }
    );

    await orchestrator.resumePlan('plan_r1_10');

    expect(seenModelIds[0]).toBe('claude-not-the-default');
    // The reviewed plan must show step-2 as no longer pending (resume ran it),
    // not the stale pre-resume snapshot.
    expect(seenPlans[0]?.steps.find((s) => s.id === 'step-2')?.status).not.toBe('pending');
  });
});
