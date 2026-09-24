/**
 * Phase 21 — Performance acceptance benchmarks.
 *
 * Covers PERF-01..05 and PERF-07 (PERF-06/08 are tracked separately in
 * category I of EXECUTION_PLAN_V2.md and are not part of phase 21).
 *
 * Every test asserts the concrete number from the plan's acceptance
 * table:
 *   PERF-01  plan-runtime: 200-ish steps / 50 ready → < 500 step visits
 *            (measured as `plan.steps` property accesses per call)
 *   PERF-02  AgentCache: get on a 10 KB definition < 1 ms (avg)
 *   PERF-03  TaskRuntime: 1000 pending tasks → scheduleNext < 2 ms
 *   PERF-04  ObservabilityLogger: 1000 events < 100 ms
 *   PERF-05  search_code: early exit — files are only read up to the
 *            early-termination point
 *   PERF-07  ToolRegistry LRU: reference-stable hits, ≤ 64 combos,
 *            invalidation on registerImplementation
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fsSync from 'node:fs';
import fsP from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from 'ai';
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

import { PlanRuntime } from '../runtime/plan-runtime.js';
import type { PlanStore } from '../runtime/plan-store.js';
import type { Planner } from '../planning/planner.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import {
  AgentCache,
  stableStringify,
  hashAgentDefinition,
  type ResolvedAgent,
} from '../agents/agent-factory.js';
import type { AgentDefinition } from '../schemas/agent-definition.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import { ObservabilityLogger } from '../runtime/observability-logger.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';

// ─── PERF-01: PlanRuntime — O(V+E) dependent counts ────────────────

const stubPlanner = {
  plan: async () => ({ isClear: true, needsClarification: [] }),
} as unknown as Planner;

function makePlanRuntime(): PlanRuntime {
  // Only getReadyStepsPrioritized is exercised — everything else is stubbed.
  return new PlanRuntime({
    taskRuntime: {} as TaskRuntime,
    planStore: {} as PlanStore,
    planner: stubPlanner,
    feasibilityDeps: {} as never,
    refs: {} as never,
  });
}

/**
 * 50 ready "root" steps; root-i has (i % 4) dependent "leaf" steps.
 * 50 + 75 = 125 steps, 50 ready — the plan's 200-step/50-ready shape
 * at 60% density.
 */
function makeBushPlan(): Plan {
  const base = {
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: [],
    claimedResources: [],
    acceptanceCriteria: 'done',
  };
  const steps = [];
  const roots: Array<{ id: string; dependents: number }> = [];
  for (let i = 1; i <= 50; i++) {
    const rootId = `root-${String(i).padStart(2, '0')}`;
    roots.push({ id: rootId, dependents: i % 4 });
    steps.push({ ...base, id: rootId, description: `root ${i}`, dependsOn: [] });
  }
  for (const root of roots) {
    for (let k = 0; k < root.dependents; k++) {
      steps.push({
        ...base,
        id: `leaf-${root.id.slice(-2)}-${k}`,
        description: `leaf of ${root.id}`,
        dependsOn: [root.id],
      });
    }
  }
  return createPlan('perf bush', steps);
}

/** A Proxy that counts how many times `plan.steps` is accessed. */
function countStepsAccesses<T extends object>(obj: T): { proxy: T; count: () => number } {
  let accesses = 0;
  const proxy = new Proxy(obj, {
    get(target, prop, receiver) {
      if (prop === 'steps') accesses += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, count: () => accesses };
}

/**
 * Reference copy of the OLD per-ready-step BFS (pre-phase-21), counting
 * `plan.steps` accesses exactly once per ready step (the real sort
 * comparator called it repeatedly — that only makes the old algorithm
 * worse, so the per-ready-step count is a lower bound).
 */
function legacyPrioritizedAccesses(plan: Plan): number {
  const done = new Set(
    (plan as { steps: Array<{ id: string; status: string; dependsOn: string[] }> }).steps
      .filter((s) => s.status === 'done')
      .map((s) => s.id),
  );
  const ready = (plan as { steps: Array<{ id: string; status: string; dependsOn: string[] }> }).steps.filter(
    (s) =>
      s.status === 'pending' &&
      s.dependsOn.every((d) => (done as Set<string>).has(d)),
  );
  const countDependents = (stepId: string): number => {
    const visited = new Set<string>();
    const queue = [stepId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      // ONE plan.steps access per queue pop — the old hot spot.
      for (const step of (plan as { steps: Array<{ id: string; dependsOn: string[] }> }).steps) {
        if (step.dependsOn.includes(current) && !visited.has(step.id)) {
          visited.add(step.id);
          queue.push(step.id);
        }
      }
    }
    return visited.size;
  };
  return ready.reduce((acc, s) => acc + countDependents(s.id) + 1, 0);
}

describe('PERF-01: PlanRuntime getReadyStepsPrioritized (single O(V+E) pass)', () => {
  it('counts transitive dependents in a bounded number of plan.steps accesses (< 500 per the plan)', () => {
    const runtime = makePlanRuntime();
    const { proxy, count } = countStepsAccesses(makeBushPlan());

    const ready = (runtime as any).getReadyStepsPrioritized(proxy) as Array<{
      id: string;
    }>;

    expect(ready.length).toBe(50);
    // The old BFS-based implementation touched plan.steps 127 times here
    // (per-ready-step BFS: 50 roots × (1 + dependents) queue pops).
    // Acceptance criterion: < 500; implementation is a single memoized
    // DFS → 4 accesses total (2 in getReadySteps, 2 in the DFS pass).
    expect(count()).toBeLessThan(500);
    expect(count()).toBeLessThanOrEqual(8);
  });

  it('scales: old BFS does ~127 step-list accesses, new pass does ≤ 8', () => {
    const runtime = makePlanRuntime();

    // Run 1: the OLD algorithm against its own counter.
    const legacyCounter = countStepsAccesses(makeBushPlan());
    legacyPrioritizedAccesses(legacyCounter.proxy);
    const legacy = legacyCounter.count();

    // Run 2: the NEW implementation against a fresh counter.
    const newCounter = countStepsAccesses(makeBushPlan());
    (runtime as any).getReadyStepsPrioritized(newCounter.proxy);
    const fresh = newCounter.count();

    // Legacy: 2 (ready-step filtering) + 50 root BFS starts + 75
    // dependent pops = 127 plan.steps accesses — and a lower bound at
    // that, because the real sort comparator re-ran the BFS several
    // times per comparison.
    expect(legacy).toBe(127);
    // New: 2 (getReadySteps) + 1 (build reverse adjacency) + 1 (count DFS).
    expect(fresh).toBe(4);
    expect(legacy / fresh).toBeGreaterThanOrEqual(10);
  });

  it('prioritizes by transitive dependent count (ties → id order)', () => {
    const runtime = makePlanRuntime();
    const ready = (runtime as any).getReadyStepsPrioritized(makeBushPlan()) as Array<{
      id: string;
    }>;

    // root-i has (i % 4) dependents → the 3-dependent roots come first,
    // in id order: root-03, root-07, root-11, root-15, …
    expect(ready.slice(0, 4).map((s) => s.id)).toEqual([
      'root-03',
      'root-07',
      'root-11',
      'root-15',
    ]);
    // 12 roots have 3 dependents (i ≡ 3 mod 4), so the 13th is the first
    // 2-dependent root: root-02.
    expect(ready[12].id).toBe('root-02');
    // Every ready step is a root (leaves depend on un-done roots).
    for (const s of ready) {
      expect(s.id.startsWith('root-')).toBe(true);
    }
  });
});

// ─── PERF-02: AgentCache — hash-keyed, O(1) hit check ──────────────

describe('PERF-02: AgentCache (sha256 definition hash)', () => {
  const bigDescription = 'x'.repeat(10_000); // 10 KB definition payload

  const baseDef: AgentDefinition = {
    id: 'perf-agent',
    name: 'Perf Agent',
    personaId: 'boss',
    skillIds: ['a', 'b'],
    modelId: 'gpt-4o',
    description: bigDescription,
  };

  const resolvedStub = {
    agentId: 'perf-agent',
    systemPrompt: 'sys',
    tools: {},
    model: {},
    persona: { id: 'boss', name: 'Boss', system: 's', allowedTools: [] },
    skills: [],
  } as unknown as ResolvedAgent;

  it('get() on a 10 KB definition averages < 1 ms', () => {
    const cache = new AgentCache();
    cache.set('perf-agent', baseDef, resolvedStub);

    // Warm-up (JIT / allocator)
    for (let i = 0; i < 100; i++) {
      expect(cache.get('perf-agent', baseDef)).toBe(resolvedStub);
    }

    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      cache.get('perf-agent', baseDef);
    }
    const avgMs = (performance.now() - t0) / N;

    // The old JSON.stringify(cached.def) !== JSON.stringify(currentDef)
    // comparison serialized 20 KB on every lookup.
    expect(avgMs).toBeLessThan(1);
  });

  it('cache hit is key-order invariant (canonical hashing)', () => {
    const cache = new AgentCache();
    cache.set('perf-agent', baseDef, resolvedStub);

    // Same fields, different declaration order:
    const reordered: AgentDefinition = {
      description: baseDef.description,
      modelId: baseDef.modelId,
      skillIds: [...baseDef.skillIds],
      personaId: baseDef.personaId,
      name: baseDef.name,
      id: baseDef.id,
    };

    // The old JSON.stringify comparison would have MISSED here.
    expect(cache.get('perf-agent', reordered)).toBe(resolvedStub);
    expect(hashAgentDefinition(baseDef)).toBe(hashAgentDefinition(reordered));
    expect(stableStringify({ a: 1, b: { d: 2, c: 3 } })).toBe(
      stableStringify({ b: { c: 3, d: 2 }, a: 1 }),
    );
  });

  it('any real definition change invalidates the entry', () => {
    const cache = new AgentCache();
    cache.set('perf-agent', baseDef, resolvedStub);

    expect(cache.get('perf-agent', { ...baseDef, description: bigDescription + 'y' })).toBeUndefined();
    expect(cache.get('perf-agent', { ...baseDef, name: 'Other' })).toBeUndefined();
    expect(cache.get('perf-agent', { ...baseDef, skillIds: ['a', 'b', 'c'] })).toBeUndefined();
    // Mismatching lookups evict the stale entry.
    expect(cache.size).toBe(0);
  });
});

// ─── PERF-03: TaskRuntime — O(1) counts, O(pending) scheduling ─────

describe('PERF-03: TaskRuntime with 1000 pending tasks', () => {
  afterEach(() => {
    mockGenerateText.mockReset();
  });

  it('scheduleNext scans 997 pending tasks in < 2 ms with accurate O(1) counts', async () => {
    const eventBus = new EventBus();
    // The model "hangs" — running tasks never complete on their own;
    // the 50 ms agent timeout (below) is what releases them.
    mockGenerateText.mockImplementation(() => new Promise(() => {}));

    const tr = new TaskRuntime({
      maxConcurrentTasks: 4,
      eventBus,
      agentTimeoutMs: 50,
    });
    const agent = { agentId: 'worker', systemPrompt: 'w', tools: {}, model: {} } as unknown as ResolvedAgent;

    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(
        tr.createTask({
          agent,
          prompt: `prompt ${i}`,
          claimedResources: i === 0 ? ['r1'] : i === 499 ? ['r2'] : ['shared'],
        }),
      );
    }

    // Task 0 (r1) and task 1 (shared) start first; task 499 (r2) fits the
    // 4th slot. Every remaining task claims 'shared' → conflict with the
    // running shared-task → stays pending.
    expect(tr.getRunningCount()).toBe(3);
    expect(tr.getPendingCount()).toBe(997);

    // The acceptance measurement: one scheduling pass over 997 pending
    // tasks (1 free slot, all blocked by the resource lock).
    const t0 = performance.now();
    (tr as any).scheduleNext();
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(2);
    // Nothing new could start — the pass must not corrupt state.
    expect(tr.getRunningCount()).toBe(3);
    expect(tr.getPendingCount()).toBe(997);

    // Cleanup: cancel everything so the (timed-out) in-flight runs find an
    // empty queue.  After ~50 ms the three hanging runs time out and the
    // runtime goes quiet — no background task chain.
    for (const id of ids) {
      tr.cancelTask(id);
    }
    expect(tr.getPendingCount()).toBe(0);
    tr.destroy();
    await new Promise((r) => setTimeout(r, 80));
  });
});

// ─── PERF-04: ObservabilityLogger — fd-reuse writes ────────────────

describe('PERF-04: ObservabilityLogger (reused fd, sync durability)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes 1000 events in < 100 ms (single write syscall each)', () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase21-obs-'));
    const file = path.join(dir, 'logs', 'obs.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file, consoleOutput: false });

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      logger.log({
        planId: 'p1',
        eventType: 'plan:started',
        message: `event ${i}`,
        level: 'info',
        payload: { i },
      });
    }
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(100);

    // Synchronous durability: everything is readable immediately.
    const entries = logger.readAll();
    expect(entries).toHaveLength(1000);
    expect(entries[0].message).toBe('event 0');
    expect(entries[999].message).toBe('event 999');
    expect(entries[500].payload).toEqual({ i: 500 });

    // close() is idempotent (called at shutdown — may be called twice in
    // a double-shutdown race).
    logger.close();
    expect(() => logger.close()).not.toThrow();
    expect(logger.readAll()).toHaveLength(1000);
  });
});

// ─── PERF-05: search_code — early exit ─────────────────────────────

describe('PERF-05: search_code single-pass early exit', () => {
  let dir: string;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function makeDirent(name: string, isDir: boolean): import('node:fs').Dirent {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    } as import('node:fs').Dirent;
  }

  it('reads files only up to the early-termination point (1 readFile, not 101)', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase21-search-'));
    const root = dir;
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    fsSync.mkdirSync(dirA);
    fsSync.mkdirSync(dirB);
    fsSync.writeFileSync(path.join(dirA, 'hit.ts'), 'foo\nHIT MARKER\nbar\n');
    const bNames = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`);
    for (const n of bNames) {
      fsSync.writeFileSync(path.join(dirB, n), 'nothing here\n');
    }

    // Control the walk order (a before b); a pass-through spy records
    // every real readFile without replacing the implementation.
    const readdirSpy = vi
      .spyOn(fsP, 'readdir')
      .mockImplementation(((p: unknown) => {
        const d = String(p);
        if (d === root) return Promise.resolve([makeDirent('a', true), makeDirent('b', true)]);
        if (d === dirA) return Promise.resolve([makeDirent('hit.ts', false)]);
        if (d === dirB)
          return Promise.resolve(bNames.map((n) => makeDirent(n, false)));
        return Promise.resolve([]);
      }) as never);
    const readFileSpy = vi.spyOn(fsP, 'readFile');
    spies.push(readdirSpy, readFileSpy);

    const tool = createSearchCodeTool(root);
    const out = (await (tool as any).execute(
      { pattern: 'HIT', directory: root, maxResults: 1 },
      {},
    )) as {
      success: boolean;
      matches: Array<{ file: string; line: number; text: string }>;
      truncated: boolean;
    };

    expect(out.success).toBe(true);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].file).toBe(path.join('a', 'hit.ts'));
    expect(out.matches[0].line).toBe(2);
    expect(out.matches[0].text).toBe('HIT MARKER');
    expect(out.truncated).toBe(true);

    // The early exit fired BEFORE directory b was visited:
    //   - exactly ONE file was read (a/hit.ts — the old two-phase walk
    //     would have read all 101 files first)
    //   - directory b was never even listed
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy).toHaveBeenCalledWith(path.join(dirA, 'hit.ts'), 'utf-8');
    const readdirDirs = readdirSpy.mock.calls.map((c) => String(c[0]));
    expect(readdirDirs).toEqual([root, dirA]);
  });

  it('still walks the whole tree when maxResults is not reached', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase21-search-'));
    const root = dir;
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    fsSync.mkdirSync(dirA);
    fsSync.mkdirSync(dirB);
    fsSync.writeFileSync(path.join(dirA, 'x.ts'), 'one\n');
    fsSync.writeFileSync(path.join(dirB, 'y.ts'), 'HIT\n');

    const tool = createSearchCodeTool(root);
    const out = (await (tool as any).execute(
      { pattern: 'HIT', directory: root, maxResults: 10 },
      {},
    )) as { success: boolean; matches: Array<{ file: string }>; truncated: boolean };

    expect(out.success).toBe(true);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].file).toBe(path.join('b', 'y.ts'));
    expect(out.truncated).toBe(false);
  });
});

// ─── PERF-07: ToolRegistry — LRU-cached getToolsByIds ──────────────

describe('PERF-07: ToolRegistry.getToolsByIds LRU cache', () => {
  function makeToolImpl(id: string, marker: string): Tool {
    return {
      id,
      name: id,
      description: `tool ${id}`,
      inputSchema: z.object({ input: z.string().optional() }),
      execute: async () => ({ marker }),
    } as unknown as Tool;
  }

  function makeRegistry(n: number): ToolRegistry {
    const tr = new ToolRegistry();
    for (let i = 0; i < n; i++) {
      tr.registerDefinition({
        id: `t${i}`,
        name: `T${i}`,
        description: `desc ${i}`,
        source: 'local',
        modulePath: `./m${i}`,
      });
      tr.registerImplementation(`t${i}`, makeToolImpl(`t${i}`, `v1-${i}`));
    }
    return tr;
  }

  it('returns the SAME object reference on cache hits', () => {
    const tr = makeRegistry(10);
    const first = tr.getToolsByIds(['t1', 't2']);
    const second = tr.getToolsByIds(['t1', 't2']);
    expect(second).toBe(first);
    expect(second.t1).toBe(tr.getToolsByIds(['t1']).t1); // implementations shared
  });

  it('bounds the cache at 64 combinations (LRU eviction)', () => {
    const tr = makeRegistry(100);
    // 70 distinct single-tool combos + the warm-up one → 71 total.
    tr.getToolsByIds(['t0']);
    for (let i = 1; i <= 70; i++) {
      tr.getToolsByIds([`t${i}`]);
    }
    const size = (tr as any).toolsCache.size;
    expect(size).toBeLessThanOrEqual(64);
    expect(size).toBe(64); // exactly at capacity, nothing else to evict
    // The MRU entry survived; the LRU one was evicted.
    expect(tr.getToolsByIds(['t70'])).toBeDefined();
    expect((tr as any).toolsCache.get('t70')).toBeDefined();
  });

  it('invalidates the cache when an implementation is re-registered', () => {
    const tr = makeRegistry(10);
    const before = tr.getToolsByIds(['t5']);
    const replacement = makeToolImpl('t5', 'v2');
    tr.registerImplementation('t5', replacement);

    const after = tr.getToolsByIds(['t5']);
    expect(after).not.toBe(before); // cache was cleared, not served stale
    expect(after.t5).toBe(replacement);
    // Other entries were rebuilt too — but consistent with the registry.
    expect(tr.getToolsByIds(['t5', 't6']).t5).toBe(replacement);
  });
});
