import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

import { Orchestrator } from '../orchestrator.js';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { UsageAggregator } from '../runtime/usage-aggregator.js';
import { StreamingManager, createArrayCollector } from '../runtime/streaming-manager.js';
import { ObservabilityLogger } from '../runtime/observability-logger.js';
import { McpConnector } from '../tools/mcp-connector.js';
import { createRegistry, RegistryValidationError } from '../registries/base-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { AgentRegistry } from '../registries/agent-registry.js';
import { createAgent } from '../agents/agent-factory.js';
import { createCreateTaskTool } from '../tools/implementations/task-control-tools.js';
import { validateWorkspacePath } from '../tools/implementations/path-security.js';
import type { Persona } from '../schemas/persona.js';
import type { Task } from '../schemas/task.js';
import type { McpServerConfig } from '../schemas/mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

/** Same temp-project helper as phase 19 (real registry + boss persona). */
function makeTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  const boss: Persona = {
    id: 'boss',
    name: 'Boss',
    system: 'You can delegate.',
    allowedTools: ['delegate_task', 'read_file'],
  };
  const personasDir = path.join(projectRoot, 'registry', 'personas');
  fs.writeFileSync(path.join(personasDir, 'boss.json'), JSON.stringify(boss, null, 2));
  return projectRoot;
}

function makeMockAgent(agentId = 't'): any {
  return {
    agentId,
    systemPrompt: 's',
    tools: {},
    model: {} as never,
    persona: { id: agentId, name: 'T', system: 'S', allowedTools: [] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    agentDefinitionOrId: 'coder',
    prompt: 'p',
    status: 'completed',
    claimedResources: [],
    errors: [],
    createdAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  } as Task;
}

function makeMcpConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'test-srv',
    name: 'Test Server',
    transport: 'http',
    url: 'http://localhost:9',
    args: [],
    auth: { type: 'none' },
    connectTimeoutMs: 200,
    ...overrides,
  };
}

// ─── CORR-01: tryRegister surfaces the real ZodError ─────────────

describe('Phase 20 — base-registry tryRegister returns ZodError (CORR-01)', () => {
  const registry = createRegistry({
    schema: z.object({
      id: z.string().min(1),
      requiredNumber: z.number(),
    }),
    label: 'TestRegistry',
  });

  it('validation failure returns reason=validation WITH a populated ZodError', () => {
    const result = registry.tryRegister({ id: 'a' }); // missing requiredNumber

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('validation');
      // THE BUG: before Phase 20 zodError was ALWAYS undefined here
      expect(result.zodError).toBeDefined();
      expect(result.zodError!.issues.length).toBeGreaterThan(0);
      expect(result.zodError!.issues[0].path).toContain('requiredNumber');
    }
  });

  it('duplicate id still returns reason=duplicate', () => {
    expect(registry.tryRegister({ id: 'dup', requiredNumber: 1 }).success).toBe(true);
    const again = registry.tryRegister({ id: 'dup', requiredNumber: 2 });
    expect(again.success).toBe(false);
    if (!again.success) {
      expect(again.reason).toBe('duplicate');
      expect(again.zodError).toBeUndefined();
    }
  });

  it('register() throws RegistryValidationError carrying the ZodError', () => {
    try {
      registry.register({ id: 'b' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryValidationError);
      expect((err as RegistryValidationError).zodError.issues.length).toBeGreaterThan(0);
    }
  });
});

// ─── CORR-02: shutdown waits for in-flight tasks BEFORE unsubscribe ─

describe('Phase 20 — Orchestrator.shutdown keeps in-flight events (CORR-02)', () => {
  let projectRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
    process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
    projectRoot = makeTempProject();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a task running during shutdown completes and its usage is still recorded', async () => {
    // Task work takes 30ms — it will still be running when shutdown starts
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: 'finished after shutdown began',
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
                steps: [],
              }),
            30
          )
        ) as never
    );

    const orch = new Orchestrator({ projectRoot });
    await orch.initialize();

    const agent = createAgent({
      agentDefinition: {
        id: 'shutdown-task-agent',
        name: 'Shutdown Task',
        personaId: 'boss',
        skillIds: [],
        modelId: 'gpt-4o',
      },
      refs: {
        personaRegistry: orch.personaRegistry,
        skillRegistry: orch.skillRegistry,
        toolRegistry: orch.toolRegistry,
        modelRegistry: orch.modelRegistry,
      },
    });

    const taskId = orch.taskRuntime.createTask({
      agent,
      prompt: 'slow work',
      planId: 'plan-shutdown',
      planStepId: 'step-1',
    });

    // Shutdown while the task is still in flight (it has not completed yet)
    await orch.shutdown();

    // The task ran to completion (not killed by an early destroy)
    const task = orch.taskRuntime.getResult(taskId);
    expect(task?.status).toBe('completed');

    // THE BUG: old order unsubscribed UsageAggregator BEFORE waitForAll,
    // so this completion event was lost. Now it is recorded — and with
    // the real plan id (CORR-03 event path).
    const records = orch.usageAggregator.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].taskId).toBe(taskId);
    expect(records[0].planId).toBe('plan-shutdown');
    expect(orch.usageAggregator.getSummary().byPlan['plan-shutdown'].totalTokens).toBe(15);
  });
});

// ─── CORR-03: usage bucketed by real planId ──────────────────────

describe('Phase 20 — UsageAggregator uses task.planId (CORR-03)', () => {
  it('record() buckets by planId, NOT by planStepId', () => {
    const agg = new UsageAggregator();
    agg.record(
      makeTask('t1', {
        planStepId: 'step-1',
        planId: 'plan-A',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
      'coder'
    );

    const summary = agg.getSummary();
    // Correct bucket — the PLAN id
    expect(summary.byPlan['plan-A']?.totalTokens).toBe(150);
    // The step id must NOT be used as a plan bucket (the old bug)
    expect(summary.byPlan['step-1']).toBeUndefined();
  });
});

// ─── CORR-05: StreamingManager gets real plan context ────────────

describe('Phase 20 — StreamingManager uses event plan context (CORR-05)', () => {
  let bus: EventBus;
  let manager: StreamingManager;
  let collector: ReturnType<typeof createArrayCollector>;

  beforeEach(() => {
    bus = new EventBus();
    manager = new StreamingManager({ eventBus: bus });
    collector = createArrayCollector();
    manager.subscribe(collector.handler);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
  });

  it('agent events with plan context produce real planId/stepId/taskId', () => {
    bus.emit({
      type: 'agent:completed',
      taskId: 'task-9',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'done',
      toolsUsed: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      planId: 'plan-real',
      planStepId: 'step-2',
    });

    expect(collector.events).toHaveLength(1);
    const e = collector.events[0];
    // THE BUG: planId used to be the taskId
    expect(e.planId).toBe('plan-real');
    expect(e.stepId).toBe('step-2');
    expect(e.taskId).toBe('task-9');
  });

  it('events without plan context fall back to taskId (backward compat)', () => {
    bus.emit({
      type: 'agent:running',
      taskId: 'task-legacy',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'old event',
    });

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].planId).toBe('task-legacy');
  });
});

// ─── LEAK-01/02: timeout timers are cleared when the race settles ─

describe('Phase 20 — no pending timers after run/connect (LEAK-01/02)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AgentRuntime: hanging run → timeout → zero pending timers', async () => {
    vi.useFakeTimers();
    mockGenerateText.mockImplementation(() => new Promise(() => {}) as never);

    const runtime = new AgentRuntime();
    const runPromise = runtime.run({
      agent: makeMockAgent('leak'),
      taskId: 'leak-1',
      prompt: 'hang',
      eventBus: new EventBus(),
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100); // fire the timeout
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.summary.toLowerCase()).toContain('timed out');
    // THE BUG: the race winner left the losing timer pending
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AgentRuntime: successful run → zero pending timers', async () => {
    vi.useFakeTimers();
    mockGenerateText.mockResolvedValue({
      text: 'ok',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      steps: [],
    } as never);

    const runtime = new AgentRuntime();
    const result = await runtime.run({
      agent: makeMockAgent('leak2'),
      taskId: 'leak-2',
      prompt: 'quick',
      eventBus: new EventBus(),
      timeoutMs: 120_000, // default-ish long timer that MUST be cleared
    });

    expect(result.success).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('McpConnector: connection timeout → zero pending timers', async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({
      toolRegistry,
      createTransport: () => ({}),
      createClient: () => new Promise(() => {}), // never connects
    });

    const connectPromise = connector.connectServer(makeMcpConfig({ connectTimeoutMs: 200 }));
    await vi.advanceTimersByTimeAsync(200); // fire the timeout
    const ok = await connectPromise;

    expect(ok).toBe(false);
    expect(connector.getServerState('test-srv')?.lastError).toContain('Connection timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('McpConnector: successful connect → zero pending timers', async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({
      toolRegistry,
      createTransport: () => ({}),
      createClient: async () => ({
        tools: async () => ({}),
        close: async () => {},
      }),
    });

    const ok = await connector.connectServer(makeMcpConfig({ connectTimeoutMs: 200 }));

    expect(ok).toBe(true);
    expect(connector.getServerState('test-srv')?.status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
    await connector.closeAll();
  });
});

// ─── PATH-07/08: symlink escape + case-insensitive compare ───────

/**
 * Creating a symlink needs a privilege Windows does not grant by default
 * (`SeCreateSymbolicLinkPrivilege`), so the OS answers EPERM.  That is a
 * property of the machine, not of the code under test: probe it once and skip
 * the symlink cases with a reason instead of reporting a red build for a
 * capability the runner does not have.  The lexical checks below still run
 * everywhere, and the symlink defense is exercised on POSIX and macOS.
 */
function symlinksAreSupported(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target.txt'), 'x');
    fs.symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = symlinksAreSupported();
const symlinkSkip = SYMLINK_SUPPORTED
  ? false
  : 'this machine cannot create symlinks (Windows without SeCreateSymbolicLinkPrivilege)';

describe('Phase 20 — path security: symlinks cannot escape the workspace (PATH-07)', () => {
  let outside: string;
  let root: string;

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-out-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-root-'));
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(symlinkSkip)('file symlink pointing outside is blocked', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link'));

    const check = validateWorkspacePath('link', root);
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('via symlink');
  });

  it.skipIf(symlinkSkip)('directory symlink used to write a NEW file outside is blocked', () => {
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'inner.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'dirlink'));

    // The target file does not exist yet — only the directory does.
    // The old lexical check passed this; the realpath ancestor check blocks it.
    const check = validateWorkspacePath('dirlink/brand-new.txt', root);
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('via symlink');
  });

  it('a real file inside the workspace is still allowed', () => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'ok');
    const check = validateWorkspacePath('real.txt', root);
    expect(check.safe).toBe(true);
    expect(check.resolvedPath).toBe(path.join(root, 'real.txt'));
  });

  it('a nonexistent path inside an existing root is allowed (lexical)', () => {
    const check = validateWorkspacePath('does/not/exist.txt', root);
    expect(check.safe).toBe(true);
  });

  it.skipIf(symlinkSkip)('a workspace root that is itself a symlink still works', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-real-'));
    fs.writeFileSync(path.join(realDir, 'f.txt'), 'x');
    const symlinkedRoot = path.join(outside, 'root-link');
    fs.symlinkSync(realDir, symlinkedRoot);

    const check = validateWorkspacePath('f.txt', symlinkedRoot);
    expect(check.safe).toBe(true);
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('a nonexistent root falls back to the lexical check (no crash)', () => {
    const check = validateWorkspacePath('src/main.ts', '/definitely/not/here-xyz');
    expect(check.safe).toBe(true);
  });

  it('classic ../ traversal is still blocked', () => {
    const check = validateWorkspacePath('../outside/secret.txt', root);
    expect(check.safe).toBe(false);
  });
});

// ─── SEC-03: sanitiseError redacts 5-8 char secret fragments ─────

describe('Phase 20 — MCP error sanitisation redacts short fragments (SEC-03)', () => {
  afterEach(() => {
    delete process.env.MCP_PHASE20_KEY;
  });

  it('a 5-char token fragment in an error is redacted (was >8 before)', async () => {
    // Two 5-char parts; the error only contains ONE of them.
    process.env.MCP_PHASE20_KEY = 'partA partB';

    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({
      toolRegistry,
      createTransport: () => ({}),
      createClient: () => Promise.reject(new Error('server rejected: partB')),
    });

    const ok = await connector.connectServer(
      makeMcpConfig({
        auth: { type: 'api-key', keyEnvVar: 'MCP_PHASE20_KEY', headerName: 'X-Key' },
      })
    );

    expect(ok).toBe(false);
    const state = connector.getServerState('test-srv')!;
    expect(state.lastError).toContain('***REDACTED***');
    // THE BUG: with the old >8 threshold, 'partB' (5 chars) leaked
    expect(state.lastError).not.toContain('partB');
    expect(state.lastError).not.toContain('partA');
  });
});

// ─── SEC-04: redactPayload uses substring matching ───────────────

describe('Phase 20 — log payload redaction is substring-based (SEC-04)', () => {
  let dir: string;
  let logger: ObservabilityLogger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-log-'));
    logger = new ObservabilityLogger({ logFilePath: path.join(dir, 'obs.jsonl') });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('numeric *Tokens counters survive redaction (Phase 29 regression)', () => {
    logger.log({
      eventType: 'task:completed',
      message: 'done',
      level: 'info',
      payload: {
        toolsUsed: ['read_file'],
        usage: { promptTokens: 240, completionTokens: 90, totalTokens: 330 },
        accessToken: 'string-secret-must-stay-redacted',
      },
    });

    const [entry] = logger.readAll();
    expect(entry!.payload!.usage).toEqual({
      promptTokens: 240,
      completionTokens: 90,
      totalTokens: 330,
    });
    // …while a real string credential is still redacted.
    expect(entry!.payload!.accessToken).toBe('***REDACTED***');
  });

  it('keys CONTAINING redact patterns are redacted (myApiKey, dbToken, accessToken)', () => {
    logger.log({
      eventType: 'system:info',
      message: 'diag',
      level: 'info',
      payload: {
        myApiKey: 'sk-should-be-redacted-1',
        dbToken: 'token-should-be-redacted-2',
        accessToken: 'token-should-be-redacted-3',
        modelName: 'gpt-4o', // must NOT be redacted
      },
    });

    const [entry] = logger.readAll();
    expect(entry!.payload!.myApiKey).toBe('***REDACTED***');
    expect(entry!.payload!.dbToken).toBe('***REDACTED***');
    expect(entry!.payload!.accessToken).toBe('***REDACTED***');
    // THE BUG: before Phase 20 all three above leaked (exact match only)
    expect(entry!.payload!.modelName).toBe('gpt-4o');
  });

  it('custom redact keys also use substring matching', () => {
    const custom = new ObservabilityLogger({
      logFilePath: path.join(dir, 'custom.jsonl'),
      redactKeys: ['zipfile'],
    });
    custom.log({
      eventType: 'system:info',
      message: 'diag',
      level: 'info',
      payload: { myZipFile: 'secret-zip', other: 'fine' },
    });

    const [entry] = custom.readAll();
    expect(entry!.payload!.myZipFile).toBe('***REDACTED***');
    expect(entry!.payload!.other).toBe('fine');
  });
});

// ─── CORR-08: create_task tool type guard ────────────────────────

describe('Phase 20 — create_task tool discriminator (CORR-08)', () => {
  it('bare TaskRuntime still works (backward-compat path)', async () => {
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 1, eventBus: new EventBus() });
    const toolObj = createCreateTaskTool(taskRuntime);
    const execute = (toolObj as unknown as { execute: (a: unknown) => Promise<unknown> }).execute;

    const result = (await execute({
      agentId: 'coder',
      prompt: 'p',
      claimedResources: [],
    })) as { success: boolean; code?: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('USE_DELEGATE_TASK');
    taskRuntime.destroy();
  });

  it('full deps resolve the agent (unknown id → AGENT_NOT_FOUND)', async () => {
    const toolObj = createCreateTaskTool({
      taskRuntime: new TaskRuntime({ maxConcurrentTasks: 1, eventBus: new EventBus() }),
      agentRegistry: new AgentRegistry(),
      personaRegistry: new (await import('../registries/persona-registry.js')).PersonaRegistry(),
      skillRegistry: new (await import('../registries/skill-registry.js')).SkillRegistry({ toolRegistry: new ToolRegistry() }),
      toolRegistry: new ToolRegistry(),
      modelRegistry: new (await import('../registries/model-registry.js')).ModelRegistry(),
    });
    const execute = (toolObj as unknown as { execute: (a: unknown) => Promise<unknown> }).execute;

    const result = (await execute({
      agentId: 'does-not-exist',
      prompt: 'p',
      claimedResources: [],
    })) as { success: boolean; code?: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('AGENT_NOT_FOUND');
  });
});
