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

import { generateObject } from 'ai';
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

function createCheckerConfig(
  env: TestEnv,
  overrides?: Partial<AcceptanceCheckerConfig>
): AcceptanceCheckerConfig {
  return {
    personaRegistry: env.personaRegistry,
    skillRegistry: env.skillRegistry,
    toolRegistry: env.toolRegistry,
    modelRegistry: env.modelRegistry,
    eventBus: env.eventBus,
    planStore: env.planStore,
    ...overrides,
  };
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

// ─── AcceptanceChecker — event-driven flow ───────────────────────

describe('AcceptanceChecker — event-driven flow', () => {
  let env: TestEnv;
  let checker: AcceptanceChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    checker?.stop();
  });

  it('automatically checks step on agent:completed event', async () => {
    const qualityFailures: Array<{ planId: string; stepId: string; reason: string }> = [];

    checker = new AcceptanceChecker(
      createCheckerConfig(env, {
        onQualityFailure: (planId, stepId, reason) => {
          qualityFailures.push({ planId, stepId, reason });
        },
      })
    );

    const plan = createTestPlan();
    plan.id = 'event-test-plan';
    plan.steps[0].status = 'done';
    plan.steps[0].taskId = 'task-step-1';
    plan.steps[0].resultSummary = 'Created user model with name field only.';

    checker.registerPlan(plan);
    checker.start();

    // Mock the reviewer to reject
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        accepted: false,
        reason: 'Email field is missing.',
      },
    } as any);

    // Simulate agent:completed event
    env.eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-step-1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Created user model.',
      toolsUsed: ['write_file'],
    });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 100));

    // Step should now be failed with quality failureType
    expect(plan.steps[0].status).toBe('failed');
    expect(plan.steps[0].failureType).toBe('quality');
    expect(plan.steps[0].resultSummary).toContain('FAILED');
    expect(plan.steps[0].resultSummary).toContain('Email field is missing');

    // Quality failure callback should have been invoked
    expect(qualityFailures).toHaveLength(1);
    expect(qualityFailures[0].stepId).toBe('step-1');
  });

  it('keeps step as done when acceptance passes', async () => {
    const qualityFailures: any[] = [];

    checker = new AcceptanceChecker(
      createCheckerConfig(env, {
        onQualityFailure: (planId, stepId, reason) => {
          qualityFailures.push({ planId, stepId, reason });
        },
      })
    );

    const plan = createTestPlan();
    plan.id = 'pass-test-plan';
    plan.steps[0].status = 'done';
    plan.steps[0].taskId = 'task-step-1-pass';
    plan.steps[0].resultSummary = 'Created user model with name and email.';

    checker.registerPlan(plan);
    checker.start();

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        accepted: true,
        reason: 'All criteria met.',
      },
    } as any);

    env.eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-step-1-pass',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done.',
      toolsUsed: [],
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(plan.steps[0].status).toBe('done');
    expect(plan.steps[0].failureType).toBeUndefined();
    expect(qualityFailures).toHaveLength(0);
  });

  it('ignores events for tasks not associated with any plan', async () => {
    checker = new AcceptanceChecker(createCheckerConfig(env));
    checker.start();

    // Emit event for an unknown task
    env.eventBus.emit({
      type: 'agent:completed',
      taskId: 'orphan-task',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done.',
      toolsUsed: [],
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should not throw or call generateObject
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('ignores steps that are not in "done" status', async () => {
    checker = new AcceptanceChecker(createCheckerConfig(env));

    const plan = createTestPlan();
    plan.id = 'not-done-plan';
    plan.steps[0].status = 'running'; // Not done yet
    plan.steps[0].taskId = 'task-running';

    checker.registerPlan(plan);
    checker.start();

    env.eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-running',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done.',
      toolsUsed: [],
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should not check — step is "running", not "done"
    expect(mockGenerateObject).not.toHaveBeenCalled();
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
  it('onQualityFailure callback is invoked with correct args', async () => {
    vi.clearAllMocks();
    const env = setup();
    const failures: any[] = [];

    const checker = new AcceptanceChecker(
      createCheckerConfig(env, {
        onQualityFailure: (planId, stepId, reason) => {
          failures.push({ planId, stepId, reason });
        },
      })
    );

    const plan = createTestPlan();
    plan.id = 'replan-test';
    plan.steps[0].status = 'done';
    plan.steps[0].taskId = 'task-r1';
    plan.steps[0].resultSummary = 'Bad output';

    checker.registerPlan(plan);
    checker.start();

    mockGenerateObject.mockResolvedValueOnce({
      object: { accepted: false, reason: 'Missing validation logic.' },
    } as any);

    env.eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-r1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done.',
      toolsUsed: [],
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(failures).toHaveLength(1);
    expect(failures[0].planId).toBe('replan-test');
    expect(failures[0].stepId).toBe('step-1');
    expect(failures[0].reason).toContain('validation');

    checker.stop();
  });
});
