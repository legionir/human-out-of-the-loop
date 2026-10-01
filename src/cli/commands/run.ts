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
import { ZodError } from 'zod';
import { Orchestrator, type OrchestratorResult } from '../../ai/orchestrator.js';
import type { CachedOrchestratorHooks } from '../utils/orchestrator-cache.js';
import type { Plan } from '../../ai/schemas/plan.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import fs from 'node:fs';
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';
import {
  confirmPlanInteractively,
  promptClarifications,
  type ConfirmationResult,
} from '../utils/confirm.js';
import { resolveCliDefaults } from '../utils/config.js';
import { resolveAndMaybePersistTrust } from '../utils/trust-project.js';
import { parseModePrefix, resolveRunMode, modeWords } from '../utils/mode-prefix.js';
import type { RunMode } from '../../ai/modes.js';
import { createProgressRenderer } from '../utils/streaming.js';
import { color, err, out } from '../utils/output.js';
import {
  ActivityIndicator,
  resolveActivityEnabled,
  resolveActivityIntervalMs,
} from '../utils/activity.js';
import {
  createReasoningRenderer,
  resolveThinkingMode,
  type ThinkingMode,
} from '../utils/reasoning.js';
import { createToolLogRenderer, resolveToolLogEnabled } from '../utils/tool-log.js';
import { parseBudget } from '../../ai/runtime/budget.js';
import { resolveProfileSelection as resolveSelectedWorkflowProfile } from '../../ai/workflow-profiles/profile-selection.js';
import {
  loadResumableWorkflowProfileRun,
  openWorkflowProfileRunStore,
} from '../../ai/workflow-profiles/profile-resume.js';
import { WorkflowProfileLoadError } from '../../ai/workflow-profiles/profile-registry.js';
import type { OrchestratorWorkflowProfileOptions } from '../../ai/orchestrator.js';

/**
 * Phase 8 Step 2: resolve `--profile <id>` / `--profile-file <path>` into the activation options.
 * The resolution itself lives in the workflow-profile module so the CLI and the server cannot
 * drift apart; only the *explicit* selection is turned into an opt-in, and `profiles validate` is
 * the introspection path, so nothing is executed or written here.
 */
export function resolveProfileSelection(
  projectRoot: string,
  trustedProject: boolean,
  opts: Pick<RunCommandOptions, 'profile' | 'profileFile'>,
): OrchestratorWorkflowProfileOptions {
  return resolveSelectedWorkflowProfile({
    projectRoot,
    trustedProject,
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.profileFile !== undefined ? { profileFile: opts.profileFile } : {}),
  });
}

export interface RunCommandOptions {
  /** Default: '.' (or the global config's projectRoot) */
  projectRoot?: string;
  /** Force persistent stores (default: global config or off) */
  persistent?: boolean;
  /** Model id (default: global config or DEFAULT_MODEL_ID) */
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
  /**
   * Phase 32: show the model's own thinking text while it answers
   * (`auto` = only in a terminal).  See `resolveThinkingMode`.
   */
  thinking?: ThinkingMode | string;
  /**
   * v27.17.3: log every tool call (type, name, input, status).
   * `auto` (default) = on, unless `HOTL_TOOL_LOG=0` says otherwise.
   */
  toolLog?: string;
  /**
   * v27.17.0: `auto` (default) plans or answers depending on the request,
   * `chat` never plans, `plan` never answers.  An `@chat`/`@plan` prefix in
   * the goal wins over this flag.
   */
  mode?: RunMode | string;
  /**
   * G-17: force persistence off even when the global config has persistent:true.
   */
  noPersistent?: boolean;
  /**
   * G-01: when false (REPL) Ctrl-C during planning aborts the goal instead of
   * `process.exit(130)`.  Default true for `hootl run`.
   */
  exitOnInterrupt?: boolean;
  /** G-09: reuse a live Orchestrator (REPL cache). */
  orchestrator?: Orchestrator;
  /** G-09: leave the reused Orchestrator running. */
  skipShutdown?: boolean;
  /** G-09: live callback slot on a cached Orchestrator. */
  runHooks?: CachedOrchestratorHooks;
  /**
   * A-02: mark this project trusted (persist in global config) so its
   * `registry/mcp-servers` layer is allowed to spawn.
   */
  trustProject?: boolean;
  /** Phase 8: run with this discovered Workflow Profile (explicit user selection). */
  profile?: string;
  /** Phase 8: run with this Workflow Profile file (explicit user selection). */
  profileFile?: string;
  /**
   * Phase 10 (U-2): resume a recorded profile run (see `hootl profiles runs`). The stored record
   * supplies the profile and the session; the request text is supplied again, because the kernel
   * keeps no cross-run input state.
   */
  resume?: string;
  /** J-03: token count or `$1.50`. */
  budget?: string;
  /** J-07: plan only and print an estimate; nothing is executed. */
  estimate?: boolean;
}

/** C3: option validation → undefined when OK, error message otherwise (exit 2). */
export function validateRunOptions(opts: RunCommandOptions): string | undefined {
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
  if (opts.budget !== undefined) {
    const parsed = parseBudget(String(opts.budget));
    if ('error' in parsed) return `--budget: ${parsed.error}`;
  }
  // Phase 32: a typo in --thinking must fail fast, not silently do nothing.
  if (
    opts.thinking !== undefined &&
    !['auto', 'on', 'off'].includes(String(opts.thinking).trim().toLowerCase())
  ) {
    return `--thinking must be auto, on or off (got "${String(opts.thinking)}")`;
  }
  // v27.17.3: same for --tool-log.
  if (
    opts.toolLog !== undefined &&
    !['auto', 'on', 'off'].includes(String(opts.toolLog).trim().toLowerCase())
  ) {
    return `--tool-log must be auto, on or off (got "${String(opts.toolLog)}")`;
  }
  // v27.17.0: same for --mode.
  if (
    opts.mode !== undefined &&
    !['auto', 'chat', 'plan'].includes(String(opts.mode).trim().toLowerCase())
  ) {
    return `--mode must be auto, chat or plan (got "${String(opts.mode)}")`;
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
  /** G-04: `--session` pointed at a missing id. */
  sessionNotFound?: boolean;
}

/** G-01: first Ctrl-C during planning vs. a confirmed plan. */
export function planningInterruptAction(opts: {
  currentPlanId: string | undefined;
  interruptRequested: boolean;
  exitOnInterrupt: boolean;
}): 'exit' | 'abort-planning' | 'cancel-plan' {
  if (opts.interruptRequested || !opts.currentPlanId) {
    return opts.exitOnInterrupt || Boolean(opts.currentPlanId) ? 'exit' : 'abort-planning';
  }
  return 'cancel-plan';
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

  // v27.17.0: the mode can be written inside the goal (`@chat …`, `@plan …`).
  const prefixed = parseModePrefix(goal);
  const requested = prefixed.text;

  // Phase 29: an empty goal reached the planner (and produced an opaque
  // schema error); it is a usage mistake, so fail fast with exit 2.
  if (requested.trim().length === 0) {
    err(chalk.red('The goal must not be empty.'));
    err(chalk.dim(`Example: hootl run "summarize the README"   (or "${'@chat'} hello")`));
    return { exitCode: 2 };
  }

  const defaults = resolveCliDefaults({
    projectRoot: opts.projectRoot,
    persistent: opts.persistent,
    noPersistent: opts.noPersistent,
    model: opts.model,
  });
  const projectRoot = defaults.projectRoot;
  const globalConfig = defaults.global;

  const { resolved, invalid: badMode } = resolveRunMode({
    ...(prefixed.mode ? { prefix: prefixed.mode } : {}),
    ...(opts.mode !== undefined ? { flag: String(opts.mode) } : {}),
    env: process.env,
    config: globalConfig,
  });
  if (badMode) {
    err(
      chalk.red(
        `Invalid default mode "${badMode.value}" (${badMode.source === 'env' ? 'HOTL_MODE' : 'defaultMode in the global config'}).`,
      ),
    );
    err(chalk.dim(`Use one of: ${['auto', 'chat', 'plan'].join(', ')} — or an ${modeWords()} prefix in the goal.`));
    return { exitCode: 2 };
  }

  const persistent = defaults.persistent;
  const model = defaults.model;

  // ── Phase 32: tell the user the run is alive, and stream its thinking ──
  //
  // Everything from here to the report can wait on a model: planning,
  // clarification, a step's agent turn, the acceptance judgment, the final
  // review.  The spinner covers "no result yet"; the reasoning renderer
  // shows the model's own thinking when the provider exposes it (showing it
  // switches agent turns to `streamText` — see AgentRuntime).
  const showThinking = resolveThinkingMode(opts.thinking);
  const activity = new ActivityIndicator({
    enabled: resolveActivityEnabled(),
    intervalMs: resolveActivityIntervalMs(),
  });
  const reasoning = createReasoningRenderer({ indicator: activity });
  // v27.17.3: what the AI does, line by line (see utils/tool-log.ts).  The
  // sink is wired through the Orchestrator, so plan steps AND chat turns
  // report through it — one renderer for the whole run.
  const toolLog = createToolLogRenderer({
    enabled: resolveToolLogEnabled(opts.toolLog),
  });
  activity.start();

  /** Run a prompt with the spinner out of the way. */
  const withoutActivity = async <T>(fn: () => Promise<T>): Promise<T> => {
    activity.pause();
    try {
      return await fn();
    } finally {
      activity.resume();
    }
  };

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
  const abortController = new AbortController();
  const exitOnInterrupt = opts.exitOnInterrupt !== false;
  const onSigint = (): void => {
    if (!orchestratorRef) return;
    const action = planningInterruptAction({ currentPlanId, interruptRequested, exitOnInterrupt });
    if (action === 'abort-planning') {
      abortController.abort();
      out(color.warn('\n⏹  Planning cancelled.'));
      return;
    }
    if (action === 'exit') {
      out(color.warn('\n⏹  Interrupted again — exiting now.'));
      if (currentPlanId) finalizeCancelledPlan(projectRoot, currentPlanId);
      abortController.abort();
      if (exitOnInterrupt) process.exit(130);
      return;
    }
    interruptRequested = true;
    out(
      color.warn(
        `\n⏹  Cancelling plan ${currentPlanId} — no new steps will start.` +
          '\n   The step in flight finishes; press Ctrl-C again to leave now.',
      ),
    );
    void orchestratorRef.cancelPlan(currentPlanId!).catch(() => undefined);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  process.on('SIGHUP', onSigint);

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
        // The prompt owns the terminal while it is up.
        return withoutActivity(() => confirmPlanInteractively(planText));
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
      : (questions: string[], round: number) =>
          withoutActivity(() => promptClarifications(questions, round));

  const renderer = createProgressRenderer({ verbose: opts.verbose ?? false });


  const trustedProject = resolveAndMaybePersistTrust(projectRoot, opts.trustProject === true);

  const extraOrch = {
    trustedProject,
    ...(opts.timeoutMs !== undefined ? { agentTimeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.maxReplans !== undefined ? { maxReplanningAttempts: opts.maxReplans } : {}),
    ...(opts.maxDelegationDepth !== undefined ? { maxDelegationDepth: opts.maxDelegationDepth } : {}),
  };
  if (opts.runHooks) {
    opts.runHooks.onProgress = (event: ProgressEvent) => renderer(event);
    if (showThinking) opts.runHooks.onThought = reasoning;
    opts.runHooks.onToolCall = toolLog;
  }

  // Phase 10 (U-2): `--resume <runId>` reads the recorded run state first, so a missing or finished
  // run fails before anything else happens. The stored record supplies the profile and session; the
  // guards that decide whether the profile, dependencies and authority still match run inside the
  // runner, before any node executes.
  let resumeState: ReturnType<typeof loadResumableWorkflowProfileRun> | undefined;
  if (opts.resume !== undefined) {
    if (opts.profile !== undefined || opts.profileFile !== undefined) {
      err(chalk.red('--resume cannot be combined with --profile/--profile-file: the recorded run names its profile.'));
      return { exitCode: 2 };
    }
    try {
      resumeState = loadResumableWorkflowProfileRun(
        openWorkflowProfileRunStore(path.join(projectRoot, '.ai-runtime')),
        opts.resume,
      );
    } catch (error) {
      if (error instanceof WorkflowProfileLoadError) {
        err(chalk.red(error.message));
        for (const diagnostic of error.diagnostics) err(chalk.dim(`  ${diagnostic.code}: ${diagnostic.message}`));
        err(chalk.dim('List recorded runs with `hootl profiles runs`.'));
        return { exitCode: 1 };
      }
      throw error;
    }
  }

  // Phase 8: an explicitly selected Workflow Profile turns the profile path on for this run —
  // selection is the opt-in the flag documents. Discovery/validation happens here, before the
  // session and the plan exist, so a bad profile fails before any side effect. A resume selects the
  // profile its record names, through the same resolution path.
  const profileSelection = resumeState
    // A run started from an explicit file is resumed from that file: the id alone would not be
    // discoverable. The resume guard compares the profile hash, so a tampered record cannot
    // substitute different content for the one the interrupted attempt was running.
    ? resolveProfileSelection(projectRoot, trustedProject, resumeState.profileFile
      ? { profileFile: resumeState.profileFile }
      : { profile: resumeState.profileId })
    : opts.profile !== undefined || opts.profileFile !== undefined
      ? resolveProfileSelection(projectRoot, trustedProject, opts)
      : undefined;
  const resumeOptions = resumeState
    ? { runId: resumeState.runId, stateStore: openWorkflowProfileRunStore(path.join(projectRoot, '.ai-runtime')) }
    : undefined;

  const orchestrator =
    opts.orchestrator ??
    new Orchestrator({
      projectRoot,
      persistent,
      ...extraOrch,
      ...(model ? { defaultModelId: model } : {}),
      ...(profileSelection ? { workflowProfile: { ...profileSelection, ...(resumeOptions ?? {}) } } : {}),
      onProgress: (event: ProgressEvent) => renderer(event),
      ...(showThinking ? { onThought: reasoning } : {}),
      onToolCall: toolLog,
    });
  orchestratorRef = orchestrator;

  try {
    // ── Validate the model id before ANY side effect (U3 semantics) ──
    // Previously an unknown --model fell through to the planner, whose error
    // was swallowed into an empty "clarification needed" report.
    await orchestrator.initialize();

    // Phase 10 (U-2): a resumed profile run continues in the session its record names, when that
    // session still exists. A record from a non-persistent run has no session to continue, so the
    // run simply starts a fresh one (the resume guards compare the profile, pins and authority,
    // not the session).
    const resumeSessionId = opts.session ??
      (resumeState?.sessionId && orchestrator.sessionStore.getSession(resumeState.sessionId)
        ? resumeState.sessionId
        : undefined);

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
      return { exitCode: 2, sessionNotFound: true };
    }

    // Any model spec runs — a registered id, `<provider>:<name>`, or a
    // provider model name (registered on the fly by the orchestrator).  Say
    // which one, so a typo is visible before the first call fails.
    const active = orchestrator.modelRegistry.getConfig(orchestrator.config.defaultModelId);
    if (active && active.description?.startsWith('Selected at runtime')) {
      // G-18: never print a custom baseURL (it may be an internal gateway).
      out(color.dim(`Model: ${active.model} (not in the registry) via the ${active.provider} API`));
    }

    // Say which mode is in force when the user (or their config) chose it —
    // a stray `HOTL_MODE` must never surprise anyone.
    if (resolved.source !== 'default') {
      out(color.dim(`Mode: ${resolved.mode} (${resolved.source})`));
    }

    // ── Estimate: plan, print cost, stop ──────────────────────
    if (opts.estimate) {
      out(color.bold('📊 Estimate — planning only, nothing will be executed.'));
      const estimated = await orchestrator.estimatePlan(requested, undefined, resolved.mode);
      if (!estimated.ok && !estimated.plan) {
        out(color.failed(estimated.error ?? 'Planning failed.'));
        return { exitCode: 1 };
      }
      if (estimated.planText) {
        out(color.bold('\n── Planned steps ─────────────────────────────'));
        out(estimated.planText);
      }
      out(color.bold('\n── Estimate ──────────────────────────────────'));
      out(`Steps:  ${estimated.estimate.steps}`);
      out(`Tokens: ~${estimated.estimate.tokens} (planning used ${estimated.usage.totalTokens})`);
      out(`Cost:   ~$${estimated.estimate.usd.toFixed(4)}`);
      return { exitCode: 0 };
    }

    // ── Dry run: plan, show, stop ─────────────────────────────
    if (opts.dryRun) {
      out(color.bold('📋 Dry run — planning only, nothing will be executed.'));
      const preview = await orchestrator.previewPlan(requested, undefined, resolved.mode);
      if (preview.ok && preview.answer !== undefined) {
        // Chat mode has nothing to execute, so the answer IS the preview.
        out(color.bold('\n💬 Answer (nothing to execute)'));
        out(preview.answer);
        return { exitCode: 0 };
      }
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

    // G-02: fail before any paid LLM call.  Confirmation needs a TTY unless
    // `--yes`; a chat-mode run never confirms.  This comes after the free
    // pre-flight (options, --session, model) so usage errors still exit 2.
    if (
      !opts.yes &&
      resolved.mode !== 'chat' &&
      (!process.stdout.isTTY || !process.stdin.isTTY)
    ) {
      err(
        chalk.red(
          'Interactive confirmation requires a TTY. Re-run with --yes to auto-confirm (CI / Human-Out-Of-Loop mode), or from an interactive terminal.',
        ),
      );
      return { exitCode: 1 };
    }

    // ── Full run (Human-Out-Of-Loop after confirmation) ───────
    if (resumeState) {
      out(color.dim(
        `Resuming profile run ${resumeState.runId} (${resumeState.profileId}) from node "${resumeState.currentNodeId}".`,
      ));
    }
    const result: OrchestratorResult = await orchestrator.run(requested, {
      sessionId: resumeSessionId,
      abortSignal: abortController.signal,
      // v27.17.0: auto (default) / chat / plan — the prefix in the goal wins.
      mode: resolved.mode,
      ...(opts.budget || opts.timeoutMs !== undefined || opts.maxSteps !== undefined || opts.maxReplans !== undefined
        ? {
            runOverrides: {
              ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
              ...(opts.timeoutMs !== undefined ? { agentTimeoutMs: opts.timeoutMs } : {}),
              ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
              ...(opts.maxReplans !== undefined ? { maxReplanningAttempts: opts.maxReplans } : {}),
            },
          }
        : {}),
      // C3: label the NEW session (--label is rejected with --session)
      ...(opts.label !== undefined ? { sessionLabel: opts.label } : {}),
      confirmCallback,
      // C4: interactive clarification (undefined in --yes / non-TTY)
      ...(clarificationCallback ? { clarificationCallback } : {}),
    });

    // A thinking block that was still streaming must not run into the
    // report; the spinner belongs to the waiting, which is over.
    reasoning.close();
    out('');
    out(result.report);

    const usage = orchestrator.getUsageSummary();
    out(
      color.dim(
        `\nUsage: ${usage.totalTokens} tokens ` +
          `(${usage.totalPromptTokens} prompt + ${usage.totalCompletionTokens} completion)`,
      ),
    );
    out(
      color.dim(
        `Session: ${result.sessionId}   ` +
          (result.kind === 'answer'
            ? `Plan: none (answered in ${resolved.mode === 'chat' ? 'chat' : 'auto'} mode)`
            : `Plan: ${result.planId}`),
      ),
    );

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
    process.removeListener('SIGTERM', onSigint);
    process.removeListener('SIGHUP', onSigint);
    // ...including an error path that left a thinking block open.
    reasoning.close();
    activity.stop();
    if (!opts.skipShutdown) await orchestrator.shutdown();
  }
}
