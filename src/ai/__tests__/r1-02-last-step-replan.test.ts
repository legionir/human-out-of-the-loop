/**
 * R1-02 — a failed LAST (or only) step must trigger re-planning, not an
 * immediate `failed-partial`. Before the fix, `PlanRuntime.execute()`'s
 * `while (!this.shouldExit(plan))` guard exited the loop the instant every
 * step was `done` or `failed` (`isPlanTerminal`) — BEFORE the loop body's
 * `isStuck()` check (which only fires for a step blocked on a still-
 * pending dependency) ever ran. Re-planning was unreachable for a
 * single-step plan, or any plan whose last remaining step failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime, type PlanRuntimeConfig } from '../runtime/plan-runtime.js';
import type { Planner } from '../planning/planner.js';
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
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

const TEST_ROOT = process.cwd();
const readFileTool = createReadFileTool(TEST_ROOT);
const searchCodeTool = createSearchCodeTool(TEST_ROOT);
const writeFileTool = createWriteFileTool(TEST_ROOT);
const gitStatusTool = createGitStatusTool(TEST_ROOT);

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as any;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

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
  const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 3, eventBus, agentRuntime });

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
  registerLocalToolFixtures(toolRegistry, TEST_ROOT);

  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  return {
    eventBus,
    agentRuntime,
    taskRuntime,
    planStore: new MemoryPlanStore(),
    personaRegistry,
    skillRegistry,
    toolRegistry,
    modelRegistry,
  };
}

function singleStepPlan(): Plan {
  return createPlan('Fix the bug', [
    {
      id: 'step-1',
      description: 'Attempt the fix',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'The fix works',
      status: 'pending',
    },
  ]);
}

function replacementPlan(): Plan {
  return createPlan('Fix the bug', [
    {
      // Same id as the failed step: the planner is REPLACING it, which is
      // the merge path this test exercises (R1-03, a separate finding,
      // covers a planner that invents a brand-new id instead).
      id: 'step-1',
      description: 'A different approach to the fix',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'The fix works',
      status: 'pending',
    },
  ]);
}

describe('R1-02 — a failed single/last step triggers re-planning', () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = setup();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('re-plans and completes when the ONLY step fails but the replacement succeeds', async () => {
    let call = 0;
    mockGenerateText.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('step-1 blew up');
      return { text: 'done', toolCalls: [], toolResults: [], usage: {}, finishReason: 'stop' } as any;
    });

    const mockPlanner = {
      assess: vi.fn(),
      generatePlan: vi.fn(),
      plan: vi.fn().mockResolvedValue({ isClear: true, needsClarification: [], errors: [], plan: replacementPlan() }),
    } as unknown as Planner;

    const runtime = new PlanRuntime({
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
    });

    const plan = singleStepPlan();
    const result = await runtime.execute(plan);

    expect(mockPlanner.plan).toHaveBeenCalled();
    expect(result.replanningAttempts).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('completed');
  });
});
