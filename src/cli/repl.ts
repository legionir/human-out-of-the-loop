/**
 * Interactive mode: `hootl` with no arguments in a terminal.
 *
 * Like the Claude Code CLI, the tool opens a prompt instead of printing its
 * help.  A plain line is a goal (plan → confirm → execute, exactly like
 * `hootl run`); a line starting with `/` is a command:
 *
 *   /help  /status  /config  /model  /persistent  /yes  /cd  /new  /clear  /exit
 *
 * and every regular subcommand is available with a slash too (`/plans list`,
 * `/usage`, `/logs --tail 20`, `/mcp test <id>` …), run in the current
 * directory.  The banner and the prompt always show the active directory,
 * which is the project root every goal and command works in.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { CommanderError } from 'commander';
import { runCommand } from './commands/run.js';
import { envDefaultModelId, loadRegistries } from './utils/registries.js';
import {
  globalConfigPath,
  loadDotEnv,
  loadGlobalConfig,
  saveGlobalConfig,
  type GlobalCliConfig,
} from './utils/config.js';
import { color, err, out, renderTable } from './utils/output.js';
import type { Command } from 'commander';

/** Mutable settings of one interactive session. */
export interface ReplState {
  /** Active directory = project root for goals and commands. */
  cwd: string;
  model?: string;
  persistent: boolean;
  /** Auto-confirm plans (the `--yes` of every goal). */
  autoConfirm: boolean;
  verbose: boolean;
  /** Session the goals are recorded in (persistent mode only). */
  sessionId?: string;
}

export interface ReplOptions {
  binName: string;
  version?: string;
  /** Builds a fresh commander program for slash-passthrough commands. */
  createProgram: (binName: string) => Command;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const DEFAULT_MODEL = 'gpt-4o';

/** Commands handled by the REPL itself (everything else goes to commander). */
const BUILTINS: Record<string, string> = {
  help: 'show this help',
  status: 'active directory, model, persistence, session and API keys',
  config: 'show settings  ·  /config set <key> <value>  ·  /config unset <key>',
  model: 'list models  ·  /model <id> to switch for this session',
  persistent: '/persistent on|off — write plans, sessions and logs to .ai-runtime',
  yes: '/yes on|off — confirm plans automatically',
  verbose: '/verbose on|off — stream tool calls and low-level status',
  cd: '/cd <dir> — change the active directory (project root)',
  pwd: 'print the active directory',
  new: 'start a new session for the next goal',
  clear: 'clear the screen',
  exit: 'leave interactive mode (also /quit, Ctrl-D)',
};

/** Subcommands of the regular CLI, reachable as `/<name> …`. */
const PASSTHROUGH = [
  'plans', 'sessions', 'usage', 'tasks', 'logs',
  'models', 'personas', 'skills', 'tools', 'mcp', 'run',
];

/** Keys `/config set` accepts, with how to parse them. */
const CONFIG_KEYS: Record<string, (v: string) => GlobalCliConfig[keyof GlobalCliConfig]> = {
  defaultModel: (v) => v,
  persistent: (v) => parseOnOff(v),
  projectRoot: (v) => v,
};

export function parseOnOff(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  throw new Error(`expected on or off, got "${value ?? ''}"`);
}

/**
 * Split a command line into arguments: whitespace-separated, with single or
 * double quotes grouping (`/run "fix the tests" --yes`).
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/** `~` for the home directory, like a shell prompt. */
export function displayPath(dir: string): string {
  const home = os.homedir();
  if (dir === home) return '~';
  if (dir.startsWith(home + path.sep)) return '~' + dir.slice(home.length);
  return dir;
}

/** Which provider keys are present (never their values). */
function keyStatus(): string {
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', ...(process.env.HOTL_API_KEY ? ['HOTL_API_KEY'] : [])];
  return keys
    .map((k) => (process.env[k] ? color.done(`${k} ✓`) : color.dim(`${k} ✗`)))
    .join('  ');
}

export function initialState(cwd: string = process.cwd()): ReplState {
  const config = loadGlobalConfig();
  const root = config.projectRoot ? path.resolve(cwd, config.projectRoot) : cwd;
  // The project's .env may carry HOTL_MODEL / HOTL_BASE_URL.
  loadDotEnv([root]);
  return {
    cwd: root,
    model: envDefaultModelId(root) ?? config.defaultModel,
    persistent: config.persistent ?? false,
    autoConfirm: false,
    verbose: false,
  };
}

export class Repl {
  readonly state: ReplState;
  private readonly history: string[] = [];
  private rl?: readline.Interface;
  private pendingExit = false;
  private closed = false;

  constructor(private readonly opts: ReplOptions, state: ReplState = initialState()) {
    this.state = state;
  }

  /** Banner + prompt loop.  Resolves when the user leaves. */
  async start(): Promise<void> {
    this.enterDirectory(this.state.cwd);
    this.printBanner();
    await new Promise<void>((resolve) => {
      this.onExit = resolve;
      this.openPrompt();
    });
  }

  private onExit: () => void = () => undefined;

  // ── prompt ───────────────────────────────────────────────────

  private promptText(): string {
    const dir = path.basename(this.state.cwd) || this.state.cwd;
    return `${color.info(this.opts.binName)} ${color.dim(dir)} ${color.bold('›')} `;
  }

  /**
   * A fresh readline per prompt: while a goal runs, inquirer (plan
   * confirmation, clarification questions) must own stdin alone — two
   * readline interfaces on one stream would both consume every key.
   */
  private openPrompt(): void {
    if (this.closed) return;
    const rl = readline.createInterface({
      input: this.opts.input ?? process.stdin,
      output: this.opts.output ?? process.stdout,
      terminal: true,
      history: [...this.history],
      historySize: 500,
      completer: (line: string) => this.complete(line),
    });
    this.rl = rl;
    rl.on('SIGINT', () => {
      if (rl.line.length > 0) {
        // Ctrl-C on a half-typed line clears it, like a shell.
        rl.write(null, { ctrl: true, name: 'u' });
        out('');
        rl.prompt();
        return;
      }
      if (this.pendingExit) {
        this.exit();
        return;
      }
      this.pendingExit = true;
      out(color.dim('\n(press Ctrl-C again, or type /exit, to leave)'));
      rl.prompt();
    });
    rl.on('close', () => {
      // Ctrl-D (or /exit).  A close we caused ourselves to hand stdin to a
      // running command is not an exit.
      if (this.rl === rl) this.exit();
    });
    rl.once('line', (line) => {
      this.rl = undefined;
      rl.close();
      void this.handle(line).then(() => this.openPrompt());
    });
    rl.setPrompt(this.promptText());
    rl.prompt();
  }

  private complete(line: string): [string[], string] {
    if (!line.startsWith('/')) return [[], line];
    const names = [...Object.keys(BUILTINS), 'quit', ...PASSTHROUGH].map((n) => `/${n}`);
    const hits = names.filter((n) => n.startsWith(line));
    return [hits.length > 0 ? hits : names, line];
  }

  private exit(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    out(color.dim('Bye.'));
    this.onExit();
  }

  // ── dispatch ─────────────────────────────────────────────────

  /** Handle one line of input.  Never throws. */
  async handle(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    this.pendingExit = false;
    if (!line) return;
    if (this.history[0] !== line) this.history.unshift(line);
    // While a command runs the prompt is closed; without a listener a
    // Ctrl-C would kill the whole session.  `run` installs its own handler
    // (first Ctrl-C cancels the plan, the second one leaves).
    const keepAlive = (): void => undefined;
    process.on('SIGINT', keepAlive);
    try {
      if (line.startsWith('/')) await this.command(line.slice(1));
      else await this.goal(line);
    } catch (e) {
      err(color.failed(`Error: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      process.removeListener('SIGINT', keepAlive);
    }
  }

  private async goal(goal: string): Promise<void> {
    const result = await runCommand(goal, {
      projectRoot: this.state.cwd,
      persistent: this.state.persistent,
      model: this.state.model,
      yes: this.state.autoConfirm,
      verbose: this.state.verbose,
      // A session only exists on disk in persistent mode; an in-memory
      // run cannot continue one that lived in an earlier orchestrator.
      ...(this.state.persistent && this.state.sessionId ? { session: this.state.sessionId } : {}),
    });
    if (this.state.persistent && result.sessionId) this.state.sessionId = result.sessionId;
  }

  private async command(text: string): Promise<void> {
    const [name = '', ...args] = splitArgs(text);
    switch (name) {
      case 'help':
      case '?':
        return this.printHelp();
      case 'exit':
      case 'quit':
      case 'q':
        return this.exit();
      case 'status':
        return this.printStatus();
      case 'pwd':
        return out(this.state.cwd);
      case 'cd':
        return this.changeDirectory(args[0]);
      case 'clear':
        (this.opts.output ?? process.stdout).write('\x1b[2J\x1b[H');
        return;
      case 'new':
        this.state.sessionId = undefined;
        return out(color.dim('The next goal starts a new session.'));
      case 'persistent':
        this.state.persistent = parseOnOff(args[0]);
        return out(`persistent: ${this.state.persistent ? 'on' : 'off'}`);
      case 'yes':
        this.state.autoConfirm = parseOnOff(args[0]);
        return out(`auto-confirm: ${this.state.autoConfirm ? 'on' : 'off'}`);
      case 'verbose':
        this.state.verbose = parseOnOff(args[0]);
        return out(`verbose: ${this.state.verbose ? 'on' : 'off'}`);
      case 'model':
        return this.model(args[0]);
      case 'config':
        return this.config(args);
      default:
        if (PASSTHROUGH.includes(name)) return this.passthrough([name, ...args]);
        err(color.failed(`Unknown command /${name}.`) + color.dim('  Type /help for the list.'));
    }
  }

  /** Run a regular subcommand in the active directory. */
  private async passthrough(args: string[]): Promise<void> {
    const program = this.opts.createProgram(this.opts.binName);
    const previous = process.exitCode;
    try {
      await program.parseAsync(['node', this.opts.binName, ...args]);
    } catch (e) {
      // commander already printed its own message (or the help).
      if (!(e instanceof CommanderError)) throw e;
    } finally {
      // A failed command must not become the exit code of the REPL.
      process.exitCode = previous;
    }
  }

  // ── built-ins ────────────────────────────────────────────────

  private enterDirectory(dir: string): void {
    process.chdir(dir);
    this.state.cwd = process.cwd();
    // The project's .env (API keys) applies from now on; the real
    // environment still wins, as everywhere else.
    loadDotEnv([this.state.cwd]);
  }

  private changeDirectory(target: string | undefined): void {
    const raw = target ?? os.homedir();
    const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
    const next = path.resolve(this.state.cwd, expanded);
    if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
      err(color.failed(`No such directory: ${next}`));
      return;
    }
    this.enterDirectory(next);
    // A session belongs to one project's .ai-runtime.
    this.state.sessionId = undefined;
    out(displayPath(this.state.cwd));
  }

  private model(id: string | undefined): void {
    const models = loadRegistries(this.state.cwd).models;
    const current = this.state.model ?? DEFAULT_MODEL;
    if (!id) {
      out(
        renderTable(
          ['', 'ID', 'PROVIDER', 'MODEL'],
          models.map((m) => [m.id === current ? '●' : '', m.id, m.provider, m.model]),
        ),
      );
      out(color.dim('\n/model <id> switches for this session; /config set defaultModel <id> saves it.'));
      return;
    }
    if (!models.some((m) => m.id === id)) {
      err(color.failed(`Unknown model "${id}".`) + color.dim(`  Available: ${models.map((m) => m.id).join(', ')}`));
      return;
    }
    this.state.model = id;
    out(`model: ${id}`);
  }

  private config(args: string[]): void {
    const [action, key, ...rest] = args;
    if (!action) {
      const saved = loadGlobalConfig();
      out(color.bold('This session'));
      out(
        renderTable(
          ['SETTING', 'VALUE'],
          [
            ['directory', displayPath(this.state.cwd)],
            ['model', this.state.model ?? `${DEFAULT_MODEL} (default)`],
            ['persistent', this.state.persistent ? 'on' : 'off'],
            ['auto-confirm', this.state.autoConfirm ? 'on' : 'off'],
            ['verbose', this.state.verbose ? 'on' : 'off'],
          ],
        ),
      );
      out('');
      out(color.bold('Saved defaults') + color.dim(`  ${displayPath(globalConfigPath())}`));
      const entries = Object.entries(saved);
      out(entries.length > 0 ? renderTable(['KEY', 'VALUE'], entries.map(([k, v]) => [k, String(v)])) : color.dim('(none)'));
      out(color.dim(`\nKeys: ${Object.keys(CONFIG_KEYS).join(', ')}.  API keys belong in the environment or a .env file.`));
      return;
    }
    if (action !== 'set' && action !== 'unset') {
      err(color.failed('Usage: /config  |  /config set <key> <value>  |  /config unset <key>'));
      return;
    }
    if (!key || !(key in CONFIG_KEYS)) {
      err(color.failed(`Unknown key "${key ?? ''}".`) + color.dim(`  Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
      return;
    }
    const saved = loadGlobalConfig() as Record<string, unknown>;
    if (action === 'unset') {
      delete saved[key];
    } else {
      const value = rest.join(' ');
      if (!value) {
        err(color.failed(`Usage: /config set ${key} <value>`));
        return;
      }
      if (key === 'defaultModel' && !loadRegistries(this.state.cwd).models.some((m) => m.id === value)) {
        err(color.failed(`Unknown model "${value}".`) + color.dim('  See /model.'));
        return;
      }
      saved[key] = CONFIG_KEYS[key]!(value);
    }
    saveGlobalConfig(saved as GlobalCliConfig);
    // The saved default also applies to this session right away.
    if (key === 'defaultModel') this.state.model = saved[key] as string | undefined;
    if (key === 'persistent') this.state.persistent = (saved[key] as boolean | undefined) ?? false;
    out(action === 'set' ? `saved ${key} = ${String(saved[key])}` : `removed ${key}`);
  }

  // ── output ───────────────────────────────────────────────────

  private printBanner(): void {
    const title = `${this.opts.binName}${this.opts.version ? ` v${this.opts.version}` : ''}`;
    const lines = [
      color.bold(title) + color.dim('  — plan once, confirm once, then out of the loop'),
      '',
      `${color.dim('cwd:  ')} ${shorten(displayPath(this.state.cwd), 72)}`,
      `${color.dim('model:')} ${this.modelLabel()}   ${color.dim('persistent:')} ${this.state.persistent ? 'on' : 'off'}`,
      ...(process.env.HOTL_BASE_URL ? [`${color.dim('url:  ')} ${shorten(process.env.HOTL_BASE_URL, 72)}`] : []),
      `${color.dim('keys: ')} ${keyStatus()}`,
    ];
    const width = Math.max(...lines.map((l) => stripAnsi(l).length)) + 2;
    out(color.dim(`╭${'─'.repeat(width)}╮`));
    for (const l of lines) out(`${color.dim('│')} ${l}${' '.repeat(width - 1 - stripAnsi(l).length)}${color.dim('│')}`);
    out(color.dim(`╰${'─'.repeat(width)}╯`));
    out(color.dim('Type a goal to plan and run it, /help for commands, /exit to leave.'));
    out('');
  }

  /** `custom (@aur/auto)` — the id, plus the provider model when it differs. */
  private modelLabel(): string {
    const id = this.state.model ?? DEFAULT_MODEL;
    const cfg = loadRegistries(this.state.cwd).models.find((m) => m.id === id);
    return cfg && cfg.model !== id ? `${id} (${cfg.model})` : id;
  }

  private printStatus(): void {
    out(`${color.dim('directory: ')} ${this.state.cwd}`);
    out(`${color.dim('model:     ')} ${this.modelLabel()}`);
    if (process.env.HOTL_BASE_URL) out(`${color.dim('endpoint:  ')} ${process.env.HOTL_BASE_URL}`);
    out(`${color.dim('persistent:')} ${this.state.persistent ? 'on' : 'off'}   ${color.dim('auto-confirm:')} ${this.state.autoConfirm ? 'on' : 'off'}   ${color.dim('verbose:')} ${this.state.verbose ? 'on' : 'off'}`);
    out(`${color.dim('session:   ')} ${this.state.sessionId ?? (this.state.persistent ? '(new on the next goal)' : '(in-memory)')}`);
    out(`${color.dim('api keys:  ')} ${keyStatus()}`);
  }

  private printHelp(): void {
    out(color.bold('Goals'));
    out('  Type what you want done in plain language — it is planned, shown for');
    out('  confirmation once, then executed in the active directory.');
    out('');
    out(color.bold('Commands'));
    out(renderTable(['', ''], Object.entries(BUILTINS).map(([k, v]) => [`  /${k}`, v])).split('\n').slice(1).join('\n'));
    out('');
    out(color.bold('Everything else') + color.dim('  (same as the regular CLI, run in the active directory)'));
    out(`  ${PASSTHROUGH.map((c) => `/${c}`).join('  ')}`);
    out(color.dim('  e.g. /plans list · /plans resume <id> · /usage · /logs --tail 20 · /mcp test <id> · /tools --mcp'));
    out(color.dim('  Add --help to any of them: /plans --help'));
  }
}

/** Keep the tail of a long path (the part that says where you are). */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Entry point used by `main()` when `hootl` runs with no arguments in a TTY. */
export async function startRepl(opts: ReplOptions): Promise<number> {
  await new Repl(opts).start();
  return 0;
}
