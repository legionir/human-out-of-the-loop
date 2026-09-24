import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime, type PlanRuntimeConfig } from '../runtime/plan-runtime.js';
import { Planner, type PlannerConfig } from '../planning/planner.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createPlan, type Plan } from '../schemas/plan.js';
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
  const actual = await vi.importActual('ai') as any;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText } from 'ai';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
const mockGenerateText = vi.mocked(generateText);

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
  agentRuntime: AgentRuntime;
  taskRuntime: TaskRuntime;
  planStore: MemoryPlanStore;
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
}

function setup(): TestEnv {
  const eventBus = new EventBus();
  const agentRuntime = new AgentRuntime();
  const taskRuntime = new TaskRuntime({
    maxConcurrentTasks: 3,
    eventBus,
    agentRuntime,
  });

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
  // Minimal fix: bootstrap catalog tools BEFORE loading skills because task_decomposition depends on list_personas etc.
  // Original spec loaded skills first, which fails with "[SkillRegistry] references unknown tool(s)".
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  // Re-bootstrap idempotently after loading (ensures implementations are registered)
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  const planStore = new MemoryPlanStore();

  return {
    eventBus,
    agentRuntime,
    taskRuntime,
    planStore,
    personaRegistry,
    skillRegistry,
    toolRegistry,
    modelRegistry,
  };
}

function createPlanRuntime(env: TestEnv, overrides?: Partial<PlanRuntimeConfig>): PlanRuntime {
  // Mock planner that always returns "isClear: false" for re-planning
  // (simplifies tests — re-planning returns false = no progress)
  const mockPlanner = {
    assess: vi.fn().mockResolvedValue({ isClear: false, needsClarification: ['mock'] }),
    generatePlan: vi.fn(),
    plan: vi.fn().mockResolvedValue({ isClear: false, needsClarification: [], errors: [] }),
  } as unknown as Planner;

  return new PlanRuntime({
    taskRuntime: env.taskRuntime,
    planStore: env.planStore,
    planner: mockPlanner,
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
    maxReplanningAttempts: 2,
    defaultModelId: 'gpt-4o',
    ...overrides,
  });
}

function createSimplePlan(): Plan {
  return createPlan('Build a login page', [
    {
      id: 'step-1',
      description: 'Analyse requirements',
      dependsOn: [],
      assignedPersona: 'architect',
      assignedSkills: ['code_analysis'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'Requirements document produced',
      status: 'pending',
    },
    {
      id: 'step-2',
      description: 'Implement login form',
      dependsOn: ['step-1'],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file', 'search_code'],
      claimedResources: ['src/login.tsx'],
      acceptanceCriteria: 'Login form renders and validates input',
      status: 'pending',
    },
    {
      id: 'step-3',
      description: 'Review implementation',
      dependsOn: ['step-2'],
      assignedPersona: 'reviewer',
      assignedSkills: ['code_analysis'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'No critical findings',
      status: 'pending',
    },
  ]);
}

// ─── PlanRuntime — full execution ────────────────────────────────

describe('PlanRuntime — full execution', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('executes a multi-step plan with dependencies to completion', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Step completed successfully.',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      steps: [],
    } as any);

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    const result = await runtime.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.completedSteps).toBe(3);
    expect(result.failedSteps).toBe(0);
    expect(result.totalSteps).toBe(3);
    expect(result.incompleteSteps).toHaveLength(0);
  });

  it('persists plan state after each step', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    await runtime.execute(plan);

    // Plan should be persisted in the store
    const stored = env.planStore.load(plan.id!);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('completed');
    expect(stored!.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('executes steps in dependency order', async () => {
    const executionOrder: string[] = [];

    mockGenerateText.mockImplementation(async (opts: any) => {
      // Extract step description from the prompt
      executionOrder.push(opts.prompt);
      return {
        text: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any;
    });

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    await runtime.execute(plan);

    // step-1 must come before step-2, step-2 before step-3
    expect(executionOrder).toHaveLength(3);
    expect(executionOrder[0]).toContain('Analyse requirements');
    expect(executionOrder[1]).toContain('Implement login form');
    expect(executionOrder[2]).toContain('Review implementation');
  });

  it('runs independent steps in parallel', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockGenerateText.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 50));
      concurrentCount--;
      return {
        text: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any;
    });

    // Plan with two independent root steps
    const plan = createPlan('Parallel work', [
      {
        id: 's1',
        description: 'Task A',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
      {
        id: 's2',
        description: 'Task B',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
      {
        id: 's3',
        description: 'Merge',
        dependsOn: ['s1', 's2'],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);

    const runtime = createPlanRuntime(env);
    await runtime.execute(plan);

    expect(maxConcurrent).toBe(2); // s1 and s2 ran in parallel
    expect(plan.steps.every((s) => s.status === 'done')).toBe(true);
  });
});

// ─── PlanRuntime — failure handling ──────────────────────────────

describe('PlanRuntime — failure handling', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('handles a step failure without crashing the entire plan', async () => {
    let callCount = 0;
    mockGenerateText.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Provider error on step 2');
      }
      return {
        text: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any;
    });

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    const result = await runtime.execute(plan);

    // Plan should not crash — it should report partial failure
    expect(['failed-partial', 'completed']).toContain(result.status);
    expect(result.totalSteps).toBe(3);
    // At least step-1 should have completed
    const step1 = plan.steps.find((s) => s.id === 'step-1')!;
    expect(step1.status).toBe('done');
  });

  it('reports incomplete steps in failed-partial result', async () => {
    mockGenerateText.mockRejectedValue(new Error('All steps fail'));

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    const result = await runtime.execute(plan);

    expect(result.status).toBe('failed-partial');
    expect(result.incompleteSteps.length).toBeGreaterThan(0);
    expect(result.completedSteps).toBe(0);
  });
});

// ─── PlanRuntime — priority queue ────────────────────────────────

describe('PlanRuntime — priority queue', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('prioritizes steps that unblock the most dependents', async () => {
    const executionOrder: string[] = [];

    mockGenerateText.mockImplementation(async (opts: any) => {
      executionOrder.push(opts.prompt);
      return {
        text: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any;
    });

    // Diamond dependency: A and B are roots, C depends on A, D depends on A+B
    // A has 2 dependents (C, D), B has 1 dependent (D)
    // So A should be prioritized over B when concurrency is limited
    const plan = createPlan('Priority test', [
      { id: 'A', description: 'Root A (2 dependents)', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'B', description: 'Root B (1 dependent)', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'C', description: 'Depends on A', dependsOn: ['A'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'D', description: 'Depends on A and B', dependsOn: ['A', 'B'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    // Use concurrency cap of 1 to force sequential execution
    env.taskRuntime.destroy();
    env.taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus: env.eventBus,
      agentRuntime: env.agentRuntime,
    });

    const runtime = createPlanRuntime(env);
    await runtime.execute(plan);

    // A should execute before B (more dependents)
    const indexA = executionOrder.findIndex((p) => p.includes('Root A'));
    const indexB = executionOrder.findIndex((p) => p.includes('Root B'));
    expect(indexA).toBeLessThan(indexB);
  });
});

// ─── PlanRuntime — resume after crash ────────────────────────────

describe('PlanRuntime — resume', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('resumes a partially completed plan from the store', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    // Simulate a plan where step-1 is already done (from a previous run)
    const plan = createSimplePlan();
    plan.id = 'resume-test-plan';
    plan.status = 'running';
    plan.steps[0].status = 'done';
    plan.steps[0].resultSummary = 'Previously completed';

    // Persist the partial state
    env.planStore.save(plan);

    const runtime = createPlanRuntime(env);
    const result = await runtime.resume('resume-test-plan');

    expect(result.status).toBe('completed');
    expect(result.completedSteps).toBe(3);
  });

  it('resets "running" steps to "pending" on resume (crash recovery)', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const plan = createSimplePlan();
    plan.id = 'crash-recovery-plan';
    plan.status = 'running';
    plan.steps[0].status = 'done';
    plan.steps[1].status = 'running'; // Was running when crash happened
    plan.steps[1].taskId = 'old-task-id';

    env.planStore.save(plan);

    const runtime = createPlanRuntime(env);
    const result = await runtime.resume('crash-recovery-plan');

    // step-1 should have been re-dispatched (reset from running → pending → running → done)
    expect(result.status).toBe('completed');
    // Minimal fix: MemoryPlanStore deep-clones on save, so original `plan` variable
    // is not mutated by resume. Check the persisted copy instead.
    const storedAfter = env.planStore.load('crash-recovery-plan')!;
    const step2 = storedAfter.steps.find((s) => s.id === 'step-2')!;
    expect(step2.status).toBe('done');
  });

  it('throws when resuming a non-existent plan', async () => {
    const runtime = createPlanRuntime(env);
    await expect(runtime.resume('nonexistent')).rejects.toThrow(/not found/);
  });
});

// ─── PlanRuntime — re-planning ceiling ───────────────────────────

describe('PlanRuntime — re-planning ceiling', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('stops after reaching max re-planning attempts', async () => {
    // All steps fail → triggers re-planning → re-planning also fails
    mockGenerateText.mockRejectedValue(new Error('Persistent failure'));

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env, { maxReplanningAttempts: 2 });

    const result = await runtime.execute(plan);

    expect(result.status).toBe('failed-partial');
    expect(result.replanningAttempts).toBeLessThanOrEqual(2);
    expect(result.incompleteSteps.length).toBeGreaterThan(0);
  });
});

// ─── PlanRuntime — cancellation ──────────────────────────────────

describe('PlanRuntime — cancellation', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('stops dispatching new steps when cancelled', async () => {
    let stepCount = 0;

    mockGenerateText.mockImplementation(async () => {
      stepCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        text: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any;
    });

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    // Cancel after a short delay
    setTimeout(() => runtime.cancel(), 30);

    const result = await runtime.execute(plan);

    expect(result.status).toBe('cancelled');
    // Not all steps should have been dispatched
    expect(stepCount).toBeLessThan(3);
  });
});

// ─── PlanRuntime — no human intervention (Law 17) ───────────────

describe('PlanRuntime — Law 17: Human-Out-Of-Loop', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('completes an entire plan without any "await user input" pause', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env);

    // The execute() call should resolve on its own — no external
    // signal needed.  If it hangs, the test will timeout.
    const startTime = Date.now();
    const result = await runtime.execute(plan);
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe('completed');
    // Should complete in reasonable time (not stuck waiting)
    expect(elapsed).toBeLessThan(10_000);
  });

  it('handles failure + re-planning exhaustion without human input', async () => {
    mockGenerateText.mockRejectedValue(new Error('Fail'));

    const plan = createSimplePlan();
    const runtime = createPlanRuntime(env, { maxReplanningAttempts: 1 });

    // Should resolve with failed-partial, not hang
    const result = await runtime.execute(plan);

    expect(['failed-partial', 'cancelled']).toContain(result.status);
    expect(result.incompleteSteps.length).toBeGreaterThan(0);
  });
});

// ─── PlanStore tests ─────────────────────────────────────────────

describe('MemoryPlanStore', () => {
  it('saves and loads a plan', () => {
    const store = new MemoryPlanStore();
    const plan = createSimplePlan();
    plan.id = 'test-plan';

    store.save(plan);
    const loaded = store.load('test-plan');

    expect(loaded).toBeDefined();
    expect(loaded!.goal).toBe('Build a login page');
    expect(loaded!.steps).toHaveLength(3);
  });

  it('returns undefined for non-existent plan', () => {
    const store = new MemoryPlanStore();
    expect(store.load('nope')).toBeUndefined();
  });

  it('lists stored plan ids', () => {
    const store = new MemoryPlanStore();
    const p1 = createSimplePlan();
    p1.id = 'p1';
    const p2 = createSimplePlan();
    p2.id = 'p2';

    store.save(p1);
    store.save(p2);

    expect(store.list()).toContain('p1');
    expect(store.list()).toContain('p2');
  });

  it('deletes a plan', () => {
    const store = new MemoryPlanStore();
    const plan = createSimplePlan();
    plan.id = 'del-me';

    store.save(plan);
    expect(store.exists('del-me')).toBe(true);

    store.delete('del-me');
    expect(store.exists('del-me')).toBe(false);
  });

  it('deep-clones on save (mutations do not affect stored copy)', () => {
    const store = new MemoryPlanStore();
    const plan = createSimplePlan();
    plan.id = 'clone-test';

    store.save(plan);
    plan.steps[0].status = 'done'; // Mutate original

    const loaded = store.load('clone-test')!;
    expect(loaded.steps[0].status).toBe('pending'); // Stored copy unchanged
  });
});
