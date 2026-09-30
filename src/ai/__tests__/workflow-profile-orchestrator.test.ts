import { describe, expect, it, vi } from 'vitest';

// The answer branch delegates to the existing chat agent (`answerRun`), so its model call is
// stubbed here — the parity of that delegation is asserted in the Phase 7 parity suite.
vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: 'It is 42.',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [],
    })),
    generateObject: vi.fn(),
  };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../orchestrator.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR } from '../workflow-profiles/profile-runner.js';
import type { OrchestratorWorkflowProfileOptions } from '../orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** A project root that carries the repository's registry (personas/rubrics must resolve). */
const PROJECT_ROOT = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-profile-'));
  fs.cpSync(path.join(REPO_ROOT, 'registry'), path.join(dir, 'registry'), { recursive: true });
  return dir;
})();

const FLAG_ON = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' } as const;
/** The legacy run options require a confirm callback; these runs never confirm a plan. */
const CONFIRM = async (): Promise<{ confirmed: boolean }> => ({ confirmed: true });

function orchestrator(workflowProfile: OrchestratorWorkflowProfileOptions): Orchestrator {
  return new Orchestrator({
    projectRoot: PROJECT_ROOT,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-profile-rt-')),
    env: { OPENAI_API_KEY: 'sk-test-dummy' },
    workflowProfile,
  });
}

describe('orchestrator workflow-profile path', () => {
  it('never resolves a profile while the flag is off', async () => {
    // The selected document is intentionally invalid: with the flag off the legacy path runs
    // and the profile is never validated. The run fails on the legacy session check instead.
    const orch = orchestrator({ env: {}, selection: { document: { schemaVersion: '9.0.0' } } });
    const error = await orch.run('do something', { sessionId: 'missing-session', confirmCallback: CONFIRM }).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(WorkflowProfileLoadError);
    expect((error as Error).message).toContain('missing-session');
  });

  it('fails closed before any session side effect when the flag is on and nothing is selected', async () => {
    const orch = orchestrator({ env: FLAG_ON });
    const error = await orch.run('do something', { confirmCallback: CONFIRM }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkflowProfileLoadError);
    expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('profile-activation.not-selected');
    expect(orch.sessionStore.listSessions()).toHaveLength(0);
  });

  it('refuses the built-in default until its activation approval is recorded', async () => {
    const orch = orchestrator({ env: FLAG_ON, allowBuiltInDefault: true });
    const error = await orch.run('do something', { confirmCallback: CONFIRM }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkflowProfileLoadError);
    expect((error as WorkflowProfileLoadError).diagnostics[0]).toMatchObject({
      code: 'profile-activation.not-approved',
      profileId: 'hootl.default',
    });
    expect(orch.sessionStore.listSessions()).toHaveLength(0);
  });

  it('runs the approved built-in default end to end through the existing lifecycle', async () => {
    const planner = { plan: vi.fn(async () => ({ kind: 'answer' as const, answer: 'It is 42.' })) };
    const orch = orchestrator({
      env: FLAG_ON,
      allowBuiltInDefault: true,
      builtInDefaultApproval: { approved: true, reference: 'test approval' },
      ports: { planner },
    });
    const result = await orch.run('what is the answer?', { confirmCallback: CONFIRM });
    expect(result.kind).toBe('answer');
    expect(result.report).toContain('It is 42.');
    expect(result.planId).toBe('none');
    expect(result.review.outcome).toBe('success');
    // The entry point still owns sessions/interactions, exactly like the legacy path.
    const sessions = orch.sessionStore.listSessions();
    expect(sessions).toHaveLength(1);
    const interactions = orch.sessionStore.getSession(sessions[0]!)?.interactions ?? [];
    expect(interactions[0]).toMatchObject({ outcome: 'success' });
    expect(planner.plan).toHaveBeenCalledTimes(1);
  });
});
