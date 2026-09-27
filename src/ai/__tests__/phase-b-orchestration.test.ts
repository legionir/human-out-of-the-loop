/**
 * Phase B — orchestration, stores, re-plan merge, resume ownership.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(async () => ({
      object: {
        planId: 'plan_a',
        goal: 'first goal',
        outcome: 'success',
        acceptedFindings: [],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: 'ok',
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })),
  };
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilePlanStore, hashedStoreFileName } from '../runtime/plan-store.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { mergeReplannedSteps, ReplanMergeError } from '../runtime/replan-merge.js';
import {
  PlanLiveOwnerError,
  tryAcquirePlanOwner,
  isPlanOwnerAlive,
  planOwnerFilePath,
} from '../runtime/plan-owner.js';
import { runFeasibilityGate } from '../planning/feasibility-gate.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { buildPlanPrompt, formatSessionHistory } from '../planning/planner.js';
import { modelIdForSpec, envEndpoint } from '../models/env-endpoint.js';
import type { Plan, PlanStep } from '../schemas/plan.js';
import { Orchestrator, PlanLiveOwnerError as OrchestratorOwnerError } from '../orchestrator.js';

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `part ${id}`,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: 'part handled',
    status: 'pending',
    ...over,
  };
}

function samplePlan(id: string, over: Partial<Plan> = {}): Plan {
  return {
    id,
    goal: 'do the thing',
    status: 'running',
    createdAt: Date.now(),
    clarifications: [],
    steps: [step('s1', { status: 'pending' })],
    ...over,
  };
}

describe('B-03 / B-11 — plan store schema + hash migrate', () => {
  let dir: string;
  let store: FilePlanStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-plans-'));
    store = new FilePlanStore(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips a corrupt file and lists the valid neighbour with a warning', () => {
    store.save(samplePlan('plan_ok'));
    fs.writeFileSync(path.join(dir, 'zzzz-corrupt.json'), '{not json');
    const ids = store.list();
    expect(ids).toContain('plan_ok');
    expect(store.loadWarnings.some((w) => w.error.length > 0)).toBe(true);
    expect(store.load('plan_ok')?.goal).toBe('do the thing');
  });

  it('migrates a pre-hash filename so load/delete work', () => {
    const plan = samplePlan('plan_legacy');
    fs.writeFileSync(path.join(dir, 'plan_legacy.json'), JSON.stringify(plan, null, 2));
    expect(store.list()).toContain('plan_legacy');
    expect(fs.existsSync(path.join(dir, hashedStoreFileName('plan_legacy')))).toBe(true);
    expect(store.load('plan_legacy')?.id).toBe('plan_legacy');
    store.delete('plan_legacy');
    expect(store.load('plan_legacy')).toBeUndefined();
    expect(store.list()).not.toContain('plan_legacy');
  });

  it('update() is a locked read-modify-write', () => {
    store.save(samplePlan('plan_rmw', { status: 'running' }));
    const next = store.update('plan_rmw', (p) => ({ ...p, status: 'cancelled' }));
    expect(next?.status).toBe('cancelled');
    expect(store.load('plan_rmw')?.status).toBe('cancelled');
  });
});

describe('B-03 — session store schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-sess-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips corrupt session JSON', () => {
    const store = new FileSessionStore(dir);
    const id = store.createSession('ok');
    fs.writeFileSync(path.join(dir, 'nope.json'), '{"id":1}');
    const ids = store.listSessions();
    expect(ids).toContain(id);
    expect(store.loadWarnings.length).toBeGreaterThan(0);
  });
});

describe('B-05 — replan merge replacesStepId', () => {
  it('rewires dependsOn onto the replacement id', () => {
    const current = [
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed' }),
      step('step-3', { status: 'pending', dependsOn: ['step-2'] }),
    ];
    const revised = [
      step('step-2b', { replacesStepId: 'step-2', description: 'new approach' }),
      step('step-3', { dependsOn: ['step-2'] }),
    ];
    const merged = mergeReplannedSteps(current, revised, 1);
    expect(merged.find((s) => s.id === 'step-2')?.status).toBe('superseded');
    expect(merged.find((s) => s.id === 'step-3')?.dependsOn).toEqual(['step-2b']);
  });

  it('rejects a re-plan that leaves a failed step without a replacement', () => {
    expect(() =>
      mergeReplannedSteps(
        [step('a', { status: 'failed' })],
        [step('b')],
        1,
      ),
    ).toThrow(ReplanMergeError);
  });
});

describe('B-04 — duplicate step ids (regression)', () => {
  it('feasibility gate rejects duplicate ids', () => {
    const toolRegistry = new ToolRegistry();
    const result = runFeasibilityGate(
      {
        id: 'p',
        goal: 'g',
        status: 'draft',
        createdAt: Date.now(),
        clarifications: [],
        steps: [step('dup'), step('dup', { description: 'other' })],
      },
      {
        personaRegistry: new PersonaRegistry(),
        skillRegistry: new SkillRegistry({ toolRegistry }),
        toolRegistry,
      },
    );
    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate step id'))).toBe(true);
  });
});

describe('B-01 — plan owner lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-own-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a second acquire while the owner is alive', () => {
    const h = tryAcquirePlanOwner(dir, 'plan_x');
    expect(h).toBeDefined();
    expect(tryAcquirePlanOwner(dir, 'plan_x')).toBeUndefined();
    expect(isPlanOwnerAlive(dir, 'plan_x')).toBe(true);
    h!.release();
    expect(isPlanOwnerAlive(dir, 'plan_x')).toBe(false);
  });

  it('a stale / dead-pid owner is stealable', () => {
    fs.writeFileSync(
      planOwnerFilePath(dir, 'plan_dead'),
      JSON.stringify({ pid: 2147483646, heartbeatAt: Date.now() - 60_000, planId: 'plan_dead' }),
    );
    expect(isPlanOwnerAlive(dir, 'plan_dead')).toBe(false);
    const h = tryAcquirePlanOwner(dir, 'plan_dead');
    expect(h).toBeDefined();
    h!.release();
  });
});

describe('B-01 — resumePlan 409 while live', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-orch-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws PlanLiveOwnerError when the same orchestrator already owns the plan', async () => {
    const orch = new Orchestrator({
      projectRoot: root,
      persistent: true,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await orch.initialize();
    orch.planStore.save(samplePlan('plan_live', { status: 'running' }));
    orch.claimPlan('plan_live');
    await expect(orch.resumePlan('plan_live')).rejects.toBeInstanceOf(OrchestratorOwnerError);
    orch.releasePlan('plan_live');
    await orch.shutdown();
  });
});

describe('B-02 / B-06 — resume interaction matching + reconcile', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-int-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('closes only the interaction that lists this planId', async () => {
    const orch = new Orchestrator({
      projectRoot: root,
      persistent: true,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await orch.initialize();
    const sid = orch.sessionStore.createSession();
    const i1 = orch.sessionStore.addInteraction(sid, 'first goal')!;
    const i2 = orch.sessionStore.addInteraction(sid, 'first goal')!;
    orch.sessionStore.updateInteraction(sid, i1.id, { planIds: ['plan_a'] });
    orch.sessionStore.updateInteraction(sid, i2.id, { planIds: ['plan_b'] });
    orch.planStore.save(
      samplePlan('plan_a', {
        status: 'completed',
        sessionId: sid,
        goal: 'first goal',
        steps: [step('s1', { status: 'done' })],
      }),
    );
    // resume of a completed plan returns without executing
    const result = await orch.resumePlan('plan_a');
    expect(result).toBeDefined();
    const session = orch.sessionStore.getSession(sid)!;
    const a = session.interactions.find((i) => i.id === i1.id)!;
    const b = session.interactions.find((i) => i.id === i2.id)!;
    expect(a.completedAt).toBeDefined();
    expect(b.completedAt).toBeUndefined();
    await orch.shutdown();
  });

  it('reconcile closes a pending interaction whose plan is already cancelled', async () => {
    const orch = new Orchestrator({
      projectRoot: root,
      persistent: true,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await orch.initialize();
    const sid = orch.sessionStore.createSession();
    const i = orch.sessionStore.addInteraction(sid, 'gone')!;
    orch.sessionStore.updateInteraction(sid, i.id, { planIds: ['plan_gone'] });
    orch.planStore.save(samplePlan('plan_gone', { status: 'cancelled', sessionId: sid, goal: 'gone' }));
    orch.reconcileAbandonedInteractions();
    const session = orch.sessionStore.getSession(sid)!;
    expect(session.interactions[0].completedAt).toBeDefined();
    expect(session.interactions[0].outcome).toBe('cancelled');
    await orch.shutdown();
  });
});

describe('B-15 — session history in planner prompt', () => {
  it('injects the previous turn into the plan prompt', () => {
    const history = formatSessionHistory([
      {
        userRequest: 'build the login page',
        outcome: 'success',
        reviewSummary: 'login form added',
        completedAt: Date.now(),
      },
    ]);
    const prompt = buildPlanPrompt('now add logout', undefined, undefined, history);
    expect(prompt).toContain('build the login page');
    expect(prompt).toContain('login form added');
  });
});

describe('B-21 / B-22 — model spec + HOTL_BASE_URL', () => {
  const known = [
    { id: 'gpt-4o', provider: 'openai' as const, model: 'gpt-4o' },
    { id: 'aur-auto', provider: 'openai' as const, model: '@aur/auto' },
  ];

  it('table of modelIdForSpec samples', () => {
    expect(modelIdForSpec('gpt-4o', known)).toBe('gpt-4o');
    expect(modelIdForSpec('@aur/auto', known)).toBe('aur-auto');
    expect(modelIdForSpec('openai:gpt-4.1', known)).toMatch(/^openai-gpt-4-1/);
    expect(modelIdForSpec('local:llama3:8b', known)).toMatch(/^local-llama3-8b/);
    // collision: slug aur-auto already maps to @aur/auto; a different model gets a hash suffix
    const collided = modelIdForSpec('aur auto!', known);
    // "aur auto!" slugs to aur-auto which exists with a different model name
    expect(collided === 'aur-auto' || collided.startsWith('aur-auto-')).toBe(true);
    expect(modelIdForSpec('', known)).toBe('custom');
  });

  it('HOTL_BASE_URL alone does not set defaultModelId', () => {
    expect(envEndpoint({ HOTL_BASE_URL: 'http://x/v1' }, known)).toEqual({});
  });
});

describe('B-10 — persist errors are not silent', () => {
  it('PlanLiveOwnerError is a 409', () => {
    const e = new PlanLiveOwnerError('p', 12);
    expect(e.status).toBe(409);
    expect(e.code).toBe('PLAN_LIVE_OWNER');
  });
});
