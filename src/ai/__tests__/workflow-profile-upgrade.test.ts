/**
 * Phase 10 Step 1 — upgrade/resume safety for a profile run that was interrupted.
 *
 * A profile run is prepared and executed inside one `run()` call, and the run record is persisted
 * before the first node and after the attempt ends; there is no per-node checkpoint. So a killed
 * process leaves exactly the record this suite writes by hand: `currentNodeId` at the run's start
 * node, status `interrupted`, no approvals consumed. (The CLI/server do not wire a resume surface
 * yet — `PHASE10_OPERATIONS.md` §7 — but the guard itself is implemented and must hold wherever an
 * embedder passes a state store.)
 *
 * What this suite proves about the approval digest at resume:
 *  - a stored approval is a *record*, never authority: the resumed run runs the approval node again
 *    and asks the user again;
 *  - a user who declines on the resumed attempt stops the run — nothing executes, so an approval
 *    recorded before the interruption can never authorize the work after it;
 *  - a user who accepts resumes the same run id and executes, i.e. the guard is safe *and* usable.
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
import { FileWorkflowProfileRunStateStore } from '../workflow-profiles/profile-run-state.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR, prepareWorkflowProfileRun } from '../workflow-profiles/profile-runner.js';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { createBuiltInRubricCatalogue } from '../workflow-profiles/profile-resolver.js';
import { createWorkflowProfileComponentSources } from '../workflow-profiles/profile-sources.js';
import { loadProfileRegistries } from '../../cli/commands/profiles.js';
import { packageVersion } from '../registries/layout.js';
import type { WorkflowProfileDocument } from '../workflow-profiles/profile-types.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const GOAL = 'Build a login page';
const PROFILE_ENV = { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' };

const planOf = (goal = GOAL) => ({
  goal,
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

/** intake → planner → digest-bound approval → execute → end (the Phase 9 fixture, at v1). */
function profileWithApproval(): WorkflowProfileDocument {
  const { personaRegistry } = loadProfileRegistries(REPO_ROOT);
  const pin = (id: string): string => {
    const record = personaRegistry.get(id) as unknown as Record<string, unknown> | undefined;
    if (!record) throw new Error(`the repository registry must ship the ${id} persona`);
    return dependencyDigest('persona', id, componentProjection(record));
  };
  const rubric = createBuiltInRubricCatalogue().get('hootl.default-review') as unknown as Record<string, unknown>;
  return {
    schemaVersion: '1.0.0',
    profile: { id: 'phase10.resume', name: 'Phase 10 resume fixture', version: '1.0.0', author: 'tests' },
    dependencies: [
      { kind: 'persona', id: 'planner', digest: pin('planner') },
      { kind: 'persona', id: 'reviewer', digest: pin('reviewer') },
      { kind: 'rubric', id: 'hootl.default-review', digest: dependencyDigest('rubric', 'hootl.default-review', componentProjection(rubric)) },
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
        {
          id: 'confirm', kind: 'approval', goal: 'confirm the plan',
          inputs: { plan: objectPort(), planText: port(), planDigest: port() },
          outputs: { plan: objectPort(true), planText: { type: 'string', required: true }, planDigest: { type: 'string', required: true }, decision: objectPort(true) },
          config: { prompt: 'Review the plan', approvalType: 'side-effect', responseKind: 'decision', bindsTo: 'planText', show: ['planText'], timeoutSeconds: 60 },
        },
        {
          id: 'execute', kind: 'execute', goal: 'execute the plan',
          inputs: { plan: objectPort(), planDigest: port() },
          outputs: { status: { type: 'string', required: true }, summary: { type: 'string', required: true } },
          bindings: { personaSource: 'plan-step' },
          config: { mode: 'assisted', requireApprovalForSideEffects: true },
        },
        {
          id: 'review', kind: 'review', goal: 'judge the result',
          inputs: { summary: port(), status: port() },
          outputs: { decision: { type: 'string', required: true, enum: ['pass', 'revise', 'reject'] }, reason: { type: 'string', required: true } },
          bindings: { personaRef: 'reviewer' }, config: { rubricRef: 'hootl.default-review', allowedDecisions: ['pass', 'revise', 'reject'] },
        },
        { id: 'finish', kind: 'end', goal: 'finish', inputs: { summary: { type: 'string', required: true } }, outputs: { response: { type: 'string', required: true } }, config: { outcome: 'success', emit: { response: 'summary' } } },
        { id: 'rejected', kind: 'end', goal: 'reject', inputs: { summary: { type: 'string', required: true } }, outputs: { response: { type: 'string', required: true } }, config: { outcome: 'rejected', emit: { response: 'summary' } } },
      ],
      edges: [
        { from: 'request', to: 'plan', map: { request: '/request' } },
        { from: 'plan', to: 'confirm', when: { path: '/kind', operator: 'equals', value: 'plan' }, map: { plan: '/plan', planText: '/planText', planDigest: '/planDigest' } },
        { from: 'plan', to: 'rejected', default: true, map: { summary: '/kind' } },
        { from: 'confirm', to: 'execute', default: true, map: { plan: '/plan', planDigest: '/planDigest' } },
        { from: 'execute', to: 'review', map: { summary: '/summary', status: '/status' } },
        { from: 'review', to: 'finish', when: { path: '/decision', operator: 'equals', value: 'pass' }, map: { summary: '/reason' } },
        { from: 'review', to: 'rejected', default: true, map: { summary: '/reason' } },
      ],
    },
    policies: {
      execution: { maxNodeVisits: 40, maxDurationSeconds: 600, maxModelCalls: 500, maxToolCalls: 500, onLimit: 'fail' },
      tools: { allowedToolsets: [], deniedTools: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [
      { fromNode: 'finish', port: 'response', kind: 'response', outcome: 'success' },
      { fromNode: 'rejected', port: 'response', kind: 'response', outcome: 'rejected' },
    ],
  } as unknown as WorkflowProfileDocument;
}

/** The sources the Orchestrator builds for itself, so a hand-written state record matches its pins. */
function profileSources() {
  const { personaRegistry, skillRegistry, modelRegistry, toolRegistry, toolsetRegistry } = loadProfileRegistries(REPO_ROOT);
  return createWorkflowProfileComponentSources({
    registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry, toolsets: toolsetRegistry },
    toolCatalog: { hasDefinition: (id: string) => toolRegistry.getDefinition(id) !== undefined },
  });
}

describe('Phase 10 — an interrupted profile run, resumed', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-resume-'));
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const orchestratorFor = (
    document: WorkflowProfileDocument,
    runId: string,
    stateStore: FileWorkflowProfileRunStateStore,
  ) => new Orchestrator({
    projectRoot: REPO_ROOT,
    runtimeDir,
    persistent: true,
    env: { OPENAI_API_KEY: 'sk-test-dummy' },
    workflowProfile: { env: PROFILE_ENV, selection: { document }, runId, stateStore },
  });

  /** Exactly what a killed process leaves behind: the record written before the first node. */
  const interruptedRun = (document: WorkflowProfileDocument, runId: string, stateStore: FileWorkflowProfileRunStateStore) => {
    prepareWorkflowProfileRun({
      document: document as unknown as Record<string, unknown>,
      sources: profileSources(),
      env: PROFILE_ENV,
      runId,
      // What a real run records now (U-1): the Orchestrator defaults the runtime version to the
      // package version, and a resume must match it.
      runtimeVersion: packageVersion() ?? 'unversioned',
      stateStore,
    });
    const stored = stateStore.load(runId);
    if (!stored) throw new Error('the runner must persist the run before its first node');
    return stored;
  };

  it('asks for the confirmation again and never reuses a stored approval', async () => {
    installScript();
    const stateStore = new FileWorkflowProfileRunStateStore(path.join(runtimeDir, 'workflow-profile-runs'));
    const runId = 'run-interrupted-declined';
    const document = profileWithApproval();
    const stored = interruptedRun(document, runId, stateStore);

    expect(stored.status).toBe('interrupted');
    expect(stored.currentNodeId).toBe('request');
    expect(stored.approvals).toEqual([]);

    let asked = 0;
    const result = await orchestratorFor(document, runId, stateStore).run(GOAL, {
      confirmCallback: async () => { asked += 1; return { confirmed: false }; },
    });

    // The approval node ran again on the resumed attempt (a stored approval is not authority)…
    expect(asked).toBe(1);
    // …and the decline stopped the run before any effect.
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result.review.outcome).toBe('failure');
    // The denial is recorded for audit together with the digest it was about — a record of what
    // the user rejected, which no later attempt reads as a licence to run anything.
    expect(stateStore.load(runId)?.approvals.map(({ nodeId, status, digest }) => ({ nodeId, status, digest: Boolean(digest) })))
      .toEqual([{ nodeId: 'confirm', status: 'denied', digest: true }]);
  });

  it('resumes the same run and executes when the user confirms on the resumed attempt', async () => {
    installScript();
    const stateStore = new FileWorkflowProfileRunStateStore(path.join(runtimeDir, 'workflow-profile-runs'));
    const runId = 'run-interrupted-accepted';
    const document = profileWithApproval();
    interruptedRun(document, runId, stateStore);

    let asked = 0;
    const result = await orchestratorFor(document, runId, stateStore).run(GOAL, {
      confirmCallback: async () => { asked += 1; return { confirmed: true }; },
    });

    expect(asked).toBe(1);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(result.review.outcome).toBe('success');
    // The resumed attempt kept writing to the same run record, which is now terminal.
    const stored = stateStore.load(runId);
    expect(stored?.status).toBe('success');
    expect(stored?.currentNodeId).toBe('finish');
    // The approval is recorded with the digest it bound — and was still re-asked on resume.
    expect(stored?.approvals.map(({ nodeId, status, digest, boundPort }) => ({ nodeId, status, boundPort, digest: Boolean(digest) })))
      .toEqual([{ nodeId: 'confirm', status: 'approved', boundPort: 'planText', digest: true }]);
  });

  it('refuses to resume a run whose profile content changed, before asking for anything', async () => {
    installScript();
    const stateStore = new FileWorkflowProfileRunStateStore(path.join(runtimeDir, 'workflow-profile-runs'));
    const runId = 'run-interrupted-repinned';
    const document = profileWithApproval();
    interruptedRun(document, runId, stateStore);

    // A version bump with identical content, i.e. the run was started from different bytes.
    const changed = JSON.parse(JSON.stringify(document)) as WorkflowProfileDocument;
    changed.profile = { ...changed.profile, version: '2.0.0' };

    let asked = 0;
    const run = orchestratorFor(changed, runId, stateStore).run(GOAL, {
      confirmCallback: async () => { asked += 1; return { confirmed: true }; },
    });

    await expect(run).rejects.toThrow(/cannot resume.*resume\.profile-changed/s);
    expect(asked).toBe(0);
    expect(mockGenerateText).not.toHaveBeenCalled();
    // The interrupted record is untouched: a refused resume changes no state.
    expect(stateStore.load(runId)?.status).toBe('interrupted');
  });
});
