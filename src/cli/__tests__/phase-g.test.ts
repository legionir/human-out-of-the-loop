/**
 * Phase G — CLI, REPL and server (UNIFIED G-01…G-18).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { main, createProgram } from '../../cli.js';
import { Repl, parseInteractiveArgs } from '../repl.js';
import { readLine } from '../line-editor.js';
import { showSplash } from '../splash.js';
import { parseDotEnv, resolveCliDefaults } from '../utils/config.js';
import { displayWidth, graphemeWidth, graphemes } from '../utils/graphemes.js';
import { planningInterruptAction, validateRunOptions } from '../commands/run.js';
import { confirmPlanInteractively } from '../utils/confirm.js';
import { OrchestratorCache } from '../utils/orchestrator-cache.js';
import { evaluatePlanResume } from '../../ai/runtime/resume-guard.js';
import { SESSION_LABEL_MAX_CHARS, SESSION_REVIEW_SUMMARY_MAX_CHARS } from '../../ai/runtime/session-limits.js';
import { FileSessionStore } from '../../ai/runtime/session-store.js';
import { JSON_RPC_ERRORS, parseMessage } from '../../mcp/protocol.js';
import { createMcpServer } from '../../mcp/server.js';
import { collectProjectUsage } from '../commands/usage.js';
import { createApp } from '../../server.js';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);
process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

function makeProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(REGISTRY_SRC, path.join(dir, 'registry'), { recursive: true });
  return dir;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; errOut: string }> {
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
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'hootl', ...args]);
    return { code: code ?? process.exitCode ?? 0, out: chunks.join(''), errOut: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prev;
  }
}

describe('G-01 Ctrl-C during planning', () => {
  it('aborts only the current goal in the REPL and exits for hootl run', () => {
    expect(
      planningInterruptAction({ currentPlanId: undefined, interruptRequested: false, exitOnInterrupt: true }),
    ).toBe('exit');
    expect(
      planningInterruptAction({ currentPlanId: undefined, interruptRequested: false, exitOnInterrupt: false }),
    ).toBe('abort-planning');
    expect(
      planningInterruptAction({ currentPlanId: 'plan_1', interruptRequested: false, exitOnInterrupt: false }),
    ).toBe('cancel-plan');
    expect(
      planningInterruptAction({ currentPlanId: 'plan_1', interruptRequested: true, exitOnInterrupt: false }),
    ).toBe('exit');
  });
});

describe('G-02 non-TTY without --yes', () => {
  it('does not call the model', async () => {
    mockGenerateObject.mockClear();
    mockGenerateText.mockClear();
    const project = makeProject('g02-');
    try {
      const { code, errOut } = await runCli(['run', 'Build a login page', '--project-root', project]);
      expect(code).toBe(1);
      expect(errOut.toLowerCase()).toContain('tty');
      expect(mockGenerateObject).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('G-03 /cd env snapshot', () => {
  let home: HomeHandle;
  let startCwd: string;
  beforeEach(() => {
    startCwd = process.cwd();
    home = useIsolatedHome('g03-home-');
  });
  afterEach(() => {
    process.chdir(startCwd);
    home.restore();
  });

  it('drops project A keys and loads project B, then recomputes the model', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'g03-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'g03-b-'));
    fs.mkdirSync(path.join(a, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(a, '.env'), 'HOTL_G03=from-a\nHOTL_MODEL=gpt-4o\n');
    fs.writeFileSync(path.join(b, '.env'), 'HOTL_G03=from-b\nHOTL_MODEL=claude-sonnet\n');
    delete process.env.HOTL_G03;
    delete process.env.HOTL_MODEL;
    const r = new Repl({ binName: 'hootl', createProgram }, {
      cwd: a,
      persistent: false,
      autoConfirm: true,
      verbose: false,
      mode: 'auto',
    });
    await r.handle(`/cd ${a}`);
    expect(process.env.HOTL_G03).toBe('from-a');
    await r.handle(`/cd ${b}`);
    expect(process.env.HOTL_G03).toBe('from-b');
    expect(r.state.cwd).toBe(fs.realpathSync(b));
    expect(r.state.model).toBe('claude-sonnet');
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});

describe('G-04 deleted session', () => {
  it('clears sessionId after Session not found', async () => {
    const project = makeProject('g04-');
    try {
      const r = new Repl({ binName: 'hootl', createProgram }, {
        cwd: project,
        persistent: true,
        autoConfirm: true,
        verbose: false,
        mode: 'auto',
        sessionId: 'session_missing',
      });
      await r.handle('do a thing');
      expect(r.state.sessionId).toBeUndefined();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('G-05 bracketed paste', () => {
  it('turns a three-line paste into one goal', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const done = readLine({
      input,
      output,
      prompt: '> ',
      history: [],
      suggest: () => [],
    });
    (input as unknown as PassThrough).write('\x1b[200~one\ntwo\nthree\x1b[201~');
    await new Promise((r) => setTimeout(r, 20));
    (input as unknown as PassThrough).write('\r');
    const result = await done;
    expect(result).toEqual({ kind: 'line', line: 'one\ntwo\nthree' });
  });
});

describe('G-06 grapheme cursor', () => {
  it('counts emoji as 2 columns and ZWNJ/diacritics as 0', () => {
    expect(displayWidth('😀')).toBe(2);
    expect(graphemeWidth('😀')).toBe(2);
    expect(displayWidth('\u200c')).toBe(0); // ZWNJ
    expect(displayWidth('ا\u064B')).toBe(1); // alef + fatha
    expect(graphemes('👨‍👩‍👧‍👦').length).toBe(1);
  });
});

describe('G-07 ExitPromptError', () => {
  it('maps Ctrl-C at confirm to confirmed:false', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const stdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    Object.defineProperty(process, 'stdin', { value: { isTTY: true } });
    Object.defineProperty(process, 'stdout', { value: { isTTY: true, write: () => true } });
    const inquirer = await import('inquirer');
    const err = Object.assign(new Error('User force closed the prompt with CTRL+C'), {
      name: 'ExitPromptError',
    });
    const spy = vi.spyOn(inquirer.default, 'prompt').mockRejectedValueOnce(err);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await confirmPlanInteractively('plan text');
      expect(result.confirmed).toBe(false);
    } finally {
      spy.mockRestore();
      outSpy.mockRestore();
      Object.defineProperty(process, 'stdin', stdin);
      Object.defineProperty(process, 'stdout', stdout);
    }
  });
});

describe('G-08 resume guard', () => {
  it('is the same decision for CLI and server', () => {
    const cancelled = evaluatePlanResume({ found: true, status: 'cancelled', liveOwner: false });
    const completed = evaluatePlanResume({ found: true, status: 'completed', liveOwner: false });
    const live = evaluatePlanResume({ found: true, status: 'running', liveOwner: true });
    const ok = evaluatePlanResume({ found: true, status: 'executing', liveOwner: false });
    expect(cancelled.action).toBe('refuse');
    expect(completed.action).toBe('noop');
    expect(live).toMatchObject({ action: 'refuse', httpStatus: 409, code: 'PLAN_LIVE_OWNER' });
    expect(ok.action).toBe('resume');
    expect(ok.httpStatus).toBe(202);
  });
});

describe('G-09 orchestrator cache', () => {
  it('reuses one Orchestrator per (cwd, model, persistent) and initializes once', async () => {
    const project = makeProject('g09-');
    const cache = new OrchestratorCache();
    try {
      const a = cache.acquire({ cwd: project, model: 'gpt-4o', persistent: false });
      const b = cache.acquire({ cwd: project, model: 'gpt-4o', persistent: false });
      expect(a.orchestrator).toBe(b.orchestrator);
      expect(cache.constructCount).toBe(1);
      await a.orchestrator.initialize();
      await b.orchestrator.initialize();
      expect(cache.initializeCount).toBe(1);
    } finally {
      await cache.invalidate();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('G-10 /run passthrough', () => {
  it('injects the REPL model, persistent, yes and session', async () => {
    const captured: string[][] = [];
    const project = makeProject('g10-');
    try {
      const r = new Repl(
        {
          binName: 'hootl',
          createProgram: (bin) => {
            const program = createProgram(bin);
            program.parseAsync = async (argv) => {
              captured.push(argv as string[]);
              return program;
            };
            return program;
          },
        },
        {
          cwd: project,
          model: 'gpt-4o',
          persistent: true,
          autoConfirm: true,
          verbose: false,
          mode: 'auto',
          sessionId: 'session_abc',
        },
      );
      await r.handle('/run "fix the tests"');
      const argv = captured[0] ?? [];
      expect(argv).toContain('--model');
      expect(argv).toContain('gpt-4o');
      expect(argv).toContain('--persistent');
      expect(argv).toContain('--yes');
      expect(argv).toContain('--session');
      expect(argv).toContain('session_abc');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('G-11 JSON-RPC batch and object id', () => {
  it('returns a batch array and rejects an object id with -32600', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g11-mcp-'));
    const server = createMcpServer({ projectRoot: dir });
    try {
      const batch = await server.handleFrame(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ]),
      );
      const parsed = JSON.parse(batch[0]!) as Array<{ id: number }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.map((r) => r.id)).toEqual([1, 2]);

      const bad = parseMessage(JSON.stringify({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.response.error?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('G-12 validation and help', () => {
  it('plans resume --timeout-ms abc exits 2', async () => {
    const project = makeProject('g12-');
    try {
      const { code, errOut } = await runCli([
        'plans',
        'resume',
        'plan_x',
        '--timeout-ms',
        'abc',
        '--project-root',
        project,
      ]);
      expect(code).toBe(2);
      expect(errOut).toMatch(/timeout-ms/i);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('/config set defaultMode rejects unknown values', async () => {
    const home = useIsolatedHome('g12-home-');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'g12-repl-'));
    const errChunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      errChunks.push(String(c));
      return true;
    });
    try {
      const r = new Repl({ binName: 'hootl', createProgram }, {
        cwd: project,
        persistent: false,
        autoConfirm: false,
        verbose: false,
        mode: 'auto',
      });
      await r.handle('/config set defaultMode foo');
      expect(errChunks.join('')).toMatch(/Unknown mode/i);
    } finally {
      spy.mockRestore();
      home.restore();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('run help describes exit 2 as invalid usage without promising unknown-model', async () => {
    const { out, errOut } = await runCli(['run', '--help']);
    const text = out + errOut;
    expect(text).toMatch(/invalid usage/i);
    expect(text).not.toMatch(/unknown model, out-of-range/);
  });
});

describe('G-13 splash dismiss + registry cache', () => {
  it('any key dismisses the splash before the timeout', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const started = Date.now();
    const pending = showSplash(output, { ms: 5000, input: input as NodeJS.ReadStream });
    (input as unknown as PassThrough).write('x');
    await pending;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('G-14 usage API equals CLI jsonl', () => {
  it('GET /api/usage?planId matches collectProjectUsage', async () => {
    const project = makeProject('g14-');
    const runtime = path.join(project, '.ai-runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, 'observability.jsonl'),
      JSON.stringify({
        eventType: 'task:completed',
        planId: 'plan_g14',
        payload: {
          usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, cacheReadTokens: 1, cacheWriteTokens: 2 },
        },
      }) + '\n',
    );
    const created = createApp({ projectRoot: project, persistent: true, model: 'gpt-4o' });
    try {
      const cli = collectProjectUsage(project);
      const row = cli.rows.find((r) => r.planId === 'plan_g14')!;
      const api = await request(created.app).get('/api/usage?planId=plan_g14').expect(200);
      expect(api.body).toMatchObject({
        planId: 'plan_g14',
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        taskCount: row.taskCount,
      });
    } finally {
      await created.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('G-15 session file growth and shared label limit', () => {
  it('writes compact JSON, clips review summaries, and shares the label ceiling', () => {
    expect(SESSION_LABEL_MAX_CHARS).toBe(64);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g15-sess-'));
    const store = new FileSessionStore(dir);
    const id = store.createSession('ok');
    store.updateInteraction(
      id,
      store.addInteraction(id, 'hello')!.id,
      { reviewSummary: 'x'.repeat(SESSION_REVIEW_SUMMARY_MAX_CHARS + 50), outcome: 'success' },
    );
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf-8');
    expect(raw).not.toContain('\n  ');
    const session = store.getSession(id)!;
    expect(session.interactions[0]!.reviewSummary!.length).toBe(SESSION_REVIEW_SUMMARY_MAX_CHARS);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('G-16 .env parser', () => {
  it.each([
    ['export KEY=value', { KEY: 'value' }],
    ['HOTL_MODE=chat # default', { HOTL_MODE: 'chat' }],
    ['HOTL_MODEL="gpt-4o" # prod', { HOTL_MODEL: 'gpt-4o' }],
    ['GREETING="hello\\nworld"', { GREETING: 'hello\nworld' }],
  ] as Array<[string, Record<string, string>]>)('parses %j', (body, expected) => {
    expect(parseDotEnv(body)).toEqual(expected);
  });
});

describe('G-17 shared config resolve', () => {
  it('resolves the same projectRoot/persistent/model for every entry point', () => {
    const home = useIsolatedHome('g17-home-');
    try {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'g17-cwd-'));
      const a = resolveCliDefaults({ cwd, persistent: true, model: 'gpt-4o' });
      const b = resolveCliDefaults({ cwd, persistent: true, model: 'gpt-4o' });
      expect(a).toEqual(b);
      const off = resolveCliDefaults({ cwd, noPersistent: true });
      expect(off.persistent).toBe(false);
      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      home.restore();
    }
  });

  it('parses --no-persistent on the interactive command line', () => {
    expect(parseInteractiveArgs(['--no-persistent'])).toMatchObject({ persistent: false, noPersistent: true });
  });
});

describe('G-18 no custom baseURL in run output', () => {
  it('never prints a custom gateway URL', async () => {
    mockGenerateObject.mockResolvedValue({
      object: { kind: 'answer', answer: 'hi' },
    } as never);
    mockGenerateText.mockResolvedValue({ text: 'hi' } as never);
    const project = makeProject('g18-');
    try {
      const { out, errOut } = await runCli([
        'run',
        '@chat hello',
        '--yes',
        '--project-root',
        project,
        '--model',
        'gpt-4o',
      ]);
      expect(out + errOut).not.toMatch(/https?:\/\//);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('validateRunOptions NaN timeout', () => {
  it('rejects non-integer timeout-ms', () => {
    expect(validateRunOptions({ timeoutMs: Number('abc') })).toMatch(/timeout-ms/);
  });
});
