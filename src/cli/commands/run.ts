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
import { envDefaultModelId } from '../utils/registries.js';
import path from 'node:path';
import chalk from 'chalk';
import { ZodError } from 'zod';
import { Orchestrator, type OrchestratorResult } from '../../ai/orchestrator.js';
import type { Plan } from '../../ai/schemas/plan.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import fs from 'node:fs';
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';
import {
  confirmPlanInteractively,
  promptClarifications,
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
  // Phase 29: these two used to fall through to the OrchestratorConfigSchema
  // and print a raw ZodError.  Bounds mirror the schema exactly.
  if (
    opts.maxSteps !== undefined &&
    (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1 || opts.maxSteps > 100)
  ) {
    return '--max-steps must be an integer between 1 and 100';
  }
  if (
    opts.timeoutMs !== undefined &&
    (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 600000)
  ) {
    return '--timeout-ms must be an integer between 1000 and 600000';
  }
  return undefined;
}

/** Render a ZodError as a short, human list instead of a JSON dump. */
function formatZodError(err: unknown): string | undefined {
  if (!(err instanceof ZodError)) return undefined;
  const lines = err.issues.map((issue) => {
    const field = issue.path.join('.') || '(config)';
    return `${field}: ${issue.message}`;
  });
  return `Invalid configuration — ${lines.join('; ')}`;
}

export interface RunCommandResult {
  exitCode: number;
  /** The session the run was recorded in (full runs only). */
  sessionId?: string;
}

/**
 * Phase 30 (P10 follow-up): the second Ctrl-C leaves immediately, but the
 * plan must not stay stuck in `cancelling` on disk — a later reader
 * (`plans list`, the web UI) would show a state no process owns any more.
 * Synchronous on purpose: this runs on the way out of the process.
 */
function finalizeCancelledPlan(projectRoot: string, planId: string): void {
  try {
    const dir = path.join(projectRoot, '.ai-runtime', 'plans');
    if (!fs.existsSync(dir)) return;
    const store = new FilePlanStore(dir);
    const plan = store.load(planId);
    if (!plan) return;
    if (
      plan.status === 'completed' ||
      plan.status === 'cancelled' ||
      plan.status === 'failed-partial'
    ) {
      return;
    }
    plan.status = 'cancelled';
    plan.completedAt = Date.now();
    store.save(plan);
  } catch {
    // Leaving the process matters more than the bookkeeping.
  }
}

export async function runCommand(goal: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  const invalid = validateRunOptions(opts);
  if (invalid) {
    err(chalk.red(invalid));
    return { exitCode: 2 };
  }
  // Phase 29: an empty goal reached the planner (and produced an opaque
  // schema error); it is a usage mistake, so fail fast with exit 2.
  if (goal.trim().length === 0) {
    err(chalk.red('The goal must not be empty.'));
    err(chalk.dim('Example: hootl run "summarize the README"'));
    return { exitCode: 2 };
  }

  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  const globalConfig = prepareCliEnvironment(projectRoot);

  const persistent = opts.persistent ?? globalConfig.persistent ?? false;
  const model = opts.model ?? envDefaultModelId(projectRoot) ?? globalConfig.defaultModel;

  // Phase 30 (P10 follow-up): graceful Ctrl-C.
  //
  //   first  Ctrl-C -> cancel the running plan the same way
  //                    `hootl plans cancel` does: no new step is dispatched,
  //                    the step already in flight finishes, the report is
  //                    still written;
  //   second Ctrl-C -> leave immediately (the old behaviour).
  //
  // The plan id only exists once the plan is confirmed, so an interrupt
  // before that (planning, the confirmation prompt) keeps the exit-now
  // behaviour — nothing has been dispatched yet.
  let currentPlanId: string | undefined;
  let interruptRequested = false;
  let orchestratorRef: Orchestrator | undefined;
  const onSigint = (): void => {
    if (!orchestratorRef) return;
    if (interruptRequested || !currentPlanId) {
      out(color.warn('\n⏹  Interrupted again — exiting now.'));
      if (currentPlanId) finalizeCancelledPlan(projectRoot, currentPlanId);
      process.exit(130);
    }
    interruptRequested = true;
    out(
      color.warn(
        `\n⏹  Cancelling plan ${currentPlanId} — no new steps will start.` +
          '\n   The step in flight finishes; press Ctrl-C again to leave now.',
      ),
    );
    void orchestratorRef.cancelPlan(currentPlanId).catch(() => undefined);
  };
  process.on('SIGINT', onSigint);

  const confirmCallback: (
    planText: string,
    plan?: Plan,
  ) => Promise<ConfirmationResult> = opts.yes
    ? async (_planText: string, plan?: Plan) => {
        // --yes still sees the plan: without the id, a Ctrl-C could not
        // address the running plan and had to exit immediately.
        currentPlanId = plan?.id ?? currentPlanId;
        return { confirmed: true };
      }
    : (planText: string, plan?: Plan) => {
        currentPlanId = plan?.id ?? currentPlanId;
        return confirmPlanInteractively(planText);
      };

  // C4: clarification only when interactive AND not auto-confirming.
  //  - --yes (CI / HOTL): no callback → the planner's questions fail the
  //    run with the questions shown (legacy CI-safe behavior).
  //  - non-TTY without --yes: no callback → same; the questions are
  //    printed by the failure report instead of hanging on a prompt.
  //  - TTY without --yes: prompt per question; Ctrl+C / all-empty answers
  //    → null → clean run cancellation.
  const clarificationCallback =
    opts.yes || !process.stdout.isTTY || !process.stdin.isTTY
      ? undefined
      : (questions: string[], round: number) => promptClarifications(questions, round);

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
  orchestratorRef = orchestrator;

  try {
    // ── Validate the model id before ANY side effect (U3 semantics) ──
    // Previously an unknown --model fell through to the planner, whose error
    // was swallowed into an empty "clarification needed" report.
    await orchestrator.initialize();

    // Phase 29: `--session <id>` pointing at a session that does not exist
    // used to be accepted silently — the run reported the bogus id as its
    // session and persisted no interaction at all.  Fail fast instead.
    if (opts.session !== undefined && !orchestrator.sessionStore.getSession(opts.session)) {
      err(chalk.red(`Session "${opts.session}" not found.`));
      err(
        chalk.dim(
          persistent
            ? 'List existing sessions with `hootl sessions list`.'
            : 'Sessions are only stored with --persistent (or persistent:true in the global config).',
        ),
      );
      return { exitCode: 2 };
    }

    // Any model spec runs — a registered id, `<provider>:<name>`, or a
    // provider model name (registered on the fly by the orchestrator).  Say
    // which one, so a typo is visible before the first call fails.
    const active = orchestrator.modelRegistry.getConfig(orchestrator.config.defaultModelId);
    if (active && active.description?.startsWith('Selected at runtime')) {
      const where = (active.config?.baseURL as string | undefined) ?? `the ${active.provider} API`;
      out(color.dim(`Model: ${active.model} (not in the registry) via ${where}`));
    }

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
      // C4: interactive clarification (undefined in --yes / non-TTY)
      ...(clarificationCallback ? { clarificationCallback } : {}),
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
    return { exitCode, sessionId: result.sessionId };
  } catch (e) {
    const message = formatZodError(e) ?? (e instanceof Error ? e.message : String(e));
    err(color.failed(`Error: ${message}`));
    if (opts.verbose && e instanceof Error && e.stack) {
      err(color.dim(e.stack));
    }
    return { exitCode: 1 };
  } finally {
    process.removeListener('SIGINT', onSigint);
    await orchestrator.shutdown();
  }
}
