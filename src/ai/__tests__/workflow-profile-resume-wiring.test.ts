/**
 * Phase 10 (U-2): durable run state is wired by default, and the operator surface reads it back.
 *
 * Before this, the store existed and was tested but no entry point created one: an interrupted CLI
 * run left no profile record, so nothing could be listed or resumed. These tests pin the wiring at
 * the two boundaries that matter:
 *
 *  - the Orchestrator defaults a file-backed store under `<runtimeDir>/workflow-profile-runs` and
 *    gives each run its own id (a second run of the same profile is a new run, not a "resume" of the
 *    first), while `stateStore: null` keeps a host's run in memory;
 *  - the listing/resume helpers report what a human needs and refuse a missing or finished run with
 *    the same diagnostic codes the runner uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateObject, generateText } from 'ai';
import { Orchestrator } from '../orchestrator.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR, prepareWorkflowProfileRun } from '../workflow-profiles/profile-runner.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import {
  WORKFLOW_PROFILE_RUNS_DIRNAME,
  isTerminalWorkflowProfileRun,
  listWorkflowProfileRuns,
  loadResumableWorkflowProfileRun,
  openWorkflowProfileRunStore,
  workflowProfileRunsDir,
} from '../workflow-profiles/profile-resume.js';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { loadProfileRegistries } from '../../cli/commands/profiles.js';
import { createWorkflowProfileComponentSources } from '../workflow-profiles/profile-sources.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const GOAL = 'Build a login page';
const PROFILE_ENV = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' };
const confirmAccepting = async () => ({ confirmed: true });

const planOf = () => ({
  goal: GOAL,
  steps: [{
    id: 'step-1', description: 'Create the login form component', dependsOn: [],
    assignedPersona: 'coder', assignedSkills: [], assignedTools: ['read_file'],
    claimedResources: [], acceptanceCriteria: 'Login form exists', status: 'pending',
  }],
});

function installScript(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const name = (opts as { schemaName?: string }).schemaName;
    if (name === 'PlannerAssessment') return { object: { isClear: true, needsClarification: [], plan: planOf() } } as never;
    if (name === 'ExecutionPlan') return { object: planOf() } as never;
    if (name === 'AcceptanceJudgment') return { object: { accepted: true, reason: 'fine' } } as never;
    if (name === 'FinalReview') {
      return { object: { planId: 'plan_x', goal: GOAL, outcome: 'success', acceptedFindings: [], rejectedFindings: [], incompleteSteps: [], finalSummary: 'reviewed: success', usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 } } } as never;
    }
    throw new Error(`unexpected schema ${String(name)}`);
  });
  mockGenerateText.mockResolvedValue({ text: 'step done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] } as never);
}

const port = () => ({ type: 'string', required: false });
const objectPort = (required = false) => ({ type: 'object', required });

/** intake → planner → end: the smallest profile that can run, so the run itself stays cheap. */
function answerProfile(): WorkflowProfileDocument {
  const { personaRegistry } = loadProfileRegistries(REPO_ROOT);
  const planner = personaRegistry.get('planner') as unknown as Record<string, unknown>;
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'phase10.wiring', name: 'Phase 10 wiring fixture', version: '1.0.0', author: 'tests' },
    dependencies: [
      { kind: 'persona', id: 'planner', digest: dependencyDigest('persona', 'planner', componentProjection(planner)) },
    ],
    workflow: {
      startNode: 'request',
      nodes: [
        { id: 'request', kind: 'intake', goal: 'carry the request', inputs: { request: objectPort() }, outputs: { request: objectPort() }, config: {} },
        {
          id: 'plan', kind: 'planner', goal: 'plan',
          inputs: { request: objectPort() },
          outputs: { kind: { type: 'string', required: true, enum: ['plan', 'answer', 'clarify'] }, plan: objectPort(), planText: port(), planDigest: port(), answer: port() },
          bindings: { personaRef: 'planner' }, config: { mode: 'decompose', maxPlanItems: 20 },
        },
        { id: 'done', kind: 'end', goal: 'finish', inputs: { response: { type: 'string', required: false } }, outputs: { response: port() }, config: { outcome: 'success', emit: { response: 'response' } } },
        { id: 'failed', kind: 'end', goal: 'fail', inputs: { response: { type: 'string', required: true } }, outputs: { response: port() }, config: { outcome: 'rejected', emit: { response: 'response' } } },
      ],
      edges: [
        { from: 'request', to: 'plan', map: { request: '/request' } },
        { from: 'plan', to: 'done', when: { path: '/kind', operator: 'equals', value: 'plan' }, map: { response: '/planText' } },
        { from: 'plan', to: 'failed', default: true, map: { response: '/kind' } },
      ],
    },
    policies: {
      execution: { maxNodeVisits: 20, maxDurationSeconds: 600, maxModelCalls: 10, maxToolCalls: 10, onLimit: 'fail' },
      tools: { allowedToolsets: [], deniedTools: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [
      { fromNode: 'done', port: 'response', kind: 'response', outcome: 'success' },
      { fromNode: 'failed', port: 'response', kind: 'response', outcome: 'rejected' },
    ],
  } as unknown as WorkflowProfileDocument;
}

describe('Phase 10 — durable run state is wired, and the operator surface reads it', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-wiring-'));
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const orchestratorFor = (document: WorkflowProfileDocument, extra: Record<string, unknown> = {}) => new Orchestrator({
    projectRoot: REPO_ROOT,
    runtimeDir,
    persistent: true,
    env: { OPENAI_API_KEY: 'sk-test-dummy' },
    workflowProfile: { env: PROFILE_ENV, selection: { document }, ...extra },
  });

  it('records a run under the runtime directory without being asked, and lists it', async () => {
    installScript();
    const result = await orchestratorFor(answerProfile()).run(GOAL, { confirmCallback: confirmAccepting });
    expect(result.review.outcome).toBe('success');

    const summaries = listWorkflowProfileRuns(openWorkflowProfileRunStore(runtimeDir));
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary!.profileId).toBe('phase10.wiring');
    expect(summary!.status).toBe('success');
    expect(summary!.nodeSequence).toContain('plan');
    expect(summary!.resumable).toBe(false);
    // The record lives in the documented place, not somewhere only the Orchestrator knows.
    expect(fs.existsSync(workflowProfileRunsDir(runtimeDir))).toBe(true);
    expect(fs.readdirSync(workflowProfileRunsDir(runtimeDir)).every((name) => name.endsWith('.json'))).toBe(true);
  });

  it('gives each run its own id, so a second run is a new run and not a "resume"', async () => {
    installScript();
    await orchestratorFor(answerProfile()).run(GOAL, { confirmCallback: confirmAccepting });
    installScript();
    await orchestratorFor(answerProfile()).run(GOAL, { confirmCallback: confirmAccepting });

    const summaries = listWorkflowProfileRuns(openWorkflowProfileRunStore(runtimeDir));
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((summary) => summary.runId)).size).toBe(2);
    // Both finished, so neither is offered for resume.
    expect(summaries.every((summary) => !summary.resumable)).toBe(true);
  });

  it('keeps a run in memory when the caller opts out with stateStore: null', async () => {
    installScript();
    await orchestratorFor(answerProfile(), { stateStore: null }).run(GOAL, { confirmCallback: confirmAccepting });
    // The opt-out is about the run's own state: nothing was created for it. (An earlier `runs`
    // listing would create the directory when it opens its store, so the check comes first.)
    expect(fs.existsSync(workflowProfileRunsDir(runtimeDir))).toBe(false);
    expect(listWorkflowProfileRuns(openWorkflowProfileRunStore(runtimeDir))).toEqual([]);
  });

  it('lists an interrupted run as resumable and refuses to resume a finished one', () => {
    const store = openWorkflowProfileRunStore(runtimeDir);
    const document = answerProfile();
    const { personaRegistry, skillRegistry, modelRegistry, toolRegistry, toolsetRegistry } = loadProfileRegistries(REPO_ROOT);
    prepareWorkflowProfileRun({
      document: document as unknown as Record<string, unknown>,
      sources: createWorkflowProfileComponentSources({
        registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry, toolsets: toolsetRegistry },
        toolCatalog: { hasDefinition: (id) => toolRegistry.getDefinition(id) !== undefined },
      }),
      env: PROFILE_ENV,
      runId: 'run-interrupted',
      stateStore: store,
    });

    const summaries = listWorkflowProfileRuns(store);
    expect(summaries.map((summary) => [summary.runId, summary.status, summary.resumable]))
      .toEqual([['run-interrupted', 'interrupted', true]]);

    // Reading it back is what `hootl run --resume <id>` does first.
    const state = loadResumableWorkflowProfileRun(store, 'run-interrupted');
    expect(state.currentNodeId).toBe('request');

    // A finished run and an unknown id are refused with the runner's own codes.
    const finished = { ...state, status: 'success' as const, updatedAtMs: Date.now() };
    store.save(finished);
    expect(() => loadResumableWorkflowProfileRun(store, 'run-interrupted'))
      .toThrowError(/already finished/);
    try {
      loadResumableWorkflowProfileRun(store, 'nope');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics.map((diagnostic) => diagnostic.code))
        .toEqual(['resume.profile-missing']);
    }
    // Terminal classification the CLI's "resumable" column relies on.
    expect(isTerminalWorkflowProfileRun('interrupted')).toBe(false);
    expect(isTerminalWorkflowProfileRun('success')).toBe(true);
    expect(WORKFLOW_PROFILE_RUNS_DIRNAME).toBe('workflow-profile-runs');
  });
});
