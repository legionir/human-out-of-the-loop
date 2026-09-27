/**
 * Phase 30 / P5 — slow / looping models: timeout, `--max-steps`, abort.
 *
 * Driving the real CLI against a deliberately silent stub exposed two
 * unbounded waits:
 *
 *   1. an agent run that hit `--timeout-ms` marked the step failed and
 *      printed the report — but the process never exited: the abandoned
 *      model request kept the event loop alive (the harness had to
 *      `SIGKILL` it after 90 s);
 *   2. the *structured* calls (planner assessment, plan generation,
 *      acceptance judgment, final review) had no deadline at all — a
 *      provider that accepted the socket and never answered hung the CLI
 *      forever, with no output.
 *
 * These tests pin both: the deadline fires, the request is aborted, the
 * caller gets a truthful answer, and nothing is left running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

import { withLlmTimeout, LlmTimeoutError } from '../runtime/llm-timeout.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import { AcceptanceChecker } from '../runtime/acceptance-checker.js';
import { Planner } from '../planning/planner.js';
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
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

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
  // Phase 33: register the reference filesystem toolset so skill cross-validation
  // (registry/skills/*) sees the same catalog as production bootstrapTools().
  registerLocalToolFixtures(toolRegistry, TEST_ROOT);

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

/** A promise that never settles — exactly "the provider never answers". */
const neverAnswers = <T,>() => new Promise<T>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── the helper ──────────────────────────────────────────────────

describe('Phase 30 P5 — withLlmTimeout', () => {
  it('resolves a fast call untouched', async () => {
    await expect(withLlmTimeout('Fast call', 1000, async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects with a truthful message and ABORTS the request on the deadline', async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();

    await expect(
      withLlmTimeout('Plan generation', 80, (signal) => {
        seen = signal;
        return neverAnswers<string>();
      })
    ).rejects.toThrowError(new LlmTimeoutError('Plan generation', 80));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(seen?.aborted).toBe(true);
  });
});

// ─── the agent run ───────────────────────────────────────────────

describe('Phase 30 P5 — a timed-out agent run stops the request', () => {
  it('aborts the in-flight model call so the process can exit', async () => {
    let captured: AbortSignal | undefined;
    mockGenerateText.mockImplementation((options: unknown) => {
      captured = (options as { abortSignal?: AbortSignal }).abortSignal;
      return neverAnswers() as never;
    });

    const result = await new AgentRuntime().run({
      agent: makeAgent(),
      taskId: 'task_timeout',
      prompt: 'work',
      eventBus: new EventBus(),
      timeoutMs: 60,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('timed out after 60ms');
    expect(result.failureType).toBe('technical');
    // The abandoned request was cancelled, not left dangling.
    expect(captured?.aborted).toBe(true);
  });
});

// ─── the structured calls ────────────────────────────────────────

describe('Phase 30 P5 — structured calls are bounded too', () => {
  it('the planner answers (truthfully) instead of hanging forever', async () => {
    mockGenerateObject.mockImplementation(() => neverAnswers() as never);
    const registries = setupRegistries();

    const planner = new Planner({ ...registries, modelId: 'gpt-4o', timeoutMs: 60 });
    const started = Date.now();
    const result = await planner.plan('do something vague');

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.isClear).toBe(false);
    // A failure, not a clarification question.
    expect(result.needsClarification).toEqual([]);
    expect(result.errors.join(' ')).toContain('timed out after 60ms');
  });

  it('the acceptance check fails closed (never hangs the plan)', async () => {
    mockGenerateObject.mockImplementation(() => neverAnswers() as never);
    const registries = setupRegistries();

    const checker = new AcceptanceChecker({ ...registries, modelId: 'gpt-4o', timeoutMs: 60 });
    const plan = createPlan('goal', [
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
    ]);
    const task = {
      id: 'task_1',
      status: 'completed',
      summary: 'all good',
      result: 'all good',
      errors: [],
      toolsUsed: [],
    } as unknown as Task;

    const started = Date.now();
    const judgment = await checker.checkStep(plan.steps[0]!, task);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(judgment.accepted).toBe(false);
    expect(judgment.reason).toContain('timed out after 60ms');
    // R1-07: a timeout is a checker failure, not a real quality verdict —
    // callers must not fail the step for this.
    expect(judgment.checkerError).toBe(true);
  });
});
