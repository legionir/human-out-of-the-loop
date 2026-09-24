#!/usr/bin/env node
/**
 * Phase 23 (CLI): `human-out-of-the-loop` — the command-line entry
 * point, structured like the Claude Code CLI:
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
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
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

export function createProgram(): Command {
  const program = new Command();
  program
    .name('human-out-of-the-loop')
    .description(
      'Autonomous agent runtime — the human confirms ONCE, then goes out of the loop.',
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
    .option('--timeout-ms <ms>', 'per-agent timeout in milliseconds', (v: string) => Number(v))
    .option('--max-steps <n>', 'max tool-call iterations per agent run', (v: string) => Number(v))
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
    });

  // ── sessions ─────────────────────────────────────────────────
  const sessions = program.command('sessions').description('List, show, label, and delete sessions');
  sessions
    .command('list')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsListCommand({ projectRoot: opts.projectRoot });
    });
  sessions
    .command('show')
    .argument('<sessionId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsShowCommand(id, { projectRoot: opts.projectRoot });
    });
  sessions
    .command('delete')
    .argument('<sessionId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsDeleteCommand(id, { projectRoot: opts.projectRoot });
    });
  sessions
    .command('label')
    .argument('<sessionId>')
    .argument('<label>', 'new label (empty string clears it)')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, label: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await sessionsLabelCommand(id, label, { projectRoot: opts.projectRoot });
    });

  // ── plans ────────────────────────────────────────────────────
  const plans = program.command('plans').description('List, show, cancel, and resume plans');
  plans
    .command('list')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await plansListCommand({ projectRoot: opts.projectRoot });
    });
  plans
    .command('show')
    .argument('<planId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await plansShowCommand(id, { projectRoot: opts.projectRoot });
    });
  plans
    .command('cancel')
    .argument('<planId>')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | undefined>) => {
      process.exitCode = await plansCancelCommand(id, { projectRoot: opts.projectRoot });
    });
  plans
    .command('resume')
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
  const mcp = program.command('mcp').description('Manage MCP servers (registry/mcp-servers)');
  mcp
    .command('list')
    .option('--project-root <dir>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | undefined>) => {
      process.exitCode = await mcpListCommand({ projectRoot: opts.projectRoot });
    });
  mcp
    .command('test')
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
      .option('--json', 'machine-readable output');

  registryOptions(program
    .command('models')
    .description('List available models (registry/models/*.json)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await modelsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('personas')
    .description('List available personas (registry/personas/*.json)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await personasCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('skills')
    .description('List available skills (registry/skills/*.json)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await skillsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

  registryOptions(program
    .command('tools')
    .description('List available tools (registry/tools/*.json)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      process.exitCode = await toolsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        json: opts.json === true,
      });
    }));

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
    });

  const tasksCmd = program
    .command('tasks')
    .description('Inspect tasks from the observability log (read-only)');

  tasksCmd
    .command('list')
    .description('List tasks (optionally scoped to one plan)')
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
    .option('--tail <n>', 'number of trailing lines', (v: string) => Number(v), 50)
    .option('--follow', 'keep following the log for new entries')
    .action(async (opts: Record<string, string | number | boolean | undefined>) => {
      process.exitCode = await logsCommand({
        projectRoot: opts.projectRoot as string | undefined,
        plan: opts.plan as string | undefined,
        tail: opts.tail as number | undefined,
        follow: opts.follow === true,
      });
    });

  return program;
}

/**
 * Parse and execute the CLI.  Returns the process exit code (does NOT
 * call process.exit — the caller sets process.exitCode so async cleanup
 * and stdio flushing can finish).
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();
  program.exitOverride();
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

if (isDirectlyInvoked()) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
