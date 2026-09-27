/**
 * J-03 — `--budget` tokens or `$`: exceeding cancels with "budget exceeded"
 * and no further model calls. Prices live on the model registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import {
  BudgetExceededError,
  BudgetTracker,
  parseBudget,
  priceFromModelConfig,
  estimatePlanCost,
} from '../runtime/budget.js';
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
import { ModelConfigSchema } from '../schemas/model-config.js';
import { createPlan } from '../schemas/plan.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
import { validateRunOptions } from '../../cli/commands/run.js';
import fs from 'node:fs';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as object;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');
const REPO = path.resolve(__dirname, '../../..');

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

describe('J-03 — budget', () => {
  it('parses token counts and dollar amounts', () => {
    expect(parseBudget('10000')).toMatchObject({ kind: 'tokens', limit: 10000 });
    expect(parseBudget('10k')).toMatchObject({ kind: 'tokens', limit: 10000 });
    expect(parseBudget('10k tokens')).toMatchObject({ kind: 'tokens', limit: 10000 });
    expect(parseBudget('$1.50')).toMatchObject({ kind: 'usd', limit: 1.5 });
    expect(parseBudget('1.50$')).toMatchObject({ kind: 'usd', limit: 1.5 });
    expect(parseBudget('nope')).toHaveProperty('error');
  });

  it('tracks tokens and throws after the cap so a next call is blocked', () => {
    const tracker = new BudgetTracker({ kind: 'tokens', limit: 10, raw: '10' });
    tracker.record({ promptTokens: 6, completionTokens: 5, totalTokens: 11 });
    expect(tracker.exceeded()).toBe(true);
    expect(() => tracker.assertCanCall()).toThrow(BudgetExceededError);
    expect(() => tracker.assertCanCall()).toThrow(/budget exceeded/);
  });

  it('reads prices from the model registry', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'registry/models/gpt-4o.json'), 'utf8'));
    const parsed = ModelConfigSchema.parse(raw);
    expect(parsed.pricing?.inputUsdPerMTok).toBeGreaterThan(0);
    expect(priceFromModelConfig(parsed).outputUsdPerMTok).toBe(10);
  });

  it('rejects a bad --budget in CLI validation', () => {
    expect(validateRunOptions({ budget: 'abc' })).toMatch(/--budget/);
    expect(validateRunOptions({ budget: '$2' })).toBeUndefined();
  });

  it('cancels the plan with budget exceeded before any further model call', async () => {
    mockGenerateText.mockClear();
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentRuntime });
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(createMockProvider('openai'));
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    const runtime = new PlanRuntime({
      taskRuntime,
      planStore: new MemoryPlanStore(),
      planner: { generatePlan: vi.fn() } as unknown as Planner,
      feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
      maxReplanningAttempts: 0,
      defaultModelId: 'gpt-4o',
      budgetExceeded: () => 'budget exceeded',
    });

    const plan = createPlan('do work', [
      {
        id: 'step-1',
        description: 'work',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'done',
      },
    ]);
    const result = await runtime.execute(plan);
    expect(result.status).toBe('cancelled');
    expect(plan.cancelReason).toBe('budget exceeded');
    expect(mockGenerateText).not.toHaveBeenCalled();
    taskRuntime.destroy();
  });

  it('estimates step tokens from planning usage', () => {
    const estimate = estimatePlanCost(3, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(estimate.steps).toBe(3);
    expect(estimate.tokens).toBe(150 + 3 * 800);
    expect(estimate.usd).toBeGreaterThan(0);
  });
});
