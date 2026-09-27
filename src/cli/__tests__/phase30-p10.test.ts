/**
 * Phase 30 (P10 follow-up) — CLI behaviour the user asked for:
 *
 *   - `hootl tools --mcp` shows the tools an MCP server actually exposes
 *     (before this, an MCP config could not be verified from the CLI at all:
 *     `hootl tools` only ever listed the static registry files);
 *   - `hootl tasks list` does not report a task as `running` when the plan it
 *     belongs to has already finished or been cancelled — the process that
 *     owned it is gone and no event will ever arrive;
 *   - `hootl plans resume` refuses a cancelled / cancelling plan instead of
 *     quietly running it again.
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

import { main } from '../../cli.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { createPlan } from '../../ai/schemas/plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_SRC = path.resolve(__dirname, '../../..', 'registry');

let projectRoot: string;

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

/** Write one observability entry (the tasks view reads this file). */
function writeLog(entries: Array<Record<string, unknown>>): void {
  const dir = path.join(projectRoot, '.ai-runtime');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'observability.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
}

const now = (offset = 0): string => new Date(1_700_000_000_000 + offset).toISOString();

function taskEvents(planId: string): Array<Record<string, unknown>> {
  return [
    { timestamp: now(0), epochMs: 0, planId, taskId: 'task_a', eventType: 'task:created', message: 'started', level: 'info' },
    { timestamp: now(1), epochMs: 1, planId, taskId: 'task_a', eventType: 'task:tool-call', message: 'read_file', level: 'info' },
    // …and then the process died: no task:completed.
    { timestamp: now(2), epochMs: 2, planId, eventType: 'plan:cancelled', message: 'Plan cancelled.', level: 'warn' },
  ];
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase30-p10-cli-'));
  fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('Phase 30 / P10 — hootl tools --mcp', () => {
  it('reports a broken MCP config without pretending the tool exists', async () => {
    const dir = path.join(projectRoot, 'registry', 'mcp-servers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'broken.json'),
      JSON.stringify({ id: 'broken', name: 'Broken', transport: 'stdio', command: 'node', args: ['/nonexistent/path.mjs'], connectTimeoutMs: 1500 })
    );

    const { code, out } = await runCli(['tools', '--mcp', '--trust-project', '--project-root', projectRoot]);

    expect(code).toBe(1); // one server failed
    expect(out).toContain('✖ broken (stdio)');
    // The static registry is still listed.
    expect(out).toContain('read_file');
  }, 20_000);

  it('without --mcp nothing is started and the static listing still works', async () => {
    const dir = path.join(projectRoot, 'registry', 'mcp-servers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'broken.json'),
      JSON.stringify({ id: 'broken', name: 'Broken', transport: 'stdio', command: 'definitely-not-a-real-binary' })
    );

    const { code, out } = await runCli(['tools', '--project-root', projectRoot]);

    expect(code).toBe(0);
    expect(out).not.toContain('✖');
    expect(out).toContain('read_file');
  }, 20_000);

  it('--mcp --json includes the MCP tools in the machine-readable output', async () => {
    const dir = path.join(projectRoot, 'registry', 'mcp-servers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'broken.json'),
      JSON.stringify({ id: 'broken', name: 'Broken', transport: 'stdio', command: 'definitely-not-a-real-binary', connectTimeoutMs: 1500 })
    );

    const { out } = await runCli(['tools', '--mcp', '--json', '--trust-project', '--project-root', projectRoot]);

    const parsed = JSON.parse(out) as Array<{ id: string }>;
    expect(parsed.some((t) => t.id === 'read_file')).toBe(true);
  }, 20_000);
});

describe('Phase 30 / P10 — tasks list is honest after a hard exit', () => {
  it('a task whose plan is cancelled is reported interrupted, not running', async () => {
    writeLog(taskEvents('plan_x'));
    const store = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    const plan = createPlan('cancelled', [
      {
        id: 'step-1',
        description: 'do it',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'running',
      },
    ]);
    plan.id = 'plan_x';
    plan.status = 'cancelled';
    store.save(plan);

    const { code, out } = await runCli(['tasks', 'list', '--project-root', projectRoot]);

    expect(code).toBe(0);
    expect(out).toContain('interrupted');
    expect(out).not.toMatch(/\b1 running\b/);
  });

  it('a still-running task of a running plan is NOT rewritten', async () => {
    writeLog([
      { timestamp: now(0), epochMs: 0, planId: 'plan_live', taskId: 'task_a', eventType: 'task:created', message: 'started', level: 'info' },
    ]);
    const store = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    const plan = createPlan('live', [
      {
        id: 'step-1',
        description: 'do it',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'running',
      },
    ]);
    plan.id = 'plan_live';
    plan.status = 'running';
    store.save(plan);

    const { out } = await runCli(['tasks', 'list', '--project-root', projectRoot]);

    expect(out).toContain('running');
    expect(out).toMatch(/1 running/);
  });
});

describe('Phase 30 / P10 — plans resume refuses what it cannot finish', () => {
  function seedPlan(status: 'cancelled' | 'cancelling' | 'completed'): string {
    const store = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
    const plan = createPlan('seeded', [
      {
        id: 'step-1',
        description: 'do it',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);
    plan.id = 'plan_seed';
    plan.status = status;
    store.save(plan);
    return 'plan_seed';
  }

  it('a cancelled plan is not re-run', async () => {
    const id = seedPlan('cancelled');
    const { code, errOut } = await runCli(['plans', 'resume', id, '--project-root', projectRoot]);

    expect(code).toBe(1); // refused, with a reason — not a silent re-run
    expect(errOut).toMatch(/cancellation is final/i);
    const plan = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans')).load(id);
    expect(plan?.status).toBe('cancelled');
    expect(plan?.steps[0].status).toBe('pending'); // nothing was dispatched
  });

  it('a plan stuck in `cancelling` is finalised, not executed', async () => {
    const id = seedPlan('cancelling');
    await runCli(['plans', 'resume', id, '--project-root', projectRoot]);

    const plan = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans')).load(id);
    expect(plan?.status).toBe('cancelled');
    expect(plan?.steps[0].status).toBe('pending');
  });

  it('a completed plan is not re-executed', async () => {
    const id = seedPlan('completed');
    const { code, errOut } = await runCli(['plans', 'resume', id, '--project-root', projectRoot]);
    expect(code).toBe(0);
    expect(errOut).toMatch(/already completed/i);

    const plan = new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans')).load(id);
    expect(plan?.status).toBe('completed');
    expect(plan?.steps[0].status).toBe('pending');
  });
});
