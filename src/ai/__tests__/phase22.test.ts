/**
 * Phase 22 — Code Quality & Maintainability acceptance tests.
 *
 * Encodes the plan's acceptance criteria:
 *   Step 1  `any` in runtime sources < 3        (source scan)
 *   Step 2  `console.*` in runtime sources = 0  (source scan)
 *   Step 4  OrchestratorConfig: invalid value → ZodError in constructor
 *   Step 5  cancelTask on a RUNNING task truly aborts generateText (mock)
 *   Step 6  isPlanTerminal includes cancelled/failed-partial;
 *           Review.usage required with a zero default
 *   Step 7  FileStore hash filenames — no id collisions, no traversal
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';

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
import { TaskRuntime } from '../runtime/task-runtime.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { createPlan, isPlanTerminal, type Plan, type PlanStep } from '../schemas/plan.js';
import { ReviewSchema, emptyReviewUsage, type Review } from '../schemas/review.js';
import type { Session } from '../schemas/session.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeStep(id: string): Omit<PlanStep, 'status'> & { status?: PlanStep['status'] } {
  return {
    id,
    description: `step ${id}`,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: [],
    claimedResources: [],
    acceptanceCriteria: 'done',
  };
}

function makeAgent(): ResolvedAgent {
  return { agentId: 'worker', systemPrompt: 's', tools: {}, model: {} } as unknown as ResolvedAgent;
}

/**
 * A generateText mock that HONORS abortSignal the way the real AI SDK
 * does: the returned promise rejects with an AbortError when the
 * signal fires.
 */
function hangUnlessAborted(abortFired?: { value: boolean }) {
  mockGenerateText.mockImplementation(
    (((opts: { abortSignal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const fire = () => {
          if (abortFired) abortFired.value = true;
          const err = new Error('Generation aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (opts.abortSignal?.aborted) {
          fire();
          return;
        }
        opts.abortSignal?.addEventListener('abort', fire, { once: true });
      });
    }) as never),
  );
}

// ─── Step 4: OrchestratorConfig zod validation ────────────────────

describe('Step 4 — OrchestratorConfig is zod-validated in the constructor', () => {
  let dir: string;

  beforeEach(() => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase22-cfg-'));
  });
  afterEach(() => {
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('throws a ZodError for out-of-range values', () => {
    const cases = [
      { projectRoot: dir, maxConcurrentTasks: 0 },
      { projectRoot: dir, maxConcurrentTasks: 101 },
      { projectRoot: dir, agentTimeoutMs: 100 },
      { projectRoot: dir, agentTimeoutMs: 600_001 },
      { projectRoot: dir, maxSteps: 0 },
      { projectRoot: dir, maxDelegationDepth: 99 },
      { projectRoot: dir, maxRetries: 11 },
      { projectRoot: dir, baseBackoffMs: 1 },
      { projectRoot: dir, maxBackoffMs: 999 },
      { projectRoot: dir, maxConcurrentPerProvider: 0 },
      { projectRoot: '' },
      { projectRoot: 42 },
    ] as Array<Record<string, unknown>>;
    for (const config of cases) {
      expect(
        () => new Orchestrator(config as never),
        JSON.stringify(config),
      ).toThrow(ZodError);
    }
  });

  it('applies the schema defaults for a minimal config', () => {
    const orch = new Orchestrator({ projectRoot: dir });
    const cfg = (orch as unknown as { config: Record<string, unknown> }).config;
    expect(cfg.persistent).toBe(false);
    expect(cfg.runtimeDir).toBe(path.join(dir, '.ai-runtime'));
    expect(cfg.maxConcurrentTasks).toBe(5);
    expect(cfg.maxConcurrentPerProvider).toBe(5);
    expect(cfg.maxReplanningAttempts).toBe(3);
    expect(cfg.agentTimeoutMs).toBe(120_000);
    expect(cfg.maxDelegationDepth).toBe(1);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.baseBackoffMs).toBe(1_000);
    expect(cfg.maxBackoffMs).toBe(30_000);
    expect(cfg.maxSteps).toBe(20);
    expect(cfg.contextBudgetChars).toBe(120_000);
    expect(cfg.connectTimeoutMs).toBe(10_000);
    expect(cfg.defaultModelId).toBe('gpt-4o');
  });

  it('accepts in-range custom values', () => {
    const orch = new Orchestrator({
      projectRoot: dir,
      maxConcurrentTasks: 3,
      agentTimeoutMs: 5_000,
      maxDelegationDepth: 2,
      defaultModelId: 'claude-sonnet-4',
    });
    const cfg = (orch as unknown as { config: Record<string, unknown> }).config;
    expect(cfg.maxConcurrentTasks).toBe(3);
    expect(cfg.agentTimeoutMs).toBe(5_000);
    expect(cfg.maxDelegationDepth).toBe(2);
    expect(cfg.defaultModelId).toBe('claude-sonnet-4');
  });
});

// ─── Step 5: AbortSignal for cancellation ─────────────────────────

describe('Step 5 — real cancellation via AbortSignal', () => {
  afterEach(() => {
    mockGenerateText.mockReset();
  });

  it('cancelTask on a RUNNING task aborts the in-flight generateText', async () => {
    const fired = { value: false };
    hangUnlessAborted(fired);

    const eventBus = new EventBus();
    const tr = new TaskRuntime({ maxConcurrentTasks: 1, eventBus });
    const taskId = tr.createTask({ agent: makeAgent(), prompt: 'p' });
    expect(tr.getRunningCount()).toBe(1);

    // The SDK call received a live AbortSignal…
    const callArg = mockGenerateText.mock.calls[0]?.[0] as {
      abortSignal?: AbortSignal;
    };
    expect(callArg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArg.abortSignal!.aborted).toBe(false);

    // …and cancelTask fires it.
    expect(tr.cancelTask(taskId)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // let the rejection propagate

    expect(fired.value).toBe(true); // the model call was REALLY aborted
    // The aborted run's failure must NOT overwrite "cancelled".
    expect(tr.getStatus(taskId)?.status).toBe('cancelled');
    expect(tr.getRunningCount()).toBe(0);
    tr.destroy();
  });

  it('AgentRuntime surfaces an abort as a structured ABORTED failure', async () => {
    hangUnlessAborted();

    const eventBus = new EventBus();
    const codes: string[] = [];
    eventBus.subscribe('agent:error', (e) => {
      if (e.type === 'agent:error') codes.push(e.code);
    });

    const controller = new AbortController();
    controller.abort(); // already aborted before the run starts

    const result = await new AgentRuntime().run({
      agent: makeAgent(),
      taskId: 't1',
      prompt: 'p',
      eventBus,
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(codes).toContain('ABORTED');
  });
});

// ─── Step 6: isPlanTerminal + Review usage ────────────────────────

describe('Step 6 — isPlanTerminal and required Review.usage', () => {
  function planWith(
    status: Plan['status'],
    stepStatuses: PlanStep['status'][],
  ): Plan {
    const steps = stepStatuses.map((s, i) => ({ ...makeStep(`s${i}`), status: s }));
    const plan = createPlan('goal', steps);
    plan.status = status;
    return plan;
  }

  it('treats plan-level terminal statuses as terminal (even with pending steps)', () => {
    // A cancelled/failed-partial plan with un-dispatched steps is over.
    expect(isPlanTerminal(planWith('cancelled', ['pending', 'pending']))).toBe(true);
    expect(isPlanTerminal(planWith('failed-partial', ['done', 'pending']))).toBe(true);
    expect(isPlanTerminal(planWith('completed', ['done']))).toBe(true);
  });

  it('falls back to the per-step check for non-terminal statuses', () => {
    expect(isPlanTerminal(planWith('running', ['pending']))).toBe(false);
    expect(isPlanTerminal(planWith('running', ['done', 'pending']))).toBe(false);
    expect(isPlanTerminal(planWith('running', ['done', 'failed']))).toBe(true);
  });

  it('ReviewSchema fills usage with zeros when the model omits it', () => {
    const parsed = ReviewSchema.parse({
      planId: 'p1',
      goal: 'g',
      outcome: 'success',
      acceptedFindings: [],
      rejectedFindings: [],
      incompleteSteps: [],
      finalSummary: 'done',
      // usage intentionally omitted — the default must kick in
    }) as Review;
    expect(parsed.usage).toEqual(emptyReviewUsage);
    expect(parsed.usage).toEqual({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    });
  });
});

// ─── Step 7: FileStore hash filenames ─────────────────────────────

describe('Step 7 — FileStore hash-based filenames (collision + traversal fix)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase22-store-'));
  });
  afterEach(() => {
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  function makePlan(id: string): Plan {
    const plan = createPlan(`goal for ${id}`, [makeStep('s1')]);
    plan.id = id;
    return plan;
  }

  it('ids that collided under sanitisation now map to DISTINCT files', () => {
    const store = new FilePlanStore(dir);
    // Old sanitiser: 'a/b' → 'a_b.json' AND 'a_b' → 'a_b.json'
    // → the second save silently clobbered the first plan.
    const p1 = makePlan('a/b');
    const p2 = makePlan('a_b');
    store.save(p1);
    store.save(p2);

    const files = fsSync.readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(store.load('a/b')?.goal).toBe('goal for a/b');
    expect(store.load('a_b')?.goal).toBe('goal for a_b');
    expect([...store.list()].sort()).toEqual(['a/b', 'a_b']);
  });

  it('no id can escape the store directory', () => {
    const store = new FilePlanStore(dir);
    const evil = makePlan('../../evil');
    store.save(evil);

    // The file must live INSIDE the store dir, not outside it.
    expect(fsSync.existsSync(path.resolve(dir, '../evil.json'))).toBe(false);
    expect(fsSync.readdirSync(dir)).toHaveLength(1);
    // And it is still loadable via its (hash-of) id.
    expect(store.load('../../evil')?.id).toBe('../../evil');
    expect(store.exists('../../evil')).toBe(true);
  });

  it('session store round-trips through hashed filenames', () => {
    const store = new FileSessionStore(dir);
    const session: Session = {
      id: 's/x',
      label: 'L',
      interactions: [],
      metadata: {},
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    store.saveSession(session);
    expect(store.getSession('s/x')?.id).toBe('s/x');
    expect(store.listSessions()).toEqual(['s/x']);
    store.deleteSession('s/x');
    expect(store.listSessions()).toEqual([]);
  });
});

// ─── Steps 1+2: source-level invariants ───────────────────────────

describe('Steps 1+2 — runtime sources: zero console.*, <3 any usages', () => {
  const SRC_DIR = path.resolve(__dirname, '..'); // src/ai

  function listRuntimeTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listRuntimeTsFiles(full));
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  const runtimeFiles = listRuntimeTsFiles(SRC_DIR);

  it('scans a non-trivial number of runtime files', () => {
    expect(runtimeFiles.length).toBeGreaterThan(30);
  });

  it('contains zero console.* calls (step 2)', () => {
    const offenders = runtimeFiles.filter((f) =>
      /console\./.test(fsSync.readFileSync(f, 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it('contains fewer than 3 `as any` / `: any` usages (step 1)', () => {
    let count = 0;
    for (const f of runtimeFiles) {
      const src = fsSync.readFileSync(f, 'utf-8');
      for (const line of src.split('\n')) {
        if (/as any|: any/.test(line)) count += 1;
      }
    }
    expect(count).toBeLessThan(3);
  });
});
