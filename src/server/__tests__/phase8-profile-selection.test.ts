/**
 * Phase 8 Step 2 (server half): per-request Workflow Profile selection.
 *
 *   POST /api/run { message, profile }  → 202 { runId, profileId } | 400 { error, diagnostics }
 *
 * The request field is the only API change (the plan forbids inventing routes from a guess), and it
 * is resolved exactly like the CLI: discovery on the documented scopes, the D-WP-003 precedence, and
 * the flag turned on for that run only. These tests prove:
 *
 *   - selection changes the path for ONE request and leaves the other requests on the legacy path,
 *     including when both run concurrently against the same (shared) Orchestrator;
 *   - every failure is a clean 400 with diagnostics, before a run/session/plan exists;
 *   - the trust opt-in and the operator directory behave exactly like the CLI;
 *   - `profileFile` is refused: over HTTP a client-supplied host path would be a new file-reading
 *     primitive, so selecting by file stays a CLI/operator action.
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
import request from 'supertest';
import type { Express } from 'express';
import { generateObject, generateText } from 'ai';
import { useIsolatedHome } from '../../test-utils/isolated-home.js';
import { createApp } from '../../server.js';
import { componentProjection, dependencyDigest } from '../../ai/workflow-profiles/profile-digest.js';
import { loadProfileRegistries } from '../../cli/commands/profiles.js';
import type { WorkflowProfileDocument } from '../../ai/workflow-profiles/profile-types.js';

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');
const GOAL = 'Build a login page';

const PLAN = {
  id: 'plan_a_mock',
  goal: GOAL,
  steps: [{
    id: 'step-1', description: 'Create the login form', dependsOn: [], assignedPersona: 'coder',
    assignedSkills: ['file_management'], assignedTools: ['read_file'], claimedResources: [],
    acceptanceCriteria: 'form exists', status: 'pending',
  }],
  clarifications: [],
  status: 'draft',
};

function installScript(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const name = (opts as { schemaName?: string } | undefined)?.schemaName;
    switch (name) {
      case 'PlannerAssessment': return { object: { isClear: true, needsClarification: [], plan: PLAN } } as never;
      case 'ExecutionPlan': return { object: PLAN } as never;
      case 'AcceptanceJudgment': return { object: { accepted: true, reason: 'ok' } } as never;
      case 'FinalReview':
        return { object: { planId: 'plan_a_mock', goal: GOAL, outcome: 'success', acceptedFindings: [], rejectedFindings: [], incompleteSteps: [], finalSummary: 'done', usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 } } } as never;
      default: throw new Error(`unexpected schemaName: ${String(name)}`);
    }
  });
  mockGenerateText.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as never);
}

/**
 * A tiny profile whose plan branch ends `rejected` without executing anything: on the profile path
 * the observable outcome is therefore `rejected`, while the legacy path would execute the plan and
 * report `success`. That difference is what makes "which path ran?" observable from the API.
 */
function rejectInsteadOfExecuting(id: string): WorkflowProfileDocument {
  const { personaRegistry } = loadProfileRegistries(REPO_ROOT);
  const planner = personaRegistry.get('planner') as unknown as Record<string, unknown> | undefined;
  if (!planner) throw new Error('the repository registry must ship the planner persona');
  const port = (required: boolean) => ({ type: 'string', required });
  return {
    schemaVersion: '1.0.0',
    profile: { id, name: `Rejecting profile ${id}`, version: '1.0.0', author: 'tests' },
    dependencies: [
      { kind: 'persona', id: 'planner', digest: dependencyDigest('persona', 'planner', componentProjection(planner)) },
    ],
    workflow: {
      startNode: 'request',
      nodes: [
        { id: 'request', kind: 'intake', goal: 'carry the request', inputs: { request: { type: 'object', required: false } }, outputs: { request: { type: 'object', required: true } }, config: {} },
        {
          id: 'plan', kind: 'planner', goal: 'decide',
          inputs: { request: { type: 'object', required: false }, context: port(false) },
          outputs: {
            kind: { type: 'string', required: true, enum: ['plan', 'answer', 'clarify'] },
            plan: { type: 'object', required: false }, planText: port(false), planDigest: port(false),
            answer: port(false), clarification: port(false),
          },
          bindings: { personaRef: 'planner' }, config: { mode: 'decompose', maxPlanItems: 20 },
        },
        { id: 'answered', kind: 'end', goal: 'answer', inputs: { answer: port(false) }, outputs: { response: port(false) }, config: { outcome: 'success', emit: { response: 'answer' } } },
        { id: 'rejected', kind: 'end', goal: 'refuse', inputs: { response: port(true) }, outputs: { response: port(true) }, config: { outcome: 'rejected', emit: { response: 'response' } } },
      ],
      edges: [
        { from: 'request', to: 'plan', map: { request: '/request' } },
        { from: 'plan', to: 'answered', when: { path: '/kind', operator: 'equals', value: 'answer' }, map: { answer: '/answer' } },
        { from: 'plan', to: 'rejected', default: true, map: { response: '/kind' } },
      ],
    },
    policies: {
      execution: { maxNodeVisits: 20, maxDurationSeconds: 300, maxModelCalls: 20, maxToolCalls: 20, onLimit: 'fail' },
      tools: { allowedToolsets: [], deniedTools: [] },
      approvals: { policy: 'runtime-default' },
    },
    result: [
      { fromNode: 'answered', port: 'response', kind: 'response', outcome: 'success' },
      { fromNode: 'rejected', port: 'response', kind: 'response', outcome: 'rejected' },
    ],
  } as unknown as WorkflowProfileDocument;
}

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-server-'));
  fs.cpSync(REGISTRY_SRC, path.join(dir, 'registry'), { recursive: true });
  return dir;
}

function writeProjectProfile(projectRoot: string, name: string, document: unknown): string {
  const dir = path.join(projectRoot, '.hootl', 'workflow-profiles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
}

async function pollRun(app: Express, runId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    if (res.body.state === 'done' || res.body.state === 'error') return res.body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not converge: ${JSON.stringify(res.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Phase 8 — per-request profile selection over the API', () => {
  let home: ReturnType<typeof useIsolatedHome>;
  let projectRoot: string;

  beforeEach(() => {
    home = useIsolatedHome('phase8-server-home-');
    projectRoot = makeProject();
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript();
  });

  afterEach(() => {
    home.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('selects the profile for one request only, while another run on the same server stays legacy', async () => {
    writeProjectProfile(projectRoot, 'rejecting.json', rejectInsteadOfExecuting('tests.rejecting'));
    const created = createApp({ projectRoot, persistent: false, trustedProject: true });
    try {
      // Legacy request: the plan is executed and the run reports success.
      const legacy = await request(created.app).post('/api/run').send({ message: GOAL, confirm: true }).expect(202);
      const legacyState = await pollRun(created.app, legacy.body.runId as string);
      expect(legacyState.outcome).toBe('success');
      expect(legacyState.report).toContain('FINAL REPORT');

      // Profile-selected request against the same (shared) Orchestrator: the profile's graph ends
      // `rejected`, so the profile path is provably the one that ran.
      const selected = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, confirm: true, profile: 'tests.rejecting' })
        .expect(202);
      expect(selected.body.profileId).toBe('tests.rejecting');
      const selectedState = await pollRun(created.app, selected.body.runId as string);
      // The profile's end node reports `rejected`, which the legacy Review vocabulary records as
      // `failure` (the recorded mapping difference; the report keeps the profile's own status), and
      // no step agent ran for this request.
      expect(selectedState.outcome).toBe('failure');
      expect(selectedState.profileId).toBe('tests.rejecting');
      expect(selectedState.report).toContain('Workflow profile "rejected"');
      expect(mockGenerateText).toHaveBeenCalledTimes(1); // only the legacy request executed a step
      // The legacy run kept its own outcome and profile-free record.
      expect(legacyState.profileId).toBeUndefined();
    } finally {
      await created.close();
    }
  });

  it('keeps concurrent requests separate: a profile run and a legacy run do not leak into each other', async () => {
    writeProjectProfile(projectRoot, 'rejecting.json', rejectInsteadOfExecuting('tests.rejecting'));
    const created = createApp({ projectRoot, persistent: false, trustedProject: true });
    try {
      const [withProfile, withoutProfile] = await Promise.all([
        request(created.app).post('/api/run').send({ message: GOAL, confirm: true, profile: 'tests.rejecting' }),
        request(created.app).post('/api/run').send({ message: GOAL, confirm: true }),
      ]);
      expect([withProfile.status, withoutProfile.status]).toEqual([202, 202]);
      const [profileState, legacyState] = await Promise.all([
        pollRun(created.app, withProfile.body.runId as string),
        pollRun(created.app, withoutProfile.body.runId as string),
      ]);
      expect(profileState.report).toContain('Workflow profile "rejected"');
      expect(legacyState.report).toContain('FINAL REPORT');
      expect(legacyState.outcome).toBe('success');
    } finally {
      await created.close();
    }
  });

  it('refuses an untrusted project profile with diagnostics and starts nothing', async () => {
    writeProjectProfile(projectRoot, 'rejecting.json', rejectInsteadOfExecuting('tests.rejecting'));
    const created = createApp({ projectRoot, persistent: false });
    try {
      const res = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, confirm: true, profile: 'tests.rejecting' })
        .expect(400);
      expect(res.body.error).toMatch(/discovered|select/i);
      expect(res.body.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)).toContain('selection.profile-missing');
      // Nothing was created: no run, no session, no plan.
      expect(created.ctx.runs.size).toBe(0);
      expect(created.ctx.orchestrator.sessionStore.listSessions()).toHaveLength(0);
      expect(created.ctx.orchestrator.planStore.list()).toHaveLength(0);
      expect(mockGenerateObject).not.toHaveBeenCalled();
    } finally {
      await created.close();
    }
  });

  it('reads an operator-directory profile without any trust, like the CLI', async () => {
    const operatorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-operator-'));
    fs.writeFileSync(path.join(operatorDir, 'rejecting.json'), JSON.stringify(rejectInsteadOfExecuting('tests.operator'), null, 2));
    const previous = process.env.HOOTL_WORKFLOW_PROFILES_DIR;
    process.env.HOOTL_WORKFLOW_PROFILES_DIR = operatorDir;
    const created = createApp({ projectRoot, persistent: false });
    try {
      const res = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, confirm: true, profile: 'tests.operator' })
        .expect(202);
      expect(res.body.profileId).toBe('tests.operator');
      const state = await pollRun(created.app, res.body.runId as string);
      expect(state.report).toContain('Workflow profile "rejected"');
    } finally {
      await created.close();
      if (previous === undefined) delete process.env.HOOTL_WORKFLOW_PROFILES_DIR;
      else process.env.HOOTL_WORKFLOW_PROFILES_DIR = previous;
      fs.rmSync(operatorDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown profile id with diagnostics', async () => {
    const created = createApp({ projectRoot, persistent: false, trustedProject: true });
    try {
      const unknown = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, profile: 'nope.missing' })
        .expect(400);
      expect(unknown.body.error).toMatch(/not discovered/i);
      expect(unknown.body.diagnostics.map((diagnostic: { code: string }) => diagnostic.code))
        .toContain('selection.profile-missing');
      expect(created.ctx.runs.size).toBe(0);
      expect(mockGenerateObject).not.toHaveBeenCalled();
    } finally {
      await created.close();
    }
  });

  it('reports an unreadable profile file instead of skipping it silently', async () => {
    const dir = path.join(projectRoot, '.hootl', 'workflow-profiles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
    writeProjectProfile(projectRoot, 'good.json', rejectInsteadOfExecuting('tests.good'));
    const created = createApp({ projectRoot, persistent: false, trustedProject: true });
    try {
      const broken = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, profile: 'tests.good' })
        .expect(400);
      // The good profile cannot be used while the project's profile set is broken: the failure is
      // reported with the offending file, never hidden.
      expect(JSON.stringify(broken.body)).toMatch(/broken\.json/i);
      expect(created.ctx.runs.size).toBe(0);
    } finally {
      await created.close();
    }
  });

  it('never accepts a client-supplied profile file path, and validates the field type', async () => {
    const created = createApp({ projectRoot, persistent: false, trustedProject: true });
    try {
      const file = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, profileFile: '/etc/passwd' })
        .expect(400);
      expect(file.body.error).toMatch(/profileFile.*not accepted|CLI/i);

      await request(created.app).post('/api/run').send({ message: GOAL, profile: 42 }).expect(400);
      await request(created.app).post('/api/run').send({ message: GOAL, profile: '  ' }).expect(400);
      expect(created.ctx.runs.size).toBe(0);
      expect(mockGenerateObject).not.toHaveBeenCalled();
    } finally {
      await created.close();
    }
  });

  it('answers a session-scoped profile request inside the existing session', async () => {
    writeProjectProfile(projectRoot, 'rejecting.json', rejectInsteadOfExecuting('tests.rejecting'));
    const created = createApp({ projectRoot, persistent: true, trustedProject: true });
    try {
      const first = await request(created.app).post('/api/run').send({ message: GOAL, confirm: true }).expect(202);
      const firstState = await pollRun(created.app, first.body.runId as string);
      const sessionId = firstState.sessionId as string;
      const second = await request(created.app)
        .post('/api/run')
        .send({ message: GOAL, confirm: true, sessionId, profile: 'tests.rejecting' })
        .expect(202);
      const secondState = await pollRun(created.app, second.body.runId as string);
      expect(secondState.report).toContain('Workflow profile "rejected"');
      expect(secondState.sessionId).toBe(sessionId);
      // Both interactions live in the same session, in order: selection changed the path, not the
      // session/plan lifecycle.
      const session = created.ctx.orchestrator.sessionStore.getSession(sessionId);
      expect(session?.interactions.map((interaction) => interaction.userRequest)).toEqual([GOAL, GOAL]);
    } finally {
      await created.close();
    }
  });
});
