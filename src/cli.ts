#!/usr/bin/env node
/**
 * Phase 23 (CLI): `human-out-of-the-loop` / `hootl` — the command-line
 * entry point, structured like the Claude Code CLI:
 *
 *   human-out-of-the-loop run "goal" [flags]      plan + execute
 *   human-out-of-the-loop sessions list|show|delete
 *   human-out-of-the-loop plans list|show|cancel|resume
 *   human-out-of-the-loop mcp list|test <id>
 *   human-out-of-the-loop models|personas|skills|tools [--json]
 *   human-out-of-the-loop usage [--plan X] [--json]
 *   human-out-of-the-loop tasks list [--plan X] | tasks show <taskId>
 *   human-out-of-the-loop logs [--plan X] [--tail N] [--follow]
 *
 * The heavy lifting lives in src/ai (the Orchestrator); this layer only
 * parses commands, renders progress, and manages exit codes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { packageRoot } from './ai/registries/layout.js';
import chalk from 'chalk';
import { runCommand } from './cli/commands/run.js';
import {
  sessionsListCommand,
  sessionsShowCommand,
  sessionsDeleteCommand,
  sessionsLabelCommand,
} from './cli/commands/sessions.js';
import {
  plansListCommand,
  plansShowCommand,
  plansCancelCommand,
  plansResumeCommand,
} from './cli/commands/plans.js';
import { mcpListCommand, mcpTestCommand } from './cli/commands/mcp.js';
import { logsCommand } from './cli/commands/logs.js';
import {
  modelsCommand,
  personasCommand,
  skillsCommand,
  toolsCommand,
} from './cli/commands/registry.js';
import { usageCommand } from './cli/commands/usage.js';
import { tasksListCommand, tasksShowCommand } from './cli/commands/tasks.js';
import { err } from './cli/utils/output.js';

const DEFAULT_BIN_NAME = 'human-out-of-the-loop';

/**
 * The name this process was launched as.  `hootl` (the short alias
 * installed by `npm i -g .` / `npm link`) gets its own help text so the
 * printed usage line matches what the user typed; every other entry point
 * (dev runs, tests, the long binary name) keeps the full name.
 */
export function detectBinName(argv: string[] = process.argv): string {
  const entry = argv[1];
  if (!entry) return DEFAULT_BIN_NAME;
  const base = path.basename(entry).replace(/\.(js|mjs|cjs|ts)$/i, '');
  return /^hootl$/i.test(base) ? 'hootl' : DEFAULT_BIN_NAME;
}

/** Version from the package manifest (undefined when unreadable). */
function packageVersion(): string | undefined {
  const root = packageRoot();
  if (!root) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof raw.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render a help appendix: blank line, then an indented block.  Used for
 * the "how this command behaves" guidance that commander's terse option
 * list cannot express.
 */
function helpBlock(...lines: string[]): string {
  return `\n${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}\n`;
}

/**
 * Apply `exitOverride()` to a command AND all of its subcommands:
 * commander only honours the override on the command that registered it,
 * and without this a `--help` on a subcommand would call `process.exit`
 * directly (which also makes the CLI untestable in-process).
 */
function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) applyExitOverride(sub);
}

/** Phase 28: the appendix shown by `sessions` AND its subcommands. */
const SESSIONS_HELP = helpBlock(
      'SUBCOMMANDS',
      '  list                 newest-first table: id, label, interaction count, last',
      '                       activity and the plans each session produced.',
      '  show <sessionId>     full detail for one session: every interaction with its',
      '                       request, outcome, review summary and plan ids.',
      '  label <id> <label>   set (or clear, with an empty string) the session label.',
      '                       Labels are for humans only — nothing else reads them.',
      '  delete <sessionId>   remove the session record.  Its plans are NOT deleted.',
      '',
      'WHERE THE DATA LIVES',
      '  <project-root>/.ai-runtime/sessions — one file per session, written only when',
      '  runs use --persistent (or the global config enables it).  Without persistent',
      '  state these commands report that there is nothing to list.',
);

/** Phase 28: the appendix shown by `plans` AND its subcommands. */
const PLANS_HELP = helpBlock(
      'SUBCOMMANDS',
      '  list              newest-first table of persisted plans: id, goal, status',
      '                    and step progress (done/total).',
      '  show <planId>     the plan in full: goal, per-step status, assigned persona,',
      '                    skills, tools, dependencies and acceptance criteria.',
      '  cancel <planId>   mark the plan cancelled.  This is a state change only —',
      '                    running agents are not killed (use the API/UI cancel for',
      '                    that); a cancelled plan is terminal and cannot be resumed.',
      '  resume <planId>   re-execute every step that is not done/failed yet.  Resuming',
      '                    keeps the same plan id and session, and accepts --model and',
      '                    --timeout-ms to override the model/timeout for this resume.',
      '',
      'PLAN STATES',
      '  draft            created, not executed yet (a --dry-run preview is never saved)',
      '  running          an execution is in flight',
      '  awaiting-confirmation / awaiting-clarification  waiting for the human',
      '  completed        every step done — terminal',
      '  failed-partial   some steps failed after the re-plan budget — terminal',
      '  cancelled        explicitly cancelled — terminal',
      '',
      'WHERE THE DATA LIVES',
      '  <project-root>/.ai-runtime/plans (written only for persistent runs).',
);

/** Phase 28: the appendix shown by `mcp` AND its subcommands. */
const MCP_HELP = helpBlock(
      'SUBCOMMANDS',
      '  list                 table of configured servers from BOTH registry layers:',
      '                       id, name, transport, endpoint and the auth variable name',
      '                       (never the secret itself).  A project server with the same',
      '                       id overrides the packaged one.',
      '  test <serverId>      opens ONE connection to that server with the configured',
      '                       transport and credentials, prints the tools it exposes and',
      '                       exits 0 on success / 1 on failure with the redacted error.',
      '',
      'CONFIGURATION',
      '  <registry-layer>/mcp-servers/*.json — one file per server: id, name, transport',
      '  (http | sse | stdio), url (or command for stdio), optional toolPrefix and an',
      '  auth block.  Credentials are NEVER stored inline: auth names an ENVIRONMENT',
      '  VARIABLE (tokenEnvVar / keyEnvVar) whose value is read at connect time and',
      '  stripped from every error message.  Required env values are documented in',
      '  docs/CONFIGURATION.md.',
      '',
      'NOTE',
      '  MCP servers are also loaded during `run`, so tools exposed here become',
      '  available to agents (as source "mcp") without any extra step.',
);

/** Phase 28: the appendix shown by `tasks` AND its subcommands. */
const TASKS_HELP = helpBlock(
      'SUBCOMMANDS',
      '  list [--plan X]   one row per task derived from the log: id, plan, step,',
      '                    status, tools used and tokens.  Status is derived from the',
      '                    task events, so it is always consistent with the log.',
      '  show <taskId>     every log entry for that task, including payloads.',
      '',
      'SOURCE',
      '  <project-root>/.ai-runtime/observability.jsonl — the same file `logs` reads.',
      '  These commands never mutate anything and need no API key.',
      '',
      'NOTE',
      '  `tasks list --json` is the machine-readable form of the same table.',
);

export function createProgram(binName: string = DEFAULT_BIN_NAME): Command {
  const program = new Command();
  const version = packageVersion();
  program
    .name(binName)
    .description(
      'Autonomous agent runtime — the human confirms ONCE, then goes out of the loop.',
    );
  if (version) program.version(version, '-V, --version', 'print the version number and exit');
  program
    .showHelpAfterError(`Run \`${binName} --help\` to see every command and option.`)
    .addHelpText(
      'after',
      helpBlock(
        'WHAT THIS TOOL DOES',
        `  ${binName} turns a plain-language goal into a plan, asks you to confirm`,
        '  that plan ONCE, then executes it autonomously with a team of agents',
        '  (planner, coder, reviewer, ...) until every step is done.  Everything is',
        '  driven by the local Orchestrator in src/ai — no server is required.',
        '',
        'COMMAND GROUPS',
        '  run          plan + confirm + execute a goal (the main entry point)',
        '  plans        inspect, cancel or resume persisted plans',
        '  sessions     inspect, label or delete conversation sessions',
        '  logs         read the observability log (jsonl)',
        '  usage        token usage per plan',
        '  tasks        per-task view derived from the same log',
        '  models / personas / skills / tools',
        '               list what the runtime can use (registry introspection)',
        '  mcp          list configured MCP servers and test a connection',
        '',
        'CONFIGURATION PRECEDENCE (highest first)',
        '  1. CLI flags                e.g. --model, --project-root, --persistent',
        '  2. Environment variables    real env plus .env files in the project root',
        '                              and in the current directory (API keys live here)',
        '  3. Global config file       ~/.human-out-of-the-loop/config.json, e.g.',
        '                              { "persistent": true, "defaultModel": "gpt-4o" }',
        '',
        'REGISTRY LAYERS (global + local, merged)',
        '  Every command reads registries from two layers and merges them by id:',
        '    package (global)  registry/ shipped with this installation — personas,',
        '                      tools, skills, models, MCP servers, agents.json.',
        '                      Always available, so the CLI works from any directory.',
        '    project (local)   <project-root>/registry — loaded LAST, so an entry with',
        '                      the same id OVERRIDES the packaged default while extra',
        '                      entries are simply added.',
        '  HOTL_NO_PACKAGE_REGISTRY=1 disables the packaged layer (strictly local).',
        '',
        'PROJECT ROOT AND STATE',
        '  The project root defaults to the current working directory; --project-root',
        '  changes it for a single invocation.  Filesystem tools are sandboxed inside',
        '  it.  Persistent state (.ai-runtime: plans, sessions, observability log) is',
        '  written only when --persistent is given (or enabled in the global config).',
        '',
        'EXIT CODES',
        '  0  success — or partial success (some steps failed, the goal was reached)',
        '  1  failure, or a runtime error during execution',
        '  2  invalid usage — unknown model, unknown argument, out-of-range value',
        '',
        'MORE HELP',
        `  ${binName} help <command>       full help for one command`,
        `  ${binName} <group> help <sub>   full help for a subcommand`,
      ),
    );

  // ── run ──────────────────────────────────────────────────────
  program
    .command('run')
    .description('Plan and execute a goal (Human-Out-Of-Loop)')
    .argument('<goal>', 'the goal to achieve, in plain language')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--persistent', 'persist plans/sessions in .ai-runtime (default: global config or off)')
    .option('--model <id>', 'model id to use (default: global config or gpt-4o)')
    .option('--session <id>', 'continue an existing session')
    .option('--yes', 'auto-confirm the plan without prompting (CI mode)')
    .option('--verbose', 'show tool calls and low-level status')
    .option('--dry-run', 'show the plan without executing anything')
    .option('--timeout-ms <ms>', 'per-agent timeout in milliseconds (1000-600000)', (v: string) => Number(v))
    .option('--max-steps <n>', 'max tool-call iterations per agent run (1-100)', (v: string) => Number(v))
    .option('--max-replans <n>', 'automatic re-planning attempts on failure (0-10)', (v: string) => Number(v))
    .option('--max-delegation-depth <n>', 'max agent-to-subagent delegation depth (0-5)', (v: string) => Number(v))
    .option('--label <text>', 'label for the NEW session (max 64 chars)')
    .action(async (goal: string, opts: Record<string, string | boolean | undefined>) => {
      // `persistent` stays undefined when the flag is absent so
      // runCommand can fall back to the global config default.
      const result = await runCommand(goal, {
        projectRoot: opts.projectRoot as string | undefined,
        persistent: opts.persistent as boolean | undefined,
        model: opts.model as string | undefined,
        session: opts.session as string | undefined,
        yes: opts.yes === true,
        verbose: opts.verbose === true,
        dryRun: opts.dryRun === true,
        timeoutMs: opts.timeoutMs as number | undefined,
        maxSteps: opts.maxSteps as number | undefined,
        maxReplans: opts.maxReplans as number | undefined,
        maxDelegationDepth: opts.maxDelegationDepth as number | undefined,
        label: opts.label as string | undefined,
      });
      process.exitCode = result.exitCode;
    })
    .addHelpText(
      'after',
      helpBlock(
        'HOW A RUN PROCEEDS',
        '  1. Clarification  If the goal is ambiguous the planner asks questions and',
        '                    waits for your answers (at most --max-replans below and',
        '                    the configured clarification-round ceiling).',
        '  2. Plan           Steps are produced with dependencies, assigned personas,',
        '                    skills and acceptance criteria, then shown to you.',
        '  3. Confirmation   You confirm the plan ONCE (this is the last time you are',
        '                    in the loop).  Decline and the run ends as cancelled.',
        '  4. Execution      Agents run step by step, self-validating against the',
        '                    acceptance criteria, re-planning when a step fails, and',
        '                    reviewing the result at the end.',
        '',
        'INTERACTIVE VS NON-INTERACTIVE',
        '  In a real terminal the CLI asks clarification questions and waits for the',
        '  plan confirmation.  With --yes, or whenever stdin/stdout is not a TTY (CI,',
        '  pipes, cron), it NEVER prompts: --yes confirms automatically, and without',
        '  --yes an ambiguous goal fails fast with the planner questions printed.',
        '',
        'NOTES ON THE FLAGS',
        '  --dry-run        plans and prints the steps, executes nothing, persists',
        '                   nothing (a preview has no plan id) and exits 0.',
        '  --persistent     writes .ai-runtime (plans, sessions, observability log);',
        '                   without it (and without config) the run is in-memory and',
        '                   plans/sessions/usage/logs will have nothing to show.',
        '  --session <id>   continue an existing session: the goal is recorded as a new',
        '                   interaction of that session instead of starting a new one.',
        '  --label <text>   label for a NEW session (ignored when --session is used).',
        '  --model <id>     an id from `models` (for example gpt-4o, claude-sonnet);',
        '                   unknown ids fail immediately with the list of valid ids.',
        '  --timeout-ms     per-agent budget; --max-steps caps tool-call iterations;',
        '  --max-replans    caps automatic re-planning of failed steps;',
        '  --max-delegation-depth caps agent -> sub-agent nesting (0 = no delegation).',
        '  --verbose        additionally streams tool calls and low-level status.',
        '',
        'EXIT CODES',
        '  0  the review outcome is success or partial-success',
        '  1  failure, rejected plan, unanswered clarification, or a runtime error',
        '  2  invalid usage (unknown model, out-of-range flag value, bad timeout)',
        '',
        'AFTER THE RUN',
        '  The printed summary includes the session id and plan id; use them with',
        '  `sessions show`, `plans show`, `usage --plan` and `logs --plan`.',
      ),
    );

  // ── sessions ─────────────────────────────────────────────────
  const sessions = program.command('sessions').description('List, show, label, and delete sessions');
    sessions.addHelpText('after', SESSIONS_HELP);
  sessions
    .command('list')
    .description('List persisted sessions (newest first)')
    .addHelpText('after', SESSIONS_HELP)
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsListCommand({ projectRoot: opts.projectRoot });
    });
  sessions
    .command('show')
    .description('Show one session: interactions, outcomes, plan ids')
    .addHelpText('after', SESSIONS_HELP)
    .argument('<sessionId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsShowCommand(id, { projectRoot: opts.projectRoot });
    });
  sessions
    .command('delete')
    .description('Delete a session record (its plans are kept)')
    .addHelpText('after', SESSIONS_HELP)
    .argument('<sessionId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsDeleteCommand(id, { projectRoot: opts.projectRoot });
    });
  sessions
    .command('label')
    .description('Set or clear the human-readable session label')
    .addHelpText('after', SESSIONS_HELP)
    .argument('<sessionId>')
    .argument('<label>', 'new label (empty string clears it)')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, label: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsLabelCommand(id, label, { projectRoot: opts.projectRoot });
    });

  // ── plans ────────────────────────────────────────────────────
  const plans = program.command('plans').description('List, show, cancel, and resume plans');
    plans.addHelpText('after', PLANS_HELP);
  plans
    .command('list')
    .description('List persisted plans with status and step progress')
    .addHelpText('after', PLANS_HELP)
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await plansListCommand({ projectRoot: opts.projectRoot });
    });
  plans
    .command('show')
    .description('Show one plan: steps, personas, tools, dependencies')
    .addHelpText('after', PLANS_HELP)
    .argument('<planId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--json', 'print the raw plan JSON instead of the formatted view')
    .action(async (id: string, opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await plansShowCommand(id, {
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    });
  plans
    .command('cancel')
    .description('Mark a plan cancelled (state change, does not kill running agents)')
    .addHelpText('after', PLANS_HELP)
    .argument('<planId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await plansCancelCommand(id, { projectRoot: opts.projectRoot });
    });
  plans
    .command('resume')
    .description('Re-execute the unfinished steps of a plan')
    .addHelpText('after', PLANS_HELP)
    .argument('<planId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--model <id>', 'model id to use')
    .option('--timeout-ms <ms>', 'per-agent timeout in milliseconds', (v: string) => Number(v))
    .action(async (id: string, opts: Record<string, string | number | undefined>) => {
      process.exitCode = await plansResumeCommand(id, {
        projectRoot: opts.projectRoot as string | undefined,
        model: opts.model as string | undefined,
        timeoutMs: opts.timeoutMs as number | undefined,
      });
    });

  // ── mcp ──────────────────────────────────────────────────────
  const mcp = program.command('mcp').description('Manage MCP servers (project registry + built-in)');
    mcp.addHelpText('after', MCP_HELP);
  mcp
    .command('list')
    .description('List configured MCP servers (project overrides package)')
    .addHelpText('after', MCP_HELP)
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await mcpListCommand({ projectRoot: opts.projectRoot });
    });
  mcp
    .command('test')
    .description('Connect to one MCP server and list the tools it exposes')
    .addHelpText('after', MCP_HELP)
    .argument('<serverId>', 'MCP server id from the registry')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await mcpTestCommand(id, { projectRoot: opts.projectRoot });
    });

  // ── logs ─────────────────────────────────────────────────────
  // ── registry introspection (C1) ──────────────────────────────
  const registryOptions = (cmd: Command): Command =>
    cmd
      .option('--project-root <dir>', 'project root (default: current directory)')
      .option('--json', 'machine-readable output (full entries, one JSON array)')
      .addHelpText(
        'after',
        helpBlock(
          'LAYERED RESULT',
          '  Entries are merged from the packaged registry (global, always present)',
          '  and <project-root>/registry (local).  The local layer is applied last,',
          '  so an entry with the same id replaces the packaged default and extra',
          '  ids are added.  The first output line names the layers that were read;',
          '  `HOTL_NO_PACKAGE_REGISTRY=1` restricts this to the project layer.',
          '',
          'OUTPUT',
          '  Table by default, JSON with --json (pipe it into jq or another tool).',
          '  Invalid registry files are reported after the table and make the command',
          '  exit 1 while the valid entries are still listed.',
          '',
          'EXIT CODES',
          '  0  listed successfully (possibly with a warning about missing directories)',
          '  1  at least one registry file failed validation',
          '  2  no registry layer could be found at all',
        ),
      );

  registryOptions(program
    .command('models')
    .description('List available models (project registry + built-in)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await modelsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('personas')
    .description('List available personas (project registry + built-in)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await personasCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('skills')
    .description('List available skills (project registry + built-in)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await skillsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('tools')
    .description('List available tools (project registry + built-in)')
    .option(
      '--mcp',
      'also connect to registry/mcp-servers and list the tools they expose (slower: starts stdio servers)',
    )
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await toolsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
        mcp: opts.mcp === true,
      });
    })
    .addHelpText(
      'after',
      helpBlock(
        'WHAT IT SHOWS',
        '  The static registry (registry/tools/*.json in the project layer and the',
        '  built-in layer) with each tool id, its source and category.',
        '',
        '--mcp',
        '  Connects to every server in registry/mcp-servers/ and lists the tool ids',
        '  that a run would actually receive from it (the same ids personas may',
        '  reference).  Each server reports ✔ with its tool count, or ✖ with the',
        '  connection error — the command exits 1 when any server fails.',
        '',
        'NOTE',
        '  Without --mcp nothing is started or fetched; the ids of MCP tools only',
        '  exist at runtime, so they cannot appear in a static listing.',
      ),
    ));

  // ── usage + tasks (C2) ───────────────────────────────────────
  program
    .command('usage')
    .description('Token usage per plan (from the observability log)')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--plan <planId>', 'show only this plan')
    .option('--json', 'machine-readable output')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await usageCommand({
        projectRoot: opts.projectRoot as string | undefined,
        plan: opts.plan as string | undefined,
        json: opts.json === true,
      });
    })
    .addHelpText(
      'after',
      helpBlock(
        'WHAT IT SHOWS',
        '  Per plan: prompt tokens, completion tokens, total tokens and the number of',
        '  tasks that reported usage, aggregated from the observability log.  Without',
        '  --plan every plan present in the log is listed.',
        '',
        'NOTE',
        '  Usage is only recorded for runs that wrote a log (--persistent), and only',
        '  for tasks that actually called a model.  Local models report what the',
        '  provider returns (often zero) — the numbers are provider-reported, not',
        '  estimates.',
      ),
    );

  const tasksCmd = program
    .command('tasks')
    .description('Inspect tasks from the observability log (read-only)');
    tasksCmd.addHelpText('after', TASKS_HELP);

  tasksCmd
    .command('list')
    .description('List tasks (optionally scoped to one plan)')
    .addHelpText('after', TASKS_HELP)
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--plan <planId>', 'only tasks of this plan')
    .option('--json', 'machine-readable output')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await tasksListCommand({
        projectRoot: opts.projectRoot as string | undefined,
        plan: opts.plan as string | undefined,
        json: opts.json === true,
      });
    });

  tasksCmd
    .command('show <taskId>')
    .description('Show every log entry for one task')
    .addHelpText('after', TASKS_HELP)
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (taskId: string, opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await tasksShowCommand(taskId, {
        projectRoot: opts.projectRoot as string | undefined,
      });
    });

  program
    .command('logs')
    .description('Read the observability log (.ai-runtime/observability.jsonl)')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .option('--plan <planId>', 'only entries for this plan')
    .option('--tail <n>', 'number of trailing lines (0 = none, for --follow)', (v: string) => Number(v), 50)
    .option('--follow', 'keep following the log for new entries')
    .action(async (opts: Record<string, string | number | boolean | undefined>) => {
      process.exitCode = await logsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        plan: opts.plan as string | undefined,
        tail: opts.tail as number | undefined,
        follow: opts.follow === true,
      });
    })
    .addHelpText(
      'after',
      helpBlock(
        'WHAT IS IN THE LOG',
        '  One JSON object per line: timestamp, level, event type, plan/step/task ids,',
        '  a human-readable message and (where relevant) a compact payload with tools,',
        '  token usage or the error.  Credentials and full prompts are never written.',
        '',
        'BEHAVIOUR',
        '  Prints the LAST --tail entries (default 50) in chronological order, oldest',
        '  first.  --plan filters to one plan before the tail is taken.  --follow keeps',
        '  the command attached, printing new entries as they arrive (Ctrl-C to stop) —',
        '  handy in a second terminal while `run` is executing.',
        '',
        'SOURCE',
        '  <project-root>/.ai-runtime/observability.jsonl; a project without persistent',
        '  runs has no log, which is reported as an empty result (not an error).',
      ),
    );

  applyExitOverride(program);

  return program;
}

/**
 * Parse and execute the CLI.  Returns the process exit code (does NOT
 * call process.exit — the caller sets process.exitCode so async cleanup
 * and stdio flushing can finish).
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram(detectBinName(argv));
  applyExitOverride(program);
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      // Commander already displayed the error (or the help text) itself —
      // printing again here would double every error line.
      return typeof e.exitCode === 'number' ? e.exitCode : 1;
    }
    if (e instanceof Error) {
      err(chalk.red(`Error: ${e.message}`));
      return 1;
    }
    return 1;
  }
}

// Auto-run only when executed directly (e.g. `human-out-of-the-loop` /
// `node dist/src/cli.js`) — not when imported by tests.  Node resolves
// the ESM entry to its REAL path while argv[1] keeps the symlink a
// package manager leaves in node_modules/.bin, so compare realpaths.
function isDirectlyInvoked(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * Exit quietly when the consumer closes the pipe early — `hootl --help | head`
 * or `hootl models --json | jq '.[0]'` used to crash with an unhandled EPIPE
 * stack trace instead of a clean exit.
 */
function installPipeGuard(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
}

if (isDirectlyInvoked()) {
  installPipeGuard();
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
