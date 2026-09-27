import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { FinalReviewer } from '../runtime/final-reviewer.js';
import { formatReviewForUser, formatReviewOneLine } from '../runtime/review-formatter.js';
import { ReviewSchema, emptyReviewUsage, type Review } from '../schemas/review.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import type { PlanExecutionResult } from '../runtime/plan-runtime.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGitStatusTool } from '../tools/implementations/git-status.js';

// Phase 18: filesystem tools are factories bound to a workspace root.
// Tests run from the repo root, so binding to process.cwd() keeps behavior identical.
const TEST_ROOT = process.cwd();
const readFileTool = createReadFileTool(TEST_ROOT);
const searchCodeTool = createSearchCodeTool(TEST_ROOT);
const writeFileTool = createWriteFileTool(TEST_ROOT);
const gitStatusTool = createGitStatusTool(TEST_ROOT);

// ─── Mock AI SDK ─────────────────────────────────────────────────

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateObject } from 'ai';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
const mockGenerateObject = vi.mocked(generateObject);

// ─── Test infrastructure ─────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');

function createMockProvider(name: string): ProviderFactory {
  return {
    name,
    create: (config) =>
      ({
        specificationVersion: 'v1',
        provider: name,
        modelId: config.model,
        defaultObjectGenerationMode: 'json',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      }) as unknown as LanguageModel,
  };
}

function setupReviewer() {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);

  const toolRegistry = new ToolRegistry();
  for (const d of [
    { id: 'read_file', name: 'R', description: 'R', source: 'local' as const, modulePath: './r' },
    { id: 'search_code', name: 'S', description: 'S', source: 'local' as const, modulePath: './s' },
    { id: 'write_file', name: 'W', description: 'W', source: 'local' as const, modulePath: './w' },
    { id: 'git_status', name: 'G', description: 'G', source: 'local' as const, modulePath: './g' },
  ]) toolRegistry.registerDefinition(d);
  toolRegistry.registerImplementation('read_file', readFileTool);
  toolRegistry.registerImplementation('search_code', searchCodeTool);
  toolRegistry.registerImplementation('write_file', writeFileTool);
  toolRegistry.registerImplementation('git_status', gitStatusTool);
  // Phase 33: register the reference filesystem toolset so skill cross-validation
  // (registry/skills/*) sees the same catalog as production bootstrapTools().
  registerLocalToolFixtures(toolRegistry, TEST_ROOT);

  const skillRegistry = new SkillRegistry({ toolRegistry });
  // Minimal fix: bootstrap catalog BEFORE loading skills because task_decomposition, acceptance_check etc depend on catalog tools
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  return new FinalReviewer({
    personaRegistry,
    skillRegistry,
    toolRegistry,
    modelRegistry,
  });
}

function createCompletedPlan(): Plan {
  const plan = createPlan('Refactor auth module', [
    {
      id: 'step-1',
      description: 'Analyse existing auth code',
      dependsOn: [],
      assignedPersona: 'architect',
      assignedSkills: ['code_analysis'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'Architecture report produced',
      status: 'done',
    },
    {
      id: 'step-2',
      description: 'Implement new auth service',
      dependsOn: ['step-1'],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file'],
      claimedResources: ['src/auth.ts'],
      acceptanceCriteria: 'New service passes tests',
      status: 'done',
    },
  ]);
  plan.id = 'plan-completed';
  plan.status = 'completed';
  plan.steps[0].resultSummary = 'Found 3 modules to refactor. Report at ./docs/auth-arch.md';
  plan.steps[1].resultSummary = 'Implemented AuthService with 12 unit tests passing.';
  return plan;
}

function createPartialPlan(): Plan {
  const plan = createCompletedPlan();
  plan.id = 'plan-partial';
  plan.status = 'failed-partial';
  plan.steps[1].status = 'failed';
  plan.steps[1].failureType = 'quality';
  plan.steps[1].resultSummary = '[Acceptance: FAILED — 2 tests are missing edge case coverage]';
  return plan;
}

function makeExecutionResult(plan: Plan): PlanExecutionResult {
  const doneCount = plan.steps.filter((s) => s.status === 'done').length;
  const failedCount = plan.steps.filter((s) => s.status === 'failed').length;
  const incomplete = plan.steps
    .filter((s) => s.status !== 'done')
    .map((s) => ({
      stepId: s.id,
      description: s.description,
      reason: s.resultSummary ?? 'Unknown',
      failureType: s.failureType,
    }));

  return {
    planId: plan.id ?? 'unknown',
    status: plan.status,
    completedSteps: doneCount,
    failedSteps: failedCount,
    totalSteps: plan.steps.length,
    incompleteSteps: incomplete,
    replanningAttempts: 0,
  };
}

// ─── ReviewSchema tests ──────────────────────────────────────────

describe('ReviewSchema', () => {
  it('accepts a full valid review', () => {
    const review: Review = {
      planId: 'p1',
      goal: 'Do X',
      outcome: 'success',
      acceptedFindings: [
        { stepId: 's1', title: 'Feature added', description: 'Login works', severity: 'info' },
      ],
      rejectedFindings: [],
      incompleteSteps: [],
      finalSummary: 'All done.',
      usage: emptyReviewUsage,
    };
    expect(() => ReviewSchema.parse(review)).not.toThrow();
  });

  it('accepts a partial-success review with incomplete steps', () => {
    const review: Review = {
      planId: 'p2',
      goal: 'Do Y',
      outcome: 'partial-success',
      acceptedFindings: [],
      rejectedFindings: [],
      incompleteSteps: [
        {
          stepId: 's2',
          description: 'Deploy service',
          reason: 'Auth quality check failed',
          failureType: 'quality',
        },
      ],
      finalSummary: 'Steps 1 and 3 done. Step 2 could not be completed.',
      usage: emptyReviewUsage,
    };
    expect(() => ReviewSchema.parse(review)).not.toThrow();
  });

  it('rejects invalid outcome', () => {
    expect(() =>
      ReviewSchema.parse({
        planId: 'p1',
        goal: 'X',
        outcome: 'invalid-outcome',
        finalSummary: 'x',
      })
    ).toThrow();
  });

  it('rejects empty finalSummary', () => {
    expect(() =>
      ReviewSchema.parse({
        planId: 'p1',
        goal: 'X',
        outcome: 'success',
        finalSummary: '',
      })
    ).toThrow();
  });

  it('defaults arrays when omitted', () => {
    const review = ReviewSchema.parse({
      planId: 'p1',
      goal: 'X',
      outcome: 'success',
      finalSummary: 'ok',
    });
    expect(review.acceptedFindings).toEqual([]);
    expect(review.rejectedFindings).toEqual([]);
    expect(review.incompleteSteps).toEqual([]);
  });
});

// ─── FinalReviewer — successful plan ─────────────────────────────

describe('FinalReviewer — successful plan', () => {
  let reviewer: FinalReviewer;

  beforeEach(() => {
    vi.clearAllMocks();
    reviewer = setupReviewer();
  });

  it('produces a valid review for a completed plan', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        planId: 'plan-completed',
        goal: 'Refactor auth module',
        outcome: 'success',
        acceptedFindings: [
          {
            stepId: 'step-1',
            title: 'Architecture analysed',
            description: '3 modules identified for refactoring.',
            severity: 'info',
          },
          {
            stepId: 'step-2',
            title: 'AuthService implemented',
            description: '12 unit tests passing.',
            severity: 'info',
          },
        ],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: 'Auth module successfully refactored with all tests passing.',
      },
    } as any);

    const plan = createCompletedPlan();
    const result = makeExecutionResult(plan);
    const review = await reviewer.review(plan, result);

    expect(review.outcome).toBe('success');
    expect(review.planId).toBe('plan-completed');
    expect(review.acceptedFindings).toHaveLength(2);
    expect(review.incompleteSteps).toHaveLength(0);
    expect(review.finalSummary).toContain('refactored');
  });

  it('output is always valid against ReviewSchema', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        planId: 'plan-completed',
        goal: 'Refactor auth module',
        outcome: 'success',
        acceptedFindings: [],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: 'Done.',
      },
    } as any);

    const plan = createCompletedPlan();
    const review = await reviewer.review(plan, makeExecutionResult(plan));

    // Explicit schema validation
    expect(() => ReviewSchema.parse(review)).not.toThrow();
  });
});

// ─── FinalReviewer — partial-success plan ────────────────────────

describe('FinalReviewer — partial-success plan', () => {
  let reviewer: FinalReviewer;

  beforeEach(() => {
    vi.clearAllMocks();
    reviewer = setupReviewer();
  });

  it('reports incomplete steps clearly in failed-partial outcome', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        planId: 'plan-partial',
        goal: 'Refactor auth module',
        outcome: 'partial-success',
        acceptedFindings: [
          {
            stepId: 'step-1',
            title: 'Architecture analysed',
            description: '3 modules identified.',
            severity: 'info',
          },
        ],
        rejectedFindings: [
          {
            stepId: 'step-2',
            title: 'AuthService failed quality check',
            description: '2 tests missing edge case coverage.',
            severity: 'warning',
          },
        ],
        incompleteSteps: [
          {
            stepId: 'step-2',
            description: 'Implement new auth service',
            reason: 'Quality check failed: missing edge case tests',
            failureType: 'quality',
          },
        ],
        finalSummary:
          'Architecture analysis completed. Auth service implementation did not pass quality check — 2 edge case tests are missing.',
      },
    } as any);

    const plan = createPartialPlan();
    const result = makeExecutionResult(plan);
    const review = await reviewer.review(plan, result);

    expect(review.outcome).toBe('partial-success');
    expect(review.incompleteSteps).toHaveLength(1);
    expect(review.incompleteSteps[0].stepId).toBe('step-2');
    expect(review.incompleteSteps[0].failureType).toBe('quality');
    expect(review.finalSummary).toContain('did not pass');
  });
});

// ─── FinalReviewer — cancelled plan ──────────────────────────────

describe('FinalReviewer — cancelled plan', () => {
  let reviewer: FinalReviewer;

  beforeEach(() => {
    vi.clearAllMocks();
    reviewer = setupReviewer();
  });

  it('returns minimal review without calling the model for cancelled plans', async () => {
    const plan = createCompletedPlan();
    plan.id = 'plan-cancelled';
    plan.status = 'cancelled';
    // No steps done in this scenario
    plan.steps[0].status = 'pending';
    plan.steps[1].status = 'pending';

    const result: PlanExecutionResult = {
      planId: 'plan-cancelled',
      status: 'cancelled',
      completedSteps: 0,
      failedSteps: 0,
      totalSteps: 2,
      incompleteSteps: [
        { stepId: 'step-1', description: 'Analyse', reason: 'Cancelled before start' },
        { stepId: 'step-2', description: 'Implement', reason: 'Cancelled before start' },
      ],
      replanningAttempts: 0,
    };

    const review = await reviewer.review(plan, result);

    expect(review.outcome).toBe('cancelled');
    expect(review.incompleteSteps).toHaveLength(2);
    expect(review.finalSummary).toContain('cancelled');
    // Model should NOT have been called
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});

// ─── FinalReviewer — fallback when model fails ───────────────────

describe('FinalReviewer — fallback', () => {
  let reviewer: FinalReviewer;

  beforeEach(() => {
    vi.clearAllMocks();
    reviewer = setupReviewer();
  });

  it('returns fallback review when generateObject fails', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('Provider timeout'));

    const plan = createCompletedPlan();
    const review = await reviewer.review(plan, makeExecutionResult(plan));

    // Should still return a valid review
    expect(() => ReviewSchema.parse(review)).not.toThrow();
    expect(review.outcome).toBe('success');
    expect(review.acceptedFindings.length).toBeGreaterThan(0);
    expect(review.finalSummary).toContain('fallback');
  });

  it('fallback review includes accepted findings from done steps', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('Model unavailable'));

    const plan = createCompletedPlan();
    const review = await reviewer.review(plan, makeExecutionResult(plan));

    expect(review.acceptedFindings).toHaveLength(2);
    expect(review.acceptedFindings[0].stepId).toBe('step-1');
    expect(review.acceptedFindings[1].stepId).toBe('step-2');
  });

  it('fallback review includes quality-failed steps in rejected findings', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('boom'));

    const plan = createPartialPlan();
    const review = await reviewer.review(plan, makeExecutionResult(plan));

    expect(review.rejectedFindings.length).toBeGreaterThan(0);
    expect(review.rejectedFindings[0].stepId).toBe('step-2');
  });
});

// ─── Formatter tests ─────────────────────────────────────────────

describe('formatReviewForUser', () => {
  it('produces readable output for success', () => {
    const review: Review = {
      planId: 'p1',
      goal: 'Build feature X',
      outcome: 'success',
      acceptedFindings: [
        { stepId: 's1', title: 'Login works', description: 'All tests pass.', severity: 'info' },
      ],
      rejectedFindings: [],
      incompleteSteps: [],
      finalSummary: 'Feature X built successfully.',
      usage: emptyReviewUsage,
    };

    const output = formatReviewForUser(review);

    expect(output).toContain('FINAL REPORT');
    expect(output).toContain('SUCCESS');
    expect(output).toContain('Build feature X');
    expect(output).toContain('Login works');
    expect(output).toContain('Feature X built successfully');
  });

  it('shows incomplete steps for partial-success', () => {
    const review: Review = {
      planId: 'p1',
      goal: 'Do stuff',
      outcome: 'partial-success',
      acceptedFindings: [],
      rejectedFindings: [],
      incompleteSteps: [
        {
          stepId: 's3',
          description: 'Deploy',
          reason: 'Auth failed',
          failureType: 'quality',
        },
      ],
      finalSummary: 'Partial only.',
      usage: emptyReviewUsage,
    };

    const output = formatReviewForUser(review);

    expect(output).toContain('Incomplete Steps');
    expect(output).toContain('s3');
    expect(output).toContain('quality');
    expect(output).toContain('Auth failed');
  });

  it('formatReviewOneLine produces compact summary', () => {
    const review: Review = {
      planId: 'plan-abc',
      goal: 'X',
      outcome: 'partial-success',
      acceptedFindings: [
        { stepId: 's1', title: 'A', description: 'a', severity: 'info' },
      ],
      rejectedFindings: [
        { stepId: 's2', title: 'B', description: 'b', severity: 'warning' },
      ],
      incompleteSteps: [
        { stepId: 's3', description: 'c', reason: 'stuck' },
      ],
      finalSummary: 'ok',
      usage: emptyReviewUsage,
    };

    const oneLine = formatReviewOneLine(review);

    expect(oneLine).toContain('partial-success');
    expect(oneLine).toContain('plan-abc');
    expect(oneLine).toContain('1 accepted');
    expect(oneLine).toContain('1 rejected');
    expect(oneLine).toContain('1 incomplete');
  });
});
