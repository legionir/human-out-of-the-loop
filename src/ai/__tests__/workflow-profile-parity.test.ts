/**
 * Phase 7 Step 3 (WP-R-008): characterization/parity between the legacy Orchestrator path
 * and the Workflow Profile path.
 *
 * Both paths are driven with the same scripted model (`schemaName`-dispatched
 * `generateObject` plus a text `generateText`), the same project registry and the same plan,
 * and the observable surface is compared: result kind, review outcome, plan content and step
 * statuses, the step agents' system prompts (persona + allowed tool surface), acceptance and
 * review call counts, interaction outcomes, plan/session data, and the fail-closed paths.
 *
 * Deliberate differences are asserted as differences here and recorded in
 * `docs/workflow-profiles/PHASE7_PARITY.md` (§8/§9) for the release notes and the owner's
 * approval before any default activation: the report wording, the absence of the legacy
 * `plan:clarified` observability entry, and the G-2/G-5 mappings.
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
import { Orchestrator, type OrchestratorWorkflowProfileOptions } from '../orchestrator.js';
import { WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR } from '../workflow-profiles/profile-runner.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const GOAL = 'Build a login page';
const ANSWER = 'It is 42.';
const CLARIFY_QUESTION = 'Which framework?';
const CLARIFY_ANSWER = 'React 18';

interface Script {
  /** PlannerAssessment responses, consumed in order (the last one repeats). */
  assessments: Array<Record<string, unknown>>;
  acceptance?: { accepted: boolean; reason: string };
  review?: Record<string, unknown>;
}

const planOf = () => ({
  goal: GOAL,
  steps: [
    {
      id: 'step-1', description: 'Create the login form component', dependsOn: [],
      assignedPersona: 'coder', assignedSkills: [], assignedTools: ['read_file'],
      claimedResources: [], acceptanceCriteria: 'Login form exists', status: 'pending',
    },
  ],
});

const reviewOf = (outcome = 'success') => ({
  planId: 'plan_x', goal: GOAL, outcome, acceptedFindings: [], rejectedFindings: [],
  incompleteSteps: [], finalSummary: `reviewed: ${outcome}`, usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 },
});

function installScript(script: Script): void {
  let assessmentIndex = 0;
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const name = (opts as { schemaName?: string }).schemaName;
    if (name === 'PlannerAssessment') {
      const next = script.assessments[Math.min(assessmentIndex, script.assessments.length - 1)]!;
      assessmentIndex += 1;
      return { object: { isClear: true, needsClarification: [], ...next } } as never;
    }
    if (name === 'ExecutionPlan') return { object: planOf() } as never;
    if (name === 'AcceptanceJudgment') return { object: script.acceptance ?? { accepted: true, reason: 'looks right' } } as never;
    if (name === 'FinalReview') return { object: script.review ?? reviewOf() } as never;
    throw new Error(`unexpected schema ${String(name)}`);
  });
  mockGenerateText.mockResolvedValue({ text: 'step done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] } as never);
}

const countCalls = (name: string): number =>
  mockGenerateObject.mock.calls.filter((call) => (call[0] as { schemaName?: string } | undefined)?.schemaName === name).length;

/** The step agents' system prompts: the persona each step agent was built with. */
const stepSystemPrompts = (): string[] =>
  mockGenerateText.mock.calls.map((call) => String((call[0] as { system?: string } | undefined)?.system ?? ''));

/** The tools each step agent was actually handed (persona ∩ step ∩ runtime). */
const stepToolSurface = (): string[][] =>
  mockGenerateText.mock.calls.map((call) => Object.keys(((call[0] as { tools?: Record<string, unknown> } | undefined)?.tools ?? {})).sort());

const confirmAccepting = async () => ({ confirmed: true });
/** Answers the clarification interaction and confirms the plan (one callback, both interactions). */
const confirmAnswering = async (prompt: string) =>
  prompt.toLowerCase().includes('clarification') ? { confirmed: true, feedback: CLARIFY_ANSWER } : { confirmed: true };

describe('Phase 7 parity — legacy path vs profile path', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-parity-'));
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  // `persistent: true` puts plans and sessions in the runtime dir, so the parity assertions
  // read the same durable data a CLI run writes (and a second instance can read it back).
  const legacy = (extra: Record<string, unknown> = {}) =>
    new Orchestrator({ projectRoot: REPO_ROOT, runtimeDir, persistent: true, env: { OPENAI_API_KEY: 'sk-test-dummy' }, ...extra });

  const profile = (workflowProfile: OrchestratorWorkflowProfileOptions) =>
    new Orchestrator({
      projectRoot: REPO_ROOT,
      runtimeDir,
      persistent: true,
      env: { OPENAI_API_KEY: 'sk-test-dummy' },
      workflowProfile,
    });

  const approvedDefault = (overrides: OrchestratorWorkflowProfileOptions = {}) => profile({
    env: { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' },
    allowBuiltInDefault: true,
    builtInDefaultApproval: { approved: true, reference: 'parity test approval' },
    ...overrides,
  });

  it('plan branch: same plan, same execution, same step agents, same outcome', async () => {
    installScript({ assessments: [{ plan: planOf() }] });
    const legacyResult = await legacy().run(GOAL, { confirmCallback: confirmAccepting });
    const legacyPrompts = stepSystemPrompts();
    const legacyToolSurface = stepToolSurface();
    const legacyAcceptance = countCalls('AcceptanceJudgment');
    const legacyReviews = countCalls('FinalReview');

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ plan: planOf() }] });
    const profileOrch = approvedDefault();
    const profileResult = await profileOrch.run(GOAL, { confirmCallback: confirmAccepting });
    const profilePrompts = stepSystemPrompts();
    const profileToolSurface = stepToolSurface();

    // Same observable outcome.
    expect(profileResult.kind).toBe(legacyResult.kind);
    expect(profileResult.review.outcome).toBe(legacyResult.review.outcome);
    expect(profileResult.review.outcome).toBe('success');
    expect(profileResult.executionResult.status).toBe(legacyResult.executionResult.status);
    expect(profileResult.executionResult.completedSteps).toBe(legacyResult.executionResult.completedSteps);

    // Same one-step execution, with the step agent given the same persona and tool surface.
    expect(legacyPrompts).toHaveLength(1);
    expect(profilePrompts).toEqual(legacyPrompts);
    // The persona the step's `assignedPersona` names, on both paths.
    expect(profilePrompts[0]).toContain('Software Engineer');
    // The tool surface each step agent was handed is identical: the profile path cannot
    // widen (or narrow) what the legacy path gives a step.
    expect(profileToolSurface).toEqual(legacyToolSurface);
    expect(countCalls('AcceptanceJudgment')).toBe(legacyAcceptance);
    expect(countCalls('FinalReview')).toBe(legacyReviews);

    // Both persisted a plan with the same steps and the same session linkage.
    const profilePlan = profileOrch.planStore.load(profileResult.planId);
    const legacyPlan = legacy().planStore.load(legacyResult.planId);
    expect(profilePlan?.steps.map((step) => `${step.id}:${step.status}`)).toEqual(legacyPlan?.steps.map((step) => `${step.id}:${step.status}`));
    expect(profilePlan?.sessionId).toBe(profileResult.sessionId);

    // Recorded differences (must appear in the release notes): the report wording differs.
    expect(legacyResult.report).not.toBe(profileResult.report);
    expect(profileResult.report.toLowerCase()).toContain('success');

    // Same interaction outcome on both paths.
    const interactions = (orch: Orchestrator) => orch.sessionStore.getSession(orch.sessionStore.listSessions()[0]!);
    expect(interactions(profileOrch)?.interactions[0]).toMatchObject({ outcome: 'success' });
  });

  it('answer branch: no plan, no confirmation, same answer outcome', async () => {
    installScript({ assessments: [{ isClear: true, needsClarification: [], kind: 'answer', answer: 'draft' }] });
    mockGenerateText.mockResolvedValue({ text: ANSWER, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] } as never);
    const legacyResult = await legacy().run('what is the answer?', { confirmCallback: confirmAccepting });

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ isClear: true, needsClarification: [], kind: 'answer', answer: 'draft' }] });
    mockGenerateText.mockResolvedValue({ text: ANSWER, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] } as never);
    const profileOrch = approvedDefault();
    const profileResult = await profileOrch.run('what is the answer?', { confirmCallback: confirmAccepting });

    for (const result of [legacyResult, profileResult]) {
      expect(result.kind).toBe('answer');
      expect(result.planId).toBe('none');
      expect(result.review.outcome).toBe('success');
      expect(result.report).toContain(ANSWER);
    }
    // Both paths answered with the chat agent (read-only tools), not with a plan step.
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(profileOrch.planStore.list()).toHaveLength(0);
  });

  it('clarification: the answered question is folded back into the plan on both paths', async () => {
    installScript({ assessments: [{ isClear: false, needsClarification: [CLARIFY_QUESTION] }, { plan: planOf() }] });
    const legacyResult = await legacy().run(GOAL, {
      confirmCallback: confirmAccepting,
      clarificationCallback: async () => ({ [CLARIFY_QUESTION]: CLARIFY_ANSWER }),
    });
    const legacyPrompt = String((mockGenerateObject.mock.calls[1]?.[0] as { prompt?: string } | undefined)?.prompt ?? '');

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ isClear: false, needsClarification: [CLARIFY_QUESTION] }, { plan: planOf() }] });
    const profileResult = await approvedDefault().run(GOAL, { confirmCallback: confirmAnswering });
    const profilePrompt = String((mockGenerateObject.mock.calls[1]?.[0] as { prompt?: string } | undefined)?.prompt ?? '');

    expect(legacyPrompt).toContain(CLARIFY_ANSWER);
    expect(profilePrompt).toContain(CLARIFY_ANSWER);
    expect(legacyResult.review.outcome).toBe('success');
    expect(profileResult.review.outcome).toBe('success');
    expect(countCalls('PlannerAssessment')).toBe(2);
    // Recorded difference: the legacy path logs `plan:clarified`; the profile path records the
    // same round in the workflow events instead (no new observability entry yet).
    const log = fs.readFileSync(path.join(runtimeDir, 'observability.jsonl'), 'utf-8');
    expect(log).toContain('plan:clarified');
  });

  it('cancellation: both paths end cancelled without executing the plan', async () => {
    const controller = new AbortController();
    controller.abort();
    installScript({ assessments: [{ plan: planOf() }] });
    const legacyResult = await legacy().run(GOAL, { confirmCallback: confirmAccepting, abortSignal: controller.signal });
    const legacyPrompts = stepSystemPrompts().length;

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ plan: planOf() }] });
    const profileOrch = approvedDefault();
    const profileResult = await profileOrch.run(GOAL, { confirmCallback: confirmAccepting, abortSignal: controller.signal });

    expect(legacyResult.review.outcome).toBe('cancelled');
    expect(profileResult.review.outcome).toBe('cancelled');
    expect(stepSystemPrompts()).toHaveLength(0);
    expect(legacyPrompts).toBe(0);
    const session = profileOrch.sessionStore.getSession(profileOrch.sessionStore.listSessions()[0]!);
    expect(session?.interactions[0]?.outcome).toBe('cancelled');
  });

  it('reuses legacy plan and session data, and rolls back to the legacy path on demand', async () => {
    // A legacy run first: its plan and session must stay readable afterwards.
    installScript({ assessments: [{ plan: planOf() }] });
    const legacyOrch = legacy();
    const legacyResult = await legacyOrch.run(GOAL, { confirmCallback: confirmAccepting });
    const legacyPlan = legacyOrch.planStore.load(legacyResult.planId);
    const legacySessionId = legacyResult.sessionId;

    // The profile path reads the same stores and keeps the same formats.
    installScript({ assessments: [{ plan: planOf() }] });
    const profileOrch = approvedDefault();
    const profileRun = await profileOrch.run(GOAL, { sessionId: legacySessionId, confirmCallback: confirmAccepting });
    expect(profileOrch.planStore.load(legacyResult.planId)?.steps).toEqual(legacyPlan?.steps);
    const session = profileOrch.sessionStore.getSession(legacySessionId);
    // The legacy interaction is untouched; the profile interaction was appended to the same session.
    expect(session?.interactions.length).toBeGreaterThanOrEqual(2);
    expect(session?.interactions[0]?.userRequest).toBe(GOAL);
    expect(profileRun.sessionId).toBe(legacySessionId);

    // Rollback: with the flag off the very same instance configuration runs the legacy path.
    installScript({ assessments: [{ plan: planOf() }] });
    const rolledBack = profile({ env: {}, allowBuiltInDefault: true });
    const rollbackRun = await rolledBack.run(GOAL, { confirmCallback: confirmAccepting });
    expect(rollbackRun.review.outcome).toBe('success');
    expect(rollbackRun.kind).toBe('plan');
  });

  it('acceptance failure and re-planning behave the same on both paths', async () => {
    const runOptions = {
      confirmCallback: confirmAccepting,
      // One re-planning attempt, so the comparison is bounded and deterministic.
      runOverrides: { maxReplanningAttempts: 1 },
    } as const;

    installScript({ assessments: [{ plan: planOf() }], acceptance: { accepted: false, reason: 'not good enough' }, review: reviewOf('failure') });
    const legacyResult = await legacy().run(GOAL, runOptions as never);
    const legacyPlannerCalls = countCalls('PlannerAssessment');
    const legacyReviews = countCalls('FinalReview');

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ plan: planOf() }], acceptance: { accepted: false, reason: 'not good enough' }, review: reviewOf('failure') });
    const profileOrch = approvedDefault();
    const profileResult = await profileOrch.run(GOAL, runOptions as never);

    expect(profileResult.review.outcome).toBe(legacyResult.review.outcome);
    expect(profileResult.review.outcome).toBe('failure');
    expect(profileResult.executionResult.failedSteps).toBe(legacyResult.executionResult.failedSteps);
    expect(profileResult.executionResult.failedSteps).toBe(1);
    // The automatic re-plan happens inside the delegation on both paths, the same number of times.
    expect(countCalls('PlannerAssessment')).toBe(legacyPlannerCalls);
    expect(countCalls('FinalReview')).toBe(legacyReviews);
    const session = profileOrch.sessionStore.getSession(profileOrch.sessionStore.listSessions()[0]!);
    expect(session?.interactions[0]?.outcome).toBe('failure');
  });

  it('tool authorization: a plan step naming a tool its persona does not allow is refused before execution', async () => {
    const restricted = () => ({
      goal: GOAL,
      steps: [{
        id: 'step-1', description: 'Write the file', dependsOn: [], assignedPersona: 'coder',
        // `list_personas` is a planner tool, not in the coder persona's allow list.
        assignedSkills: [], assignedTools: ['read_file', 'list_personas'], claimedResources: [],
        acceptanceCriteria: 'file written', status: 'pending',
      }],
    });
    installScript({ assessments: [{ plan: restricted() }] });
    const legacyOrch = legacy();
    const legacyResult = await legacyOrch.run(GOAL, { confirmCallback: confirmAccepting });
    const legacyAgents = stepSystemPrompts().length;
    const legacyPlanIds = legacyOrch.planStore.list();

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ plan: restricted() }] });
    const profileOrch = approvedDefault();
    const profileResult = await profileOrch.run(GOAL, { confirmCallback: confirmAccepting });

    // Both paths refuse the plan at the feasibility gate: no step agent ever runs.
    expect(legacyAgents).toBe(0);
    expect(stepSystemPrompts()).toHaveLength(0);
    expect(legacyResult.review.outcome).toBe('failure');
    expect(profileResult.review.outcome).toBe('failure');
    expect(legacyResult.report).toContain('Plan infeasible');
    expect(profileResult.report).toContain('Plan infeasible');
    // Each path persisted exactly one plan — the rejected draft stays visible to the user —
    // and the profile path did not disturb the legacy path's records.
    expect(legacyPlanIds).toHaveLength(1);
    expect(profileOrch.planStore.list()).toHaveLength(legacyPlanIds.length + 1);
    expect(profileOrch.planStore.load(legacyPlanIds[0]!)).toBeDefined();
  });

  it('the final review summary reaches the user on both paths', async () => {
    installScript({ assessments: [{ plan: planOf() }] });
    const legacyResult = await legacy().run(GOAL, { confirmCallback: confirmAccepting });

    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    installScript({ assessments: [{ plan: planOf() }] });
    const profileResult = await approvedDefault().run(GOAL, { confirmCallback: confirmAccepting });

    expect(legacyResult.review.finalSummary).toBe('reviewed: success');
    expect(profileResult.review.finalSummary).toBe('reviewed: success');
    expect(legacyResult.report).toContain('reviewed: success');
    expect(profileResult.report).toContain('reviewed: success');
  });

  it('never executes on a load error: no session, no plan, no step agent', async () => {
    installScript({ assessments: [{ plan: planOf() }] });
    const orch = approvedDefault({ allowBuiltInDefault: false, selection: { document: { schemaVersion: '9.0.0' } } });
    const error = await orch.run(GOAL, { confirmCallback: confirmAccepting }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkflowProfileLoadError);
    expect(orch.sessionStore.listSessions()).toHaveLength(0);
    expect(orch.planStore.list()).toHaveLength(0);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});
