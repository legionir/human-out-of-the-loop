/**
 * Phase C — runtime / task / agent correctness (C-01…C-14).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import { UsageAggregator } from '../runtime/usage-aggregator.js';
import { CancellationManager } from '../runtime/cancellation-manager.js';
import { PlanRuntime } from '../runtime/plan-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { JournalWriter } from '../runtime/journal.js';
import { ObservabilityLogger } from '../runtime/observability-logger.js';
import { withFileLock, withFileLockSync, lockPathFor } from '../runtime/file-lock.js';
import { DelegationGuard } from '../runtime/delegation-guard.js';
import { createDelegateTaskTool } from '../tools/implementations/delegate-task.js';
import { runWithAgentContext } from '../runtime/agent-run-context.js';
import { withStructuredRetry } from '../runtime/llm-timeout.js';
import { NoObjectGeneratedError } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry } from '../registries/model-registry.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';
import type { LanguageModel } from 'ai';
import { createPlan, type Plan, type PlanStep } from '../schemas/plan.js';
import { Orchestrator } from '../orchestrator.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText, streamText } from 'ai';
const mockGenerateText = vi.mocked(generateText);
const mockStreamText = vi.mocked(streamText);

function makeAgent(over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'sys',
    tools: {},
    model: { specificationVersion: 'v1' } as unknown as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'x', allowedTools: ['*'] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
    delegationDepth: 0,
    ...over,
  };
}

function makeStep(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: id,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: [],
    claimedResources: [],
    acceptanceCriteria: 'ok',
    status: 'pending',
    ...over,
  };
}

describe('C-01 — lock held until executionPromise settles', () => {
  afterEach(() => mockGenerateText.mockReset());

  it('task B with the same resource starts only after A’s tool actually ends', async () => {
    const started: string[] = [];
    const slow = tool({
      description: 'slow',
      inputSchema: z.object({}),
      execute: async () => {
        started.push('A-tool');
        await new Promise((r) => setTimeout(r, 180));
        started.push('A-done');
        return { ok: true };
      },
    });
    const fast = tool({
      description: 'fast',
      inputSchema: z.object({}),
      execute: async () => {
        started.push('B-tool');
        return { ok: true };
      },
    });

    mockGenerateText.mockImplementation((async (opts: { tools?: Record<string, { execute?: (i: unknown, o?: unknown) => Promise<unknown> }> }) => {
      const t = opts.tools?.slow ?? opts.tools?.fast;
      if (t?.execute) await t.execute({}, {});
      return { text: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, steps: [] };
    }) as never);

    const eventBus = new EventBus();
    const tr = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentTimeoutMs: 40 });
    const a = tr.createTask({
      agent: makeAgent({ tools: { slow } }),
      prompt: 'a',
      claimedResources: ['/shared'],
    });
    const b = tr.createTask({
      agent: makeAgent({ tools: { fast } }),
      prompt: 'b',
      claimedResources: ['/shared'],
    });

    const waitAll = tr.waitForAll();
    await waitAll;
    expect(started.indexOf('B-tool')).toBeGreaterThan(started.indexOf('A-done'));
    expect(tr.getStatus(a)?.status).toMatch(/failed|completed|cancelled/);
    expect(tr.getStatus(b)?.status).toMatch(/failed|completed|cancelled/);
    tr.destroy();
  });
});

describe('C-02 — stream error is a failure', () => {
  afterEach(() => {
    mockStreamText.mockReset();
    mockGenerateText.mockReset();
  });

  it('error part in the thought stream → success:false', async () => {
    mockStreamText.mockImplementation((async () => {
      async function* fullStream() {
        yield { type: 'error', error: '502 Bad Gateway' };
      }
      return {
        fullStream: fullStream(),
        text: Promise.resolve('partial'),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ promptTokens: 3, completionTokens: 1, totalTokens: 4 }),
        reasoningText: Promise.resolve(''),
        finishReason: Promise.resolve('error'),
      };
    }) as never);

    const result = await new AgentRuntime().run({
      agent: makeAgent(),
      taskId: 't-err',
      prompt: 'p',
      eventBus: new EventBus(),
      onThought: () => undefined,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/502|error/i);
  });
});

describe('C-03 — cancel running tasks and skip acceptance', () => {
  afterEach(() => mockGenerateText.mockReset());

  it('cancelPlan aborts a running task and never calls the checker', async () => {
    let aborted = false;
    mockGenerateText.mockImplementation((async (opts: { abortSignal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        opts.abortSignal?.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      return { text: 'nope', steps: [], usage: {} };
    }) as never);

    const eventBus = new EventBus();
    const tr = new TaskRuntime({ maxConcurrentTasks: 1, eventBus, agentTimeoutMs: 10_000 });
    const store = new MemoryPlanStore();
    const checks: string[] = [];
    const plan = createPlan('goal', [makeStep('s1', { status: 'running' })]);
    plan.status = 'running';
    const taskId = tr.createTask({ agent: makeAgent(), prompt: 'work', planId: plan.id });
    plan.steps[0]!.taskId = taskId;
    store.save(plan);

    const runtime = new PlanRuntime({
      taskRuntime: tr,
      planStore: store,
      planner: {} as never,
      feasibilityDeps: {} as never,
      refs: {} as never,
      acceptanceChecker: {
        checkStep: async () => {
          checks.push('checked');
          return { accepted: true, reason: 'ok' };
        },
      } as never,
    });
    const cm = new CancellationManager(store, tr);
    cm.registerRuntime(plan.id!, runtime);
    runtime.cancel();
    await cm.cancelPlan(plan.id!);
    await tr.waitForAll();
    expect(aborted).toBe(true);
    expect(tr.getStatus(taskId)?.status).toBe('cancelled');
    expect(checks).toEqual([]);
    tr.destroy();
  });
});

describe('C-06 / C-12 — usage on failure and live tool_call events', () => {
  afterEach(() => mockGenerateText.mockReset());

  it('timeout after step 1 still records step-1 usage', async () => {
    mockGenerateText.mockImplementation((async (opts: {
      onStepFinish?: (e: { usage: unknown }) => void;
      abortSignal?: AbortSignal;
    }) => {
      opts.onStepFinish?.({ usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } });
      await new Promise<never>((_, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
      return { text: '', steps: [], usage: {} };
    }) as never);

    const eventBus = new EventBus();
    const agg = new UsageAggregator();
    agg.subscribeToEventBus(eventBus);
    const result = await new AgentRuntime().run({
      agent: makeAgent(),
      taskId: 't-usage',
      prompt: 'p',
      eventBus,
      timeoutMs: 40,
    });
    expect(result.success).toBe(false);
    expect(result.usage?.promptTokens).toBe(11);
    expect(agg.getSummary().totalPromptTokens).toBe(11);
    agg.unsubscribe();
  });

  it('emits agent:tool_call when the tool starts, not after the run', async () => {
    const order: string[] = [];
    mockGenerateText.mockImplementation((async (opts: {
      tools?: Record<string, { execute?: (i: unknown, o?: unknown) => Promise<unknown> }>;
    }) => {
      await opts.tools!.ping.execute?.({}, { toolCallId: 'c1' } as never);
      order.push('generate-done');
      return { text: 'ok', steps: [{ toolCalls: [{ toolName: 'ping', toolCallId: 'c1' }] }], usage: {} };
    }) as never);
    const ping = tool({
      description: 'ping',
      inputSchema: z.object({}),
      execute: async () => {
        order.push('tool-exec');
        return { ok: true };
      },
    });
    const eventBus = new EventBus();
    eventBus.subscribe('agent:tool_call', () => order.push('event'));
    await new AgentRuntime().run({
      agent: makeAgent({ tools: { ping } }),
      taskId: 't-tc',
      prompt: 'p',
      eventBus,
    });
    expect(order.indexOf('event')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('event')).toBeLessThan(order.indexOf('generate-done'));
  });
});

describe('C-05 / C-07 — delegation depth, caller persona, child result', () => {
  it('second delegation at depth 1 is denied when maxDepth is 1', async () => {
    const personas = new PersonaRegistry();
    personas.register({ id: 'main', name: 'Main', system: 's', allowedTools: ['*'] });
    personas.register({ id: 'coder', name: 'Coder', system: 's', allowedTools: ['*'] });
    const guard = new DelegationGuard({ maxDepth: 1, personaRegistry: personas });
    const created: number[] = [];
    const toolDef = createDelegateTaskTool({
      personaRegistry: personas,
      skillRegistry: new SkillRegistry({ toolRegistry: new ToolRegistry() }),
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelRegistry(),
      onTaskCreated: async () => {
        created.push(1);
        return 'task_child';
      },
      delegationGuard: guard,
      currentDelegationDepth: 0,
    });
    const denied = await runWithAgentContext(
      { taskId: 'parent', agentId: 'a', personaId: 'main', delegationDepth: 1 },
      () =>
        toolDef.execute!(
          { mode: 'dynamic', persona: 'coder', skills: [], tools: [], model: 'gpt-4o', prompt: 'x' },
          { toolCallId: 'c' } as never
        )
    );
    expect((denied as { code?: string }).code).toBe('DELEGATION_DENIED');
    expect(created).toHaveLength(0);
  });
});

describe('C-08 / C-09 — waitFor isolation and map pruning', () => {
  afterEach(() => mockGenerateText.mockReset());

  it('run() reject does not hot-loop waitForAll', async () => {
    const boom = {
      run: async () => {
        throw new Error('boom');
      },
    };
    const eventBus = new EventBus();
    const tr = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus,
      agentRuntime: boom as unknown as AgentRuntime,
    });
    tr.createTask({ agent: makeAgent(), prompt: 'x' });
    const t0 = Date.now();
    await tr.waitForAll();
    expect(Date.now() - t0).toBeLessThan(1000);
    tr.destroy();
  });

  it('waitFor(planA) does not wait for planB', async () => {
    mockGenerateText.mockImplementation((async (opts: { prompt?: string | unknown; abortSignal?: AbortSignal }) => {
      if (String(opts.prompt).includes('slow')) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return { text: 'ok', steps: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }) as never);
    const eventBus = new EventBus();
    const tr = new TaskRuntime({ maxConcurrentTasks: 2, eventBus });
    tr.createTask({ agent: makeAgent(), prompt: 'fast', planId: 'planA' });
    tr.createTask({ agent: makeAgent(), prompt: 'slow', planId: 'planB' });
    const t0 = Date.now();
    await tr.waitFor('planA');
    expect(Date.now() - t0).toBeLessThan(150);
    await tr.waitForAll();
    tr.destroy();
  });

  it('prunes agents map after many tasks', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'ok',
      steps: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } as never);
    const eventBus = new EventBus();
    const tr = new TaskRuntime({ maxConcurrentTasks: 5, eventBus, maxTaskRecords: 20 });
    for (let i = 0; i < 40; i++) {
      tr.createTask({ agent: makeAgent(), prompt: `p${i}` });
    }
    await tr.waitForAll();
    const sizes = tr.debugMapSizes();
    expect(sizes.agents).toBe(0);
    expect(sizes.tasks).toBeLessThanOrEqual(20);
    tr.destroy();
  });
});

describe('C-10 — stale lock CAS', () => {
  it('two async waiters on a stale lock: exactly one owner at a time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-c10-'));
    const lockPath = lockPathFor(path.join(dir, 'store.json'));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, acquiredAt: 1 }));
    let concurrent = 0;
    let max = 0;
    const body = async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return true;
    };
    const results = await Promise.all([
      withFileLock(lockPath, body, { timeoutMs: 2000, staleMs: 1 }),
      withFileLock(lockPath, body, { timeoutMs: 2000, staleMs: 1 }),
    ]);
    expect(results).toEqual([true, true]);
    expect(max).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not steal a lock from a live pid even if mtime is old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-c10b-'));
    const lockPath = lockPathFor(path.join(dir, 'store.json'));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: 1 }));
    const past = Date.now() - 60_000;
    fs.utimesSync(lockPath, past / 1000, past / 1000);
    expect(() =>
      withFileLockSync(lockPath, () => 'nope', { timeoutMs: 40, staleMs: 10, pollMs: 5 })
    ).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('C-11 — journal close and log rotation', () => {
  it('journal.close releases the fd; observability rotates above the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-c11-'));
    const journal = new JournalWriter({ runtimeDir: dir, enabled: true });
    journal.log({ ts: new Date().toISOString(), kind: 'agent', summary: 'hello' });
    expect(journal.isOpen).toBe(true);
    journal.close();
    expect(journal.isOpen).toBe(false);

    const logPath = path.join(dir, 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: logPath, maxLogBytes: 80 });
    for (let i = 0; i < 20; i++) {
      logger.log({ eventType: 'system:info', message: `line-${i}-xxxxxxxxxx`, level: 'info' });
    }
    logger.close();
    const rotated = fs.readdirSync(dir).filter((f) => f.startsWith('observability.jsonl.'));
    expect(rotated.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('C-13 / C-14 — chat task ids and structured-retry usage', () => {
  it('withStructuredRetry reports usage from the failed first attempt', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const result = await withStructuredRetry(
      async () => {
        n++;
        if (n === 1) {
          throw new NoObjectGeneratedError({
            message: 'nope',
            text: '{',
            response: { id: '1', timestamp: new Date(), modelId: 'm' },
            usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } as never,
            finishReason: 'stop',
          });
        }
        return { ok: true, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      },
      2,
      (err) => {
        if (NoObjectGeneratedError.isInstance(err)) seen.push(err.usage);
      }
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('reconcile closes a pending chat interaction with no planId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-c13-'));
    const sessions = new FileSessionStore(path.join(dir, 'sessions'));
    const sid = sessions.createSession('chat');
    const interaction = sessions.addInteraction(sid, 'hello?');
    expect(interaction?.outcome).toBe('pending');
    const orch = new Orchestrator({
      projectRoot: path.resolve(import.meta.dirname, '../../..'),
      runtimeDir: dir,
      persistent: true,
    });
    await orch.initialize();
    const after = sessions.getSession(sid);
    const row = after?.interactions.find((i) => i.id === interaction?.id);
    expect(row?.completedAt).toBeDefined();
    expect(row?.outcome).toBe('cancelled');
    await orch.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
