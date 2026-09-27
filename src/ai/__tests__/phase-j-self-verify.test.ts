/**
 * J-02 — after a coder step, if the project has a testCommand, run it.
 * Failure is technical and re-plan sees the test output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime } from '../runtime/plan-runtime.js';
import type { Planner } from '../planning/planner.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as object;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

function setup(projectRoot: string) {
  const eventBus = new EventBus();
  const agentRuntime = new AgentRuntime();
  const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentRuntime });
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);
  const toolRegistry = new ToolRegistry();
  registerLocalToolFixtures(toolRegistry, projectRoot);
  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });
  return { taskRuntime, personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

function coderPlan(): Plan {
  return createPlan('Fix the bug', [
    {
      id: 'step-1',
      description: 'Attempt the fix',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file'],
      claimedResources: [],
      acceptanceCriteria: 'The fix works',
    },
  ]);
}

describe('J-02 — self-verify after coder', () => {
  let root: string;
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j02-'));
    fs.mkdirSync(path.join(root, '.ai-runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.ai-runtime', 'commands.json'),
      JSON.stringify({
        allow: ['node'],
        testCommand: ['node', '-e', 'console.error("SELF_VERIFY_FAIL"); process.exit(1)'],
      }),
    );
    env = setup(root);
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: 'HANDOFF: {"keyResult":"patched","changedFiles":[],"notes":""}',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    } as never);
  });

  afterEach(() => {
    env.taskRuntime.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails the coder step as technical and re-plans with the test output', async () => {
    const generatePlan = vi.fn().mockResolvedValue(
      createPlan('Fix the bug', [
        {
          id: 'step-1',
          description: 'A different approach',
          dependsOn: [],
          assignedPersona: 'reviewer',
          assignedSkills: [],
          assignedTools: ['read_file'],
          claimedResources: [],
          acceptanceCriteria: 'reviewed',
        },
      ]),
    );
    const runtime = new PlanRuntime({
      taskRuntime: env.taskRuntime,
      planStore: new MemoryPlanStore(),
      planner: { generatePlan } as unknown as Planner,
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
      projectRoot: root,
    });

    await runtime.execute(coderPlan());
    expect(generatePlan).toHaveBeenCalled();
    const replanPrompt = String(generatePlan.mock.calls[0]?.[0] ?? '');
    expect(replanPrompt).toContain('SELF_VERIFY_FAIL');
    expect(replanPrompt).toMatch(/technical/i);
  });
});
