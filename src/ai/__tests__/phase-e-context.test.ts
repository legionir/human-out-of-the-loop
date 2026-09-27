import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createAgent, filterSkillInstructions } from '../agents/agent-factory.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
import { buildCatalogBlock } from '../planning/catalog-prompt.js';
import {
  buildAssessmentPrompt,
  buildPlanPrompt,
  fallbackClarificationQuestion,
} from '../planning/planner.js';
import { buildStepPrompt, formatDoneStepSummaries, STEP_CONTEXT_CHAR_CAP } from '../runtime/step-prompt.js';
import { detectLanguage } from '../language.js';
import { PlanModelSchema, PlanStepModelSchema, type Plan } from '../schemas/plan.js';
import { DEFAULT_MODEL_ID } from '../models/defaults.js';
import { generationSettingsFromConfig, withGenerationSettings } from '../models/generation-settings.js';
import { resolveAnthropicClientOptions } from '../models/providers/anthropic-provider.js';
import type { ModelConfig } from '../schemas/model-config.js';
import type { PlanStep } from '../schemas/plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSONAS_DIR = path.join(ROOT, 'registry/personas');
const SKILLS_DIR = path.join(ROOT, 'registry/skills');
const SRC_DIR = path.join(ROOT, 'src');

function mockProvider(name: string): ProviderFactory {
  return {
    name,
    create: (config) =>
      ({
        specificationVersion: 'v1',
        provider: name,
        modelId: config.model,
        defaultObjectGenerationMode: 'json',
        doGenerate: () => Promise.resolve({}),
        doStream: () => Promise.resolve({}),
      }) as unknown as LanguageModel,
  };
}

function loadRefs() {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);
  const toolRegistry = new ToolRegistry();
  registerLocalToolFixtures(toolRegistry, ROOT);
  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry, false);
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(mockProvider('openai'));
  modelRegistry.registerProvider(mockProvider('anthropic'));
  modelRegistry.registerConfig({
    id: 'gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    config: { temperature: 0.2, maxTokens: 2048, maxContextTokens: 4_000 },
  });
  modelRegistry.registerConfig({
    id: 'claude-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    config: { temperature: 0.3, maxTokens: 8192, apiKeyEnv: 'MY_ANTHROPIC_KEY', baseURL: 'https://example.test/v1' },
  });
  modelRegistry.registerConfig({
    id: 'tiny-model',
    provider: 'openai',
    model: 'tiny',
    config: { maxContextTokens: 20 },
  });
  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walkTs(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function step(over: Partial<PlanStep> & Pick<PlanStep, 'id' | 'description'>): PlanStep {
  return {
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: [],
    claimedResources: [],
    acceptanceCriteria: 'done',
    status: 'pending',
    ...over,
  };
}

describe('E-01 — planner catalog', () => {
  it('lists every registered persona and skill id in the compact catalog', () => {
    const refs = loadRefs();
    const block = buildCatalogBlock(refs);
    expect(block).toContain('AVAILABLE CATALOG');
    for (const persona of refs.personaRegistry.list()) {
      expect(block).toContain(`- ${persona.id}:`);
    }
    expect(block).toContain('- judge:');
    for (const skill of refs.skillRegistry.list()) {
      expect(block).toContain(`- ${skill.id}:`);
    }
    expect(block).toContain('read_file');
  });

  it('injects the catalog into assess/plan prompts (5th arg stays optional)', () => {
    const refs = loadRefs();
    const catalog = buildCatalogBlock(refs);
    const assess = buildAssessmentPrompt('do the thing', ROOT, 'plan', undefined, catalog);
    const plan = buildPlanPrompt('do the thing', undefined, ROOT, undefined, catalog);
    expect(assess).toContain('AVAILABLE CATALOG');
    expect(assess).toContain('- coder:');
    expect(plan).toContain('AVAILABLE CATALOG');
    expect(buildAssessmentPrompt('hi')).not.toContain('AVAILABLE CATALOG');
    expect(buildPlanPrompt('hi')).not.toContain('AVAILABLE CATALOG');
  });

  it('task_decomposition no longer tells the model to call list_personas', () => {
    const md = fs.readFileSync(path.join(SKILLS_DIR, 'task_decomposition/SKILL.md'), 'utf8');
    expect(md).not.toMatch(/use `list_personas`/i);
    expect(md).toContain('Use the Catalog in the Prompt');
  });
});

describe('E-02 — step prompt', () => {
  const plan: Plan = {
    id: 'plan_1',
    goal: 'Ship the login page',
    status: 'running',
    createdAt: 1,
    clarifications: [],
    steps: [
      step({
        id: 's1',
        description: 'scaffold',
        status: 'done',
        resultSummary: 'Created src/login.ts',
      }),
      step({
        id: 's2',
        description: 'wire the form',
        dependsOn: ['s1'],
        acceptanceCriteria: 'form submits',
        status: 'ready',
      }),
    ],
  };

  it('includes the goal, this step’s criteria, and dependency result summaries', () => {
    const prompt = buildStepPrompt(plan, plan.steps[1]!);
    expect(prompt).toContain('Ship the login page');
    expect(prompt).toContain('form submits');
    expect(prompt).toContain('Created src/login.ts');
    expect(prompt).toContain('wire the form');
  });

  it('clips each field to the character cap', () => {
    const huge = 'x'.repeat(STEP_CONTEXT_CHAR_CAP + 200);
    const clipped = buildStepPrompt(
      { ...plan, goal: huge, steps: [{ ...plan.steps[0]!, resultSummary: huge }, plan.steps[1]!] },
      { ...plan.steps[1]!, acceptanceCriteria: huge, dependsOn: ['s1'] }
    );
    expect(clipped.length).toBeLessThan(STEP_CONTEXT_CHAR_CAP * 4);
    expect(clipped).toContain('…');
  });

  it('re-plan done-step text uses resultSummary, not only the description', () => {
    const text = formatDoneStepSummaries(plan);
    expect(text).toContain('Created src/login.ts');
    expect(text).not.toMatch(/^- s1: scaffold$/m);
  });
});

describe('E-03 — generation settings and Anthropic client options', () => {
  it('reads temperature and maxTokens from the model config', () => {
    const settings = generationSettingsFromConfig({
      id: 'x',
      provider: 'openai',
      model: 'x',
      config: { temperature: 0.4, maxTokens: 512 },
    });
    expect(settings).toEqual({ temperature: 0.4, maxOutputTokens: 512 });
    expect(withGenerationSettings({ model: 'm' }, settings)).toMatchObject({
      model: 'm',
      temperature: 0.4,
      maxOutputTokens: 512,
    });
  });

  it('createAgent copies those settings onto the resolved agent', () => {
    const refs = loadRefs();
    const agent = createAgent({
      agentDefinition: {
        id: 'a',
        name: 'A',
        personaId: 'coder',
        skillIds: [],
        modelId: 'gpt-4o',
      },
      refs,
    });
    expect(agent.generationSettings).toEqual({ temperature: 0.2, maxOutputTokens: 2048 });
  });

  it('Anthropic uses apiKeyEnv and baseURL', () => {
    const config: ModelConfig = {
      id: 'claude-sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      config: { apiKeyEnv: 'MY_ANTHROPIC_KEY', baseURL: 'https://example.test/v1' },
    };
    const options = resolveAnthropicClientOptions(config, {
      MY_ANTHROPIC_KEY: 'sk-ant-test',
    });
    expect(options).toEqual({ apiKey: 'sk-ant-test', baseURL: 'https://example.test/v1' });
  });
});

describe('E-04 — coder does not claim to run tests', () => {
  it('rephrases the verification step instead of inventing a test tool', () => {
    const coder = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, 'coder.json'), 'utf8')) as {
      system: string;
    };
    expect(coder.system.toLowerCase()).not.toMatch(/passes tests/);
    expect(coder.system).toMatch(/do not claim you ran a test suite/i);
  });
});

describe('E-05 — judge persona and code_analysis', () => {
  it('registers a tool-less judge', () => {
    const refs = loadRefs();
    const judge = refs.personaRegistry.get('judge');
    expect(judge).toBeDefined();
    expect(judge!.allowedTools).toEqual([]);
    expect(judge!.system.toLowerCase()).toMatch(/do not reject for style/);
  });

  it('code_analysis no longer forbids a coder from editing', () => {
    const md = fs.readFileSync(path.join(SKILLS_DIR, 'code_analysis/SKILL.md'), 'utf8');
    expect(md).not.toMatch(/Do NOT modify any files/);
    expect(md).toMatch(/may still implement/i);
  });
});

describe('E-06 — skill sections filtered by allowed tools', () => {
  it('drops git_push / git_commit instructions for the researcher (architect)', () => {
    const refs = loadRefs();
    const architect = refs.personaRegistry.get('architect')!;
    const git = refs.skillRegistry.get('git_operations')!;
    const filtered = filterSkillInstructions(
      git.resolvedInstructions,
      new Set(architect.allowedTools),
      git.resolvedTools
    );
    expect(filtered).not.toContain('git_push');
    expect(filtered).not.toContain('git_commit');
    expect(filtered.length).toBeLessThanOrEqual(Math.ceil(git.resolvedInstructions.length * 0.7));

    const agent = createAgent({
      agentDefinition: {
        id: 'researcher',
        name: 'Researcher',
        personaId: 'architect',
        skillIds: ['code_analysis', 'git_operations'],
        modelId: 'gpt-4o',
      },
      refs,
    });
    expect(agent.systemPrompt).not.toContain('git_push');
    expect(agent.systemPrompt).not.toContain('git_commit');
  });

  it('keeps a section that only names allowed tools', () => {
    const filtered = filterSkillInstructions(
      '# Git\n\n## Read\nUse `git_status`.\n\n## Write\nUse `git_push`.\n',
      new Set(['git_status']),
      ['git_status', 'git_push']
    );
    expect(filtered).toContain('git_status');
    expect(filtered).not.toContain('git_push');
  });
});

describe('E-07 — ENVIRONMENT and Language once; planner does not always ask', () => {
  it('user assess/plan prompts carry PROJECT CONTEXT but not a second Language block', () => {
    const assess = buildAssessmentPrompt('fix the login', ROOT, 'plan');
    const plan = buildPlanPrompt('fix the login', undefined, ROOT);
    expect(assess).toMatch(/default shell:/);
    expect(plan).toMatch(/default shell:/);
    expect(assess).not.toContain('## Language');
    expect(plan).not.toContain('## Language');
  });

  it('planner createAgent skips ENVIRONMENT (it is already in PROJECT CONTEXT)', () => {
    const refs = loadRefs();
    const agent = createAgent({
      agentDefinition: {
        id: 'planner-runtime',
        name: 'Planner',
        personaId: 'planner',
        skillIds: ['task_decomposition'],
        modelId: 'gpt-4o',
      },
      refs,
      includeEnvironment: false,
    });
    expect(agent.systemPrompt).toContain('## Language');
    expect(agent.systemPrompt).not.toContain('the machine this runtime runs on');
  });

  it('planner persona treats missing project/stack as already answered', () => {
    const planner = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, 'planner.json'), 'utf8')) as {
      system: string;
    };
    expect(planner.system).toMatch(/only lacks the project/i);
  });
});

describe('E-08 — dominant-script language detection', () => {
  it.each([
    ['سلام، حالت چطوره؟', 'fa'],
    ['این پروژه چند تست دارد؟', 'fa'],
    ['مرحبا كيف حالك', 'arabic-script'],
    ['こんにちは', 'ja'],
    ['東京の天気', 'ja'],
    ['北京天气很好', 'zh'],
    ['یہ اردو ہے ٹیسٹ', 'ur'],
    ['Привет, как дела?', 'ru'],
    ['hello there', undefined],
    ['Translate "привет" to English', undefined],
    ['Rename key کلید in i18n', undefined],
    ['step ۱۲ fails', undefined],
    ['خواندن README', 'arabic-script'],
  ] as const)('%j → %s', (text, code) => {
    expect(detectLanguage(text)?.code).toBe(code);
  });
});

describe('E-09 — reasoning skill uses the system clock', () => {
  it('tells the model to use ENVIRONMENT time, not training-data dates', () => {
    const md = fs.readFileSync(path.join(SKILLS_DIR, 'reasoning/SKILL.md'), 'utf8');
    expect(md).toMatch(/ENVIRONMENT/);
    expect(md).toMatch(/Never guess a date from training data/);
  });
});

describe('E-10 — model Plan schema omits runtime fields', () => {
  it('does not ask the model for status, taskId, resultSummary, sessionId', () => {
    expect(PlanStepModelSchema.shape).not.toHaveProperty('status');
    expect(PlanStepModelSchema.shape).not.toHaveProperty('taskId');
    expect(PlanStepModelSchema.shape).not.toHaveProperty('resultSummary');
    expect(PlanStepModelSchema.shape).not.toHaveProperty('failureType');
    expect(PlanModelSchema.shape).not.toHaveProperty('sessionId');
    expect(PlanModelSchema.shape).not.toHaveProperty('status');
    expect(PlanModelSchema.shape).not.toHaveProperty('id');
    expect(PlanModelSchema.shape.goal.description).toBeTruthy();
  });

  it('parses a model-shaped plan without runtime fields', () => {
    const parsed = PlanModelSchema.parse({
      goal: 'ship it',
      steps: [
        {
          id: 's1',
          description: 'do it',
          assignedPersona: 'coder',
          acceptanceCriteria: 'shipped',
        },
      ],
    });
    expect('status' in parsed.steps[0]!).toBe(false);
  });
});

describe('E-11 — DEFAULT_MODEL_ID and maxContextTokens', () => {
  it('is gpt-4o and the only production fallback', () => {
    expect(DEFAULT_MODEL_ID).toBe('gpt-4o');
    const files = walkTs(SRC_DIR).filter((file) => !file.split(path.sep).join('/').endsWith('models/defaults.ts'));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/['"]gpt-4o['"]/);
    }
  });

  it('catalog maxContextTokens wins over the 30k unknown-model fallback', () => {
    const refs = loadRefs();
    const agent = createAgent({
      agentDefinition: {
        id: 'a',
        name: 'A',
        personaId: 'coder',
        skillIds: ['code_analysis'],
        modelId: 'tiny-model',
      },
      refs,
    });
    // 20 tokens × 4 chars cannot hold the coder persona; without the
    // catalog override the unknown model would get 30_000 tokens.
    expect(agent.contextBudgetExceeded).toBe(true);
  });

  it('ships claude-sonnet-5', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'registry/models/claude-sonnet.json'), 'utf8')
    ) as { model: string };
    expect(cfg.model).toBe('claude-sonnet-5');
  });
});

describe('E-12 — fallback clarification has a single fa branch', () => {
  it('still answers in Persian', () => {
    const q = fallbackClarificationQuestion('/tmp/proj', {
      code: 'fa',
      name: 'Persian',
      native: 'فارسی',
    });
    expect(q).toMatch(/[\u0600-\u06ff]/);
    const src = fs.readFileSync(path.join(ROOT, 'src/ai/planning/planner.ts'), 'utf8');
    expect(src).not.toMatch(/if \(language\?\.code === 'fa'\)[\s\S]*if \(language\.code === 'fa'\)/);
  });
});
