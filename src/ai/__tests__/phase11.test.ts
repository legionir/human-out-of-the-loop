import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import {
  AcceptanceChecker,
  AcceptanceResultSchema,
  type AcceptanceCheckerConfig,
} from '../runtime/acceptance-checker.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createPlan, type Plan, getReadySteps } from '../schemas/plan.js';
import type { Task } from '../schemas/task.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
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

import { generateObject, generateText } from 'ai';
const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

import { PlanRuntime } from '../runtime/plan-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import type { Planner } from '../planning/planner.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

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

interface TestEnv {
  eventBus: EventBus;
  planStore: MemoryPlanStore;
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
}

function setup(): TestEnv {
  const eventBus = new EventBus();
  const planStore = new MemoryPlanStore();

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
  // Minimal fix: bootstrap catalog BEFORE loading skills because task_decomposition and acceptance_check depend on catalog tools
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  return { eventBus, planStore, personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

// Phase 20 (CORR-04): AcceptanceChecker is now a PURE judgment service —
// no eventBus/planStore/taskRuntime in its config.
function createCheckerConfig(
  env: TestEnv,
  overrides?: Partial<AcceptanceCheckerConfig>
): AcceptanceCheckerConfig {
  return {
    personaRegistry: env.personaRegistry,
    skillRegistry: env.skillRegistry,
    toolRegistry: env.toolRegistry,
    modelRegistry: env.modelRegistry,
    ...overrides,
  };
}

/**
 * Phase 20 (CORR-04) harness: a real PlanRuntime wired with a real
 * TaskRuntime and an AcceptanceChecker — the acceptance check now runs
 * from PlanRuntime's explicit hook (deterministic), so tests drive it
 * through `execute()` with mocked generateText (step work) and
 * generateObject (acceptance judgment).
 */
const stubPlanner = {
  plan: async () => ({ isClear: false, needsClarification: [] }),
} as unknown as Planner;

function makeHookHarness(
  env: TestEnv,
  overrides?: Partial<AcceptanceCheckerConfig>
) {
  const taskRuntime = new TaskRuntime({
    maxConcurrentTasks: 10,
    eventBus: env.eventBus,
  });
  const planStore = new MemoryPlanStore();
  const checker = new AcceptanceChecker(createCheckerConfig(env, overrides));
  const runtime = new PlanRuntime({
    taskRuntime,
    planStore,
    planner: stubPlanner,
    feasibilityDeps: {
      personaRegistry: env.personaRegistry,
      skillRegistry: env.skillRegistry,
      toolRegistry: env.toolRegistry,
    },
    refs: {
      personaRegistry: env.personaRegistry,
      skillRegistry: env.skillRegistry,
      toolRegistry: env.toolRegistry,
      modelRegistry: env.modelRegistry,
    },
    maxReplanningAttempts: 0, // tests assert verdicts, not re-planning
    acceptanceChecker: checker,
  });
  return { taskRuntime, planStore, checker, runtime };
}

function createTestPlan(): Plan {
  return createPlan('Test plan', [
    {
      id: 'step-1',
      description: 'Create a user model with name and email fields',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: ['src/models/user.ts'],
      acceptanceCriteria:
        'The user model file exists and exports a User type with name (string) and email (string) fields.',
      status: 'pending',
    },
    {
      id: 'step-2',
      description: 'Write unit tests for the user model',
      dependsOn: ['step-1'],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: ['src/models/user.test.ts'],
      acceptanceCriteria:
        'At least 3 test cases covering creation, validation, and edge cases.',
      status: 'pending',
    },
  ]);
}

function createMockTask(stepId: string, output: string): Task {
  return {
    id: `task-${stepId}`,
    agentDefinitionOrId: 'coder',
    prompt: `Execute ${stepId}`,
    status: 'completed',
    summary: output.slice(0, 200),
    result: output,
    claimedResources: [],
    errors: [],
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    planStepId: stepId,
  };
}

// ─── AcceptanceResultSchema tests ────────────────────────────────

describe('AcceptanceResultSchema', () => {
  it('accepts a valid acceptance result', () => {
    const result = AcceptanceResultSchema.parse({
      accepted: true,
      reason: 'All criteria met.',
    });
    expect(result.accepted).toBe(true);
  });

  it('accepts a rejection', () => {
    const result = AcceptanceResultSchema.parse({
      accepted: false,
      reason: 'Email field is missing from the User type.',
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('Email');
  });

  it('rejects empty reason', () => {
    expect(() =>
      AcceptanceResultSchema.parse({ accepted: true, reason: '' })
    ).toThrow();
  });
});

// ─── AcceptanceChecker — direct checkStep tests ──────────────────

describe('AcceptanceChecker — checkStep', () => {
  let env: TestEnv;
  let checker: AcceptanceChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
    checker = new AcceptanceChecker(createCheckerConfig(env));
  });

  it('returns accepted=true when output meets criteria', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        accepted: true,
        reason: 'User type exports name and email fields as required.',
      },
    } as any);

    const plan = createTestPlan();
    const step = plan.steps[0];
    const task = createMockTask(
      'step-1',
      'Created src/models/user.ts with:\n' +
        'export type User = { name: string; email: string; };\n' +
        'All fields validated.'
    );

    const result = await checker.checkStep(step, task);

    expect(result.accepted).toBe(true);
    expect(result.reason).toContain('name and email');
  });

  it('returns accepted=false when output does not meet criteria', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        accepted: false,
        reason: 'The User type only has a name field. Email is missing.',
      },
    } as any);

    const plan = createTestPlan();
    const step = plan.steps[0];
    const task = createMockTask(
      'step-1',
      'Created src/models/user.ts with:\n' +
        'export type User = { name: string; };\n'
    );

    const result = await checker.checkStep(step, task);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('Email');
  });

  it('returns accepted=false when reviewer itself fails', async () => {
    mockGenerateObject.mockRejectedValueOnce(
      new Error('Provider timeout')
    );

    const plan = createTestPlan();
    const step = plan.steps[0];
    const task = createMockTask('step-1', 'Some output');

    const result = await checker.checkStep(step, task);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('Acceptance check itself failed');
  });
});

// ─── Acceptance hook — PlanRuntime-driven (Phase 20, CORR-04) ────
//
// The old event-driven flow (checker.start() + EventBus) was RACE-prone:
// the checker mutated plan state from an async agent:completed handler
// running concurrently with PlanRuntime's own sync.  Phase 20 moved the
// check into an explicit PlanRuntime hook that runs SEQUENTIALLY after
// syncStepStatuses.  These tests drive the hook through a real
// PlanRuntime.execute() with mocked step execution + judgments.

describe('AcceptanceChecker — PlanRuntime hook (Phase 20)', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  it('marks step failed/quality when the judgment rejects (via hook)', async () => {
    const qualityFailures: Array<{ planId: string; stepId: string; reason: string }> = [];
    const { runtime } = makeHookHarness(env, {
      onQualityFailure: (planId, stepId, reason) => {
        qualityFailures.push({ planId, stepId, reason });
      },
    });

    const plan = createPlan('Hook rejection test', [
      {
        id: 'step-1',
        description: 'Create a user model',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'User type with name and email.',
        status: 'pending',
      },
    ]);
    plan.id = 'hook-reject-plan';

    // Step execution succeeds; acceptance judgment REJECTS
    mockGenerateText.mockResolvedValue({
      text: 'Created user model with name field only.',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      steps: [],
    } as any);
    mockGenerateObject.mockResolvedValue({
      object: { accepted: false, reason: 'Email field is missing.' },
    } as any);

    const result = await runtime.execute(plan);

    // Step is failed with QUALITY failure type (not technical)
    expect(plan.steps[0].status).toBe('failed');
    expect(plan.steps[0].failureType).toBe('quality');
    expect(plan.steps[0].resultSummary).toContain('FAILED');
    expect(plan.steps[0].resultSummary).toContain('Email field is missing');
    expect(result.status).toBe('failed-partial');

    // Quality failure callback invoked exactly once with correct args
    expect(qualityFailures).toHaveLength(1);
    expect(qualityFailures[0].planId).toBe('hook-reject-plan');
    expect(qualityFailures[0].stepId).toBe('step-1');

    // Judgment ran exactly once — no double check (determinism)
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  it('keeps step done and appends PASSED when the judgment accepts', async () => {
    const { runtime } = makeHookHarness(env);

    const plan = createPlan('Hook acceptance test', [
      {
        id: 'step-1',
        description: 'Create a user model',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'User type with name and email.',
        status: 'pending',
      },
    ]);

    mockGenerateText.mockResolvedValue({
      text: 'Created user model with name and email fields.',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      steps: [],
    } as any);
    mockGenerateObject.mockResolvedValue({
      object: { accepted: true, reason: 'All criteria met.' },
    } as any);

    const result = await runtime.execute(plan);

    expect(plan.steps[0].status).toBe('done');
    expect(plan.steps[0].failureType).toBeUndefined();
    expect(plan.steps[0].resultSummary).toContain('Acceptance: PASSED');
    expect(result.status).toBe('completed');
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  it('does NOT check steps that failed technically', async () => {
    const { runtime } = makeHookHarness(env);

    const plan = createPlan('No check on technical failure', [
      {
        id: 'step-1',
        description: 'Step that will crash',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'Anything.',
        status: 'pending',
      },
    ]);

    // Step execution FAILS → task failed/technical → no acceptance check
    mockGenerateText.mockRejectedValue(new Error('Provider exploded'));

    const result = await runtime.execute(plan);

    expect(plan.steps[0].status).toBe('failed');
    expect(plan.steps[0].failureType).toBe('technical');
    // The reviewer was never invoked for a technically-failed step
    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(result.status).toBe('failed-partial');
  });

  it('race test: 10 parallel tasks → every acceptance check runs exactly once', async () => {
    const { runtime } = makeHookHarness(env);

    // 10 INDEPENDENT steps → all dispatched in parallel (maxConcurrent=10)
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `step-${i + 1}`,
      description: `Parallel step ${i + 1}`,
      dependsOn: [] as string[],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file'],
      claimedResources: [],
      acceptanceCriteria: 'Output is non-empty.',
      status: 'pending' as const,
    }));
    const plan = createPlan('Ten parallel steps', steps);

    mockGenerateText.mockResolvedValue({
      text: 'Step output ok.',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      steps: [],
    } as any);
    mockGenerateObject.mockResolvedValue({
      object: { accepted: true, reason: 'ok' },
    } as any);

    const result = await runtime.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.completedSteps).toBe(10);
    // EXACTLY 10 judgments — one per task, never more (no double-check)
    expect(mockGenerateObject).toHaveBeenCalledTimes(10);
    // Every step carries the PASSED marker
    for (const step of plan.steps) {
      expect(step.status).toBe('done');
      expect(step.resultSummary).toContain('Acceptance: PASSED');
    }
  });

  it('judgment prompt contains the ACTUAL task output (no stale state)', async () => {
    const { runtime } = makeHookHarness(env);

    const plan = createPlan('Output wiring', [
      {
        id: 'step-1',
        description: 'Emit a distinctive string',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'Contains MARKER-XYZ-123.',
        status: 'pending',
      },
    ]);

    mockGenerateText.mockResolvedValue({
      text: 'The output contains MARKER-XYZ-123 as required.',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      steps: [],
    } as any);
    mockGenerateObject.mockResolvedValue({
      object: { accepted: true, reason: 'Marker found.' },
    } as any);

    await runtime.execute(plan);

    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
    const judgePrompt = mockGenerateObject.mock.calls[0]![0] as { prompt: string };
    expect(judgePrompt.prompt).toContain('MARKER-XYZ-123');
  });
});

// ─── Failure type distinction ────────────────────────────────────

describe('Failure type distinction', () => {
  it('technical failure comes from AgentRuntime/TaskRuntime', () => {
    // Simulated: a task that failed due to provider error
    const task: Task = {
      id: 't1',
      agentDefinitionOrId: 'coder',
      prompt: 'Do something',
      status: 'failed',
      summary: 'Agent execution failed: Provider timeout',
      result: '',
      claimedResources: [],
      errors: ['Provider timeout'],
      failureType: 'technical',
      createdAt: Date.now(),
    };

    expect(task.failureType).toBe('technical');
  });

  it('quality failure comes from AcceptanceChecker', async () => {
    vi.clearAllMocks();
    const env = setup();
    const checker = new AcceptanceChecker(createCheckerConfig(env));

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        accepted: false,
        reason: 'Output does not match acceptance criteria.',
      },
    } as any);

    const plan = createTestPlan();
    const step = plan.steps[0];
    step.status = 'done'; // Technically completed
    const task = createMockTask('step-1', 'Incomplete output');

    const result = await checker.checkStep(step, task);

    expect(result.accepted).toBe(false);
    // When PlanRuntime processes this, it sets failureType = 'quality'
    // (distinct from 'technical' which comes from the execution layer)
  });

  it('dependent steps do not become ready when a step is quality-failed', () => {
    const plan = createTestPlan();
    plan.steps[0].status = 'failed';
    plan.steps[0].failureType = 'quality';

    // step-2 depends on step-1, which is failed (not done)
    const ready = getReadySteps(plan);
    expect(ready).toHaveLength(0); // step-2 is NOT ready
  });
});

// ─── Integration: quality failure triggers re-planning path ──────

describe('Quality failure → re-planning integration', () => {
  it('onQualityFailure callback is invoked with correct args (Phase 20 hook)', async () => {
    vi.clearAllMocks();
    const env = setup();
    const failures: any[] = [];

    const { runtime } = makeHookHarness(env, {
      onQualityFailure: (planId, stepId, reason) => {
        failures.push({ planId, stepId, reason });
      },
    });

    const plan = createPlan('Replan trigger', [
      {
        id: 'step-1',
        description: 'Add validation to the user model',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'Validation logic present.',
        status: 'pending',
      },
    ]);
    plan.id = 'replan-test';

    mockGenerateText.mockResolvedValue({
      text: 'Done (no validation).',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      steps: [],
    } as any);
    mockGenerateObject.mockResolvedValueOnce({
      object: { accepted: false, reason: 'Missing validation logic.' },
    } as any);

    await runtime.execute(plan);

    expect(failures).toHaveLength(1);
    expect(failures[0].planId).toBe('replan-test');
    expect(failures[0].stepId).toBe('step-1');
    expect(failures[0].reason).toContain('validation');
  });
});
