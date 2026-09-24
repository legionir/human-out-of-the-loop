/**
 * Phase 29 — CLI workflow fixes found by driving the real command line
 * inside a PTY (a human at the terminal).
 *
 * Every case here reproduces a bug that only showed up in a real
 * interaction, and each one is asserted at the level where it was seen:
 *
 *   - the interactive plan-confirmation prompt used inquirer's removed
 *     `list` type (v14 renamed it to `select`) → every `hootl run`
 *     without --yes crashed with `Prompt type "list" is not registered`
 *   - a failed planning step (no questions) printed an EMPTY
 *     "Clarification needed:" block instead of the real error
 *   - `--max-steps 0` / `--timeout-ms 500` dumped a raw ZodError
 *   - `--model ghost` reached the planner and failed obscurely
 *   - `--session <unknown>` was accepted silently and persisted nothing
 *   - `hootl run ""` reached the planner
 *   - `logs --tail abc` printed nothing, `--tail 0` printed everything
 *   - `hootl usage` / `tasks` showed `***REDACTED***` for token COUNTS
 *   - the progress counter counted every step twice (`[4/2]`)
 *   - `plans show` printed raw JSON although its help promises a view
 *   - `sessions label` was write-only
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Mock AI SDK (same contract as cli.test.ts) ──────────────────

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateObject, generateText } from 'ai';
import { main } from '../../cli.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { createPlan, type Plan } from '../../ai/schemas/plan.js';
import { createProgressRenderer } from '../utils/streaming.js';
import { EventBus } from '../../ai/runtime/event-bus.js';
import { AgentRuntime } from '../../ai/runtime/agent-runtime.js';
import { TaskRuntime } from '../../ai/runtime/task-runtime.js';
import { MemoryPlanStore, type PlanStore } from '../../ai/runtime/plan-store.js';
import { PlanRuntime, type PlanRuntimeConfig } from '../../ai/runtime/plan-runtime.js';
import { PersonaRegistry } from '../../ai/registries/persona-registry.js';
import { SkillRegistry } from '../../ai/registries/skill-registry.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import { ModelRegistry } from '../../ai/registries/model-registry.js';
import { bootstrapCatalogTools } from '../../ai/tools/catalog-bootstrap.js';
import type { Planner } from '../../ai/planning/planner.js';
import { ObservabilityLogger } from '../../ai/runtime/observability-logger.js';
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

// ─── Temp project + stdout capture ───────────────────────────────

function makeTempProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  return projectRoot;
}

async function runCli(args: Array<string>): Promise<{ code: number; out: string; errOut: string }> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'hootl', ...args]);
    return { code, out: chunks.join(''), errOut: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExitCode;
  }
}

/** Minimal happy-path model mocks: assessment → plan → accepted steps. */
function installModelMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    switch (schemaName) {
      case 'PlannerAssessment':
        return { object: { isClear: true, needsClarification: [] } } as never;
      case 'ExecutionPlan':
        return {
          object: createPlan('mock goal', [
            {
              id: 'step-1',
              description: 'Do the thing',
              dependsOn: [],
              assignedPersona: 'coder',
              assignedSkills: [],
              assignedTools: ['read_file'],
              claimedResources: [],
              acceptanceCriteria: 'The thing is done',
              status: 'pending',
            },
          ]),
        } as never;
      case 'AcceptanceJudgment':
        return { object: { accepted: true, reason: 'looks complete' } } as never;
      case 'FinalReview':
        return {
          object: {
            planId: 'plan_mock',
            goal: 'mock goal',
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'Everything completed.',
            usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
          },
        } as never;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
  });

  mockGenerateText.mockResolvedValue({
    text: 'Stub agent: the step is complete and verified. Used tools: read_file.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = makeTempProject('phase29-cli-');
  vi.clearAllMocks();
  installModelMocks();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── Interactive prompt type ─────────────────────────────────────

describe('Phase 29 — the plan confirmation prompt uses a registered type', () => {
  it('uses inquirer types that actually exist in the installed version', async () => {
    // inquirer v14 renamed `list` to `select` and DELETED `list`; using the
    // old name made every interactive `hootl run` die with
    // 'Prompt type "list" is not registered'.  A TTY is required to exercise
    // the prompt itself, so assert the wiring statically.
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'confirm.ts'), 'utf8');
    const usedTypes = Array.from(src.matchAll(/type: '([a-z]+)'/g)).map((m) => m[1]);

    const inquirer = (await import('inquirer')).default;
    const registered = Object.keys(inquirer.createPromptModule().prompts ?? {});

    expect(usedTypes.length).toBeGreaterThan(0);
    for (const type of usedTypes) {
      expect(registered).toContain(type);
    }
  });
});

// ─── Usage errors (exit 2, no raw Zod dump) ──────────────────────

describe('Phase 29 — run pre-flight is a usage error, not a crash', () => {
  it('rejects an empty goal with exit 2 before any model call', async () => {
    const { code, errOut } = await runCli(['run', '   ', '--project-root', projectRoot]);
    expect(code).toBe(2);
    expect(errOut).toContain('The goal must not be empty');
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('rejects --max-steps 0 with a friendly message (no ZodError dump)', async () => {
    const { code, errOut } = await runCli([
      'run',
      'goal',
      '--max-steps',
      '0',
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(2);
    expect(errOut).toContain('--max-steps must be an integer between 1 and 100');
    expect(errOut).not.toContain('too_small');
    expect(errOut).not.toContain('ZodError');
  });

  it('rejects an out-of-range --timeout-ms with exit 2', async () => {
    const { code, errOut } = await runCli([
      'run',
      'goal',
      '--timeout-ms',
      '500',
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(2);
    expect(errOut).toContain('--timeout-ms must be an integer between 1000 and 600000');
  });

  // v27.4: models are chosen at runtime — a name that no registry file
  // defines is a provider model name, not a usage error.  The run says so
  // up front, so a typo is still visible before the first call.
  it('accepts a model that is not in the registry and says it is a provider model name', async () => {
    mockGenerateObject.mockRejectedValue(new Error('stop after the pre-flight'));
    const { code, out, errOut } = await runCli([
      'run',
      'goal',
      '--model',
      'ghost-model',
      '--project-root',
      projectRoot,
    ]);
    expect(code).not.toBe(2);
    expect(out + errOut).toContain('Model: ghost-model (not in the registry) via the openai API');
  });

  it('rejects an unknown --session instead of silently creating nothing', async () => {
    const { code, errOut } = await runCli([
      'run',
      'goal',
      '--session',
      'session_nope',
      '--persistent',
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(2);
    expect(errOut).toContain('Session "session_nope" not found');
  });

  it('still accepts a valid --session and continues it', async () => {
    const first = await runCli([
      'run',
      'first goal',
      '--yes',
      '--persistent',
      '--project-root',
      projectRoot,
    ]);
    expect(first.code).toBe(0);
    const sessionId = /Session: (\S+)/.exec(first.out)?.[1];
    expect(sessionId).toBeTruthy();

    const second = await runCli([
      'run',
      'second goal',
      '--session',
      sessionId!,
      '--yes',
      '--persistent',
      '--project-root',
      projectRoot,
    ]);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Session: ${sessionId}`);
  });
});

// ─── Planner hard failure surfacing ──────────────────────────────

describe('Phase 29 — a failed planning step shows the error, not an empty prompt', () => {
  it('reports "Planning failed" when the planner errors with no questions', async () => {
    // The assessment passes; generating the plan itself blows up — this is
    // the path that used to print an EMPTY "Clarification needed:" block.
    mockGenerateObject.mockImplementation(async (opts: unknown) => {
      const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
      if (schemaName === 'ExecutionPlan') throw new Error('provider exploded');
      return { object: { isClear: true, needsClarification: [] } } as never;
    });

    const { code, out } = await runCli([
      'run',
      'goal',
      '--yes',
      '--persistent',
      '--project-root',
      projectRoot,
    ]);

    expect(code).toBe(1);
    expect(out).toContain('Planning failed: provider exploded');
    expect(out).not.toContain('⚠️ Clarification needed:');
  });
});

// ─── Progress renderer counter ───────────────────────────────────

describe('Phase 29 — the step counter counts steps once', () => {
  function render(events: ProgressEvent[]): string {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const renderer = createProgressRenderer();
      for (const event of events) renderer(event);
    } finally {
      spy.mockRestore();
    }
    return lines.join('');
  }

  const base = { planId: 'plan_1', timestamp: Date.now() };

  it('ignores the agent-level duplicate of a step completion', () => {
    const out = render([
      { ...base, type: 'plan:started', message: 'Plan started.', payload: { totalSteps: 2 } },
      { ...base, type: 'plan:step-started', stepId: 'step-1', message: 'Step step-1: running' },
      {
        ...base,
        type: 'plan:step-completed',
        stepId: 'step-1',
        message: 'Step step-1: done',
      },
      {
        ...base,
        type: 'plan:step-completed',
        stepId: 'step-1',
        message: 'Agent "plan-step-step-1" completed. 1 tool(s) used.',
        payload: { agentLevel: true },
      },
      { ...base, type: 'plan:step-started', stepId: 'step-2', message: 'Step step-2: running' },
      {
        ...base,
        type: 'plan:step-completed',
        stepId: 'step-2',
        message: 'Step step-2: done',
      },
    ]);

    expect(out).toContain('[1/2] Step step-1: done');
    expect(out).toContain('[2/2] Step step-2: done');
    expect(out).not.toContain('[3/2]');
    expect(out).not.toContain('[4/2]');
    // the agent-level line is a detail: visible only with --verbose
    expect(out).not.toContain('Agent "plan-step-step-1" completed');
  });

  it('shows the agent-level detail with verbose enabled', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const renderer = createProgressRenderer({ verbose: true });
      renderer({
        ...base,
        type: 'plan:step-completed',
        stepId: 'step-1',
        message: 'Agent "plan-step-step-1" completed. 1 tool(s) used.',
        payload: { agentLevel: true },
      });
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('')).toContain('Agent "plan-step-step-1" completed');
  });
});

// ─── Token counts survive redaction ──────────────────────────────

describe('Phase 29 — token counts are metrics, not secrets', () => {
  it('keeps numeric *Tokens but still redacts string credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase29-log-'));
    try {
      const logger = new ObservabilityLogger({ logFilePath: path.join(dir, 'obs.jsonl') });
      logger.log({
        eventType: 'task:completed',
        message: 'done',
        level: 'info',
        payload: {
          usage: { promptTokens: 240, completionTokens: 90, totalTokens: 330 },
          accessToken: 'sk-must-not-leak',
        },
      });

      const [entry] = logger.readAll();
      expect(entry!.payload!.usage).toEqual({
        promptTokens: 240,
        completionTokens: 90,
        totalTokens: 330,
      });
      expect(entry!.payload!.accessToken).toBe('***REDACTED***');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── plans show / sessions list ──────────────────────────────────

describe('Phase 29 — plan and session views', () => {
  function seedPlan(): string {
    const store = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    const plan = createPlan('Build a login page', [
      {
        id: 'step-1',
        description: 'Create the login form',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'The form renders',
        status: 'pending',
      },
    ]);
    store.save(plan);
    return plan.id!;
  }

  it('plans show renders steps/personas/tools; --json keeps the raw dump', async () => {
    const id = seedPlan();

    const human = await runCli(['plans', 'show', id, '--project-root', projectRoot]);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`Plan ${id}`);
    expect(human.out).toContain('Tools:    read_file');
    expect(human.out).toContain('[step-1] Create the login form');

    const json = await runCli(['plans', 'show', id, '--json', '--project-root', projectRoot]);
    expect(json.code).toBe(0);
    expect((JSON.parse(json.out) as { id: string }).id).toBe(id);
  });
});

// ─── Cross-process cancellation ──────────────────────────────────

describe('Phase 29 — a plan cancelled from another process actually stops', () => {
  /** Wraps a real plan store and simulates the SECOND terminal: from the
   *  second persist onwards the stored status is 'cancelled' — exactly what
   *  `hootl plans cancel <id>` writes while the first process keeps running. */
  function cancellingStore(): { store: PlanStore; written: string[] } {
    const inner = new MemoryPlanStore();
    const written: string[] = [];
    let saves = 0;
    const store = {
      save(plan: Plan) {
        inner.save(plan);
        written.push(plan.status);
        saves += 1;
        // save #1 is the initial 'running' persist of execute(); from #2 on
        // another process owns the status.
        if (saves >= 2) inner.save({ ...inner.load(plan.id!)!, status: 'cancelled' });
      },
      load: (id: string) => inner.load(id),
      list: () => inner.list(),
      delete: (id: string) => inner.delete(id),
      exists: (id: string) => inner.exists(id),
    } as unknown as PlanStore;
    return { store, written };
  }

  it('is not overwritten by the running loop (reports CANCELLED)', async () => {
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentRuntime });

    const personaRegistry = new PersonaRegistry();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry({ toolRegistry });
    const modelRegistry = new ModelRegistry();
    // The step must SUCCEED, so the loop goes on dispatching after the
    // external cancel (otherwise the failure path stops it anyway).
    personaRegistry.register({
      id: 'coder',
      name: 'Coder',
      system: 'You write code.',
      allowedTools: ['*'],
    });
    modelRegistry.registerProvider({
      name: 'openai',
      supportsModel: () => true,
      createModel: () => ({ modelId: 'gpt-4o' }) as never,
    } as never);
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' } as never);
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

    const { store: planStore, written } = cancellingStore();
    const planner = { plan: async () => ({ isClear: false, needsClarification: [], errors: [] }) } as unknown as Planner;

    const runtime = new PlanRuntime({
      taskRuntime,
      planStore,
      planner,
      feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
      maxReplanningAttempts: 0,
      defaultModelId: 'gpt-4o',
    } as PlanRuntimeConfig);

    const plan = createPlan('cross-process cancel', [
      {
        id: 'step-1',
        description: 'First step',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'First step done',
        status: 'pending',
      },
      {
        id: 'step-2',
        description: 'Second step',
        dependsOn: ['step-1'],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'Second step done',
        status: 'pending',
      },
    ]);
    planStore.save(plan);

    const result = await runtime.execute(plan);

    // Before the fix the loop re-persisted its own 'running' view over the
    // cancellation and finished as 'completed' (the real two-terminal
    // reproduction) or 'failed-partial' (this unit-level one).
    expect(result.status).toBe('cancelled');
    expect(planStore.load(plan.id!)!.status).toBe('cancelled');
    expect(plan.steps[1]!.status).toBe('pending');
    // Writes #1 (initial 'running') and #2 (step-1 synced) happened before
    // the cancel; everything the loop persisted AFTERWARDS must be cancelled
    // — this is what the persist()-time guard protects.
    expect(written.length).toBeGreaterThan(2);
    expect(written.slice(2).every((status) => status === 'cancelled')).toBe(true);
    taskRuntime.destroy();
  });
});

// ─── logs --tail validation ──────────────────────────────────────

describe('Phase 29 — logs --tail', () => {
  it('rejects a non-numeric --tail with exit 2', async () => {
    const { code, errOut } = await runCli(['logs', '--tail', 'abc', '--project-root', projectRoot]);
    expect(code).toBe(2);
    expect(errOut).toContain('--tail must be a non-negative integer');
  });
});
