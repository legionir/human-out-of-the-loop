/**
 * C4 (CLI completion plan): interactive clarification loop in
 * `Orchestrator.run`.
 *
 * Contract under test:
 *   - NO callback → legacy behavior: run fails with the questions
 *     (CI-safe), planner consulted exactly once.
 *   - callback answers → answers folded back into the request,
 *     `plan:clarified` logged, run continues to plan + execution.
 *   - callback returns null/empty → clean run CANCELLATION.
 *   - rounds exhausted (maxClarificationRounds) → failure that says so.
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

import { generateObject } from 'ai';
import { Orchestrator } from '../orchestrator.js';

const mockGenerateObject = vi.mocked(generateObject);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function unclearAssessment(questions: string[]) {
  return {
    object: { isClear: false, needsClarification: questions },
  } as any;
}

function clearAssessment() {
  return {
    object: {
      isClear: true,
      needsClarification: [],
      plan: {
        goal: 'Build a login page',
        steps: [
          {
            id: 'step-1',
            description: 'Create the login form component',
            dependsOn: [],
            assignedPersona: 'coder',
            assignedSkills: [],
            assignedTools: [],
            claimedResources: [],
            acceptanceCriteria: 'Login form exists',
            status: 'pending',
          },
        ],
      },
    },
  } as any;
}

function reviewResult() {
  return {
    object: {
      planId: 'review-plan',
      goal: 'Build a login page',
      outcome: 'success',
      acceptedFindings: [],
      rejectedFindings: [],
      incompleteSteps: [],
      finalSummary: 'Done.',
    },
  } as any;
}

describe('C4 — clarification loop in Orchestrator.run', () => {
  let tmpDir: string;

  beforeEach(() => {
    // ModelRegistry builds real provider clients — they only throw
    // (before the mocked generateObject is reached) without keys.
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
    process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-c4-'));
    mockGenerateObject.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(extra: Record<string, unknown> = {}): Orchestrator {
    return new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
      ...extra,
    });
  }

  it('no callback → legacy failure with the questions, planner hit ONCE', async () => {
    const orchestrator = makeOrchestrator();
    mockGenerateObject.mockResolvedValueOnce(
      unclearAssessment(['Which framework?']),
    );

    const result = await orchestrator.run('Do the thing', {
      confirmCallback: async () => ({ confirmed: true }),
    });

    expect(result.planId).toBe('none');
    expect(result.review.outcome).toBe('failure');
    expect(result.report).toContain('Clarification needed');
    expect(result.report).toContain('Which framework?');
    // No loop without a callback
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);

    await orchestrator.shutdown();
  });

  it('callback answers → answers folded into the request, plan:clarified logged, run continues', async () => {
    const orchestrator = makeOrchestrator();
    mockGenerateObject
      .mockResolvedValueOnce(unclearAssessment(['Which framework?']))
      .mockResolvedValueOnce(clearAssessment())
      .mockResolvedValueOnce(reviewResult());

    const clarification = vi.fn(
      async (questions: string[], _round: number) => {
        expect(questions).toEqual(['Which framework?']);
        return { 'Which framework?': 'React 18' };
      },
    );

    const result = await orchestrator.run('Build a login page', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: clarification,
    });

    expect(clarification).toHaveBeenCalledTimes(1);
    // round 1 was reported
    expect(clarification.mock.calls[0][1]).toBe(1);
    // the answer was folded into the SECOND planner prompt
    const secondPrompt = mockGenerateObject.mock.calls[1][0] as any;
    expect(String(secondPrompt.prompt)).toContain('A: React 18');
    expect(String(secondPrompt.prompt)).toContain('CLARIFICATIONS FROM USER');
    // run continued through plan creation
    expect(result.planId).toBeDefined();
    expect(result.planId).not.toBe('none');

    // plan:clarified is in the durable observability log
    const logFile = path.join(tmpDir, 'observability.jsonl');
    const log = fs.readFileSync(logFile, 'utf-8');
    expect(log).toContain('plan:clarified');
    expect(log).toContain('answered 1 clarification');

    await orchestrator.shutdown();
  });

  it('callback returns null → clean run CANCELLATION', async () => {
    const orchestrator = makeOrchestrator();
    mockGenerateObject.mockResolvedValueOnce(
      unclearAssessment(['What is the scope?']),
    );

    const result = await orchestrator.run('Something vague', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: async () => null,
    });

    expect(result.planId).toBe('none');
    expect(result.review.outcome).toBe('cancelled');
    expect(result.report).toContain('cancelled');
    expect(result.report).toContain('What is the scope?');
    // planner consulted exactly once (no retry after decline)
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);

    await orchestrator.shutdown();
  });

  it('maxClarificationRounds exhausted → failure that says how many rounds ran', async () => {
    const orchestrator = makeOrchestrator({ maxClarificationRounds: 2 });
    // the planner keeps asking, no matter the answers
    mockGenerateObject.mockImplementation(async () =>
      unclearAssessment(['Still unclear, why?'])
    );

    const clarification = vi.fn(
      async () => ({ 'Still unclear, why?': 'Because.' }),
    );

    const result = await orchestrator.run('Mystery task', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: clarification,
    });

    expect(clarification).toHaveBeenCalledTimes(2);
    expect(result.planId).toBe('none');
    expect(result.review.outcome).toBe('failure');
    expect(result.report).toContain('after 2 clarification round(s)');

    await orchestrator.shutdown();
  });

  it('default maxClarificationRounds is 3', async () => {
    const orchestrator = makeOrchestrator();
    mockGenerateObject.mockImplementation(async () =>
      unclearAssessment(['q?'])
    );
    const clarification = vi.fn(async () => ({ 'q?': 'a' }));

    await orchestrator.run('Mystery task', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: clarification,
    });

    expect(clarification).toHaveBeenCalledTimes(3);
    await orchestrator.shutdown();
  });
});
