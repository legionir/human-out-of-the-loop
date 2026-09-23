/**
 * Phase 23 (CLI) tests — the `human-out-of-the-loop` command line.
 *
 * Runs the REAL commander program in-process (`main()`) against
 * temp project roots, with the `ai` module mocked (planner,
 * acceptance, final review, step execution).  Acceptance criteria
 * covered here:
 *   - `run --dry-run` shows the plan WITHOUT executing anything
 *   - `run --yes` runs to the end and prints the report
 *   - `sessions list` / `plans list` read the persistent stores
 *   - `plans cancel` flips a running plan to cancelled
 *   - `plans resume` re-executes a partially done plan
 *   - `logs --plan --tail` filters .ai-runtime/observability.jsonl
 *   - global config (~/.human-out-of-the-loop/config.json) + .env work
 *   - non-TTY without --yes fails fast with a hint (no hang)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ─── Mock AI SDK ─────────────────────────────────────────────────

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

// Imports AFTER vi.mock so the mocked module is used everywhere.
import { generateObject, generateText } from 'ai';
import { main } from '../../cli.js';
import { FileSessionStore } from '../../ai/runtime/session-store.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { loadGlobalConfig, loadDotEnv } from '../../cli/utils/config.js';
import { followLog } from '../../cli/commands/logs.js';
import type { Plan } from '../../ai/schemas/plan.js';
import type { LogEntry } from '../../ai/runtime/observability-logger.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

// The provider FACTORIES instantiate real model clients, which need API
// key env vars to exist (they only use them at request time — and the
// requests are mocked here).  Set dummy keys so agent building works.
process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

// ─── Temp project + stdout capture ───────────────────────────────

function makeTempProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
  return projectRoot;
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
    const code = await main(['node', 'human-out-of-the-loop', ...args]);
    return { code, out: chunks.join(''), errOut: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExitCode;
  }
}

// ─── Mock model responses ────────────────────────────────────────

const MOCK_PLAN_ID = 'plan_cli_mock_1';

function makeMockPlan(goal: string): Plan {
  return {
    id: MOCK_PLAN_ID,
    goal,
    steps: [
      {
        id: 'step-1',
        description: 'Create the login form component',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: ['src/login.tsx'],
        acceptanceCriteria: 'A login form component exists at src/login.tsx',
        status: 'pending',
      },
      {
        id: 'step-2',
        description: 'Add unit tests for the login form',
        dependsOn: ['step-1'],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file', 'search_code'],
        claimedResources: ['src/login.test.tsx'],
        acceptanceCriteria: 'Tests exist and cover the submit flow',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };
}

function installModelMocks(): void {
  mockGenerateObject.mockImplementation(async (opts: unknown) => {
    const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
    let object: unknown;
    switch (schemaName) {
      case 'PlannerAssessment':
        object = {
          isClear: true,
          needsClarification: [],
          plan: makeMockPlan('Build a login page'),
        };
        break;
      case 'ExecutionPlan':
        object = makeMockPlan('Build a login page');
        break;
      case 'AcceptanceJudgment':
        object = { accepted: true, reason: 'Criteria met.' };
        break;
      case 'FinalReview':
        object = {
          planId: MOCK_PLAN_ID,
          goal: 'Build a login page',
          outcome: 'success',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: 'All steps completed successfully.',
          usage: { totalPromptTokens: 10, totalCompletionTokens: 5, totalTokens: 15 },
        };
        break;
      default:
        throw new Error(`Unexpected schemaName in test: ${schemaName}`);
    }
    return { object } as never;
  });
  mockGenerateText.mockResolvedValue({
    text: 'Step work complete.',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Phase 23 — CLI: run command', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-run-');
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('run --dry-run shows the plan and executes NOTHING', async () => {
    const { code, out } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--dry-run',
    ]);

    expect(code).toBe(0);
    expect(out).toContain('Dry run');
    expect(out).toContain('Create the login form component');
    expect(out).toContain('Add unit tests for the login form');
    expect(out).toContain('coder');
    // The plan was generated (planner mock hit) but never executed
    expect(mockGenerateObject).toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    // Nothing persisted: no plan files, no session files
    // (the .ai-runtime dir itself may exist — the observability logger
    // creates it lazily even in memory mode)
    for (const sub of ['plans', 'sessions']) {
      const dir = path.join(projectRoot, '.ai-runtime', sub);
      if (fs.existsSync(dir)) {
        expect(fs.readdirSync(dir)).toEqual([]);
      }
    }
  });

  it('run --yes --persistent runs to the end, prints the report, persists everything', async () => {
    const { code, out } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
      '--persistent',
    ]);

    expect(code).toBe(0);
    // Steps executed (2 steps → 2 generateText calls)
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    // Final report printed
    expect(out).toContain('All steps completed successfully.');
    expect(out).toContain('Usage:');
    expect(out).toContain('Session:');
    expect(out).toContain('Plan:');
    // Streaming progress lines from the terminal renderer
    expect(out).toContain('Plan started');
    expect(out).toContain('(2 steps)');

    // Persistent artifacts
    const sessionsDir = path.join(projectRoot, '.ai-runtime', 'sessions');
    const plansDir = path.join(projectRoot, '.ai-runtime', 'plans');
    expect(fs.readdirSync(sessionsDir).length).toBeGreaterThanOrEqual(1);
    expect(fs.readdirSync(plansDir).length).toBeGreaterThanOrEqual(1);

    const planFiles = fs.readdirSync(plansDir);
    const savedPlan = JSON.parse(
      fs.readFileSync(path.join(plansDir, planFiles[0]), 'utf-8'),
    ) as Plan;
    expect(savedPlan.status).toBe('completed');

    // Observability log written
    const logFile = path.join(projectRoot, '.ai-runtime', 'observability.jsonl');
    expect(fs.existsSync(logFile)).toBe(true);
    const logLines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(logLines.length).toBeGreaterThanOrEqual(3);
  });

  it('run without --yes on a non-TTY fails fast with a hint (no hang)', async () => {
    const { code, errOut } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
    ]);

    expect(code).toBe(1);
    expect(errOut).toContain('--yes');
    expect(errOut.toLowerCase()).toContain('tty');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('unknown command exits 1 with a usage error (no crash)', async () => {
    const { code, errOut } = await runCli(['frobnicate']);
    expect(code).toBe(1);
    expect(errOut).toContain('frobnicate');
  });
});

describe('Phase 23 — CLI: sessions', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-sess-');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function seedSession(): string {
    const store = new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
    const id = store.createSession('test-session');
    store.addInteraction(id, 'Build a login page');
    const session = store.getSession(id);
    expect(session).toBeDefined();
    const interaction = session!.interactions[0];
    interaction.outcome = 'success';
    interaction.reviewSummary = 'All steps completed.';
    interaction.planIds = ['plan_1'];
    store.saveSession(session!);
    return id;
  }

  it('sessions list shows seeded sessions', async () => {
    const id = seedSession();
    const { code, out } = await runCli(['sessions', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain(id);
    expect(out).toContain('success');
    expect(out).toContain('All steps completed.');
  });

  it('sessions list with no sessions prints a friendly note', async () => {
    const { code, out } = await runCli(['sessions', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('No sessions found');
  });

  it('sessions show prints interaction details; delete removes the session', async () => {
    const id = seedSession();

    const shown = await runCli(['sessions', 'show', id, '--project-root', projectRoot]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Build a login page');
    expect(shown.out).toContain('All steps completed.');

    const missing = await runCli([
      'sessions',
      'show',
      'session_does_not_exist',
      '--project-root',
      projectRoot,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.errOut).toContain('not found');

    const deleted = await runCli(['sessions', 'delete', id, '--project-root', projectRoot]);
    expect(deleted.code).toBe(0);
    const store = new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
    expect(store.getSession(id)).toBeUndefined();
  });
});

describe('Phase 23 — CLI: plans', () => {
  let projectRoot: string;
  let planStore: FilePlanStore;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-plan-');
    planStore = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function seedPlan(status: Plan['status'], doneSteps: number): string {
    const plan = makeMockPlan('Build a login page');
    plan.id = `plan_cli_${status}_${doneSteps}`;
    plan.status = status;
    plan.steps.forEach((s, i) => {
      s.status = i < doneSteps ? 'done' : 'pending';
    });
    planStore.save(plan);
    return plan.id!;
  }

  it('plans list shows plans with status and progress', async () => {
    seedPlan('running', 1);
    seedPlan('completed', 2);

    const { code, out } = await runCli(['plans', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('plan_cli_running_1');
    expect(out).toContain('running');
    expect(out).toContain('1/2');
    expect(out).toContain('completed');
    expect(out).toContain('2/2');
  });

  it('plans show prints the full plan JSON', async () => {
    const id = seedPlan('running', 1);
    const { code, out } = await runCli(['plans', 'show', id, '--project-root', projectRoot]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Plan;
    expect(parsed.id).toBe(id);
    expect(parsed.steps.length).toBe(2);
  });

  it('plans cancel flips a running plan to cancelled (no runtime needed)', async () => {
    const id = seedPlan('running', 1);
    const { code, out } = await runCli(['plans', 'cancel', id, '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('Cancellation initiated');
    const plan = planStore.load(id);
    expect(plan?.status).toBe('cancelled');
  });

  it('plans cancel on a completed plan fails with a message', async () => {
    const id = seedPlan('completed', 2);
    const { code, errOut } = await runCli(['plans', 'cancel', id, '--project-root', projectRoot]);
    expect(code).toBe(1);
    expect(errOut).toContain('terminal');
  });

  it('plans resume re-executes the remaining steps of an interrupted plan', async () => {
    const id = seedPlan('running', 1); // step-1 done, step-2 pending
    const { code, out } = await runCli(['plans', 'resume', id, '--project-root', projectRoot]);

    expect(code).toBe(0);
    expect(mockGenerateText).toHaveBeenCalledTimes(1); // only the pending step
    expect(out).toContain('All steps completed successfully.');
    expect(planStore.load(id)?.status).toBe('completed');
  });
});

describe('Phase 23 — CLI: mcp + logs', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-mcplogs-');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('mcp list shows servers from registry/mcp-servers', async () => {
    const mcpDir = path.join(projectRoot, 'registry', 'mcp-servers');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'fs-server.json'),
      JSON.stringify({
        id: 'fs-server',
        name: 'FS Server',
        transport: 'stdio',
        command: 'node',
        args: ['fs-server.js'],
        auth: { type: 'none' },
      }),
    );

    const { code, out } = await runCli(['mcp', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('fs-server');
    expect(out).toContain('stdio');
    expect(out).toContain('node fs-server.js');
    expect(out).toContain('none');
  });

  it('mcp list with no servers prints a friendly note (exit 0)', async () => {
    const { code, out } = await runCli(['mcp', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('No MCP servers configured');
  });

  it('mcp test on an unknown server fails with exit 1', async () => {
    const { code, errOut } = await runCli([
      'mcp',
      'test',
      'ghost-server',
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain('ghost-server');
  });

  function writeLogEntries(entries: Array<Partial<LogEntry>>): void {
    const runtimeDir = path.join(projectRoot, '.ai-runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lines = entries.map((e, i) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now() + i,
        eventType: 'plan:started',
        message: `entry ${i}`,
        ...e,
      }),
    );
    fs.writeFileSync(path.join(runtimeDir, 'observability.jsonl'), lines.join('\n') + '\n');
  }

  it('logs prints the tail; --plan filters by plan id', async () => {
    writeLogEntries([
      { planId: 'plan_A', message: 'A-1' },
      { planId: 'plan_B', message: 'B-1' },
      { planId: 'plan_A', message: 'A-2' },
      { planId: 'plan_B', message: 'B-2' },
      { planId: 'plan_A', message: 'A-3' },
    ]);

    const all = await runCli(['logs', '--project-root', projectRoot, '--tail', '50']);
    expect(all.code).toBe(0);
    for (const m of ['A-1', 'B-1', 'A-2', 'B-2', 'A-3']) expect(all.out).toContain(m);

    const filtered = await runCli([
      'logs',
      '--project-root',
      projectRoot,
      '--plan',
      'plan_A',
      '--tail',
      '10',
    ]);
    expect(filtered.code).toBe(0);
    expect(filtered.out).toContain('A-1');
    expect(filtered.out).toContain('A-3');
    expect(filtered.out).not.toContain('B-1');
    expect(filtered.out).not.toContain('B-2');
  });

  it('logs --tail N limits the number of lines', async () => {
    writeLogEntries([
      { message: 'L-0' },
      { message: 'L-1' },
      { message: 'L-2' },
      { message: 'L-3' },
    ]);
    const { code, out } = await runCli(['logs', '--project-root', projectRoot, '--tail', '2']);
    expect(code).toBe(0);
    expect(out).not.toContain('L-0');
    expect(out).not.toContain('L-1');
    expect(out).toContain('L-2');
    expect(out).toContain('L-3');
  });

  it('logs with a missing log file prints a hint and exits 0', async () => {
    const { code, errOut } = await runCli(['logs', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(errOut).toContain('No observability log');
  });

  it('logs --follow streams new entries as they are appended (followLog)', async () => {
    const logFile = path.join(projectRoot, '.ai-runtime', 'observability.jsonl');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        planId: 'plan_A',
        eventType: 'plan:started',
        message: 'existing entry',
      }) + '\n',
    );

    const seen: string[] = [];
    const stop = followLog(logFile, undefined, 50, (entry) => seen.push(entry.message));

    // Give the watcher a beat to attach, then append two new entries.
    await new Promise((r) => setTimeout(r, 150));
    fs.appendFileSync(
      logFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now() + 1,
        planId: 'plan_A',
        eventType: 'step:started',
        message: 'new entry 1',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 300));
    fs.appendFileSync(
      logFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now() + 2,
        planId: 'plan_A',
        eventType: 'plan:completed',
        message: 'new entry 2',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 300));
    stop();

    expect(seen).toContain('new entry 1');
    expect(seen).toContain('new entry 2');
    // The pre-existing entry is NOT re-emitted (startAt=0 → but the
    // watcher only fires on change, and the first change delivers all
    // entries beyond startAt — so it may be included; assert only that
    // NEW entries arrived, which is the streaming guarantee.)
  }, 15000);
});

describe('Phase 23 — CLI: configuration (global config + .env)', () => {
  let projectRoot: string;
  let homeDir: string;
  const realHome = process.env.HOME;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-cfg-');
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase23-home-'));
    process.env.HOME = homeDir;
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('loadGlobalConfig reads ~/.human-out-of-the-loop/config.json', () => {
    const cfgDir = path.join(homeDir, '.human-out-of-the-loop');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ persistent: true, defaultModel: 'gpt-4o' }),
    );
    const config = loadGlobalConfig();
    expect(config.persistent).toBe(true);
    expect(config.defaultModel).toBe('gpt-4o');
  });

  it('loadGlobalConfig returns {} when the file is missing or invalid', () => {
    expect(loadGlobalConfig()).toEqual({});
    const cfgDir = path.join(homeDir, '.human-out-of-the-loop');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), '{not json');
    expect(loadGlobalConfig()).toEqual({});
  });

  it('global config persistent=true makes run persist without --persistent', async () => {
    const cfgDir = path.join(homeDir, '.human-out-of-the-loop');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ persistent: true }));

    const { code } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
    ]);
    expect(code).toBe(0);
    // persistent (from global config) → session + plan files on disk
    const sessionsDir = path.join(projectRoot, '.ai-runtime', 'sessions');
    expect(fs.readdirSync(sessionsDir).length).toBeGreaterThanOrEqual(1);
    const plansDir = path.join(projectRoot, '.ai-runtime', 'plans');
    expect(fs.readdirSync(plansDir).length).toBeGreaterThanOrEqual(1);
  });

  it('.env in projectRoot sets missing env vars but never overrides real env', async () => {
    process.env.CLI_TEST_ALREADY_SET = 'real-env-wins';
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'CLI_TEST_FROM_ENV=from-env-file\nCLI_TEST_ALREADY_SET=from-env-file\n',
    );

    // loadDotEnv is also called by every command; drive it directly here
    loadDotEnv([projectRoot]);
    expect(process.env.CLI_TEST_FROM_ENV).toBe('from-env-file');
    expect(process.env.CLI_TEST_ALREADY_SET).toBe('real-env-wins');

    delete process.env.CLI_TEST_FROM_ENV;
    delete process.env.CLI_TEST_ALREADY_SET;
  });
});
