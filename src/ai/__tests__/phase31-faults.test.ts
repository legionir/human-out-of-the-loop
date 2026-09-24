/**
 * Phase 31 — provider faults, found by the fault-injecting e2e stub
 * (`FAULT:` / `BADJSON:` markers in `e2e/fake-llm.mjs`).
 *
 *   1. Token usage of the structured calls (planning, acceptance, final
 *      review) was never counted: the report showed half of what the
 *      provider billed.  And the final report summed EVERY run the
 *      orchestrator had made — on the long-lived web server the number
 *      grew with each run.
 *   2. One malformed structured answer ended the run at planning (and was
 *      reported as "please provide more details"), or failed a finished
 *      step and forced a re-plan.  Structured calls now get one retry.
 *   3. An empty agent answer (no text, no tool call) counted as a
 *      completed task.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

import { withStructuredRetry } from '../runtime/llm-timeout.js';
import type { LlmUsageReport } from '../runtime/llm-usage.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import { AcceptanceChecker } from '../runtime/acceptance-checker.js';
import { UsageAggregator } from '../runtime/usage-aggregator.js';
import { Planner } from '../planning/planner.js';
import { sumUsageFromEntries } from '../../cli/utils/log-reader.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGitStatusTool } from '../tools/implementations/git-status.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import type { Task } from '../schemas/task.js';
import { createPlan } from '../schemas/plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TEST_ROOT = process.cwd();

/** A provider whose model never does anything — the SDK calls are mocked. */
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

function setupRegistries() {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(path.join(REPO_ROOT, 'registry', 'personas'));

  const toolRegistry = new ToolRegistry();
  for (const d of ['read_file', 'search_code', 'write_file', 'git_status']) {
    toolRegistry.registerDefinition({
      id: d,
      name: d,
      description: d,
      source: 'local' as const,
      modulePath: `./${d}`,
    });
  }
  toolRegistry.registerImplementation('read_file', createReadFileTool(TEST_ROOT));
  toolRegistry.registerImplementation('search_code', createSearchCodeTool(TEST_ROOT));
  toolRegistry.registerImplementation('write_file', createWriteFileTool(TEST_ROOT));
  toolRegistry.registerImplementation('git_status', createGitStatusTool(TEST_ROOT));

  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(path.join(REPO_ROOT, 'registry', 'skills'), skillRegistry);

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

function makeAgent(): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'Test',
    tools: {},
    model: {} as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'C', allowedTools: [] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  } as unknown as ResolvedAgent;
}


const usage = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };

function badOutput(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    text: '{not json',
    response: { id: 'r', timestamp: new Date(), modelId: 'gpt-4o' },
    usage: usage as never,
    finishReason: 'stop' as never,
  });
}

function doneStep() {
  return createPlan('goal', [
    {
      id: 'step-1',
      description: 'do it',
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: [],
      assignedTools: [],
      claimedResources: [],
      acceptanceCriteria: 'done',
      status: 'done',
    },
  ]).steps[0]!;
}

const task = {
  id: 'task_1',
  planId: 'plan_abc',
  status: 'completed',
  summary: 'all good',
  result: 'all good',
  errors: [],
  toolsUsed: [],
} as unknown as Task;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Phase 31 — withStructuredRetry', () => {
  it('retries once on an unparsable answer', async () => {
    const call = vi.fn().mockRejectedValueOnce(badOutput()).mockResolvedValueOnce('ok');
    await expect(withStructuredRetry(call)).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second unparsable answer', async () => {
    const call = vi.fn().mockRejectedValue(badOutput());
    await expect(withStructuredRetry(call)).rejects.toThrow('could not parse');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors (the provider SDK owns transport retries)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(withStructuredRetry(call)).rejects.toThrow('401');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 31 — structured calls report their token usage', () => {
  it('the acceptance check reports usage billed to the task\'s plan, after a retry', async () => {
    mockGenerateObject
      .mockRejectedValueOnce(badOutput())
      .mockResolvedValueOnce({ object: { accepted: true, reason: 'fine' }, usage } as never);
    const reports: LlmUsageReport[] = [];
    const checker = new AcceptanceChecker({
      ...setupRegistries(),
      modelId: 'gpt-4o',
      onUsage: (r) => reports.push(r),
    });

    const judgment = await checker.checkStep(doneStep(), task);

    expect(judgment.accepted).toBe(true);
    expect(reports).toEqual([
      {
        purpose: 'acceptance',
        planId: 'plan_abc',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      },
    ]);
  });

  it('the planner bills the new plan, or the plan being re-planned', async () => {
    const planObject = {
      goal: 'g',
      steps: [{ ...doneStep(), status: 'pending' }],
    };
    mockGenerateObject.mockResolvedValue({
      object: { isClear: true, needsClarification: [], plan: planObject },
      usage,
    } as never);
    const reports: LlmUsageReport[] = [];
    const planner = new Planner({
      ...setupRegistries(),
      modelId: 'gpt-4o',
      onUsage: (r) => reports.push(r),
    });

    const fresh = await planner.plan('do it');
    await planner.plan('revise it', 'plan_original');

    expect(reports.map((r) => r.purpose)).toEqual(['planning', 'planning']);
    expect(reports[0]!.planId).toBe(fresh.plan!.id);
    expect(reports[1]!.planId).toBe('plan_original');
  });

  it('a planner failure is reported as an error, not a clarification question', async () => {
    mockGenerateObject.mockRejectedValue(badOutput());
    const planner = new Planner({ ...setupRegistries(), modelId: 'gpt-4o' });

    const result = await planner.plan('do it');

    expect(mockGenerateObject).toHaveBeenCalledTimes(2); // one retry
    expect(result.isClear).toBe(false);
    expect(result.needsClarification).toEqual([]);
    expect(result.errors.join(' ')).toContain('could not parse');
  });
});

describe('Phase 31 — usage accounting', () => {
  it('structured calls count toward the totals but not toward taskCount', () => {
    const agg = new UsageAggregator();
    const tokens = { promptTokens: 3, completionTokens: 1, totalTokens: 4 };
    agg.recordDirect({ taskId: 't1', planId: 'p', agentId: 'a', usage: tokens, timestamp: 1 });
    agg.recordDirect({
      taskId: 'llm:review',
      planId: 'p',
      agentId: 'llm:review',
      usage: tokens,
      timestamp: 2,
      llmCall: true,
    });

    expect(agg.getSummary()).toMatchObject({ totalTokens: 8, taskCount: 1 });
    expect(agg.getPlanUsage('p')).toMatchObject({ totalTokens: 8, taskCount: 1 });
  });

  it('`hootl usage` sums llm:usage log entries too', () => {
    const tokens = { promptTokens: 3, completionTokens: 1, totalTokens: 4 };
    const totals = sumUsageFromEntries([
      { eventType: 'task:completed', payload: { usage: tokens } },
      { eventType: 'llm:usage', payload: { purpose: 'planning', usage: tokens } },
      { eventType: 'step:started', payload: {} },
    ] as never);

    expect(totals).toEqual({ promptTokens: 6, completionTokens: 2, totalTokens: 8, taskCount: 1 });
  });
});

describe('Phase 31 — an empty agent answer is not a completed task', () => {
  it('fails the task with a clear reason', async () => {
    mockGenerateText.mockResolvedValue({ text: '', steps: [], usage } as never);

    const result = await new AgentRuntime().run({
      agent: makeAgent(),
      taskId: 'task_empty',
      prompt: 'work',
      eventBus: new EventBus(),
    });

    expect(result.success).toBe(false);
    expect(result.failureType).toBe('technical');
    expect(result.summary).toContain('empty response');
  });
});
