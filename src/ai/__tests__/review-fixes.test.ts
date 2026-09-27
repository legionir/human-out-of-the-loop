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
