/**
 * Regressions for the defects found in the code review of phases A–K
 * (UNIFIED_EXECUTION_PLAN §3, "R-" rows).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { finalizePlan } from '../planning/planner.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function planResult(goal: string) {
  return {
    kind: 'plan' as const,
    isClear: true,
    needsClarification: [],
    errors: [],
    plan: finalizePlan({
      goal,
      steps: [
        {
          id: 'step-1',
          description: 'look around',
          dependsOn: [],
          assignedPersona: 'architect',
          assignedSkills: [],
          assignedTools: [],
          claimedResources: [],
          acceptanceCriteria: 'done',
        },
      ],
      clarifications: [],
    }),
  };
}

describe('R-09 — a cancelled confirmation never re-plans', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: false });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('Ctrl-C at the prompt (cancelled + feedback text) ends the run without a planner call', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    const spy = vi.spyOn(planner, 'plan').mockResolvedValue(planResult('goal') as never);
    const result = await orch.run('goal', {
      confirmCallback: async () => ({
        confirmed: false,
        cancelled: true,
        feedback: 'User cancelled the confirmation prompt.',
      }),
    });
    expect(result.review.outcome).toBe('cancelled');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('real feedback text still re-plans', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    const spy = vi.spyOn(planner, 'plan').mockResolvedValue(planResult('goal') as never);
    let calls = 0;
    await orch.run('goal', {
      confirmCallback: async () => {
        calls += 1;
        return calls === 1 ? { confirmed: false, feedback: 'use two steps' } : { confirmed: false, cancelled: true };
      },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('R-10 — session history is per run, not shared planner state', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: false });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('two concurrent runs in different sessions each see only their own history', async () => {
    const store = orch.sessionStore;
    const sA = store.createSession();
    const sB = store.createSession();
    for (const [sid, text] of [
      [sA, 'secret alpha project'],
      [sB, 'bravo work'],
    ] as const) {
      const i = store.addInteraction(sid, text)!;
      store.updateInteraction(sid, i.id, { outcome: 'success', completedAt: Date.now() });
    }
    const planner = (orch as unknown as {
      planner: { plan: (...a: unknown[]) => unknown; sessionHistory: () => string | undefined };
    }).planner;
    const seen: Record<string, string | undefined> = {};
    vi.spyOn(planner, 'plan').mockImplementation((async (request: string) => {
      await new Promise((r) => setTimeout(r, request === 'A' ? 30 : 0));
      seen[request] = planner.sessionHistory();
      return planResult(request);
    }) as never);
    const cancel = async () => ({ confirmed: false, cancelled: true });
    await Promise.all([
      orch.run('A', { sessionId: sA, confirmCallback: cancel }),
      orch.run('B', { sessionId: sB, confirmCallback: cancel }),
    ]);
    expect(seen.A).toContain('secret alpha project');
    expect(seen.A).not.toContain('bravo work');
    expect(seen.B).toContain('bravo work');
    expect(seen.B).not.toContain('secret alpha project');
  });
});

describe('R-11 — reconcile never closes a live interaction', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: true });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a run waiting at its confirmation keeps its draft plan and open interaction', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    vi.spyOn(planner, 'plan').mockResolvedValue(planResult('waiting goal') as never);
    let release!: (v: { confirmed: boolean; cancelled?: boolean }) => void;
    let reachedPrompt!: () => void;
    const atPrompt = new Promise<void>((r) => (reachedPrompt = r));
    const running = orch.run('waiting goal', {
      confirmCallback: () =>
        new Promise((resolve) => {
          release = resolve;
          reachedPrompt();
        }),
    });
    await atPrompt;
    orch.reconcileAbandonedInteractions();
    const sid = orch.sessionStore.listSessions()[0]!;
    const interaction = orch.sessionStore.getSession(sid)!.interactions[0]!;
    expect(interaction.completedAt).toBeUndefined();
    const planId = interaction.planIds[0]!;
    expect(orch.planStore.load(planId)?.status).toBe('draft');
    release({ confirmed: false, cancelled: true });
    await running;
  });

  it('an interaction owned by another live process is left alone', () => {
    const sid = orch.sessionStore.createSession();
    orch.sessionStore.addInteraction(sid, 'elsewhere');
    // process.ppid is alive and is not this process.
    const session = orch.sessionStore.getSession(sid)!;
    session.interactions[0]!.ownerPid = process.ppid;
    orch.sessionStore.saveSession(session);
    orch.reconcileAbandonedInteractions();
    expect(orch.sessionStore.getSession(sid)!.interactions[0]!.completedAt).toBeUndefined();
  });
});

describe('R-12 — usage accounting', () => {
  let root: string;
  let orch: Orchestrator;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-'));
    orch = new Orchestrator({ projectRoot: root, persistent: false });
    await orch.initialize();
  });
  afterEach(async () => {
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a chat answer is counted once, and each run reports only its own tokens', async () => {
    const planner = (orch as unknown as { planner: { plan: (...a: unknown[]) => unknown } }).planner;
    vi.spyOn(planner, 'plan').mockResolvedValue({
      kind: 'answer',
      isClear: true,
      needsClarification: [],
      errors: [],
      answer: 'draft',
    } as never);
    // No provider key in tests: the chat agent itself is a stub.
    vi.spyOn(planner as unknown as { buildChatAgent: () => unknown }, 'buildChatAgent').mockReturnValue({
      agentId: 'chat',
      systemPrompt: 's',
      tools: {},
      model: {},
      persona: { id: 'chat', name: 'Chat', system: 's', allowedTools: [] },
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
    } as never);
    const runtime = (orch as unknown as { agentRuntime: { run: (o: { eventBus: { emit: (e: unknown) => void }; taskId: string }) => unknown } }).agentRuntime;
    vi.spyOn(runtime, 'run').mockImplementation((async (o: { eventBus: { emit: (e: unknown) => void }; taskId: string }) => {
      const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      o.eventBus.emit({ type: 'agent:completed', taskId: o.taskId, agentId: 'chat', timestamp: Date.now(), status: 'completed', summary: 'hi', toolsUsed: [], usage });
      return { taskId: o.taskId, agentId: 'chat', success: true, summary: 'hi', result: 'hi', toolsUsed: [], errors: [], usage };
    }) as never);
    const confirm = async () => ({ confirmed: true });
    const first = await orch.run('hello', { mode: 'chat', confirmCallback: confirm });
    const second = await orch.run('hello again', { mode: 'chat', confirmCallback: confirm });
    expect(orch.getUsageSummary().totalTokens).toBe(30);
    expect(first.review.usage.totalTokens).toBe(15);
    expect(second.review.usage.totalTokens).toBe(15);
  });
});

describe('R-13 — delegate_task cannot deadlock the concurrency slots', () => {
  it('a parent waiting on its child lends its slot (maxConcurrentTasks = 1)', async () => {
    const { TaskRuntime } = await import('../runtime/task-runtime.js');
    const { EventBus } = await import('../runtime/event-bus.js');
    const agent = { agentId: 'a', tools: {}, systemPrompt: '', model: {} } as never;
    let tr!: InstanceType<typeof TaskRuntime>;
    const agentRuntime = {
      run: async (o: { taskId: string; prompt: string }) => {
        if (o.prompt === 'parent') {
          const child = tr.createTask({ agent, prompt: 'child', parentTaskId: o.taskId });
          const done = await tr.waitForTask(child, o.taskId);
          return { taskId: o.taskId, agentId: 'a', success: true, summary: `child:${done?.status}`, result: '', toolsUsed: [], errors: [] };
        }
        return { taskId: o.taskId, agentId: 'a', success: true, summary: 'ok', result: '', toolsUsed: [], errors: [] };
      },
    };
    tr = new TaskRuntime({ maxConcurrentTasks: 1, eventBus: new EventBus(), agentRuntime: agentRuntime as never });
    const parent = tr.createTask({ agent, prompt: 'parent' });
    const outcome = await Promise.race([
      tr.waitForTask(parent),
      new Promise((r) => setTimeout(() => r('deadlock'), 2_000)),
    ]);
    expect(outcome).not.toBe('deadlock');
    expect(tr.getStatus(parent)?.summary).toBe('child:completed');
    tr.destroy();
  });
});

describe('R-14 — plan ownership is claimed atomically across processes', () => {
  it('of several processes racing for one plan, exactly one wins', async () => {
    const { spawn } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-owner-'));
    const script = `
      import { tryAcquirePlanOwner } from ${JSON.stringify(path.resolve(__dirname, '../runtime/plan-owner.ts'))};
      const h = tryAcquirePlanOwner(${JSON.stringify(dir)}, 'plan_race');
      process.stdout.write(h ? 'WON' : 'LOST');
      setTimeout(() => process.exit(0), 300);
    `;
    const tsx = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
    const runOne = () =>
      new Promise<string>((resolve) => {
        const child = spawn(tsx, ['--input-type=module', '-e', script]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => resolve(out.trim()));
      });
    const results = await Promise.all([runOne(), runOne(), runOne(), runOne()]);
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('R-15 — breaking a stale lock never steals a fresh one', () => {
  it('a waiter that judged the old lock stale leaves a newer lock in place', async () => {
    const { staleLockIdentity, breakStaleLock } = await import('../runtime/file-lock.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-lock-'));
    const lockPath = path.join(dir, 'x.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, acquiredAt: 0 }));
    const staleIno = staleLockIdentity(lockPath, 1);
    expect(typeof staleIno).toBe('string');
    // Meanwhile another waiter broke it and took a fresh lock at the same path.
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    expect(breakStaleLock(lockPath, staleIno!)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.stale'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('R-16 — a persona using a down MCP server\'s tools does not block start-up', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-review-mcp-'));
    fs.mkdirSync(path.join(root, 'registry', 'personas'), { recursive: true });
    fs.mkdirSync(path.join(root, 'registry', 'mcp-servers'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'registry', 'personas', 'searcher.json'),
      JSON.stringify({ id: 'searcher', name: 'Searcher', system: 's', allowedTools: ['read_file', 'web_search'] }),
    );
    fs.writeFileSync(
      path.join(root, 'registry', 'mcp-servers', 'down.json'),
      JSON.stringify({
        id: 'down',
        name: 'Down',
        transport: 'stdio',
        command: path.join(root, 'no-such-binary'),
        connectTimeoutMs: 500,
      }),
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('trusted project, server fails to start → warning, not a crash', async () => {
    const orch = new Orchestrator({ projectRoot: root, trustedProject: true });
    await expect(orch.initialize()).resolves.toBeUndefined();
    await orch.shutdown();
  });

  it('untrusted project (MCP layer skipped) → warning, not a crash', async () => {
    const orch = new Orchestrator({ projectRoot: root });
    await expect(orch.initialize()).resolves.toBeUndefined();
    await orch.shutdown();
  });

  it('a plain typo with every MCP server healthy still fails start-up', async () => {
    fs.rmSync(path.join(root, 'registry', 'mcp-servers', 'down.json'));
    const orch = new Orchestrator({ projectRoot: root, trustedProject: true });
    await expect(orch.initialize()).rejects.toThrow(/allowedTools/i);
  });
});

describe('R-18 — process output is read to the end', () => {
  it('spawnArgv returns every byte a fast-exiting child wrote', async () => {
    const { spawnArgv } = await import('../tools/spawn-argv.js');
    for (let i = 0; i < 5; i++) {
      const result = await spawnArgv(
        ['node', '-e', 'process.stdout.write("y".repeat(20000)); process.exit(0)'],
        { cwd: os.tmpdir(), maxBytes: 1_000_000 },
      );
      expect(result.stdout.length).toBe(20000);
    }
  });

  it('runGit returns a large blob in full', async () => {
    const { runGit } = await import('../tools/git/git-runner.js');
    const { execFileSync } = await import('node:child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'big.txt'), 'z'.repeat(150_000));
      execFileSync('git', ['add', 'big.txt'], { cwd: repo });
      const blob = await runGit(repo, ['show', ':big.txt'], { maxBytes: 1_000_000 });
      expect(blob.ok && blob.stdout.length).toBe(150_000);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('R-19 — language detection ignores quoted code', () => {
  it('a Persian request full of paths and identifiers is still Persian', async () => {
    const { detectLanguage } = await import('../language.js');
    expect(detectLanguage('فایل src/components/LoginButton.tsx و README.md رو درست کن')?.code).toBe('fa');
    expect(detectLanguage('تابع `validateUserSession` در auth_service.ts را بازنویسی کن')?.code).toBe('fa');
    expect(detectLanguage('https://example.com/docs/getting-started را بخوان و خلاصه کن')?.code).toBe('fa');
  });

  it('an English sentence with one quoted foreign word stays English', async () => {
    const { detectLanguage } = await import('../language.js');
    expect(detectLanguage('Please translate the word "سلام" into French for the greeting page')).toBeUndefined();
  });
});

describe('R-20 — the tool-result cap trims to the budget, not to a stub', () => {
  it('a file just over the cap keeps almost all of its content', async () => {
    const { capToolResult, TOOL_RESULT_CHAR_CAP } = await import('../runtime/tool-result-cap.js');
    const capped = capToolResult({ success: true, content: 'a'.repeat(31_000), filePath: 'x.ts' }) as {
      content: string;
      truncated: boolean;
      filePath: string;
    };
    expect(capped.truncated).toBe(true);
    expect(capped.filePath).toBe('x.ts');
    expect(capped.content.length).toBeGreaterThan(29_000);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP);
  });

  it('escape-heavy content still fits', async () => {
    const { capToolResult, TOOL_RESULT_CHAR_CAP } = await import('../runtime/tool-result-cap.js');
    const capped = capToolResult({ content: '"\n'.repeat(20_000) });
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP);
  });
});

describe('R-21 — log rotation keeps a bounded history; store retention is configurable', () => {
  it('keeps only the newest rotated logs', async () => {
    const { ObservabilityLogger, ROTATED_LOGS_KEPT } = await import('../runtime/observability-logger.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-rot-'));
    const logFilePath = path.join(dir, 'observability.jsonl');
    // Old rotated files from earlier runs.
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(`${logFilePath}.2020-01-0${i + 1}T00-00-00-000Z`, 'x');
    }
    const logger = new ObservabilityLogger({ logFilePath, maxLogBytes: 200 });
    for (let i = 0; i < 20; i++) {
      logger.log({ eventType: 'system:info', message: `entry ${i} ${'p'.repeat(80)}` } as never);
    }
    logger.close();
    const rotated = fs.readdirSync(dir).filter((f) => f.startsWith('observability.jsonl.'));
    expect(rotated.length).toBe(ROTATED_LOGS_KEPT);
    expect(rotated.some((f) => f.startsWith('observability.jsonl.2020-'))).toBe(false);
    expect(fs.existsSync(logFilePath)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('HOTL_RETENTION_DAYS sets how long plans and sessions are kept', async () => {
    const { storeRetentionDays } = await import('../orchestrator.js');
    expect(storeRetentionDays({})).toBe(365);
    expect(storeRetentionDays({ HOTL_RETENTION_DAYS: '0' })).toBe(0);
    expect(storeRetentionDays({ HOTL_RETENTION_DAYS: '30' })).toBe(30);
    expect(storeRetentionDays({ HOTL_RETENTION_DAYS: 'soon' })).toBe(365);
  });
});

describe('R-23 — edit_file keeps each line\'s own line ending', () => {
  it('a mixed CRLF/LF file is byte-identical outside the edit', async () => {
    const { applyFileEdits } = await import('../tools/fs/lib.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-eol-'));
    const file = path.join(dir, 'mixed.txt');
    fs.writeFileSync(file, 'one\r\ntwo\nthree\r\nfour\nfive');
    await applyFileEdits(file, [{ oldText: 'three', newText: 'THREE\nand a half' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\r\ntwo\nTHREE\r\nand a half\r\nfour\nfive');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an all-CRLF file stays all-CRLF, an all-LF file stays LF', async () => {
    const { applyFileEdits } = await import('../tools/fs/lib.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-eol-'));
    const crlf = path.join(dir, 'a.txt');
    fs.writeFileSync(crlf, 'a\r\nb\r\nc\r\n');
    await applyFileEdits(crlf, [{ oldText: 'b', newText: 'B1\nB2' }]);
    expect(fs.readFileSync(crlf, 'utf8')).toBe('a\r\nB1\r\nB2\r\nc\r\n');
    const lf = path.join(dir, 'b.txt');
    fs.writeFileSync(lf, 'a\nb\nc\n');
    await applyFileEdits(lf, [{ oldText: 'b', newText: 'B' }]);
    expect(fs.readFileSync(lf, 'utf8')).toBe('a\nB\nc\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ARCH-003 — one layered MCP-server view for CLI, server and runtime', () => {
  it('merges layers by id (project wins), tags the layer, and applies the trust rule', async () => {
    const { loadLayeredMcpServers, mayConnectMcpServer } = await import('../tools/mcp-bootstrap.js');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-arch3-'));
    const dir = path.join(project, 'registry', 'mcp-servers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mine.json'),
      JSON.stringify({ id: 'mine', name: 'Mine', transport: 'stdio', command: 'node' }),
    );
    const { servers } = loadLayeredMcpServers(project);
    const mine = servers.find((s) => s.config.id === 'mine')!;
    expect(mine.scope).toBe('project');
    expect(mayConnectMcpServer(mine, false)).toBe(false);
    expect(mayConnectMcpServer(mine, true)).toBe(true);
    for (const s of servers.filter((x) => x.scope === 'package')) {
      expect(mayConnectMcpServer(s, false)).toBe(true);
    }
    fs.rmSync(project, { recursive: true, force: true });
  });
});

describe('E-01 — the planner catalog shows every tool a persona may use', () => {
  it('lists coder\'s full allowedTools (not a 16-tool cut)', async () => {
    const { buildCatalogBlock } = await import('../planning/catalog-prompt.js');
    const { PersonaRegistry } = await import('../registries/persona-registry.js');
    const { SkillRegistry } = await import('../registries/skill-registry.js');
    const { ToolRegistry } = await import('../registries/tool-registry.js');
    const personas = new PersonaRegistry();
    personas.loadFromDirectory(path.resolve(__dirname, '../../../registry/personas'));
    const block = buildCatalogBlock({
      personaRegistry: personas,
      skillRegistry: new SkillRegistry({ toolRegistry: new ToolRegistry() }),
    });
    const coder = personas.get('coder')!;
    const line = block.split('\n').find((l) => l.startsWith('- coder:'))!;
    for (const tool of coder.allowedTools) expect(line).toContain(tool);
    expect(line).not.toContain('…+');
  });
});

describe('E-07 — a chat answer keeps the user\'s language', () => {
  it('the chat agent of a Persian question is told to answer in Persian', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-lang-'));
    const orch = new Orchestrator({
      projectRoot: root,
      persistent: false,
      env: { ...process.env, OPENAI_API_KEY: 'sk-test' },
    });
    await orch.initialize();
    const { detectLanguage } = await import('../language.js');
    const planner = (orch as unknown as {
      planner: { buildChatAgent: (m?: string, t?: readonly string[], l?: unknown) => { systemPrompt: string } };
    }).planner;
    const agent = planner.buildChatAgent(undefined, undefined, detectLanguage('این پروژه چه کاری انجام می‌دهد؟'));
    expect(agent.systemPrompt).toMatch(/Persian/);
    await orch.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
