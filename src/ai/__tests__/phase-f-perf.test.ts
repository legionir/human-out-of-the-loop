/**
 * Phase F — efficiency and token use (UNIFIED F-01…F-10).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { ServerResponse } from 'node:http';
import { environmentBullets, collectEnvironmentFacts } from '../environment-context.js';
import { toTokenUsage, addTokenUsage } from '../runtime/llm-usage.js';
import { withGenerationSettings } from '../models/generation-settings.js';
import { createAgent } from '../agents/agent-factory.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import type { CrossRegistryRefs } from '../registries/agent-registry.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
import { compactToolDescriptions, estimateToolCatalogTokens } from '../tools/compact-descriptions.js';
import { createDirectoryTreeTool } from '../tools/implementations/directory-tree.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { capToolResult, TOOL_RESULT_CHAR_CAP } from '../runtime/tool-result-cap.js';
import { trimConversationMessages } from '../runtime/conversation-budget.js';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { FilePlanStore, MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime } from '../runtime/plan-runtime.js';
import type { Planner } from '../planning/planner.js';
import { createPlan } from '../schemas/plan.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { ReviewModelSchema } from '../schemas/review.js';
import { followLog } from '../../cli/commands/logs.js';
import { sumUsageFromEntries } from '../../cli/utils/log-reader.js';
import { SseHub, DEFAULT_MAX_SSE_CONNECTIONS } from '../../server/sse.js';
import { JournalWriter } from '../runtime/journal.js';
import { AcceptanceChecker } from '../runtime/acceptance-checker.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText, generateObject } from 'ai';
const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');
const TEST_ROOT = process.cwd();

function executeOf(tool: { execute?: (...args: never[]) => unknown }): (input: unknown) => Promise<unknown> {
  if (typeof tool.execute !== 'function') throw new Error('missing execute');
  return (input) => Promise.resolve(tool.execute!(input as never));
}

function fakeRes(): ServerResponse {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end() {},
    statusCode: 200,
    headersSent: false,
    setHeader() {
      return this;
    },
  } as unknown as ServerResponse;
}

function mockProvider(name: string): ProviderFactory {
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

function loadRefs(): CrossRegistryRefs & {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
} {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);
  const toolRegistry = new ToolRegistry();
  registerLocalToolFixtures(toolRegistry, TEST_ROOT);
  const skillRegistry = new SkillRegistry({ toolRegistry });
  for (const id of ['list_personas', 'list_skills', 'list_tools']) {
    if (!toolRegistry.hasDefinition(id)) {
      toolRegistry.registerDefinition({
        id,
        name: id,
        description: id,
        source: 'local',
        modulePath: `./${id}`,
        category: 'catalog',
      });
      toolRegistry.registerImplementation(id, {
        description: id,
        execute: async () => ({ ok: true }),
      } as never);
    }
  }
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(mockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });
  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

function step(
  id: string,
  description: string,
  dependsOn: string[] = [],
): ReturnType<typeof createPlan>['steps'][number] {
  return {
    id,
    description,
    dependsOn,
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: 'done',
    status: 'pending',
  };
}

describe('F-01 — day-only clock and Anthropic cache', () => {
  it('environment bullets carry the date, not the second', () => {
    const facts = collectEnvironmentFacts();
    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toMatch(/current time: \d{4}-\d{2}-\d{2} \(/);
    expect(bullets).not.toMatch(/current time: \d{4}-\d{2}-\d{2} \d{2}:/);
    expect(environmentBullets(facts).join('\n')).toBe(bullets);
  });

  it('withGenerationSettings stamps Anthropic cacheControl', () => {
    const once = withGenerationSettings({ model: 'm', system: 'stable' }, undefined);
    const twice = withGenerationSettings({ model: 'm', system: 'stable' }, undefined);
    expect(once).toEqual(twice);
    expect(once).toMatchObject({
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('toTokenUsage records cache read/write tokens', () => {
    const usage = toTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 12,
    });
    expect(usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 12,
    });
    const sum = addTokenUsage(usage, usage);
    expect(sum?.cacheReadTokens).toBe(160);
    expect(sum?.cacheWriteTokens).toBe(24);
  });

  it('hootl usage aggregator sums cache tokens from log entries', () => {
    const totals = sumUsageFromEntries([
      {
        timestamp: '',
        epochMs: 0,
        eventType: 'llm:usage',
        message: '',
        level: 'info',
        payload: {
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            totalTokens: 12,
            cacheReadTokens: 8,
            cacheWriteTokens: 1,
          },
        },
      },
    ]);
    expect(totals.cacheReadTokens).toBe(8);
    expect(totals.cacheWriteTokens).toBe(1);
  });
});

describe('F-02 — step tools are assigned ∩ allowed, descriptions compact', () => {
  it('uses only def.toolIds when that list is non-empty', () => {
    const refs = loadRefs();
    const withIds = createAgent({
      agentDefinition: {
        id: 'step',
        name: 'Step',
        personaId: 'coder',
        skillIds: ['file_management', 'code_analysis'],
        toolIds: ['read_file', 'write_file', 'edit_file', 'search_code'],
        modelId: 'gpt-4o',
      },
      refs,
    });
    const withoutIds = createAgent({
      agentDefinition: {
        id: 'all',
        name: 'All',
        personaId: 'coder',
        skillIds: ['file_management', 'code_analysis'],
        modelId: 'gpt-4o',
      },
      refs,
    });
    expect(Object.keys(withIds.tools).sort()).toEqual([
      'edit_file',
      'read_file',
      'search_code',
      'write_file',
    ]);
    expect(Object.keys(withoutIds.tools).length).toBeGreaterThan(Object.keys(withIds.tools).length);
    expect(estimateToolCatalogTokens(withIds.tools)).toBeLessThanOrEqual(3500);
  });

  it('shortens the four long tool descriptions', () => {
    const refs = loadRefs();
    const agent = createAgent({
      agentDefinition: {
        id: 'c',
        name: 'C',
        personaId: 'coder',
        skillIds: [],
        toolIds: ['search_code', 'search_files', 'fetch', 'sequentialthinking'],
        modelId: 'gpt-4o',
      },
      refs,
    });
    for (const id of ['search_code', 'search_files', 'fetch', 'sequentialthinking']) {
      expect(agent.tools[id]?.description?.length ?? 0).toBeLessThanOrEqual(180);
    }
    const long = { search_code: { description: 'x'.repeat(400) } };
    compactToolDescriptions(long);
    expect(long.search_code.description.length).toBeLessThan(200);
  });
});

describe('F-03 — tool output caps', () => {
  it('directory_tree skips build dirs, drops formatted, stays under 20KB on this repo', async () => {
    const execute = executeOf(createDirectoryTreeTool(TEST_ROOT));
    const result = (await execute({ path: '.' })) as {
      success: boolean;
      tree: unknown;
      formatted?: string;
      truncated?: boolean;
      entriesVisited: number;
    };
    expect(result.success).toBe(true);
    expect(result.formatted).toBeUndefined();
    expect(result.entriesVisited).toBeLessThanOrEqual(500);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(20_000);
    const names = JSON.stringify(result.tree);
    expect(names).not.toContain('"node_modules"');
  });

  it('directory_tree stops at 500 entries and sets truncated:true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f03-tree-'));
    try {
      for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
      const execute = executeOf(createDirectoryTreeTool(dir));
      const result = (await execute({ path: '.', maxDepth: 2 })) as {
        truncated?: boolean;
        entriesVisited: number;
        formatted?: string;
      };
      expect(result.formatted).toBeUndefined();
      expect(result.entriesVisited).toBe(500);
      expect(result.truncated).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('read_file caps bytes, sets truncated, honours offset', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f03-read-'));
    const file = path.join(dir, 'big.txt');
    fs.writeFileSync(file, 'abcdefghij'.repeat(10_000));
    try {
      const execute = executeOf(createReadFileTool(dir));
      const result = (await execute({ filePath: 'big.txt', maxBytes: 64 })) as {
        success: boolean;
        content: string;
        truncated: boolean;
        sizeBytes: number;
      };
      expect(result.success).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(64);
      expect(result.truncated).toBe(true);
      const paged = (await execute({ filePath: 'big.txt', offset: 10, maxBytes: 4 })) as {
        content: string;
        truncated: boolean;
      };
      expect(paged.content).toBe('abcd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wrapper caps a huge tool result at ~30k with truncated:true', () => {
    const huge = { success: true, content: 'n'.repeat(80_000) };
    const capped = capToolResult(huge) as { truncated: boolean };
    expect(capped.truncated).toBe(true);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP + 50);
  });
});

describe('F-04 — prepareStep conversation budget', () => {
  it('20 large tool steps fit in the context budget', () => {
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'assistant', content: `step ${i}` });
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: `c${i}`, output: 'x'.repeat(8_000) }],
      });
    }
    const budget = 50_000;
    expect(JSON.stringify(messages).length).toBeGreaterThan(budget);
    const trimmed = trimConversationMessages(messages, budget);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(budget);
  });

  it('trimmed tool results keep a ToolResultOutput shape the provider can send', async () => {
    const { generateText: realGenerateText, tool, stepCountIs } =
      await vi.importActual<typeof import('ai')>('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
    let n = 0;
    const fetchMock = async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      n += 1;
      const message =
        n <= 5
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: `c${n}`, type: 'function', function: { name: 'echo', arguments: '{"x":1}' } },
              ],
            }
          : { role: 'assistant', content: 'done' };
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message, finish_reason: n <= 5 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const openai = createOpenAI({ apiKey: 'k', fetch: fetchMock as never });
    await realGenerateText({
      model: openai.chat('m'),
      prompt: 'hi',
      stopWhen: stepCountIs(8),
      tools: {
        echo: tool({ inputSchema: z.object({ x: z.number() }), execute: async () => ({ ok: true }) }),
      },
      prepareStep: (({ messages }: { messages: unknown[] }) => ({
        messages: trimConversationMessages(messages),
      })) as never,
    });
    const toolMessages = bodies[bodies.length - 1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBe(5);
    for (const m of toolMessages) expect(typeof m.content).toBe('string');
    expect(toolMessages[0]!.content).toContain('omitted');
  });
});

describe('F-05 — dispatch newly ready after each completion', () => {
  let env: ReturnType<typeof setupPlanEnv>;

  function setupPlanEnv() {
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 5, eventBus, agentRuntime });
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry, TEST_ROOT);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(mockProvider('openai'));
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

  beforeEach(() => {
    env = setupPlanEnv();
    mockGenerateText.mockReset();
    mockGenerateObject.mockReset();
  });

  afterEach(() => {
    env.taskRuntime.destroy();
  });

  it('starts C (depends on A) before B finishes', async () => {
    const started: Record<string, number> = {};
    mockGenerateText.mockImplementation(async (opts: { prompt?: unknown }) => {
      const prompt = String(opts.prompt ?? '');
      const id = prompt.includes('STEP-A') ? 'A' : prompt.includes('STEP-B') ? 'B' : 'C';
      started[id] = Date.now();
      const delay = id === 'A' ? 80 : id === 'B' ? 400 : 40;
      await new Promise((r) => setTimeout(r, delay));
      return { text: `${id} done`, toolCalls: [], toolResults: [], usage: {}, finishReason: 'stop' } as never;
    });

    const runtime = new PlanRuntime({
      taskRuntime: env.taskRuntime,
      planStore: env.planStore,
      planner: {
        plan: async () => ({ isClear: false, needsClarification: [], errors: [] }),
        generatePlan: vi.fn(),
      } as unknown as Planner,
      feasibilityDeps: {
        personaRegistry: env.personaRegistry,
        skillRegistry: env.skillRegistry,
        toolRegistry: env.toolRegistry,
      },
      refs: env,
      maxReplanningAttempts: 0,
    });

    const plan = createPlan('wave', [
      step('a', 'STEP-A independent'),
      step('b', 'STEP-B slow independent'),
      step('c', 'STEP-C waits on A', ['a']),
    ]);

    await runtime.execute(plan);
    expect(started.A).toBeDefined();
    expect(started.B).toBeDefined();
    expect(started.C).toBeDefined();
    expect(started.C).toBeLessThan(started.B + 350);
  }, 15_000);
});

describe('F-06 — concurrent acceptance checks', () => {
  it('three 200ms judgments finish in under 400ms', async () => {
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 5, eventBus, agentRuntime });
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry, TEST_ROOT);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(mockProvider('openai'));
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    mockGenerateText.mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      toolResults: [],
      usage: {},
      finishReason: 'stop',
    } as never);

    const checker = {
      checkStep: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { accepted: true, reason: 'ok' };
      },
    } as unknown as AcceptanceChecker;
    const runtime = new PlanRuntime({
      taskRuntime,
      planStore: new MemoryPlanStore(),
      planner: { generatePlan: vi.fn() } as unknown as Planner,
      feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
      maxReplanningAttempts: 0,
      acceptanceChecker: checker,
    });

    const plan = createPlan('acc', [
      step('s1', 'one'),
      step('s2', 'two'),
      step('s3', 'three'),
    ]);
    const t0 = Date.now();
    await runtime.execute(plan);
    const elapsed = Date.now() - t0;
    taskRuntime.destroy();
    expect(elapsed).toBeLessThan(400);
  }, 15_000);
});

describe('F-07 — slim reviewer schema and generatePlan re-plan', () => {
  it('ReviewModelSchema only asks the model for used fields', () => {
    const parsed = ReviewModelSchema.parse({
      acceptedFindings: [],
      rejectedFindings: [],
      finalSummary: 'ok',
    });
    expect(parsed.finalSummary).toBe('ok');
    expect('planId' in ReviewModelSchema.shape).toBe(false);
    expect('goal' in ReviewModelSchema.shape).toBe(false);
    expect('outcome' in ReviewModelSchema.shape).toBe(false);
    expect('usage' in ReviewModelSchema.shape).toBe(false);
  });
});

describe('F-08 — compact plan JSON and single journal artefacts', () => {
  it('FilePlanStore writes compact JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f08-plan-'));
    try {
      const store = new FilePlanStore(dir);
      const plan = createPlan('compact me', [step('s1', 'do')]);
      plan.id = 'plan_compact_me';
      store.save(plan);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
      expect(raw).toBe(JSON.stringify(plan));
      expect(raw).not.toContain('\n  ');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('journal still redacts a secret in one pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f08-j-'));
    try {
      const writer = new JournalWriter({
        runtimeDir: dir,
        redactValues: ['s3cret-token'],
        includeResults: 'full',
      });
      writer.log({
        ts: new Date().toISOString(),
        kind: 'tool',
        tool: 'read_file',
        durationMs: 1,
        ok: true,
        input: { token: 's3cret-token' },
        result: { token: 's3cret-token' },
        summary: 'x',
      });
      writer.close();
      const file = fs.readdirSync(path.join(dir, 'journal')).find((f) => f.endsWith('.jsonl'));
      const line = fs.readFileSync(path.join(dir, 'journal', file!), 'utf8');
      expect(line).not.toContain('s3cret-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F-09 — followLog byte offset and rotate', () => {
  it('keeps following after the log file is rotated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f09-log-'));
    const file = path.join(dir, 'observability.jsonl');
    const line = (msg: string) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        eventType: 'info',
        message: msg,
        level: 'info',
      }) + '\n';
    fs.writeFileSync(file, line('old'));
    const seen: string[] = [];
    const stop = followLog(file, undefined, 50, (entry) => seen.push(entry.message));
    await new Promise((r) => setTimeout(r, 200));
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, line('after-rotate'));
    await new Promise((r) => setTimeout(r, 700));
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(seen).toContain('after-rotate');
  }, 10_000);
});

describe('F-10 — SSE connection cap', () => {
  it('refuses a connection past the per-process cap', () => {
    expect(DEFAULT_MAX_SSE_CONNECTIONS).toBeGreaterThan(0);
    const hub = new SseHub({ maxConnections: 2 });
    const a = hub.subscribe('p', fakeRes());
    const b = hub.subscribe('p', fakeRes());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const c = hub.subscribe('p', fakeRes());
    expect(c).toBeNull();
    expect(hub.connectionCount()).toBe(2);
    a?.();
    const d = hub.subscribe('q', fakeRes());
    expect(d).not.toBeNull();
    b?.();
    d?.();
  });
});
