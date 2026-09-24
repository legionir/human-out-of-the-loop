/**
 * Interactive mode (`hootl` with no arguments in a terminal).
 *
 * The prompt loop itself is driven end to end in a real PTY (see the
 * CHANGELOG); these tests pin the pieces that decide behaviour: argument
 * splitting, on/off parsing, and what each slash command does to the
 * session state and the saved config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repl, splitArgs, parseOnOff, displayPath, parseInteractiveArgs, type ReplState } from '../repl.js';
import { PassThrough } from 'node:stream';
import { readLine, type Suggestion } from '../line-editor.js';
import { renderSplash, bigText } from '../splash.js';
import { createProgram, main } from '../../cli.js';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';
import { globalConfigPath, loadGlobalConfig } from '../utils/config.js';

let home: HomeHandle;
let project: string;
let startCwd: string;
let stdout: string;
let stderr: string;

function repl(overrides: Partial<ReplState> = {}): Repl {
  return new Repl(
    { binName: 'hootl', createProgram },
    { cwd: project, persistent: false, autoConfirm: false, verbose: false, ...overrides },
  );
}

beforeEach(() => {
  startCwd = process.cwd();
  home = useIsolatedHome('repl-home-');
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repl-project-')));
  fs.mkdirSync(path.join(project, 'sub'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(startCwd);
  home.restore();
});

describe('interactive mode — parsing', () => {
  it('splits arguments on whitespace and honours quotes', () => {
    expect(splitArgs('plans   show  abc')).toEqual(['plans', 'show', 'abc']);
    expect(splitArgs(`run "fix the tests" --yes`)).toEqual(['run', 'fix the tests', '--yes']);
    expect(splitArgs(`sessions label s1 ''`)).toEqual(['sessions', 'label', 's1', '']);
  });

  it('parses on/off and rejects anything else', () => {
    expect(parseOnOff('on')).toBe(true);
    expect(parseOnOff('OFF')).toBe(false);
    expect(parseOnOff('true')).toBe(true);
    expect(() => parseOnOff('maybe')).toThrow('expected on or off');
  });

  it('shows the home directory as ~', () => {
    expect(displayPath(os.homedir())).toBe('~');
    expect(displayPath(path.join(os.homedir(), 'work'))).toBe(`~${path.sep}work`);
    expect(displayPath(project)).toBe(project);
  });
});

describe('interactive mode — session settings', () => {
  it('/persistent, /yes and /verbose toggle the session state', async () => {
    const r = repl();
    await r.handle('/persistent on');
    await r.handle('/yes on');
    await r.handle('/verbose on');
    expect(r.state).toMatchObject({ persistent: true, autoConfirm: true, verbose: true });
    await r.handle('/yes off');
    expect(r.state.autoConfirm).toBe(false);
  });

  it('a bad on/off value is reported, not thrown', async () => {
    const r = repl();
    await r.handle('/persistent sometimes');
    expect(stderr).toContain('expected on or off');
    expect(r.state.persistent).toBe(false);
  });

  it('/model lists models and switches to a registered id or any provider model name', async () => {
    const r = repl();
    await r.handle('/model');
    expect(stdout).toContain('gpt-4o');
    await r.handle('/model claude-sonnet');
    expect(r.state.model).toBe('claude-sonnet');
    // Models are chosen at runtime: an unlisted name is a provider model name.
    await r.handle('/model @aur/auto');
    expect(r.state.model).toBe('@aur/auto');
    expect(stdout).toContain('used as a provider model name');
  });

  it('/cd changes the active directory, and rejects a missing one', async () => {
    const r = repl({ sessionId: 'session_x' });
    await r.handle('/cd sub');
    expect(r.state.cwd).toBe(path.join(project, 'sub'));
    expect(process.cwd()).toBe(path.join(project, 'sub'));
    // A session belongs to one project.
    expect(r.state.sessionId).toBeUndefined();

    await r.handle('/cd does-not-exist');
    expect(stderr).toContain('No such directory');
    expect(r.state.cwd).toBe(path.join(project, 'sub'));
  });

  it('/new forgets the session', async () => {
    const r = repl({ sessionId: 'session_x' });
    await r.handle('/new');
    expect(r.state.sessionId).toBeUndefined();
  });

  it('an unknown command points at /help', async () => {
    await repl().handle('/frobnicate');
    expect(stderr).toContain('Unknown command /frobnicate');
  });
});

describe('interactive mode — /config', () => {
  it('saves, applies and removes defaults in the global config', async () => {
    const r = repl();
    await r.handle('/config set defaultModel claude-sonnet');
    await r.handle('/config set persistent on');
    expect(loadGlobalConfig()).toEqual({ defaultModel: 'claude-sonnet', persistent: true });
    expect(globalConfigPath().startsWith(home.home)).toBe(true);
    // Applied to the running session too.
    expect(r.state).toMatchObject({ model: 'claude-sonnet', persistent: true });

    await r.handle('/config unset persistent');
    expect(loadGlobalConfig()).toEqual({ defaultModel: 'claude-sonnet' });
  });

  it('refuses unknown keys (API keys never go into the config file)', async () => {
    const r = repl();
    await r.handle('/config set apiKey sk-123');
    expect(stderr).toContain('Unknown key "apiKey"');
    expect(fs.existsSync(globalConfigPath())).toBe(false);
  });

  it('/config shows the session and the saved defaults', async () => {
    await repl({ model: 'gpt-4o' }).handle('/config');
    expect(stdout).toContain('This session');
    expect(stdout).toContain('Saved defaults');
  });
});

describe('interactive mode — regular commands', () => {
  it('runs a subcommand in the active directory without touching the exit code', async () => {
    process.chdir(project);
    process.exitCode = undefined;
    const r = repl();
    await r.handle('/plans show plan_missing');
    // `plans show` of an unknown plan fails (exit 1) — but that is the
    // command's result, not the REPL's.
    expect(process.exitCode).toBeUndefined();
    await r.handle('/models --json');
    expect(stdout).toContain('"gpt-4o"');
  });

  it('`--help` of a subcommand prints help and returns to the prompt', async () => {
    await repl().handle('/plans --help');
    expect(stdout).toContain('SUBCOMMANDS');
  });
});

describe('interactive mode — entry point', () => {
  it('without a terminal, no arguments still prints the help (scripts, CI)', async () => {
    const code = await main(['node', 'hootl']);
    expect(stdout + stderr).toContain('Usage:');
    expect(code).not.toBe(0);
  });
});

describe('interactive mode — command-line options', () => {
  it('options without a subcommand open interactive mode (the Windows `--x=y` form too)', () => {
    expect(parseInteractiveArgs([])).toEqual({});
    expect(parseInteractiveArgs(['--project-root=I:\\vs-ai-coder\\packages'])).toEqual({
      projectRoot: 'I:\\vs-ai-coder\\packages',
    });
    expect(parseInteractiveArgs(['--project-root', 'x', '--model', '@aur/auto', '--persistent', '--yes', '--no-splash'])).toEqual({
      projectRoot: 'x',
      model: '@aur/auto',
      persistent: true,
      yes: true,
      splash: false,
    });
  });

  it('anything else is left to commander', () => {
    expect(parseInteractiveArgs(['run', 'goal'])).toBeUndefined();
    expect(parseInteractiveArgs(['--help'])).toBeUndefined();
    expect(parseInteractiveArgs(['--bogus'])).toBeUndefined();
    expect(parseInteractiveArgs(['--project-root'])).toBeUndefined();
  });
});

describe('interactive mode — the / menu', () => {
  it('"/" lists every command, and typing filters it', () => {
    const r = repl();
    const all = r.suggest('/').map((s) => s.value);
    expect(all).toEqual(expect.arrayContaining(['/help', '/model', '/config', '/plans', '/exit']));
    expect(r.suggest('/mo').map((s) => s.value)).toEqual(['/model', '/models']);
    expect(r.suggest('hello')).toEqual([]);
  });

  it('a complete command closes the menu; its argument gets its own menu', () => {
    const r = repl();
    expect(r.suggest('/help')).toEqual([]);
    expect(r.suggest('/persistent ').map((s) => s.value)).toEqual(['/persistent on', '/persistent off']);
    expect(r.suggest('/model gpt').map((s) => s.label)).toContain('gpt-4o');
    expect(r.suggest('/cd s').map((s) => s.label)).toContain('sub');
  });
});

describe('the start screen', () => {
  it('draws HOOTL in block letters, centered, after clearing the screen', () => {
    const rows = bigText('HOOTL');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain('██╗  ██╗');
    const screen = renderSplash({ columns: 120, rows: 30 });
    expect(screen.startsWith('\x1b[2J')).toBe(true);
    const firstArt = screen.split('\n').find((l) => l.includes('█'))!;
    const indent = firstArt.replace(/\x1b\[[0-9;]*m/g, '').search(/\S/);
    expect(indent).toBe(Math.floor((120 - rows[0]!.length) / 2));
  });
});

describe('the line editor', () => {
  const KEYS = {
    down: '\x1b[B',
    up: '\x1b[A',
    tab: '\t',
    enter: '\r',
    esc: '\x1b',
    ctrlC: '\x03',
  };

  async function type(chunks: string[], suggest: (l: string) => Suggestion[], history: string[] = []) {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const done = readLine({ input, output, prompt: '> ', history, suggest });
    for (const c of chunks) {
      (input as unknown as PassThrough).write(c);
      // A lone ESC is only reported after readline's escape timeout (500ms).
      await new Promise((r) => setTimeout(r, c === KEYS.esc ? 600 : 5));
    }
    return done;
  }

  const menu = (line: string): Suggestion[] =>
    line.startsWith('/') && !line.includes(' ')
      ? ['/help', '/model', '/models'].filter((v) => v.startsWith(line)).map((value) => ({ value }))
      : [];

  it('Enter runs the highlighted command; ↓ moves the highlight', async () => {
    expect(await type(['/', KEYS.enter], menu)).toEqual({ kind: 'line', line: '/help' });
    expect(await type(['/', KEYS.down, KEYS.enter], menu)).toEqual({ kind: 'line', line: '/model' });
    expect(await type(['/', KEYS.up, KEYS.enter], menu)).toEqual({ kind: 'line', line: '/models' });
  });

  it('Tab completes and keeps editing', async () => {
    expect(await type(['/mo', KEYS.tab, 's', KEYS.enter], menu)).toEqual({ kind: 'line', line: '/models' });
  });

  it('Esc closes the menu so Enter submits what was typed', async () => {
    expect(await type(['/mo', KEYS.esc, KEYS.enter], menu)).toEqual({ kind: 'line', line: '/mo' });
  });

  it('↑ walks the history when the menu is closed', async () => {
    expect(await type([KEYS.up, KEYS.enter], menu, ['fix the tests'])).toEqual({ kind: 'line', line: 'fix the tests' });
  });

  it('Ctrl-C clears a typed line, and interrupts on an empty one', async () => {
    expect(await type(['abc', KEYS.ctrlC, 'x', KEYS.enter], menu)).toEqual({ kind: 'line', line: 'x' });
    expect(await type([KEYS.ctrlC], menu)).toEqual({ kind: 'interrupt' });
  });
});
