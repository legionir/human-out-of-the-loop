/**
 * Phase 30 — readiness verification (READINESS_AUDIT.md).
 *
 * P2 (crash recovery): a run killed with SIGKILL leaves a plan with status
 * 'running' and a session interaction with outcome 'pending'.  Before this
 * phase:
 *   - the plan did not know its session (`plan.sessionId` did not exist),
 *   - the interaction had NO plan id, so `sessions show` could not tell the
 *     user which plan to resume,
 *   - `plans resume` finished the plan but left the interaction 'pending'
 *     forever.
 *
 * The e2e evidence (real `kill -9`, real resume) lives in
 * `/tmp/e2e/crash.sh`; these tests pin the behaviour deterministically so it
 * cannot regress without a network or a real crash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { main } from '../../cli.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { FileSessionStore } from '../../ai/runtime/session-store.js';
import { createPlan } from '../../ai/schemas/plan.js';
import type { Plan } from '../../ai/schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

const PLAN_ID = 'plan_phase30_crash';
const STEP_1_DESC = 'Create the login form component';
const STEP_2_DESC = 'Add unit tests for the login form';

function makePlan(): Plan {
  return {
    id: PLAN_ID,
    goal: 'Build a login page',
    steps: [
      {
        id: 'step-1',
        description: STEP_1_DESC,
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'A login form component exists',
        status: 'pending',
      },
      {
        id: 'step-2',
        description: STEP_2_DESC,
        dependsOn: ['step-1'],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'Tests exist',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };
}

let projectRoot: string;
let prompts: string[];

function installModelMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    switch (schemaName) {
      case 'PlannerAssessment':
        return { object: { isClear: true, needsClarification: [] } } as never;
      case 'ExecutionPlan':
        return { object: makePlan() } as never;
      case 'AcceptanceJudgment':
        return { object: { accepted: true, reason: 'looks complete' } } as never;
      case 'FinalReview':
        return {
          object: {
            planId: PLAN_ID,
            goal: 'Build a login page',
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'All steps completed.',
            usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
          },
        } as never;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
  });

  prompts = [];
  mockGenerateText.mockImplementation(async (opts: unknown) => {
    prompts.push(String((opts as { prompt?: string }).prompt ?? ''));
    return {
      text: 'Step work complete.',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never;
  });
}

async function runCli(args: Array<string>): Promise<{ code: number; out: string; errOut: string }> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'hootl', ...args]);
    return { code, out: chunks.join(''), errOut: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExitCode;
  }
}

function planStore(): FilePlanStore {
  return new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
}
function sessionStore(): FileSessionStore {
  return new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
}
function runArgs(extra: string[] = []): string[] {
  return ['run', 'Build a login page', '--yes', '--persistent', '--project-root', projectRoot, ...extra];
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase30-crash-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  vi.clearAllMocks();
  installModelMocks();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── P2: the link is written before execution starts ─────────────

describe('Phase 30 P2 — a plan knows its session, an interaction knows its plan', () => {
  it('persists both directions of the link during the run', async () => {
    const { code, out } = await runCli(runArgs());
    expect(code).toBe(0);

    const sessionId = /Session: (\S+)/.exec(out)?.[1];
    expect(sessionId).toBeTruthy();

    const persisted = planStore().load(PLAN_ID);
    expect(persisted?.sessionId).toBe(sessionId);

    const interaction = sessionStore().getSession(sessionId!)?.interactions[0];
    expect(interaction?.planIds).toEqual([PLAN_ID]);
  });

  it('keeps the link after a simulated crash (killed mid-execution)', async () => {
    await runCli(runArgs());
    const sessionId = sessionStore().listSessions()[0]!;

    // Simulate what SIGKILL leaves behind: the plan stays 'running',
    // step-2 was interrupted, and the interaction was never closed.
    const plan = planStore().load(PLAN_ID)!;
    plan.status = 'running';
    plan.completedAt = undefined;
    plan.steps[0]!.status = 'done';
    plan.steps[1]!.status = 'running';
    delete plan.steps[1]!.taskId;
    delete plan.steps[1]!.resultSummary;
    planStore().save(plan);

    const session = sessionStore().getSession(sessionId)!;
    session.interactions[0]!.outcome = 'pending';
    session.interactions[0]!.completedAt = undefined;
    session.interactions[0]!.reviewSummary = undefined;
    sessionStore().saveSession(session);

    // The user can still find the plan to resume from the session view.
    expect(sessionStore().getSession(sessionId)!.interactions[0]!.planIds).toEqual([PLAN_ID]);
  });
});

// ─── P2: resume finishes the interrupted interaction ────────────

describe('Phase 30 P2 — `plans resume` closes what the crash left open', () => {
  it('does not re-execute finished steps and closes the interaction', async () => {
    await runCli(runArgs());
    const sessionId = sessionStore().listSessions()[0]!;

    // crash state
    const plan = planStore().load(PLAN_ID)!;
    plan.status = 'running';
    plan.completedAt = undefined;
    plan.steps[0]!.status = 'done';
    plan.steps[0]!.resultSummary = 'Step 1 finished before the crash.';
    plan.steps[1]!.status = 'running';
    delete plan.steps[1]!.taskId;
    planStore().save(plan);

    const session = sessionStore().getSession(sessionId)!;
    session.interactions[0]!.outcome = 'pending';
    session.interactions[0]!.completedAt = undefined;
    sessionStore().saveSession(session);

    prompts = [];
    const resumed = await runCli([
      'plans',
      'resume',
      PLAN_ID,
      '--project-root',
      projectRoot,
    ]);
    expect(resumed.code).toBe(0);

    // step-1 was NOT executed again; step-2 was.
    const joined = prompts.join('\n');
    expect(joined).not.toContain(STEP_1_DESC);
    expect(joined).toContain(STEP_2_DESC);

    // the plan is finished …
    const finished = planStore().load(PLAN_ID)!;
    expect(finished.status).toBe('completed');
    expect(finished.steps.map((s) => s.status)).toEqual(['done', 'done']);

    // … and the interaction the crash left open is closed now.
    const interaction = sessionStore().getSession(sessionId)!.interactions[0]!;
    expect(interaction.outcome).toBe('success');
    expect(interaction.completedAt).toBeTypeOf('number');
    expect(interaction.planIds).toEqual([PLAN_ID]);
    expect(interaction.reviewSummary).toBeTruthy();
  });

  it('still refuses a never-confirmed (draft) plan', async () => {
    await runCli(runArgs());
    const plan = planStore().load(PLAN_ID)!;
    plan.status = 'draft';
    planStore().save(plan);

    const { code, errOut } = await runCli([
      'plans',
      'resume',
      PLAN_ID,
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain('not found (or not resumable)');
  });

  it('still refuses a non-existent plan', async () => {
    const { code, errOut } = await runCli([
      'plans',
      'resume',
      'plan_does_not_exist',
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain('not found (or not resumable)');
  });
});

// ─── P2 follow-up: the task the crash left "running" ────────────

describe('Phase 30 P2 follow-up — the crashed task stops pretending to run', () => {
  it('logs `task:interrupted` and stops counting it as a live task', async () => {
    await runCli(runArgs());
    const sessionId = sessionStore().listSessions()[0]!;

    // What SIGKILL leaves behind: step-2 'running' with the task id of the
    // process that is now dead.
    const plan = planStore().load(PLAN_ID)!;
    plan.status = 'running';
    plan.completedAt = undefined;
    plan.steps[0]!.status = 'done';
    plan.steps[1]!.status = 'running';
    plan.steps[1]!.taskId = 'task_deadbeef';
    planStore().save(plan);

    const session = sessionStore().getSession(sessionId)!;
    session.interactions[0]!.outcome = 'pending';
    session.interactions[0]!.completedAt = undefined;
    sessionStore().saveSession(session);

    // The killed process did write the `task:created` line (that is why the
    // task shows up at all) — it just never got to write a terminal one.
    fs.appendFileSync(
      path.join(projectRoot, '.ai-runtime', 'observability.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        planId: PLAN_ID,
        stepId: 'step-2',
        taskId: 'task_deadbeef',
        eventType: 'task:created',
        message: 'Agent "plan-step-step-2" started for task "task_deadbeef".',
        level: 'info',
      }) + '\n'
    );

    const before = await runCli(['tasks', 'list', '--project-root', projectRoot]);
    const beforeRow = before.out.split('\n').find((l) => l.includes('task_deadbeef'));
    expect(beforeRow).toBeDefined();
    expect(beforeRow).toContain('running');

    const resumed = await runCli(['plans', 'resume', PLAN_ID, '--project-root', projectRoot]);
    expect(resumed.code).toBe(0);

    const logPath = path.join(projectRoot, '.ai-runtime', 'observability.jsonl');
    const entries = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string; taskId?: string; message: string });

    const interrupted = entries.filter((e) => e.eventType === 'task:interrupted');
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.taskId).toBe('task_deadbeef');
    expect(interrupted[0]!.message).toContain('resumed');

    // …and the task list tells the truth now.
    const after = await runCli(['tasks', 'list', '--project-root', projectRoot]);
    const afterRow = after.out.split('\n').find((l) => l.includes('task_deadbeef'))!;
    expect(afterRow).toContain('interrupted');
    expect(afterRow).not.toContain('running');
    expect(after.out).toContain('1 interrupted');
  });
});
