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
import chalk from 'chalk';
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
import { readLine, type Suggestion } from './line-editor.js';
import { stopActiveActivity } from './utils/activity.js';
import { showSplash } from './splash.js';
import { listRemoteModels, type RemoteModel } from '../ai/models/list-models.js';
import { modelIdForSpec } from '../ai/models/env-endpoint.js';

/** The product name as the prompt and banner show it. */
export const BRAND = 'HOOTL';

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

/** One-line descriptions of the passthrough commands (for the `/` menu). */
const PASSTHROUGH_HELP: Record<string, string> = {
  plans: 'list · show · cancel · resume persisted plans',
  sessions: 'list · show · label · delete sessions',
  usage: 'token usage per plan',
  tasks: 'tasks from the observability log',
  logs: 'read the observability log (--tail N, --follow)',
  models: 'registered models (--remote: what the providers serve)',
  personas: 'registered personas',
  skills: 'registered skills',
  tools: 'registered tools (--mcp: include MCP servers)',
  mcp: 'list MCP servers · test one',
  run: 'run a goal with flags (/run "goal" --dry-run)',
};

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

/** Options given on the command line (`hootl --project-root X --model Y`). */
export interface InteractiveArgs {
  projectRoot?: string;
  model?: string;
  persistent?: boolean;
  yes?: boolean;
  splash?: boolean;
}

/**
 * `hootl` with only options and no subcommand opens interactive mode with
 * them.  Returns undefined when the arguments are something else (a
 * subcommand, --help, --version, an unknown option) — commander handles those.
 */
export function parseInteractiveArgs(args: string[]): InteractiveArgs | undefined {
  const result: InteractiveArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | undefined => inline ?? args[++i];
    switch (name) {
      case '--project-root': {
        const v = value();
        if (!v) return undefined;
        result.projectRoot = v;
        break;
      }
      case '--model': {
        const v = value();
        if (!v) return undefined;
        result.model = v;
        break;
      }
      case '--persistent':
        result.persistent = true;
        break;
      case '--yes':
        result.yes = true;
        break;
      case '--no-splash':
        result.splash = false;
        break;
      default:
        return undefined;
    }
  }
  return result;
}

export function initialState(cwd: string = process.cwd(), args: InteractiveArgs = {}): ReplState {
  const config = loadGlobalConfig();
  const root = args.projectRoot
    ? path.resolve(cwd, args.projectRoot)
    : config.projectRoot
      ? path.resolve(cwd, config.projectRoot)
      : cwd;
  // The project's .env may carry HOTL_MODEL / HOTL_BASE_URL.
  loadDotEnv([root]);
  return {
    cwd: root,
    model: args.model ?? envDefaultModelId(root) ?? config.defaultModel,
    persistent: args.persistent ?? config.persistent ?? false,
    autoConfirm: args.yes ?? false,
    verbose: false,
  };
}

export class Repl {
  readonly state: ReplState;
  private readonly history: string[] = [];
  private pendingExit = false;
  private closed = false;

  constructor(private readonly opts: ReplOptions, state: ReplState = initialState()) {
    this.state = state;
  }

  /** Splash, banner, then the prompt loop.  Resolves when the user leaves. */
  async start(opts: { splash?: boolean } = {}): Promise<void> {
    this.enterDirectory(this.state.cwd);
    const output = (this.opts.output ?? process.stdout) as NodeJS.WriteStream;
    if (opts.splash !== false) {
      await showSplash(output, { ms: 3000, subtitle: 'plan once, confirm once — then out of the loop' });
    }
    void this.refreshRemoteModels();
    this.printBanner();
    while (!this.closed) {
      // Phase 32: a goal's status line (or a thinking block) must never run
      // into the prompt the user is about to type into.
      stopActiveActivity();
      const result = await readLine({
        input: (this.opts.input ?? process.stdin) as NodeJS.ReadStream,
        output,
        prompt: this.promptText(),
        history: this.history,
        suggest: (line) => this.suggest(line),
        style: { selected: (t) => chalk.inverse(t), dim: (t) => chalk.dim(t) },
      });
      if (result.kind === 'eof') {
        this.exit();
      } else if (result.kind === 'interrupt') {
        if (this.pendingExit) {
          this.exit();
        } else {
          this.pendingExit = true;
          out(color.dim('(press Ctrl-C again, or type /exit, to leave)'));
        }
      } else {
        await this.handle(result.line);
      }
    }
  }

  // ── prompt ───────────────────────────────────────────────────

  private promptText(): string {
    const dir = path.basename(this.state.cwd) || this.state.cwd;
    return `${chalk.bold.yellow(BRAND)} ${color.dim(dir)} ${color.bold('›')} `;
  }

  /** What the menu under the prompt offers for the current line. */
  suggest(line: string): Suggestion[] {
    if (!line.startsWith('/')) return [];
    const space = line.indexOf(' ');
    if (space === -1) {
      const typed = line.slice(1).toLowerCase();
      const all: Suggestion[] = [
        ...Object.entries(BUILTINS).map(([name, description]) => ({ value: `/${name}`, description })),
        ...PASSTHROUGH.map((name) => ({ value: `/${name}`, description: PASSTHROUGH_HELP[name] ?? '' })),
      ];
      const starts = all.filter((s) => s.value.slice(1).startsWith(typed));
      const contains = all.filter((s) => !starts.includes(s) && s.value.slice(1).includes(typed));
      const hits = [...starts, ...contains];
      // Nothing to offer once the line IS a complete command.
      return hits.length === 1 && hits[0]!.value === line ? [] : hits;
    }
    const command = line.slice(1, space);
    const arg = line.slice(space + 1);
    const pick = (values: Array<[string, string?]>): Suggestion[] =>
      values
        .filter(([v]) => v.toLowerCase().includes(arg.toLowerCase()) && v !== arg)
        .map(([v, description]) => ({ value: `/${command} ${v}`, label: v, description }));
    switch (command) {
      case 'model':
        return pick(this.modelChoices());
      case 'persistent':
      case 'yes':
      case 'verbose':
        return pick([['on'], ['off']]);
      case 'config':
        if (!arg.includes(' ')) return pick([['set'], ['unset']]);
        return [];
      case 'cd':
        return pick(this.subdirectories(arg));
      case 'plans':
        return pick([['list'], ['show '], ['cancel '], ['resume ']]);
      case 'sessions':
        return pick([['list'], ['show '], ['label '], ['delete ']]);
      case 'mcp':
        return pick([['list'], ['test ']]);
      case 'tasks':
        return pick([['list'], ['show ']]);
      default:
        return [];
    }
  }

  /** Registered models first, then what the providers serve. */
  private modelChoices(): Array<[string, string?]> {
    const registry = loadRegistries(this.state.cwd).models;
    const choices: Array<[string, string?]> = registry.map((m) => [m.id, `${m.provider}:${m.model}`]);
    for (const m of this.remoteModels) {
      if (!choices.some(([v]) => v === m.spec)) choices.push([m.spec, `from ${m.source}`]);
    }
    return choices;
  }

  private subdirectories(arg: string): Array<[string, string?]> {
    const base = arg.includes('/') || arg.includes(path.sep) ? arg.slice(0, Math.max(arg.lastIndexOf('/'), arg.lastIndexOf(path.sep)) + 1) : '';
    try {
      return fs
        .readdirSync(path.resolve(this.state.cwd, base || '.'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .slice(0, 200)
        .map((d) => [`${base}${d.name}`] as [string]);
    } catch {
      return [];
    }
  }

  private remoteModels: RemoteModel[] = [];
  private remoteErrors: Array<{ source: string; error: string }> = [];

  /** Ask the providers for their models (in the background at start). */
  async refreshRemoteModels(): Promise<void> {
    try {
      const list = await listRemoteModels(process.env);
      this.remoteModels = list.models;
      this.remoteErrors = list.errors;
    } catch (e) {
      this.remoteErrors = [{ source: 'providers', error: e instanceof Error ? e.message : String(e) }];
    }
  }

  private exit(): void {
    if (this.closed) return;
    this.closed = true;
    out(color.dim('Bye.'));
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
        return this.model(args.join(' ') || undefined);
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

  private async model(spec: string | undefined): Promise<void> {
    if (!spec) {
      // A fresh look at what the providers serve.
      await this.refreshRemoteModels();
      const current = this.state.model ?? DEFAULT_MODEL;
      const registry = loadRegistries(this.state.cwd).models;
      out(color.bold('Registered'));
      out(renderTable(['', 'MODEL', 'PROVIDER', 'NAME'], registry.map((m) => [m.id === current ? '●' : '', m.id, m.provider, m.model])));
      if (this.remoteModels.length > 0) {
        out('');
        out(color.bold('From your providers'));
        out(renderTable(['', 'MODEL', 'SOURCE'], this.remoteModels.map((m) => [m.spec === current ? '●' : '', m.spec, m.source])));
      }
      for (const e of this.remoteErrors) err(color.dim(`${e.source}: ${e.error}`));
      out(color.dim('\nType "/model " and pick with ↑↓, or /model <name>.  /config set defaultModel <name> saves it.'));
      return;
    }
    const registry = loadRegistries(this.state.cwd).models;
    this.state.model = spec;
    const known =
      registry.some((m) => m.id === spec) || this.remoteModels.some((m) => m.spec === spec);
    out(`model: ${this.modelLabel()}`);
    if (!known) {
      out(color.dim('  (not in the registry or the provider list — it is used as a provider model name)'));
    }
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
    const title = `${BRAND}${this.opts.version ? ` v${this.opts.version}` : ''}`;
    const lines = [
      chalk.bold.yellow(title) + color.dim('  — human out of the loop'),
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
    const spec = this.state.model ?? DEFAULT_MODEL;
    const cfg = loadRegistries(this.state.cwd).models.find((m) => m.id === spec || m.id === modelIdForSpec(spec));
    if (!cfg) return spec;
    return cfg.model !== spec && cfg.id === spec ? `${spec} (${cfg.model})` : spec;
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
export async function startRepl(opts: ReplOptions, args: InteractiveArgs = {}): Promise<number> {
  const splash = args.splash ?? !/^(1|true|yes)$/i.test(process.env.HOTL_NO_SPLASH ?? '');
  await new Repl(opts, initialState(process.cwd(), args)).start({ splash });
  return 0;
}
