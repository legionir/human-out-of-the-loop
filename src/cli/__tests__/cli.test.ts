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
import { createPlan, type Plan } from '../../ai/schemas/plan.js';
import { Orchestrator } from '../../ai/orchestrator.js';
import type { LogEntry } from '../../ai/runtime/observability-logger.js';
import { useIsolatedHome } from '../../test-utils/isolated-home.js';

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

  it('plans show renders the plan for a human (steps, personas, tools)', async () => {
    const id = seedPlan('running', 1);
    const { code, out } = await runCli(['plans', 'show', id, '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain(`Plan ${id}`);
    expect(out).toContain('Persona:');
    expect(out).toContain('Tools:');
    expect(out).toContain('[step-1]');
  });

  it('plans show --json prints the full plan JSON', async () => {
    const id = seedPlan('running', 1);
    const { code, out } = await runCli([
      'plans',
      'show',
      id,
      '--json',
      '--project-root',
      projectRoot,
    ]);
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
  // HOME alone is not enough on Windows (os.homedir() reads USERPROFILE).
  let restoreHome: () => void;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-cfg-');
    const isolated = useIsolatedHome('phase23-home-');
    homeDir = isolated.home;
    restoreHome = isolated.restore;
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
  });

  afterEach(() => {
    restoreHome();
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

// ─── C1: registry introspection ──────────────────────────────────

describe('C1 — registry introspection (models/personas/skills/tools)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-registry-');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('models lists all registry models with provider + model columns', async () => {
    const { code, out } = await runCli(['models', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('gpt-4o');
    expect(out).toContain('claude-sonnet');
    expect(out).toContain('local-llama');
    expect(out).toContain('PROVIDER');
  });

  it('personas lists all 4 personas with their allowed tools', async () => {
    const { code, out } = await runCli(['personas', '--project-root', projectRoot]);
    expect(code).toBe(0);
    for (const id of ['architect', 'coder', 'planner', 'reviewer']) expect(out).toContain(id);
    expect(out).toContain('ALLOWED TOOLS');
  });

  it('skills lists the directory-per-skill layout (skill.json)', async () => {
    const { code, out } = await runCli(['skills', '--project-root', projectRoot]);
    expect(code).toBe(0);
    for (const id of [
      'acceptance_check',
      'code_analysis',
      'file_management',
      'git_operations',
      'task_decomposition',
    ]) {
      expect(out).toContain(id);
    }
  });

  it('tools lists the 4 local tool definitions', async () => {
    const { code, out } = await runCli(['tools', '--project-root', projectRoot]);
    expect(code).toBe(0);
    for (const id of ['read_file', 'write_file', 'search_code', 'git_status']) {
      expect(out).toContain(id);
    }
  });

  it('models --json is machine-readable and matches the registry files', async () => {
    const { code, out } = await runCli(['models', '--project-root', projectRoot, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{ id: string; provider: string; model: string }>;
    expect(parsed.map((m) => m.id).sort()).toEqual(['claude-sonnet', 'gpt-4o', 'local-llama']);
    const gpt = parsed.find((m) => m.id === 'gpt-4o');
    expect(gpt?.provider).toBe('openai');
  });

  // Phase 28 (registry layering): a project WITHOUT its own registry/ is
  // no longer an error — the packaged (built-in) registry is used, so the
  // CLI works from any directory.  The old "exit 2 + hint" behaviour now
  // applies only when NO layer exists at all (HOTL_NO_PACKAGE_REGISTRY=1).
  it('falls back to the built-in registry when the project has none', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'phase23-noreg-'));
    try {
      const { code, out } = await runCli(['models', '--project-root', empty]);
      expect(code).toBe(0);
      expect(out).toContain('registry: package (built-in)');
      expect(out).toContain('gpt-4o'); // the packaged catalog is listed
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('exits 2 with a hint when no registry layer exists at all', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'phase28-noreg-'));
    process.env.HOTL_NO_PACKAGE_REGISTRY = '1';
    try {
      const { code, errOut } = await runCli(['models', '--project-root', empty]);
      expect(code).toBe(2);
      expect(errOut).toContain('No registry found');
    } finally {
      delete process.env.HOTL_NO_PACKAGE_REGISTRY;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports invalid files (exit 1) but still lists the valid ones', async () => {
    fs.writeFileSync(path.join(projectRoot, 'registry', 'models', 'broken.json'), '{ nope');
    const { code, out } = await runCli(['models', '--project-root', projectRoot]);
    expect(code).toBe(1);
    expect(out).toContain('gpt-4o'); // valid entries still shown
    expect(out).toContain('broken.json'); // the bad file is named
  });
});

// ─── C2: usage + tasks commands (durable data) ──────────────────

describe('C2 — usage + tasks commands (from the observability log)', () => {
  let projectRoot: string;
  const PLAN_A = 'plan_11111111-aaaa-4111-8111-111111111111';
  const PLAN_B = 'plan_22222222-bbbb-4222-8222-222222222222';

  const step = {
    id: 'step-1',
    description: 'do it',
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: [],
    claimedResources: [],
    acceptanceCriteria: 'done',
  };

  let epoch = 1_000_000;
  function entry(
    partial: Record<string, unknown>,
  ): string {
    epoch += 1000;
    return JSON.stringify({
      timestamp: new Date(epoch).toISOString(),
      epochMs: epoch,
      level: 'info',
      ...partial,
    });
  }

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-c2-');
    const runtimeDir = path.join(projectRoot, '.ai-runtime');
    const store = new FilePlanStore(path.join(runtimeDir, 'plans'));
    const mkPlan = (id: string, goal: string, status: string): void => {
      const p = createPlan(goal, [step]);
      p.id = id;
      p.status = status as never;
      store.save(p);
    };
    mkPlan(PLAN_A, 'Build a login page', 'completed');
    mkPlan(PLAN_B, 'Write docs', 'cancelled');

    fs.writeFileSync(
      path.join(runtimeDir, 'observability.jsonl'),
      [
        // Plan A: two completed tasks (100/50/150 + 200/100/300)
        entry({ planId: PLAN_A, stepId: 'step-1', taskId: 'task_1', eventType: 'task:created', message: 'Agent a started for task "task_1".' }),
        entry({ planId: PLAN_A, stepId: 'step-1', taskId: 'task_1', eventType: 'task:tool-call', message: 'Tool "read_file" called.', payload: { toolName: 'read_file' } }),
        entry({ planId: PLAN_A, stepId: 'step-1', taskId: 'task_1', eventType: 'task:completed', message: 'Task "task_1" completed.', payload: { toolsUsed: ['read_file'], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } } }),
        entry({ planId: PLAN_A, stepId: 'step-2', taskId: 'task_2', eventType: 'task:created', message: 'started' }),
        entry({ planId: PLAN_A, stepId: 'step-2', taskId: 'task_2', eventType: 'task:completed', message: 'done', payload: { toolsUsed: ['write_file'], usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } } }),
        // Plan B: one failed, one never finished
        entry({ planId: PLAN_B, stepId: 'step-1', taskId: 'task_3', eventType: 'task:created', message: 'started' }),
        entry({ planId: PLAN_B, stepId: 'step-1', taskId: 'task_3', eventType: 'task:failed', level: 'error', message: 'Task "task_3" failed: boom', payload: { code: 'TIMEOUT' } }),
        entry({ planId: PLAN_B, stepId: 'step-2', taskId: 'task_4', eventType: 'task:created', message: 'started' }),
        // legacy entry without planId (pre-fix log)
        entry({ taskId: 'task_legacy', eventType: 'task:created', message: 'started' }),
      ].join('\n') + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('usage lists both plans with per-plan totals + grand total', async () => {
    const { code, out } = await runCli(['usage', '--project-root', projectRoot]);
    expect(code).toBe(0);
    // table cells truncate long ids to 15 chars
    expect(out).toContain('plan_11111111-a');
    expect(out).toContain('plan_22222222-b');
    // Plan A: 100+200 prompt, 50+100 completion, 450 total
    expect(out).toContain('300');
    expect(out).toContain('450');
    expect(out).toContain('Build a login page');
    expect(out).toMatch(/Totals: 300 prompt \+ 150 completion = 450 tokens across 2 task/);
  });

  it('usage --plan filters to one plan; unknown plan → exit 1', async () => {
    const { code, out } = await runCli(['usage', '--plan', PLAN_A, '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('plan_11111111-aaaa');
    expect(out).not.toContain('plan_22222222-bbbb');

    const bad = await runCli(['usage', '--plan', 'plan_nope', '--project-root', projectRoot]);
    expect(bad.code).toBe(1);
  });

  it('usage --json is machine-readable (plans + totals)', async () => {
    const { code, out } = await runCli(['usage', '--json', '--project-root', projectRoot]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      plans: Array<{ planId: string; totalTokens: number }>;
      totals: { totalTokens: number; taskCount: number };
    };
    expect(parsed.plans).toHaveLength(2);
    const a = parsed.plans.find((p) => p.planId === PLAN_A);
    expect(a?.totalTokens).toBe(450);
    expect(parsed.totals).toEqual({
      promptTokens: 300,
      completionTokens: 150,
      totalTokens: 450,
      taskCount: 2,
    });
  });

  it('tasks list shows 5 tasks with derived statuses', async () => {
    const { code, out } = await runCli(['tasks', 'list', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('task_1');
    expect(out).toContain('task_3');
    expect(out).toContain('task_legacy'); // plan-less legacy entry still listed globally
    // Phase 30 (P2 follow-up): the summary counts every status explicitly
    // (done / failed / interrupted / running) instead of "N other".
    // P10 follow-up: `task_4` belongs to PLAN_B, whose stored status is
    // `cancelled` — the process that owned it is gone, so it is reported
    // `interrupted` instead of "running" forever.
    expect(out).toMatch(/5 task\(s\): 2 done, 1 failed, 1 interrupted, 1 running/);
  });

  it('tasks list --plan filters (and legacy plan-less entries are excluded)', async () => {
    const { code, out } = await runCli(['tasks', 'list', '--plan', PLAN_A, '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('task_1');
    expect(out).toContain('task_2');
    expect(out).not.toContain('task_3');
    expect(out).not.toContain('task_legacy');
  });

  it('tasks list --plan with no matches explains the planId limitation', async () => {
    const { code, out } = await runCli(['tasks', 'list', '--plan', 'plan_missing', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('No task events for plan');
  });

  it('tasks show prints every log entry for one task (incl. payload)', async () => {
    const { code, out } = await runCli(['tasks', 'show', 'task_1', '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(out).toContain('task:created');
    expect(out).toContain('task:tool-call');
    expect(out).toContain('task:completed');
    expect(out).toContain('read_file');
  });

  it('tasks show for an unknown task → exit 1', async () => {
    const { code, errOut } = await runCli(['tasks', 'show', 'task_nope', '--project-root', projectRoot]);
    expect(code).toBe(1);
    expect(errOut).toContain('No log entries');
  });
});

// ─── C3: execution-control flags + session labels ───────────────

describe('C3 — run flags (--max-replans/--max-delegation-depth/--label) + sessions label', () => {
  let projectRoot: string;
  let captured: {
    maxReplanningAttempts: number;
    maxDelegationDepth: number;
    defaultModelId: string;
  } | undefined;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-c3-');
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
    captured = undefined;
    const origRun = Orchestrator.prototype.run;
    vi.spyOn(Orchestrator.prototype, 'run').mockImplementation(
      function (this: Orchestrator, ...args: Parameters<Orchestrator['run']>) {
        captured = {
          maxReplanningAttempts: this.config.maxReplanningAttempts,
          maxDelegationDepth: this.config.maxDelegationDepth,
          defaultModelId: this.config.defaultModelId,
        };
        return origRun.apply(this, args);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('--max-replans and --max-delegation-depth reach the OrchestratorConfig', async () => {
    const { code } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
      '--persistent',
      '--max-replans',
      '1',
      '--max-delegation-depth',
      '0',
    ]);
    expect(code).toBe(0);
    expect(captured?.maxReplanningAttempts).toBe(1);
    expect(captured?.maxDelegationDepth).toBe(0);
  });

  it('without the flags, the schema defaults apply (3 replans, depth 1)', async () => {
    const { code } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
      '--persistent',
    ]);
    expect(code).toBe(0);
    expect(captured?.maxReplanningAttempts).toBe(3);
    expect(captured?.maxDelegationDepth).toBe(1);
  });

  it('--label labels the NEW session (persisted)', async () => {
    const { code } = await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
      '--persistent',
      '--label',
      'Login work',
    ]);
    expect(code).toBe(0);
    const store = new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
    const ids = store.listSessions();
    expect(ids).toHaveLength(1);
    expect(store.getSession(ids[0])?.label).toBe('Login work');
  });

  it('sessions label renames, "" clears, unknown id → exit 1', async () => {
    // create a session first (via a real run with --label)
    await runCli([
      'run',
      'Build a login page',
      '--project-root',
      projectRoot,
      '--yes',
      '--persistent',
      '--label',
      'original',
    ]);
    const store = new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
    const id = store.listSessions()[0];

    const renamed = await runCli(['sessions', 'label', id, 'renamed', '--project-root', projectRoot]);
    expect(renamed.code).toBe(0);
    expect(renamed.out).toContain('renamed');
    expect(store.getSession(id)?.label).toBe('renamed');

    const cleared = await runCli(['sessions', 'label', id, '', '--project-root', projectRoot]);
    expect(cleared.code).toBe(0);
    expect(cleared.out).toContain('cleared');
    expect(store.getSession(id)?.label).toBeUndefined();

    const missing = await runCli(['sessions', 'label', 'session_nope', 'x', '--project-root', projectRoot]);
    expect(missing.code).toBe(1);
  });

  it('validation: out-of-range/combined options → exit 2 with a clear message', async () => {
    const base = ['run', 'g', '--project-root', projectRoot, '--yes'];

    const a = await runCli([...base, '--max-replans', '11']);
    expect(a.code).toBe(2);
    expect(a.errOut).toContain('--max-replans');

    const b = await runCli([...base, '--max-delegation-depth', '7']);
    expect(b.code).toBe(2);
    expect(b.errOut).toContain('--max-delegation-depth');

    const c = await runCli([...base, '--label', 'x'.repeat(65)]);
    expect(c.code).toBe(2);
    expect(c.errOut).toContain('64 characters');

    const d = await runCli([...base, '--label', 'L', '--session', 'session_abc']);
    expect(d.code).toBe(2);
    expect(d.errOut).toContain('sessions label');
  });
});

// ─── C4: CLI clarification wiring (non-TTY = CI-safe) ───────────

describe('C4 — run CLI clarification behavior', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject('phase23-c4-');
    installModelMocks();
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('non-TTY + --yes: unclear request fails (exit 1) showing the questions — no hang, no prompt', async () => {
    // first generateObject call is the planner assessment
    mockGenerateObject.mockImplementationOnce(async () => ({
      object: { isClear: false, needsClarification: ['Which framework should the login use?'] },
    }) as any);

    const { code, out } = await runCli([
      'run',
      'Build a login',
      '--project-root',
      projectRoot,
      '--yes',
    ]);

    expect(code).toBe(1);
    expect(out).toContain('Clarification needed');
    expect(out).toContain('Which framework should the login use?');
    // exactly one planner hit (no loop without a callback)
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });
});
