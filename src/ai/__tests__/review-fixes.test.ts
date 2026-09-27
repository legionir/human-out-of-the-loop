/**
 * Regressions for the defects found in the code review of phases A–K
 * (UNIFIED_EXECUTION_PLAN §3, "R-" rows).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { finalizePlan } from '../planning/planner.js';

function planResult(goal: string) {
  return {
    kind: 'plan' as const,
    isClear: true,
    needsClarification: [],
    errors: [],
    plan: finalizePlan({
      goal,
      steps: [
        {
          id: 'step-1',
          description: 'look around',
          dependsOn: [],
          assignedPersona: 'architect',
          assignedSkills: [],
          assignedTools: [],
          claimedResources: [],
          acceptanceCriteria: 'done',
        },
      ],
      clarifications: [],
    }),
  };
}

describe('R-09 — a cancelled confirmation never re-plans', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: false });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('Ctrl-C at the prompt (cancelled + feedback text) ends the run without a planner call', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    const spy = vi.spyOn(planner, 'plan').mockResolvedValue(planResult('goal') as never);
    const result = await orch.run('goal', {
      confirmCallback: async () => ({
        confirmed: false,
        cancelled: true,
        feedback: 'User cancelled the confirmation prompt.',
      }),
    });
    expect(result.review.outcome).toBe('cancelled');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('real feedback text still re-plans', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    const spy = vi.spyOn(planner, 'plan').mockResolvedValue(planResult('goal') as never);
    let calls = 0;
    await orch.run('goal', {
      confirmCallback: async () => {
        calls += 1;
        return calls === 1 ? { confirmed: false, feedback: 'use two steps' } : { confirmed: false, cancelled: true };
      },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('R-10 — session history is per run, not shared planner state', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: false });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('two concurrent runs in different sessions each see only their own history', async () => {
    const store = orch.sessionStore;
    const sA = store.createSession();
    const sB = store.createSession();
    for (const [sid, text] of [
      [sA, 'secret alpha project'],
      [sB, 'bravo work'],
    ] as const) {
      const i = store.addInteraction(sid, text)!;
      store.updateInteraction(sid, i.id, { outcome: 'success', completedAt: Date.now() });
    }
    const planner = (orch as unknown as {
      planner: { plan: (...a: unknown[]) => unknown; sessionHistory: () => string | undefined };
    }).planner;
    const seen: Record<string, string | undefined> = {};
    vi.spyOn(planner, 'plan').mockImplementation((async (request: string) => {
      await new Promise((r) => setTimeout(r, request === 'A' ? 30 : 0));
      seen[request] = planner.sessionHistory();
      return planResult(request);
    }) as never);
    const cancel = async () => ({ confirmed: false, cancelled: true });
    await Promise.all([
      orch.run('A', { sessionId: sA, confirmCallback: cancel }),
      orch.run('B', { sessionId: sB, confirmCallback: cancel }),
    ]);
    expect(seen.A).toContain('secret alpha project');
    expect(seen.A).not.toContain('bravo work');
    expect(seen.B).toContain('bravo work');
    expect(seen.B).not.toContain('secret alpha project');
  });
});

describe('R-11 — reconcile never closes a live interaction', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: true });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a run waiting at its confirmation keeps its draft plan and open interaction', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    vi.spyOn(planner, 'plan').mockResolvedValue(planResult('waiting goal') as never);
    let release!: (v: { confirmed: boolean; cancelled?: boolean }) => void;
    let reachedPrompt!: () => void;
    const atPrompt = new Promise<void>((r) => (reachedPrompt = r));
    const running = orch.run('waiting goal', {
      confirmCallback: () =>
        new Promise((resolve) => {
          release = resolve;
          reachedPrompt();
        }),
    });
    await atPrompt;
    orch.reconcileAbandonedInteractions();
    const sid = orch.sessionStore.listSessions()[0]!;
    const interaction = orch.sessionStore.getSession(sid)!.interactions[0]!;
    expect(interaction.completedAt).toBeUndefined();
    const planId = interaction.planIds[0]!;
    expect(orch.planStore.load(planId)?.status).toBe('draft');
    release({ confirmed: false, cancelled: true });
    await running;
  });

  it('an interaction owned by another live process is left alone', () => {
    const sid = orch.sessionStore.createSession();
    orch.sessionStore.addInteraction(sid, 'elsewhere');
    // process.ppid is alive and is not this process.
    const session = orch.sessionStore.getSession(sid)!;
    session.interactions[0]!.ownerPid = process.ppid;
    orch.sessionStore.saveSession(session);
    orch.reconcileAbandonedInteractions();
    expect(orch.sessionStore.getSession(sid)!.interactions[0]!.completedAt).toBeUndefined();
  });
});
