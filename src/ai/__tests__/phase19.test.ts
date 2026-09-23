import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { RateLimiter } from '../runtime/rate-limiter.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { FileSessionStore, MemorySessionStore } from '../runtime/session-store.js';
import { atomicWriteFileSync } from '../runtime/atomic-write.js';
import { createPlan } from '../schemas/plan.js';
import type { Persona } from '../schemas/persona.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

type ToolExecute = (args: unknown) => Promise<unknown>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

/** Create a temp project root with the real registry + a boss persona. */
function makeTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  // A persona that is allowed to delegate (no registry persona has this)
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

// ─── SING-01/02: isolation between Orchestrator instances ────────

describe('Phase 19 — Orchestrator instances are isolated (no shared singletons)', () => {
  let rootA: string;
  let rootB: string;
  let orchA: Orchestrator;
  let orchB: Orchestrator;

  beforeEach(async () => {
    vi.clearAllMocks();
    rootA = makeTempProject();
    rootB = makeTempProject();
    orchA = new Orchestrator({ projectRoot: rootA });
    orchB = new Orchestrator({ projectRoot: rootB });
    await orchA.initialize();
    await orchB.initialize();
  });

  afterEach(async () => {
    await orchA?.shutdown();
    await orchB?.shutdown();
    if (rootA && fs.existsSync(rootA)) fs.rmSync(rootA, { recursive: true, force: true });
    if (rootB && fs.existsSync(rootB)) fs.rmSync(rootB, { recursive: true, force: true });
  });

  it('two Orchestrators do not share EventBus or AgentRuntime', async () => {
    expect(orchA.eventBus).not.toBe(orchB.eventBus);
    expect(orchA.agentRuntime).not.toBe(orchB.agentRuntime);
    expect(orchA.taskRuntime).not.toBe(orchB.taskRuntime);
  });

  it('events on one Orchestrator bus are not visible on the other', async () => {
    const seenByB: string[] = [];
    orchB.eventBus.subscribe('agent:completed', (e) => seenByB.push(e.taskId));

    orchA.eventBus.emit({
      type: 'agent:completed',
      taskId: 'task-from-A',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'done',
      toolsUsed: [],
    });

    expect(seenByB).toHaveLength(0);
  });
});

// ─── CFG-03/04: DelegationGuard is actually enforced ─────────────

describe('Phase 19 — DelegationGuard wired into delegate_task', () => {
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

  it('maxDelegationDepth=0 → DELEGATION_DENIED even for an authorized persona', async () => {
    const orch = new Orchestrator({ projectRoot, maxDelegationDepth: 0 });
    await orch.initialize();
    try {
      const impl = orch.toolRegistry.getImplementation('delegate_task');
      expect(impl).toBeDefined();
      const result = (await executeOf(impl)({
        mode: 'dynamic',
        persona: 'boss',
        skills: [],
        tools: [],
        model: 'gpt-4o',
        prompt: 'do something',
      })) as { success: boolean; code?: string; error?: string };
      expect(result.success).toBe(false);
      expect(result.code).toBe('DELEGATION_DENIED');
      expect(result.error).toContain('exceeds maximum');
    } finally {
      await orch.shutdown();
    }
  });

  it('maxDelegationDepth=1 → guard passes for an authorized persona', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'ok',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      steps: [],
    } as never);

    const orch = new Orchestrator({ projectRoot, maxDelegationDepth: 1 });
    await orch.initialize();
    try {
      const impl = orch.toolRegistry.getImplementation('delegate_task');
      const result = (await executeOf(impl)({
        mode: 'dynamic',
        persona: 'boss',
        skills: [],
        tools: [],
        model: 'gpt-4o',
        prompt: 'do something',
      })) as { success: boolean; code?: string; taskId?: string };
      // Guard must not block an authorized persona at depth 0 < maxDepth 1
      expect(result.success).toBe(true);
      expect(result.taskId).toBeDefined();
    } finally {
      await orch.shutdown();
    }
  });
});

// ─── CFG-05: agentTimeoutMs is actually applied ──────────────────

describe('Phase 19 — agentTimeoutMs wiring', () => {
  it('AgentRuntime.run honors a short timeout (mocked hang)', async () => {
    const eventBus = new EventBus();
    const runtime = new AgentRuntime();
    mockGenerateText.mockImplementation(
      () => new Promise(() => {}) as never // never resolves
    );

    const result = await runtime.run({
      agent: {
        agentId: 't',
        systemPrompt: 's',
        tools: {},
        model: {} as never,
        persona: { id: 't', name: 'T', system: 'S', allowedTools: [] } as Persona,
        skills: [],
        toolWarnings: [],
        trimmingLog: [],
        contextBudgetExceeded: false,
      },
      taskId: 'hang-1',
      prompt: 'hang',
      eventBus,
      timeoutMs: 100,
    });

    expect(result.success).toBe(false);
    expect(result.summary.toLowerCase()).toContain('timed out');
  });

  it('TaskRuntime forwards agentTimeoutMs to every run', async () => {
    mockGenerateText.mockImplementation(
      () => new Promise(() => {}) as never // never resolves
    );

    const eventBus = new EventBus();
    const taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus,
      agentRuntime: new AgentRuntime(),
      agentTimeoutMs: 100,
    });

    const taskId = taskRuntime.createTask({
      agent: {
        agentId: 't',
        systemPrompt: 's',
        tools: {},
        model: {} as never,
        persona: { id: 't', name: 'T', system: 'S', allowedTools: [] } as Persona,
        skills: [],
        toolWarnings: [],
        trimmingLog: [],
        contextBudgetExceeded: false,
      },
      prompt: 'hang',
    });

    await taskRuntime.waitForAll();

    const task = taskRuntime.getResult(taskId);
    expect(task?.status).toBe('failed');
    expect((task?.summary ?? '').toLowerCase()).toContain('timed out');
    taskRuntime.destroy();
  });
});

// ─── CFG-06: RateLimiter built from config ───────────────────────

describe('Phase 19 — RateLimiter config comes from OrchestratorConfig', () => {
  it('Orchestrator applies maxRetries / maxBackoffMs / concurrency cap', async () => {
    const projectRoot = makeTempProject();
    try {
      const orch = new Orchestrator({
        projectRoot,
        maxConcurrentPerProvider: 2,
        maxRetries: 1,
        baseBackoffMs: 100,
        maxBackoffMs: 200,
      });

      const rl = orch.rateLimiter as RateLimiter;
      // maxRetries=1 → retry only for attempt 0
      expect(rl.shouldRetry(0)).toBe(true);
      expect(rl.shouldRetry(1)).toBe(false);
      // backoff capped at maxBackoffMs
      expect(rl.getBackoffDelay(5)).toBeLessThanOrEqual(200);

      // concurrency cap = 2 → the third acquire queues
      await rl.acquire('p');
      await rl.acquire('p');
      const third = rl.acquire('p');
      expect(rl.getStats('p')).toEqual({ active: 2, queued: 1 });
      rl.release('p');
      await third;
      rl.release('p');
      rl.release('p');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── PERS-01/02/03: atomic writes + no mutation + structuredClone ─

describe('Phase 19 — atomic persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomicWriteFileSync: a failed rename leaves the target untouched and cleans the temp', () => {
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, '{"v":1}', 'utf-8');

    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash');
    });
    try {
      expect(() => atomicWriteFileSync(target, '{"v":2}')).toThrow('simulated crash');
      // Target must still hold the OLD content (no corruption)
      expect(fs.readFileSync(target, 'utf-8')).toBe('{"v":1}');
      // No leftover temp files
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('FilePlanStore.save leaves no temp files and produces valid JSON', () => {
    const store = new FilePlanStore(dir);
    const plan = createPlan('goal', [
      {
        id: 's1',
        description: 'd',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);
    plan.id = 'p1';
    store.save(plan);

    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    expect(files).toContain('p1.json');
    const loaded = JSON.parse(fs.readFileSync(path.join(dir, 'p1.json'), 'utf-8'));
    expect(loaded.goal).toBe('goal');
  });

  it('FileSessionStore.saveSession does NOT mutate the input (PERS-02)', () => {
    const store = new FileSessionStore(dir);
    const id = store.createSession('test');
    const before = store.getSession(id)!;
    const originalActive = before.lastActiveAt;

    store.saveSession(before);

    // The caller's object must be unchanged
    expect(before.lastActiveAt).toBe(originalActive);
    // The stored copy has a fresh timestamp
    const after = store.getSession(id)!;
    expect(after.lastActiveAt).toBeGreaterThanOrEqual(originalActive);
  });

  it('MemorySessionStore uses structuredClone (no input mutation on save)', () => {
    const store = new MemorySessionStore();
    const id = store.createSession('m');
    const session = store.getSession(id)!;
    const original = { ...session, interactions: [...session.interactions] };

    store.saveSession(session);

    expect(session.lastActiveAt).toBe(original.lastActiveAt);
  });
});

// ─── CFG-01/02: Law 16 — tool metadata from registry/tools/*.json ─

describe('Phase 19 — Law 16: no hardcoded tool defs in Orchestrator', () => {
  it('orchestrator.ts source no longer registers localToolDefs or duplicate catalog bootstrap', () => {
    // Tests run from source, so read the TS file directly
    const ts = fs.readFileSync(path.join(__dirname, '../orchestrator.ts'), 'utf-8');
    expect(ts).not.toContain('localToolDefs');
    // bootstrapCatalogTools is called exactly once (CFG-02)
    const calls = ts.match(/bootstrapCatalogTools\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    // bootstrapTools (registry/tools/*.json) is the single source (CFG-01)
    expect(ts).toContain('bootstrapTools(');
  });

  it('tool metadata comes from registry/tools/*.json (4 definitions load)', async () => {
    const projectRoot = makeTempProject();
    try {
      const orch = new Orchestrator({ projectRoot });
      await orch.initialize();
      try {
        for (const id of ['read_file', 'search_code', 'write_file', 'git_status']) {
          expect(orch.toolRegistry.hasDefinition(id)).toBe(true);
          expect(orch.toolRegistry.getImplementation(id)).toBeDefined();
        }
        // metadata fields come from the JSON files, not hardcoded names
        const def = orch.toolRegistry.getDefinition('read_file')!;
        expect(def.source).toBe('local');
        expect(def.name).toBeTruthy();
      } finally {
        await orch.shutdown();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
