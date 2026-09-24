/**
 * Phase 23 (CLI, step 2): the main command.
 *
 *   human-out-of-the-loop run "Build login page" \
 *     --project-root ./my-app --persistent --model gpt-4o \
 *     [--session session_123] [--yes] [--verbose] [--dry-run]
 *
 * Flow (mirrors the Claude Code CLI feel):
 *   1. load .env (API keys) + global config defaults
 *   2. build the Orchestrator (streaming → terminal renderer)
 *   3. --dry-run: previewPlan → show plan, stop (nothing executed)
 *      otherwise: run() → confirm (inquirer, or --yes) → execute → report
 *   4. exit code: 0 success/partial, 1 failure, 2 usage error
 */
import path from 'node:path';
import chalk from 'chalk';
import { Orchestrator, type OrchestratorResult } from '../../ai/orchestrator.js';
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';
import {
  confirmPlanInteractively,
  type ConfirmationResult,
} from '../utils/confirm.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { createProgressRenderer } from '../utils/streaming.js';
import { color, err, out } from '../utils/output.js';

export interface RunCommandOptions {
  /** Default: '.' (or the global config's projectRoot) */
  projectRoot?: string;
  /** Force persistent stores (default: global config or off) */
  persistent?: boolean;
  /** Model id (default: global config or 'gpt-4o') */
  model?: string;
  /** Resume in an existing session */
  session?: string;
  /** Auto-confirm the plan (CI / Human-Out-Of-Loop) */
  yes?: boolean;
  /** Show tool calls and low-level status lines */
  verbose?: boolean;
  /** Plan only — show the plan, never execute */
  dryRun?: boolean;
  /** Agent timeout in ms (OrchestratorConfig.agentTimeoutMs) */
  timeoutMs?: number;
  /** Max tool-call iterations per agent run */
  maxSteps?: number;
  /** C3: automatic re-planning attempts (OrchestratorConfig.maxReplanningAttempts) */
  maxReplans?: number;
  /** C3: max agent → sub-agent delegation depth (OrchestratorConfig.maxDelegationDepth) */
  maxDelegationDepth?: number;
  /** C3: label for the NEW session (mutually exclusive with --session) */
  label?: string;
}

/** C3: option validation → undefined when OK, error message otherwise (exit 2). */
function validateRunOptions(opts: RunCommandOptions): string | undefined {
  if (opts.maxReplans !== undefined && (!Number.isInteger(opts.maxReplans) || opts.maxReplans < 0 || opts.maxReplans > 10)) {
    return '--max-replans must be an integer between 0 and 10';
  }
  if (
    opts.maxDelegationDepth !== undefined &&
    (!Number.isInteger(opts.maxDelegationDepth) || opts.maxDelegationDepth < 0 || opts.maxDelegationDepth > 5)
  ) {
    return '--max-delegation-depth must be an integer between 0 and 5';
  }
  if (opts.label !== undefined && opts.label.length > 64) {
    return '--label must be at most 64 characters';
  }
  if (opts.label !== undefined && opts.session) {
    return '--label only applies to a NEW session; use "sessions label <id> <label>" to rename an existing one';
  }
  return undefined;
}

export interface RunCommandResult {
  exitCode: number;
}

export async function runCommand(goal: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  const invalid = validateRunOptions(opts);
  if (invalid) {
    err(chalk.red(invalid));
    return { exitCode: 2 };
  }

  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  const globalConfig = prepareCliEnvironment(projectRoot);

  const persistent = opts.persistent ?? globalConfig.persistent ?? false;
  const model = opts.model ?? globalConfig.defaultModel;

  const confirmCallback: (planText: string) => Promise<ConfirmationResult> = opts.yes
    ? async () => ({ confirmed: true })
    : (planText) => confirmPlanInteractively(planText);

  const renderer = createProgressRenderer({ verbose: opts.verbose ?? false });

  const orchestrator = new Orchestrator({
    projectRoot,
    persistent,
    ...(model ? { defaultModelId: model } : {}),
    ...(opts.timeoutMs !== undefined ? { agentTimeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    // C3: execution-control passthrough
    ...(opts.maxReplans !== undefined ? { maxReplanningAttempts: opts.maxReplans } : {}),
    ...(opts.maxDelegationDepth !== undefined ? { maxDelegationDepth: opts.maxDelegationDepth } : {}),
    onProgress: (event: ProgressEvent) => renderer(event),
  });

  try {
    // ── Dry run: plan, show, stop ─────────────────────────────
    if (opts.dryRun) {
      out(color.bold('📋 Dry run — planning only, nothing will be executed.'));
      const preview = await orchestrator.previewPlan(goal);
      if (preview.planText) {
        out(color.bold('\n── Planned steps ─────────────────────────────'));
        out(preview.planText);
        out(color.bold('─────────────────────────────────────────────'));
        out(color.dim(`(plan id: ${preview.plan?.id ?? 'n/a'} — not persisted)`));
        return { exitCode: 0 };
      }
      out(color.failed(preview.error ?? 'Planning failed.'));
      return { exitCode: 1 };
    }

    // ── Full run (Human-Out-Of-Loop after confirmation) ───────
    const result: OrchestratorResult = await orchestrator.run(goal, {
      sessionId: opts.session,
      // C3: label the NEW session (--label is rejected with --session)
      ...(opts.label !== undefined ? { sessionLabel: opts.label } : {}),
      confirmCallback,
    });

    out('');
    out(result.report);

    const usage = orchestrator.getUsageSummary();
    out(
      color.dim(
        `\nUsage: ${usage.totalTokens} tokens ` +
          `(${usage.totalPromptTokens} prompt + ${usage.totalCompletionTokens} completion)`,
      ),
    );
    out(color.dim(`Session: ${result.sessionId}   Plan: ${result.planId}`));

    const exitCode =
      result.review.outcome === 'success' || result.review.outcome === 'partial-success'
        ? 0
        : 1;
    return { exitCode };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err(color.failed(`Error: ${message}`));
    if (opts.verbose && e instanceof Error && e.stack) {
      err(color.dim(e.stack));
    }
    return { exitCode: 1 };
  } finally {
    await orchestrator.shutdown();
  }
}
