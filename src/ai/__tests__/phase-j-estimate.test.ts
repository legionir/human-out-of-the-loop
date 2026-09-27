/**
 * J-07 — `hootl run --estimate`: plan only, print steps/tokens/cost, do not execute.
 */
import { describe, it, expect, vi } from 'vitest';
import { estimatePlanCost } from '../runtime/budget.js';
import { runCommand, validateRunOptions } from '../../cli/commands/run.js';
import { createProgram } from '../../cli.js';
import type { Orchestrator } from '../orchestrator.js';

describe('J-07 — --estimate', () => {
  it('is a CLI flag distinct from --dry-run', () => {
    const run = createProgram().commands.find((command) => command.name() === 'run');
    const help = run?.helpInformation() ?? '';
    expect(help).toContain('--estimate');
    expect(help).toContain('--budget');
    expect(validateRunOptions({ estimate: true })).toBeUndefined();
  });

  it('combines planning usage with a per-step heuristic', () => {
    const estimate = estimatePlanCost(2, { promptTokens: 200, completionTokens: 50, totalTokens: 250 });
    expect(estimate.steps).toBe(2);
    expect(estimate.tokens).toBe(250 + 1600);
  });

  it('plans and prints the estimate without calling run()', async () => {
    const estimatePlan = vi.fn().mockResolvedValue({
      ok: true,
      plan: { steps: [{ id: 's1' }, { id: 's2' }] },
      planText: '- s1\n- s2',
      estimate: { steps: 2, tokens: 1850, usd: 0.0123 },
      usage: { totalTokens: 250 },
    });
    const run = vi.fn();
    const orch = {
      estimatePlan,
      run,
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      config: { defaultModelId: 'gpt-4o' },
      modelRegistry: { getConfig: () => undefined },
      sessionStore: { getSession: () => undefined },
    } as unknown as Orchestrator;

    const result = await runCommand('build login', {
      estimate: true,
      yes: true,
      orchestrator: orch,
      skipShutdown: true,
    });
    expect(result.exitCode).toBe(0);
    expect(estimatePlan).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
