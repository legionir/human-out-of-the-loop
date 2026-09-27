import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registryLayersFor, type RegistryScope } from './registries/layout.js';
import { EventBus } from './runtime/event-bus.js';
import type { EnvSource } from './env.js';
import { resolveEnv } from './env.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import { TaskRuntime } from './runtime/task-runtime.js';
import { MemoryPlanStore, FilePlanStore, type PlanStore } from './runtime/plan-store.js';
import { PlanRuntime, type PlanExecutionResult } from './runtime/plan-runtime.js';
import { AcceptanceChecker } from './runtime/acceptance-checker.js';
import { FinalReviewer } from './runtime/final-reviewer.js';
import { StreamingManager, type ProgressEvent } from './runtime/streaming-manager.js';
import type { ThoughtSink } from './runtime/thought-stream.js';
import { CancellationManager } from './runtime/cancellation-manager.js';
import { RateLimiter } from './runtime/rate-limiter.js';
import { UsageAggregator } from './runtime/usage-aggregator.js';
import { envEndpoint, modelIdForSpec, parseModelSpec, runtimeModelConfig } from './models/env-endpoint.js';
import { DEFAULT_MODEL_ID } from './models/defaults.js';
import { listRemoteModels, type RemoteModelList } from './models/list-models.js';
import type { LlmUsageReport } from './runtime/llm-usage.js';
import { MemorySessionStore, FileSessionStore, type SessionStore } from './runtime/session-store.js';
import { ObservabilityLogger } from './runtime/observability-logger.js';
import { collectSecretValues } from './runtime/secret-scrub.js';
import type { ToolCallLogOptions, ToolCallSink } from './runtime/tool-call-log.js';
import { markRootTrusted } from './registries/trust.js';
import { ScrubbingPlanStore } from './runtime/secret-scrub.js';
import { logStepEvent, parseStepEvent } from './runtime/step-events.js';
import { JournalWriter, journalOptionsFromEnv } from './runtime/journal.js';
import { cleanupStaleTempFiles } from './runtime/atomic-write.js';
import { pruneCheckpoints } from './runtime/checkpoint.js';
import { cleanupStaleLockFiles } from './runtime/file-lock.js';
import { isAbortError, throwIfAborted } from './runtime/abort.js';
import { formatReviewForUser as formatFinalReview } from './runtime/review-formatter.js';
import { RetryableAgentRuntime } from './runtime/agent-runtime-retry.js';

import { PersonaRegistry } from './registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from './registries/skill-registry.js';
import { ToolRegistry } from './registries/tool-registry.js';
import { ModelRegistry } from './registries/model-registry.js';
import { AgentRegistry } from './registries/agent-registry.js';

import { Planner, formatSessionHistory } from './planning/planner.js';
import {
  PlanLiveOwnerError,
  tryAcquirePlanOwner,
  isPlanOwnerAlive,
  isPidAlive,
  type PlanOwnerHandle,
} from './runtime/plan-owner.js';
import { runFeasibilityGate } from './planning/feasibility-gate.js';
import { detectCycles, type CycleDetectionResult } from './planning/cycle-detector.js';
import {
  summarizePlan,
  formatPlanForUser,
} from './planning/plan-confirmation.js';
import { BudgetTracker, estimatePlanCost, parseBudget, priceFromModelConfig } from './runtime/budget.js';
import { resolveModelForRole, type ModelRoutes } from './models/model-routes.js';
import { planExamplesEnabled, savePlanExample } from './planning/plan-examples.js';

import { bootstrapCatalogTools } from './tools/catalog-bootstrap.js';
import { bootstrapDelegateTask } from './tools/delegate-bootstrap.js';
import type { DelegateTaskDeps } from './tools/implementations/delegate-task.js';
import { bootstrapTaskControlTools } from './tools/task-control-bootstrap.js';
import { bootstrapMcpServers } from './tools/mcp-bootstrap.js';
import type { McpConnector } from './tools/mcp-connector.js';
import { bootstrapTools } from './tools/bootstrap.js';
import { DelegationGuard } from './runtime/delegation-guard.js';

import {
  openaiProviderFactory,
  anthropicProviderFactory,
  localProviderFactory,
} from './models/providers/index.js';

import type { FeasibilityCheckResult, Plan } from './schemas/plan.js';
import { emptyReviewUsage, type Review } from './schemas/review.js';
import { createAgent, type ResolvedAgent } from './agents/agent-factory.js';
import { DEFAULT_RUN_MODE, type RunMode } from './modes.js';
import { readOnlyToolIds } from './tools/read-only.js';
import { detectLanguage, languageSection, type DetectedLanguage } from './language.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * Phase 22: the OrchestratorConfig is now VALIDATED with zod — the
 * constructor throws a `ZodError` for out-of-range values instead of
 * silently accepting them (e.g. maxConcurrentTasks: 0, agentTimeoutMs: 50).
 */
export const OrchestratorConfigSchema = z.object({
  projectRoot: z.string().min(1),
  persistent: z.boolean().default(false),
  runtimeDir: z.string().optional(),
  maxConcurrentTasks: z.number().int().min(1).max(100).default(5),
  maxConcurrentPerProvider: z.number().int().min(1).max(50).default(5),
  maxReplanningAttempts: z.number().int().min(0).max(10).default(3),
  agentTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxDelegationDepth: z.number().int().min(0).max(5).default(1),
  maxRetries: z.number().int().min(0).max(10).default(3),
  baseBackoffMs: z.number().int().min(100).default(1000),
  maxBackoffMs: z.number().int().min(1000).default(30000),
  maxSteps: z.number().int().min(1).max(100).default(20),
  contextBudgetChars: z.number().int().min(1000).default(120000),
  // Phase 37: the Journal — automatic, append-only record of what the AI did.
  // Optional (defaults resolved in code) so existing callers stay valid;
  // `HOTL_JOURNAL=0` / `HOTL_JOURNAL_RESULTS=full` override per process.
  journal: z
    .object({
      enabled: z.boolean().optional(),
      includeResults: z.enum(['none', 'summary', 'full']).optional(),
      maxEntryBytes: z.number().int().min(512).max(1024 * 1024).optional(),
      retentionDays: z.number().int().min(0).max(3650).optional(),
    })
    .optional(),
  connectTimeoutMs: z.number().int().min(1000).default(10000),
  defaultModelId: z.string().default(DEFAULT_MODEL_ID),
  // U1 (config parity): extra observability redaction keys (defaults
  // still apply when the list is non-empty).
  redactKeys: z.array(z.string().min(1)).default([]),
  /** J-06: model id per role (classify/judge/review/plan/code). */
  modelRoutes: z.record(z.string(), z.string()).optional(),
  // C4: max question-and-answer rounds before the run fails.
  maxClarificationRounds: z.number().int().min(0).max(10).default(3),
  // Phase 27 (CFG-08): optional per-Orchestrator environment.  When set,
  // every secret lookup (provider API keys, MCP auth vars,
  // LOCAL_MODEL_BASE_URL) resolves from this object instead of
  // process.env.  Omitted → previous behaviour (live process env).
  env: z.custom<EnvSource>((v) => typeof v === 'object' && v !== null).optional(),
});

/**
 * Config shape accepted by the constructor (input type — everything
 * except `projectRoot` is optional).  `onProgress` (Phase 19) is a
 * callback and is validated structurally, not via the base schema.
 */
export type OrchestratorConfig = z.input<typeof OrchestratorConfigSchema> & {
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Phase 32: live model thinking (reasoning) text for every agent turn of
   * the run.  Absent (the default — and always absent in CI, pipes and
   * tests) agent turns stay on the non-streaming call.
   */
  onThought?: ThoughtSink;
  /**
   * v27.17.3: one structured record per tool call — type, name, input,
   * status — for every agent turn of the run (the CLI renders a line per
   * call; a UI can consume the same records).  Absent means no records, and
   * the tool set is handed to the model exactly as it was.
   */
  onToolCall?: ToolCallSink;
  /**
   * R0-08: whether the operator has explicitly trusted `projectRoot`'s own
   * `registry/mcp-servers/*.json`.  Untrusted (the default) means the
   * PROJECT layer of mcp-servers is not bootstrapped at all — no stdio
   * child is spawned and no `tokenEnvVar`/`keyEnvVar` is read for it — so a
   * freshly cloned, unreviewed repository cannot get code execution or
   * exfiltrate env vars just from `initialize()`.  The packaged (global)
   * layer is unaffected.
   */
  trustedProject?: boolean;
};

/**
 * U3: per-run execution overrides.  Each field, when present, replaces
 * the corresponding `OrchestratorConfig` value for THIS run only:
 *   modelId                → defaultModelId (agents composed for this plan)
 *   agentTimeoutMs         → per-agent timeout (TaskRuntime)
 *   maxSteps               → max tool-call iterations (TaskRuntime)
 *   maxReplanningAttempts  → replan budget (PlanRuntime)
 * `modelId` is validated against the ModelRegistry — an unknown id
 * throws `InvalidModelError` (carrying the list of valid ids).
 */
export interface RunOverrides {
  modelId?: string;
  agentTimeoutMs?: number;
  maxSteps?: number;
  maxReplanningAttempts?: number;
  /** J-03: token count or `$1.50`. */
  budget?: string;
}

export { PlanLiveOwnerError } from './runtime/plan-owner.js';

/** U3: thrown when a per-run `modelId` is not in the ModelRegistry. */
export class InvalidModelError extends Error {
  constructor(public readonly modelId: string, public readonly validIds: string[]) {
    super(
      `Unknown model id "${modelId}". Valid ids: ${validIds.join(', ') || '(none registered)'}`,
    );
    this.name = 'InvalidModelError';
  }
}

export interface OrchestratorRunOptions {
  sessionId?: string;
  /**
   * v27.17.0: how to treat the request — `auto` (default) lets the planner
   * decide between planning and answering, `chat` never plans, `plan` never
   * answers.  See `src/ai/modes.ts`.
   */
  mode?: RunMode;
  /** U3: per-run overrides (model, timeout, maxSteps, replan budget). */
  runOverrides?: RunOverrides;
  /**
   * C3: label for a NEW session (ignored when `sessionId` is given —
   * relabel existing sessions via `SessionStore.setLabel`).
   */
  sessionLabel?: string;
  /**
   * C4: interactive clarification.  Called when the planner decides the
   * request is not clear: `(questions, round) => answers` where the
   * answers key by the exact question text.  Returning `null` (or an
   * empty object) cancels the run.  WITHOUT a callback the legacy
   * behavior applies: the run fails with the questions (CI-safe).
   */
  clarificationCallback?: (
    questions: string[],
    round: number,
  ) => Promise<Record<string, string> | null>;
  /**
   * Callback to get user confirmation of the plan.
   * REQUIRED — Law 17 mandates explicit user approval before execution.
   * Receives the formatted plan text, returns confirmation result.
   */
  // Phase 24 (UI): the plan is passed as an optional second argument so
  // interactive confirmations can be keyed by plan id.  Existing
  // single-argument callbacks are unaffected.
  confirmCallback: (
    planText: string,
    plan?: Plan,
  ) => Promise<{ confirmed: boolean; feedback?: string; cancelled?: boolean }>;
  /**
   * A-04: abort planning (and skip later LLM calls). The web server
   * `POST /api/runs/:runId/cancel` fires this while state is `planning`.
   */
  abortSignal?: AbortSignal;
  /**
   * H-08: skip the planner and execute this already-previewed plan.
   * Feasibility/confirmation still run so the user confirms the same steps.
   */
  preparedPlan?: Plan;
}

export interface OrchestratorResult {
  /**
   * What the run produced (v27.17.0): `plan` for a planned run (the only
   * outcome before this), `answer` for a chat reply.  `planId` is `'none'`
   * when the run answered instead of planning.
   */
  kind: 'plan' | 'answer';
  review: Review;
  report: string;
  planId: string;
  sessionId: string;
  executionResult: PlanExecutionResult;
}

// ─── Default CLI confirm callback ────────────────────────────────

export function createCliConfirmCallback(): (planText: string) => Promise<{ confirmed: boolean; feedback?: string }> {
  return async (planText: string) => {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      // Phase 22: the runtime must not use the console API — direct
      // stdout for the interactive prompt (user-facing UI, not
      // observability).
      process.stdout.write('\n' + planText + '\n');
      rl.question('Confirm this plan? (yes/no/feedback): ', (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        if (['yes', 'y', 'confirm', 'ok', 'go'].includes(normalized)) {
          resolve({ confirmed: true });
        } else if (['no', 'n', 'reject', 'cancel'].includes(normalized)) {
          resolve({ confirmed: false, feedback: 'User rejected the plan.' });
        } else {
          resolve({ confirmed: false, feedback: answer.trim() });
        }
      });
    });
  };
}

// ─── Orchestrator ────────────────────────────────────────────────

export class Orchestrator {
  /**
   * The validated, defaults-applied config.  Exposed read-only so
   * consumers (CLI, server health endpoint, tests) can inspect the
   * effective settings without duplicating resolution logic.
   */
  /**
   * Fully-resolved config.  `env` is guaranteed present here (it is
   * defaulted to the live process env in the constructor), hence
   * `Required<Omit<…>> & { env: EnvSource }` rather than plain
   * `Required<OrchestratorConfig>`.
   */
  readonly config: Required<Omit<OrchestratorConfig, 'env' | 'onThought' | 'onToolCall'>> & {
    env: EnvSource;
    /** Phase 32: absent means "agent turns are not streamed". */
    onThought?: ThoughtSink;
    /** v27.17.3: absent means "no tool-call records". */
    onToolCall?: ToolCallSink;
  };

  /**
   * v27.17.3: how a tool-call record resolves its tool's category and which
   * credential values the shown input must not contain.  Built once from the
   * registries (a closure, so MCP tools connected later are covered) and the
   * same secret list the journal and the observability log use.
   */
  private toolCallOptions: ToolCallLogOptions = {};

  readonly personaRegistry: PersonaRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly modelRegistry: ModelRegistry;
  readonly agentRegistry: AgentRegistry;

  readonly eventBus: EventBus;
  readonly agentRuntime: AgentRuntime;
  readonly retryableAgentRuntime: RetryableAgentRuntime;
  readonly taskRuntime: TaskRuntime;
  /**
   * Phase 37: the project's Journal.  Public so a CLI command or a test can
   * read the path / close it; the runtime itself only ever appends to it.
   */
  readonly journal: JournalWriter;
  readonly planStore: PlanStore;
  /** Phase 30 (P10): literal credential values scrubbed from artifacts. */
  private readonly secretValues: string[];
  readonly sessionStore: SessionStore;
  readonly streamingManager: StreamingManager;
  readonly cancellationManager: CancellationManager;
  readonly rateLimiter: RateLimiter;
  readonly usageAggregator: UsageAggregator;
  /** J-03: per-run budget; set for the duration of `run()`. */
  /**
   * Per-run state for the web server, which runs several goals on one
   * Orchestrator at once: kept per async call chain, never on the instance.
   */
  private readonly runContext = new AsyncLocalStorage<{
    budget?: BudgetTracker;
    /** Tokens this run spent (planning calls + chat answer). */
    usage: { prompt: number; completion: number; total: number };
  }>();

  /** J-03: the budget of the run this call belongs to (none outside a run). */
  private get activeBudget(): BudgetTracker | undefined {
    return this.runContext.getStore()?.budget;
  }
  readonly observabilityLogger: ObservabilityLogger;
  readonly acceptanceChecker: AcceptanceChecker;
  readonly finalReviewer: FinalReviewer;
  /** Phase 30 (P6): live MCP connections — closed by `shutdown()`. */
  private mcpConnector?: McpConnector;
  readonly planner: Planner;
  readonly delegationGuard: DelegationGuard;

  /**
   * Phase 27 (CFG-08): environment threaded into the ModelRegistry and
   * the MCP bootstrap (default: the live process env).
   */
  private readonly env: EnvSource;
  /** The model as the caller named it (before `modelIdForSpec`). */
  private readonly defaultModelSpec: string;

  private initialized = false;
  /** B-01: in-process live plans + on-disk owner handles. */
  private readonly livePlans = new Set<string>();
  /** B-06: interactions a run() in this process is still working on. */
  private readonly liveInteractions = new Set<string>();
  private readonly planOwnerHandles = new Map<string, PlanOwnerHandle>();

  constructor(config: OrchestratorConfig) {
    // Phase 22: validate FIRST — out-of-range config throws a ZodError
    // immediately instead of producing a silently misbehaving runtime.
    const parsed = OrchestratorConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw parsed.error;
    }
    const data = parsed.data;
    this.config = {
      // Phase 27 (CFG-08): resolved here so `config.env` is always set.
      env: data.env ?? process.env,
      projectRoot: data.projectRoot,
      persistent: data.persistent,
      // runtimeDir is optional in the schema — derive the default here
      // (it depends on projectRoot, so it cannot live in the schema).
      runtimeDir: data.runtimeDir ?? path.join(data.projectRoot, '.ai-runtime'),
      maxConcurrentTasks: data.maxConcurrentTasks,
      maxReplanningAttempts: data.maxReplanningAttempts,
      // A runtime spec ("@aur/auto", "anthropic:claude-…") is stored under
      // its registry id; `initialize()` registers it when no file does.
      defaultModelId: modelIdForSpec(data.defaultModelId),
      agentTimeoutMs: data.agentTimeoutMs,
      maxDelegationDepth: data.maxDelegationDepth,
      // Phase 19 (CFG-06): RateLimiter settings now come from config
      maxConcurrentPerProvider: data.maxConcurrentPerProvider,
      maxRetries: data.maxRetries,
      baseBackoffMs: data.baseBackoffMs,
      maxBackoffMs: data.maxBackoffMs,
      maxSteps: data.maxSteps,
      contextBudgetChars: data.contextBudgetChars,
      connectTimeoutMs: data.connectTimeoutMs,
      redactKeys: data.redactKeys,
      journal: {
        ...journalOptionsFromEnv(data.env ?? process.env),
        ...(data.journal ?? {}),
      },
      maxClarificationRounds: data.maxClarificationRounds,
      onProgress: config.onProgress ?? (() => {}),
      // Phase 32: thinking is optional by design — no sink, no streaming.
      onThought: config.onThought,
      // v27.17.3: tool-call records are optional the same way.
      onToolCall: config.onToolCall,
      // R0-08: untrusted by default — a project's own mcp-servers layer is
      // not bootstrapped unless the caller explicitly says it is trusted.
      trustedProject: config.trustedProject === true,
      modelRoutes: data.modelRoutes ?? {},
    };

    // Phase 27 (CFG-08): resolve the env once, before any registry or
    // connector is built, so providers and MCP credentials see it.
    this.env = resolveEnv(data.env);
    this.defaultModelSpec = data.defaultModelId;

    this.personaRegistry = new PersonaRegistry();
    this.toolRegistry = new ToolRegistry();
    this.skillRegistry = new SkillRegistry({ toolRegistry: this.toolRegistry });
    this.modelRegistry = new ModelRegistry({ env: this.env });
    this.agentRegistry = new AgentRegistry();

    // Phase 19 (SING-01/02): each Orchestrator owns its bus/runtime —
    // no shared singletons, full isolation between instances.
    this.eventBus = new EventBus();
    // Phase 30 (P10): the persisted plan must not carry a credential the model
    // echoed into its summary — and v27.17.3 scrubs the tool-call records with
    // the same list, so a shown argument never prints a key.
    this.secretValues = collectSecretValues(this.env, this.config.redactKeys);
    // v27.17.3: the tool's CATEGORY comes from the registry (the same one the
    // tool list is built from), resolved per call so a tool registered later —
    // an MCP server that connects during `initialize()` — is classified too.
    // Both fields are set here because `TaskRuntime` keeps this very object:
    // nothing about the options may be filled in after it is handed over.
    this.toolCallOptions = {
      toolType: (toolName: string) => {
        const definition = this.toolRegistry.getDefinition(toolName);
        if (!definition) return undefined;
        return definition.category ?? (definition.source === 'mcp' ? 'mcp' : undefined);
      },
      secrets: this.secretValues,
    };
    // Phase 19 (CFG-06): RateLimiter constructed from config
    this.rateLimiter = new RateLimiter({
      maxConcurrentPerProvider: this.config.maxConcurrentPerProvider,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
      maxBackoffMs: this.config.maxBackoffMs,
    });
    this.agentRuntime = new AgentRuntime({ rateLimiter: this.rateLimiter });
    this.retryableAgentRuntime = new RetryableAgentRuntime(
      this.agentRuntime,
      this.rateLimiter
    );
    this.taskRuntime = new TaskRuntime({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      eventBus: this.eventBus,
      agentRuntime: this.agentRuntime,
      // Phase 19 (CFG-05): the configured timeout is actually applied
      agentTimeoutMs: this.config.agentTimeoutMs,
      // U3: wire the configured max tool-call iterations (before U3 this
      // value was set on the config but never reached the runtime).
      maxSteps: this.config.maxSteps,
      // Phase 32: forward the thinking sink to every agent turn.
      ...(this.config.onThought ? { onThought: this.config.onThought } : {}),
      // v27.17.3: forward the tool-call sink with its category resolver and
      // the credentials its records must never show.
      ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
      ...(this.toolCallOptions ? { toolCallOptions: this.toolCallOptions } : {}),
    });
    // Phase 19 (CFG-03/04): DelegationGuard instantiated from config
    // and wired into the delegate_task tool.
    this.delegationGuard = new DelegationGuard({
      maxDepth: this.config.maxDelegationDepth,
      personaRegistry: this.personaRegistry,
    });

    const runtimeDir = this.config.runtimeDir;
    // R0-12: `.ai-runtime` (journal, memory, plans, sessions) must never be
    // picked up by `git add .` in the user's own project — a plain
    // `.gitignore` next to it is enough, and this is the one place every
    // Orchestrator creates the directory, so it is written once, here,
    // best-effort (a read-only filesystem must not fail construction).
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      const gitignorePath = path.join(runtimeDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '*\n');
      }
    } catch {
      // best-effort — a failure here must not block the runtime from starting
    }
    // Phase 30 (P10): the persisted plan must not carry a credential the
    // model echoed into its summary.
    const planStore = this.config.persistent
      ? new FilePlanStore(path.join(runtimeDir, 'plans'))
      : new MemoryPlanStore();
    this.planStore = new ScrubbingPlanStore(planStore, this.secretValues);
    this.sessionStore = this.config.persistent
      ? new FileSessionStore(path.join(runtimeDir, 'sessions'))
      : new MemorySessionStore();

    // Phase 37: the Journal is created once per Orchestrator, next to the
    // observability log, and handed to the AgentRuntime — that is the object
    // the tool wrapper is attached to, so no tool implementation knows about it.
    this.journal = new JournalWriter({
      runtimeDir,
      enabled: this.config.journal.enabled,
      includeResults: this.config.journal.includeResults,
      ...(this.config.journal.maxEntryBytes !== undefined
        ? { maxEntryBytes: this.config.journal.maxEntryBytes }
        : {}),
      ...(this.config.journal.retentionDays !== undefined
        ? { retentionDays: this.config.journal.retentionDays }
        : {}),
      redactKeys: this.config.redactKeys.length > 0 ? this.config.redactKeys : undefined,
      redactValues: this.secretValues,
    });
    this.journal.prune();
    this.agentRuntime.setJournal(this.journal);

    this.streamingManager = new StreamingManager({ eventBus: this.eventBus });
    this.cancellationManager = new CancellationManager(this.planStore, this.taskRuntime);
    this.usageAggregator = new UsageAggregator();
    this.observabilityLogger = new ObservabilityLogger({
      logFilePath: path.join(runtimeDir, 'observability.jsonl'),
      // Empty list → keep the logger's built-in defaults.
      redactKeys: this.config.redactKeys.length > 0 ? this.config.redactKeys : undefined,
      // Phase 30 (P10): scrub the VALUES of known credentials too.  A model
      // can echo a value it read from the project into its summary, and the
      // summary is written to the log (`step:completed` payload).
      redactValues: this.secretValues,
    });

    // Phase 22: subscriber errors go to the observability log —
    // the runtime makes zero direct console calls.
    this.eventBus.onSubscriberError = (event, error) => {
      this.observabilityLogger.logSystemError(
        `event-bus:${event.type}`,
        `Subscriber error: ${error instanceof Error ? error.message : String(error)}`
      );
    };

    // Phase 20 (CORR-04): the checker is a pure judgment service — no
    // EventBus/planStore/taskRuntime wiring. PlanRuntime invokes it from
    // an explicit hook (see PlanRuntime.runAcceptanceChecks).
    this.acceptanceChecker = new AcceptanceChecker({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      // The judge runs on the run's model like every other call — without
      // it every acceptance check went to the built-in default (gpt-4o),
      // whatever `--model` / HOTL_MODEL selected.
      modelId: resolveModelForRole('judge', this.config.modelRoutes as ModelRoutes | undefined, this.config.defaultModelId),
      // Phase 30 (P5): the same deadline `--timeout-ms` gives an agent run
      // now also covers the judgment call.
      timeoutMs: this.config.agentTimeoutMs,
      onUsage: (report) => this.recordLlmUsage(report),
      onQualityFailure: (planId, stepId, reason) => {
        this.observabilityLogger.logQualityCheck(planId, stepId, false, reason);
        this.streamingManager.emitProgress({
          type: 'plan:step-failed',
          planId,
          stepId,
          timestamp: Date.now(),
          message: `Quality check failed for step "${stepId}": ${reason}`,
        });
      },
    });

    this.finalReviewer = new FinalReviewer({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      modelId: resolveModelForRole('review', this.config.modelRoutes as ModelRoutes | undefined, this.config.defaultModelId),
      timeoutMs: this.config.agentTimeoutMs,
      onUsage: (report) => this.recordLlmUsage(report),
    });

    this.planner = new Planner({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      modelId: resolveModelForRole('plan', this.config.modelRoutes as ModelRoutes | undefined, this.config.defaultModelId),
      timeoutMs: this.config.agentTimeoutMs,
      // Phase 32: the planner is told WHERE it is working.  Without the
      // project root it answered "which project?" to a goal like "scan
      // this project" — the provider has no idea what the cwd is.
      projectRoot: this.config.projectRoot,
      onUsage: (report) => this.recordLlmUsage(report),
    });
  }

  /**
   * Structured model calls (planning, acceptance, review) are billed like
   * agent turns but never reach the EventBus — record them here so the final
   * report and `hootl usage` show what the provider actually charged.
   */
  private recordLlmUsage(report: LlmUsageReport): void {
    this.usageAggregator.recordDirect({
      taskId: `llm:${report.purpose}`,
      planId: report.planId,
      agentId: `llm:${report.purpose}`,
      usage: report.usage,
      timestamp: Date.now(),
      llmCall: true,
      modelId: report.modelId,
    });
    this.addRunUsage(report.usage);
    this.activeBudget?.record(
      report.usage,
      priceFromModelConfig(report.modelId ? this.modelRegistry.getConfig(report.modelId) : undefined),
    );
    this.observabilityLogger.logLlmUsage(report.purpose, report.usage, report.planId);
  }

  /**
   * Make a model usable by spec — a registered id, `<provider>:<name>`, or a
   * provider model name on the default endpoint — and return its registry
   * id.  Models no longer have to be declared in a registry file to be run.
   */
  useModel(spec: string): string {
    if (!this.initialized) {
      throw new Error('useModel() needs initialize() first (the registry files decide what a name means).');
    }
    return this.registerModelSpec(spec);
  }

  private registerModelSpec(spec: string): string {
    const trimmed = spec.trim();
    if (!trimmed) throw new InvalidModelError(spec, this.modelRegistry.listConfigs().map((m) => m.id));
    const parsed = parseModelSpec(trimmed);
    if (!parsed.name.trim()) {
      throw new InvalidModelError(spec, this.modelRegistry.listConfigs().map((m) => m.id));
    }
    if (this.modelRegistry.hasConfig(trimmed)) return trimmed;
    const known = this.modelRegistry.listConfigs();
    const id = modelIdForSpec(trimmed, known);
    if (this.modelRegistry.hasConfig(id)) return id;
    this.modelRegistry.replaceConfig(runtimeModelConfig(trimmed, this.env, known));
    return id;
  }

  /** Ask the configured providers which models they serve (see list-models). */
  listRemoteModels(): Promise<RemoteModelList> {
    return listRemoteModels(this.env);
  }

  /** Usage of one plan only — the aggregator lives as long as the orchestrator. */
  private planUsage(planId: string | undefined): Review['usage'] {
    if (!planId) return this.totalReviewUsage();
    const u = this.usageAggregator.getPlanUsage(planId);
    return {
      totalPromptTokens: u.promptTokens,
      totalCompletionTokens: u.completionTokens,
      totalTokens: u.totalTokens,
    };
  }

  /** Tokens of the current run only (not everything this long-lived instance spent). */
  private totalReviewUsage(): Review['usage'] {
    const u = this.runContext.getStore()?.usage;
    return u
      ? { totalPromptTokens: u.prompt, totalCompletionTokens: u.completion, totalTokens: u.total }
      : emptyReviewUsage;
  }

  private addRunUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    const u = this.runContext.getStore()?.usage;
    if (!u) return;
    u.prompt += usage.promptTokens;
    u.completion += usage.completionTokens;
    u.total += usage.totalTokens;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const root = this.config.projectRoot;
    const runtimeDir = this.config.runtimeDir;
    try {
      cleanupStaleTempFiles(runtimeDir);
      cleanupStaleLockFiles(runtimeDir);
      cleanupStaleTempFiles(path.join(runtimeDir, 'plans'));
      cleanupStaleLockFiles(path.join(runtimeDir, 'plans'));
      cleanupStaleTempFiles(path.join(runtimeDir, 'sessions'));
      cleanupStaleLockFiles(path.join(runtimeDir, 'sessions'));
      this.journal.prune();
      this.planStore.pruneOlderThan?.(365);
      this.sessionStore.pruneOlderThan?.(365);
      pruneCheckpoints(root, 7);
    } catch {
      // housekeeping must never block startup
    }

    // Phase 28 (registry layering): the packaged registry (global) loads
    // first and the project registry (local) second with override, so a
    // project entry replaces a packaged default of the same id while all
    // other packaged entries remain available.  `HOTL_NO_PACKAGE_REGISTRY=1`
    // disables the packaged layer entirely.
    const layers = registryLayersFor(root, { env: this.env });
    /** Low→high precedence; the last layer overrides the earlier ones. */
    const forEachLayer = (
      baseDir: string
    ): Array<{ dir: string; override: boolean; required: boolean; scope: RegistryScope }> =>
      layers.map((layer, index) => ({
        dir: path.join(layer.dir, baseDir),
        scope: layer.scope,
        override: index > 0,
        required: layer.scope === 'project',
      }));

    /**
     * A registry layer may legitimately ship only SOME subdirectories (a
     * project that only overrides models, for example), so a missing
     * directory is tolerated while malformed/invalid entries still fail.
     */
    const assertEntriesValid = (
      errors: Array<{ file?: string; skill?: string; error: string }>,
      kind: string
    ): void => {
      const real = errors.filter(
        (e) => !/Directory (does not exist|not found)/i.test(e.error)
      );
      if (real.length > 0) {
        throw new Error(
          `[Orchestrator] Invalid ${kind} registry entries: ` +
            real.map((e) => `${e.file ?? e.skill ?? '?'}: ${e.error}`).join('; ')
        );
      }
    };

    for (const layer of forEachLayer('personas')) {
      assertEntriesValid(
        this.personaRegistry.loadFromDirectory(layer.dir, false, layer.override).errors,
        'persona'
      );
    }

    // Phase 19 (CFG-01/CFG-02, Law 16): tool metadata comes from
    // registry/tools/*.json (single source of truth) and implementations
    // are bound to projectRoot by bootstrapTools — no hardcoded defs,
    // no duplicated catalog bootstrap.
    for (const layer of forEachLayer('tools')) {
      // `required: false` only tolerates a MISSING tools directory (a layer
      // may ship just some subdirectories); invalid entries still throw.
      bootstrapTools(layer.dir, this.toolRegistry, root, {
        required: false,
        override: layer.override,
      });
    }

    // Phase 30 (P6): keep the connector — its connections (a spawned stdio
    // server, an HTTP session) must be closed on shutdown, otherwise the
    // child process/socket keeps the Node event loop alive and the CLI
    // never exits after a successful run.
    //
    // R0-08: the PROJECT layer's mcp-servers is skipped unless the caller
    // marked this project trusted — it can spawn arbitrary stdio processes
    // and send named env vars to arbitrary URLs, so a freshly cloned,
    // unreviewed repository must not get that on the first `initialize()`.
    // The packaged (global) layer always loads.
    // Same decision for `.ai-runtime/commands.json` (run_command / run_tests).
    if (this.config.trustedProject) markRootTrusted(root);
    const allMcpServerLayers = forEachLayer('mcp-servers');
    const mcpServerLayers = allMcpServerLayers.filter(
      (l) => l.scope === 'package' || this.config.trustedProject
    );
    if (mcpServerLayers.length < allMcpServerLayers.length) {
      this.observabilityLogger.logSystemError(
        'mcp-trust',
        `Skipped this project's registry/mcp-servers (untrusted project). ` +
          'Pass trustedProject:true (CLI: --trust-project) to enable it.'
      );
    }
    const mcp = await bootstrapMcpServers(
      mcpServerLayers.map((l) => l.dir),
      this.toolRegistry,
      undefined,
      this.env
    );
    this.mcpConnector = mcp.connector;
    // B-16: malformed mcp-servers JSON fails startup; a down server does not.
    const mcpJsonErrors = mcp.configErrors.filter(
      (e) => !/Directory (does not exist|not found)/i.test(e.error),
    );
    if (mcpJsonErrors.length > 0) {
      throw new Error(
        `[Orchestrator] Invalid mcp-servers registry entries: ` +
          mcpJsonErrors.map((e) => `${e.file}: ${e.error}`).join('; '),
      );
    }
    if (mcp.connectionResults.length > 0) {
      // B-19: skills may reference tools from servers that failed to connect.
      this.skillRegistry.setAllowUnknownTools(true);
      for (const c of mcp.connectionResults.filter((r) => !r.success)) {
        this.observabilityLogger.logSystemError(
          'mcp-connection',
          `MCP server "${c.id}" unavailable: ${c.error ?? 'connection failed'}`,
        );
      }
    }

    // Catalog tools must exist before skills load (skills cross-validate
    // their tool references against the ToolRegistry).
    bootstrapCatalogTools({
      toolRegistry: this.toolRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      sessionStore: this.sessionStore,
    });

    for (const layer of forEachLayer('skills')) {
      assertEntriesValid(
        loadSkillsFromDirectory(layer.dir, this.skillRegistry, false, layer.override).errors,
        'skill'
      );
    }
    for (const w of this.skillRegistry.unknownToolWarnings) {
      this.observabilityLogger.logSystemError(
        'skill-tools',
        `Skill "${w.skillId}" references unavailable tool(s) [${w.missing.join(', ')}] (MCP server may be down); those tools were dropped.`,
      );
    }

    this.modelRegistry.registerProvider(openaiProviderFactory);
    this.modelRegistry.registerProvider(anthropicProviderFactory);
    this.modelRegistry.registerProvider(localProviderFactory);
    for (const layer of forEachLayer('models')) {
      assertEntriesValid(
        this.modelRegistry.loadConfigsFromDirectory(layer.dir, false, layer.override).errors,
        'model',
      );
    }
    // HOTL_BASE_URL / HOTL_MODEL: an endpoint from the environment, on top
    // of every registry layer.
    const fromEnv = envEndpoint(this.env, this.modelRegistry.listConfigs()).config;
    if (fromEnv) this.modelRegistry.replaceConfig(fromEnv);
    // A default model that no registry file defines is a runtime spec.
    this.registerModelSpec(this.defaultModelSpec);

    try {
      this.modelRegistry.resolveAll(false);
    } catch (err) {
      this.observabilityLogger.logSystemError(
        'model-resolution',
        `Some models could not be resolved: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      this.modelRegistry.resolve(this.config.defaultModelId);
    } catch (err) {
      this.observabilityLogger.logSystemError(
        'default-model',
        `Default model "${this.config.defaultModelId}" could not be resolved (missing API key?): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const layer of forEachLayer('agents.json')) {
      const loaded = this.agentRegistry.loadFromFile(layer.dir, layer.override);
      const real = loaded.errors.filter((e) => !/File not found/i.test(e));
      if (real.length > 0) {
        throw new Error(
          `[Orchestrator] Invalid agent registry entries: ${real.join('; ')}`,
        );
      }
    }

    const delegateDeps: DelegateTaskDeps = {
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      // Phase 22: typed (was `any`)
      onTaskCreated: async (resolved: ResolvedAgent, prompt: string, meta) => {
        return this.taskRuntime.createTask({
          agent: resolved,
          prompt,
          ...(meta?.planId ? { planId: meta.planId } : {}),
          ...(meta?.parentTaskId ? { parentTaskId: meta.parentTaskId } : {}),
        });
      },
      waitForTask: (taskId) => this.taskRuntime.waitForTask(taskId),
      resolveAgentId: (id: string) => this.agentRegistry.get(id),
      // Phase 19 (CFG-04): the guard is actually enforced now
      delegationGuard: this.delegationGuard,
      currentDelegationDepth: 0,
    };
    bootstrapDelegateTask(this.toolRegistry, delegateDeps);

    bootstrapTaskControlTools({
      toolRegistry: this.toolRegistry,
      taskRuntime: this.taskRuntime,
      agentRegistry: this.agentRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      modelRegistry: this.modelRegistry,
    });

    // B-18: after every tool source is registered (local, catalog, MCP,
    // delegate, task-control). "*" and "mcp:" prefixes are allowed.
    const unknownPersonaTools: string[] = [];
    for (const persona of this.personaRegistry.list()) {
      for (const toolId of persona.allowedTools) {
        if (toolId === '*' || toolId.startsWith('mcp:')) continue;
        if (!this.toolRegistry.hasDefinition(toolId)) {
          unknownPersonaTools.push(`${persona.id}:${toolId}`);
        }
      }
    }
    if (unknownPersonaTools.length > 0) {
      this.observabilityLogger.logSystemError(
        'persona-tools',
        `Persona allowedTools reference unknown tool(s): ${unknownPersonaTools.join(', ')}`,
      );
      throw new Error(
        `[Orchestrator] Persona allowedTools reference unknown tool(s): ${unknownPersonaTools.join(', ')}`,
      );
    }

    this.observabilityLogger.subscribeToEventBus(this.eventBus);

    this.streamingManager.start();
    this.streamingManager.subscribe(this.config.onProgress);

    this.usageAggregator.subscribeToEventBus(this.eventBus);

    const validation = this.agentRegistry.validateAll({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
    });
    if (!validation.valid) {
      const errors = validation.results
        .filter((r) => !r.valid)
        .flatMap((r) => r.errors);
      this.observabilityLogger.logSystemError(
        'initialization',
        `Cross-registry validation errors: ${errors.join('; ')}`
      );
    }

    this.reconcileAbandonedInteractions();
    this.initialized = true;
    this.observabilityLogger.log({
      eventType: 'system:info',
      message: 'Orchestrator initialized successfully.',
      level: 'info',
      payload: {
        personas: this.personaRegistry.size,
        tools: this.toolRegistry.size,
        skills: this.skillRegistry.size,
        agents: this.agentRegistry.size,
        models: this.modelRegistry.configCount,
      },
    });
  }

  async run(
    userRequest: string,
    options: OrchestratorRunOptions
  ): Promise<OrchestratorResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // U3: validate per-run overrides BEFORE any side effect (a bad model
    // id must fail fast, not after planning/session creation).
    const requested = options?.runOverrides;
    // A per-run model may be any spec; it is registered on first use.
    const ov = requested?.modelId !== undefined
      ? { ...requested, modelId: this.useModel(requested.modelId) }
      : requested;
    let budget: BudgetTracker | undefined;
    if (ov?.budget) {
      const parsed = parseBudget(ov.budget);
      if ('error' in parsed) throw new Error(parsed.error);
      budget = new BudgetTracker(parsed);
    }

    if (options?.sessionId && !this.sessionStore.getSession(options.sessionId)) {
      const err = new Error(`Session "${options.sessionId}" not found.`);
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    const sessionId =
      options?.sessionId ?? this.sessionStore.createSession(options?.sessionLabel);
    const interaction = this.sessionStore.addInteraction(sessionId, userRequest);
    this.observabilityLogger.logSessionCreated(sessionId);
    const sessionForHistory = this.sessionStore.getSession(sessionId);
    const historyBlock = sessionForHistory
      ? formatSessionHistory(sessionForHistory.interactions)
      : undefined;
    if (interaction) this.liveInteractions.add(interaction.id);
    try {
      return await this.runContext.run({ budget, usage: { prompt: 0, completion: 0, total: 0 } }, () =>
        this.planner.withSessionHistory(historyBlock, () =>
          this.runInSession(userRequest, options, ov, sessionId, interaction),
        ),
      );
    } finally {
      if (interaction) this.liveInteractions.delete(interaction.id);
    }
  }

  private async runInSession(
    userRequest: string,
    options: OrchestratorRunOptions,
    ov: RunOverrides | undefined,
    sessionId: string,
    interaction: ReturnType<SessionStore['addInteraction']>,
  ): Promise<OrchestratorResult> {

    this.observabilityLogger.log({
      eventType: 'system:info',
      message: 'Starting planning phase.',
      level: 'info',
    });

    // C4: interactive clarification loop.  The planner may answer the
    // request is unclear and ask questions; with a callback we ask the
    // user, fold the answers back into the request, and re-plan — up to
    // `maxClarificationRounds`.  Without a callback (CI, server, --yes)
    // the legacy failure-with-questions path below is unchanged.
    // The run's model (a per-run override wins) — for EVERY call of the run.
    const runModelId = ov?.modelId ?? this.config.defaultModelId;
    const mode = options?.mode ?? DEFAULT_RUN_MODE;
    const abortSignal = options?.abortSignal;
    const cancelledResult = (summary: string, report: string): OrchestratorResult => {
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'cancelled',
          reviewSummary: summary,
          completedAt: Date.now(),
        });
      }
      return {
        kind: 'plan',
        review: {
          planId: 'none',
          goal: userRequest,
          outcome: 'cancelled',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: summary,
          usage: emptyReviewUsage,
        },
        report,
        planId: 'none',
        sessionId,
        executionResult: {
          planId: 'none',
          status: 'cancelled',
          completedSteps: 0,
          failedSteps: 0,
          totalSteps: 0,
          incompleteSteps: [],
          replanningAttempts: 0,
        },
      };
    };
    let planningResult;
    try {
      throwIfAborted(abortSignal);
      if (options?.preparedPlan) {
        planningResult = {
          kind: 'plan' as const,
          isClear: true,
          needsClarification: [] as string[],
          errors: [] as string[],
          plan: {
            ...options.preparedPlan,
            steps: options.preparedPlan.steps.map((s) => ({ ...s })),
          },
        };
      } else {
        planningResult = await this.planner.plan(userRequest, undefined, runModelId, mode, abortSignal);
      }
    } catch (err) {
      if (isAbortError(err) || abortSignal?.aborted) {
        return cancelledResult(
          'Run cancelled during planning.',
          '🛑 Run cancelled during planning — no further model calls will be made.',
        );
      }
      throw err;
    }

    // v27.17.0: the request was a conversation, not work.  Answer it (with the
    // read-only tools), record it as an answered interaction, and stop — no
    // plan, no confirmation, no execution.
    if (planningResult.kind === 'answer') {
      return await this.answerRun({
        userRequest,
        sessionId,
        ...(interaction ? { interactionId: interaction.id } : {}),
        modelId: runModelId,
        ...(planningResult.answer ? { draft: planningResult.answer } : {}),
        mode,
      });
    }

    let clarifyRound = 0;
    let clarificationDeclined = false;
    while (!planningResult.isClear) {
      const callback = options?.clarificationCallback;
      if (!callback || clarifyRound >= this.config.maxClarificationRounds) break;
      // U5: an unclear result with NO questions (e.g. the planner failed —
      // missing credentials) must not open an empty clarification round:
      // there is nothing for the user to answer.  Fall through to the
      // "clarification needed" failure report, which carries the errors.
      if (planningResult.needsClarification.length === 0) break;
      clarifyRound++;
      const answers = await callback(planningResult.needsClarification, clarifyRound);
      if (!answers || Object.keys(answers).length === 0) {
        clarificationDeclined = true;
        break;
      }
      const answeredCount = Object.keys(answers).length;
      this.observabilityLogger.log({
        eventType: 'plan:clarified',
        message: `User answered ${answeredCount} clarification question(s) (round ${clarifyRound}).`,
        level: 'info',
        payload: { attempt: clarifyRound, answeredCount },
      });
      const block = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n');
      try {
        throwIfAborted(abortSignal);
        planningResult = await this.planner.plan(
          `${userRequest}\n\nCLARIFICATIONS FROM USER:\n${block}`,
          undefined,
          runModelId,
          mode,
          abortSignal,
        );
      } catch (err) {
        if (isAbortError(err) || abortSignal?.aborted) {
          return cancelledResult(
            'Run cancelled during planning.',
            '🛑 Run cancelled during planning — no further model calls will be made.',
          );
        }
        throw err;
      }
    }

    // R1-01: a re-plan INSIDE the clarification loop can come back as
    // `kind:'answer'` (isClear:true, but `plan` is never set) — e.g. the
    // user's answers turned "do X" into a question that is better answered
    // directly. The initial call above already routes 'answer' to
    // `answerRun`; a later one, from inside the loop, did not, so
    // `const plan = planningResult.plan!` crashed with "Cannot set
    // properties of undefined (setting 'sessionId')" and the interaction
    // was left 'pending' forever.
    if (planningResult.kind === 'answer') {
      return await this.answerRun({
        userRequest,
        sessionId,
        ...(interaction ? { interactionId: interaction.id } : {}),
        modelId: runModelId,
        ...(planningResult.answer ? { draft: planningResult.answer } : {}),
        mode,
      });
    }

    if (clarificationDeclined) {
      const clarMsg = planningResult.needsClarification.join('\n');
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'failure',
          reviewSummary: `Clarification declined by user (round ${clarifyRound}): ${clarMsg}`,
          completedAt: Date.now(),
        });
      }
      return {
        kind: 'plan',
        review: {
          planId: 'none',
          goal: userRequest,
          outcome: 'cancelled',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: `The planner asked for clarification, but the user chose not to answer (round ${clarifyRound}).\nQuestions:\n${clarMsg}`,
          usage: this.totalReviewUsage(),
        },
        report: `🛑 Run cancelled — clarification questions were not answered.\nQuestions that were asked:\n${clarMsg}`,
        planId: 'none',
        sessionId,
        executionResult: {
          planId: 'none',
          status: 'cancelled',
          completedSteps: 0,
          failedSteps: 0,
          totalSteps: 0,
          incompleteSteps: [],
          replanningAttempts: 0,
        },
      };
    }

    if (!planningResult.isClear) {
      // Phase 29: `Planner.plan()` reports hard failures (invalid model,
      // provider error, …) as `errors` with an EMPTY question list.  Showing
      // "Clarification needed:" with nothing under it hid the real cause —
      // surface the error text instead.
      if (planningResult.needsClarification.length === 0 && planningResult.errors.length > 0) {
        const errorMsg = planningResult.errors.join('\n');
        if (interaction) {
          this.sessionStore.updateInteraction(sessionId, interaction.id, {
            outcome: 'failure',
            reviewSummary: `Planning failed: ${errorMsg}`,
            completedAt: Date.now(),
          });
        }
        return {
          kind: 'plan',
          review: {
            planId: 'none',
            goal: userRequest,
            outcome: 'failure',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: `Planning failed: ${errorMsg}`,
            usage: emptyReviewUsage,
          },
          report: `🛑 Planning failed: ${errorMsg}`,
          planId: 'none',
          sessionId,
          executionResult: {
            planId: 'none',
            status: 'failed-partial',
            completedSteps: 0,
            failedSteps: 0,
            totalSteps: 0,
            incompleteSteps: [],
            replanningAttempts: 0,
          },
        };
      }

      const clarificationMsg = planningResult.needsClarification.join('\n');
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'failure',
          reviewSummary: `Clarification needed: ${clarificationMsg}`,
          completedAt: Date.now(),
        });
      }
      const roundNote =
        clarifyRound > 0
          ? `\n(No plan could be produced after ${clarifyRound} clarification round(s).)`
          : '';
      return {
        kind: 'plan',
        review: {
          planId: 'none',
          goal: userRequest,
          outcome: 'failure',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: `The request needs clarification before a plan can be produced:\n${clarificationMsg}${roundNote}`,
          usage: this.totalReviewUsage(),
        },
        report: `⚠️ Clarification needed:\n${clarificationMsg}${roundNote}`,
        planId: 'none',
        sessionId,
        executionResult: {
          planId: 'none',
          status: 'failed-partial',
          completedSteps: 0,
          failedSteps: 0,
          totalSteps: 0,
          incompleteSteps: [],
          replanningAttempts: 0,
        },
      };
    }

    const plan = planningResult.plan!;
    // Phase 30 (P2): both directions of the plan <-> session link are
    // written BEFORE execution starts.  Without them a crash midway leaves
    // an interaction that is 'pending' forever with no plan id, and nothing
    // (user or `plans resume`) can tell how to finish the run.
    plan.sessionId = sessionId;
    // R1-10: remember this run's model so a later `resumePlan` reviews
    // with the same model instead of the server default.
    plan.modelId = runModelId;
    this.observabilityLogger.logPlanCreated(plan);
    // Phase 24 (UI): persist at creation so the plan is visible to the
    // user WHILE the confirmation is pending (UI modal / plans list).
    // Rejected plans remain in the store as 'draft'.
    this.planStore.save(plan);

    if (interaction && plan.id) {
      const known = interaction.planIds ?? [];
      if (!known.includes(plan.id)) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          planIds: [...known, plan.id],
        });
      }
    }

    const feasibility = runFeasibilityGate(plan, {
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
    });

    if (!feasibility.feasible) {
      const errorMsg = feasibility.errors
        .map((e) => `[${e.stepId}] ${e.field}: ${e.message}`)
        .join('\n');
      this.observabilityLogger.logPlanFailed(plan, `Feasibility gate failed:\n${errorMsg}`);
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'failure',
          reviewSummary: `Plan failed feasibility check:\n${errorMsg}`,
          planIds: plan.id ? [plan.id] : interaction.planIds,
          completedAt: Date.now(),
        });
      }

      return {
        kind: 'plan',
        review: {
          planId: plan.id ?? 'unknown',
          goal: plan.goal,
          outcome: 'failure',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: `Plan failed feasibility check:\n${errorMsg}`,
          usage: emptyReviewUsage,
        },
        report: `❌ Plan infeasible:\n${errorMsg}`,
        planId: plan.id ?? 'unknown',
        sessionId,
        executionResult: {
          planId: plan.id ?? 'unknown',
          status: 'failed-partial',
          completedSteps: 0,
          failedSteps: 0,
          totalSteps: plan.steps.length,
          incompleteSteps: plan.steps.map((s) => ({
            stepId: s.id,
            description: s.description,
            reason: 'Failed feasibility gate',
          })),
          replanningAttempts: 0,
        },
      };
    }

    const cycleCheck = detectCycles(plan);
    if (cycleCheck.hasCycle) {
      const cycleMsg = `Circular dependency detected: ${cycleCheck.cyclePath?.join(' → ')}`;
      this.observabilityLogger.logPlanFailed(plan, cycleMsg);
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'failure',
          reviewSummary: cycleMsg,
          planIds: plan.id ? [plan.id] : interaction.planIds,
          completedAt: Date.now(),
        });
      }

      return {
        kind: 'plan',
        review: {
          planId: plan.id ?? 'unknown',
          goal: plan.goal,
          outcome: 'failure',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: cycleMsg,
          usage: emptyReviewUsage,
        },
        report: `❌ ${cycleMsg}`,
        planId: plan.id ?? 'unknown',
        sessionId,
        executionResult: {
          planId: plan.id ?? 'unknown',
          status: 'failed-partial',
          completedSteps: 0,
          failedSteps: 0,
          totalSteps: plan.steps.length,
          incompleteSteps: [],
          replanningAttempts: 0,
        },
      };
    }

    const summary = summarizePlan(plan);
    let planText = formatPlanForUser(summary);
    if (this.activeBudget?.budget) {
      const used = this.usageAggregator.getSummary();
      const estimate = estimatePlanCost(plan.steps.length, {
        promptTokens: used.totalPromptTokens,
        completionTokens: used.totalCompletionTokens,
        totalTokens: used.totalTokens,
      });
      planText += `\n\nBudget: ${this.activeBudget.budget.raw} — estimate ${estimate.tokens} tokens / $${estimate.usd.toFixed(4)} for ${estimate.steps} steps.`;
    }

    if (abortSignal?.aborted) {
      return cancelledResult(
        'Run cancelled during planning.',
        '🛑 Run cancelled during planning — no further model calls will be made.',
      );
    }
    let confirmation = await options.confirmCallback(planText, plan);
    let feedbackRound = 0;
    while (!confirmation.confirmed) {
      const fb = confirmation.feedback?.trim();
      // A cancel (Ctrl-C, shutdown, TTL, operator cancel) or a rejection
      // without real feedback ends the run; only feedback text re-plans.
      const hardReject =
        confirmation.cancelled === true ||
        abortSignal?.aborted === true ||
        !fb ||
        /^user rejected the plan\.?$/i.test(fb);
      if (hardReject || feedbackRound >= this.config.maxClarificationRounds) {
        if (interaction) {
          this.sessionStore.updateInteraction(sessionId, interaction.id, {
            outcome: 'cancelled',
            reviewSummary: `Plan was not confirmed by user. Feedback: ${confirmation.feedback ?? 'none'}`,
            planIds: [plan.id ?? 'unknown'],
            completedAt: Date.now(),
          });
        }
        return {
          kind: 'plan',
          review: {
            planId: plan.id ?? 'unknown',
            goal: plan.goal,
            outcome: 'cancelled',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: `Plan was not confirmed by user. Feedback: ${confirmation.feedback ?? 'none'}`,
            usage: emptyReviewUsage,
          },
          report: `🛑 Plan cancelled by user.\nFeedback: ${confirmation.feedback ?? 'none'}`,
          planId: plan.id ?? 'unknown',
          sessionId,
          executionResult: {
            planId: plan.id ?? 'unknown',
            status: 'cancelled',
            completedSteps: 0,
            failedSteps: 0,
            totalSteps: plan.steps.length,
            incompleteSteps: [],
            replanningAttempts: 0,
          },
        };
      }
      feedbackRound++;
      let revised;
      try {
        revised = await this.planner.plan(
          `${userRequest}\n\nPLANNER FEEDBACK FROM USER (revise the plan accordingly):\n${fb}`,
          plan.id,
          runModelId,
          'plan',
          abortSignal,
        );
      } catch (err) {
        if (isAbortError(err) || abortSignal?.aborted) {
          confirmation = { confirmed: false, cancelled: true, feedback: 'Run cancelled while re-planning.' };
          continue;
        }
        throw err;
      }
      if (!revised.isClear || !revised.plan) {
        confirmation = { confirmed: false, feedback: fb };
        continue;
      }
      const keepId: string | undefined = plan.id;
      const keepSession: string | undefined = plan.sessionId;
      Object.assign(plan, revised.plan);
      plan.id = keepId;
      plan.sessionId = keepSession;
      plan.status = 'draft';
      this.planStore.save(plan);
      const reFeas = runFeasibilityGate(plan, {
        personaRegistry: this.personaRegistry,
        skillRegistry: this.skillRegistry,
        toolRegistry: this.toolRegistry,
      });
      if (!reFeas.feasible) {
        confirmation = { confirmed: false, feedback: fb };
        continue;
      }
      const reCycle = detectCycles(plan);
      if (reCycle.hasCycle) {
        confirmation = { confirmed: false, feedback: fb };
        continue;
      }
      const nextText = formatPlanForUser(summarizePlan(plan));
      confirmation = await options.confirmCallback(nextText, plan);
    }

    plan.status = 'confirmed';
    this.observabilityLogger.log({
      planId: plan.id,
      eventType: 'plan:confirmed',
      message: 'Plan confirmed by user. Starting execution.',
      level: 'info',
    });
    this.journal.log({
      ts: new Date().toISOString(),
      kind: 'plan',
      planId: plan.id,
      ok: true,
      summary: `plan ${plan.id} started (${plan.steps.length} steps)`,
    });

    const planRuntime = new PlanRuntime({
      taskRuntime: this.taskRuntime,
      planStore: this.planStore,
      planner: this.planner,
      feasibilityDeps: {
        personaRegistry: this.personaRegistry,
        skillRegistry: this.skillRegistry,
        toolRegistry: this.toolRegistry,
      },
      refs: {
        personaRegistry: this.personaRegistry,
        skillRegistry: this.skillRegistry,
        toolRegistry: this.toolRegistry,
        modelRegistry: this.modelRegistry,
      },
      // U3: per-run overrides (runOverrides) win over the base config
      maxReplanningAttempts: ov?.maxReplanningAttempts ?? this.config.maxReplanningAttempts,
      defaultModelId: ov?.modelId ?? this.config.defaultModelId,
      ...(ov?.agentTimeoutMs !== undefined ? { agentTimeoutMs: ov.agentTimeoutMs } : {}),
      ...(ov?.maxSteps !== undefined ? { maxSteps: ov.maxSteps } : {}),
      projectRoot: this.config.projectRoot,
      modelRoutes: this.config.modelRoutes as ModelRoutes | undefined,
      budgetExceeded: () => (this.activeBudget?.exceeded() ? 'budget exceeded' : undefined),
      onStatusChange: (p, event) => {
        // Phase 30 (P7): re-planning was invisible — the runtime emits
        // `plan:replanning-attempt-N` / `plan:replanned`, and nothing
        // translated or logged them, so the JSONL log and the terminal both
        // stayed silent while the plan was rewritten.
        if (event.startsWith('plan:replanning-attempt-')) {
          this.observabilityLogger.logPlanReplanning(p, Number(event.split('-').pop()) || 1);
        } else if (event === 'plan:replanned') {
          this.observabilityLogger.logPlanReplanned(p);
        }
        // Phase 30 (P10 follow-up): step:started/completed/failed were
        // emitted by the runtime but never translated into the log.
        logStepEvent(this.observabilityLogger, p, event);

        // Phase 37: plan/step transitions belong in the Journal too — the
        // Journal answers "what did the AI do", and a run's structure is part
        // of that answer.  Tool calls carry the plan/step ids already, so
        // these records are what makes a journal line traceable to its step.
        const stepEvent = parseStepEvent(event);
        if (stepEvent) {
          const step = p.steps.find((candidate) => candidate.id === stepEvent.stepId);
          this.journal.log({
            ts: new Date().toISOString(),
            kind: 'step',
            planId: p.id,
            planStepId: stepEvent.stepId,
            ok: stepEvent.phase !== 'failed',
            summary:
              stepEvent.phase === 'running'
                ? `step ${stepEvent.stepId} started: ${step?.description ?? ''}`.slice(0, 300)
                : stepEvent.phase === 'done'
                  ? `step ${stepEvent.stepId} completed`
                  : `step ${stepEvent.stepId} failed${step?.failureType ? ` (${step.failureType})` : ''}`,
            ...(stepEvent.phase === 'failed' && step?.resultSummary
              ? { error: step.resultSummary }
              : {}),
          });
        }
        this.streamingManager.handlePlanStatusChange(p, event);
      },
      // Phase 20 (CORR-04): explicit acceptance hook instead of the old
      // EventBus-subscription wiring (wireAcceptanceChecker removed).
      acceptanceChecker: this.acceptanceChecker,
      onPersistError: (err) => {
        this.observabilityLogger.logSystemError(
          'plan-persist',
          err instanceof Error ? err.message : String(err),
        );
      },
    });

    this.cancellationManager.registerRuntime(plan.id!, planRuntime);
    this.claimPlan(plan.id!);

    let executionResult: PlanExecutionResult;
    try {
      executionResult = await planRuntime.execute(plan);
    } finally {
      this.cancellationManager.unregisterRuntime(plan.id!);
      this.releasePlan(plan.id!);
    }

    this.observabilityLogger.logPlanCompleted(plan);
    if (executionResult.status === 'completed' && planExamplesEnabled()) {
      savePlanExample(this.config.projectRoot, plan);
    }

    const review = await this.finalReviewer.review(plan, executionResult, runModelId);

    // Per plan: a long-lived orchestrator (the web server) would otherwise
    // report the sum of every run it has ever made.
    review.usage = this.planUsage(plan.id);
    if (executionResult.persistenceDegraded) review.persistenceDegraded = true;

    const report = formatFinalReview(review);

    if (interaction) {
      this.sessionStore.updateInteraction(sessionId, interaction.id, {
        outcome: review.outcome,
        reviewSummary: review.finalSummary,
        planIds: [plan.id ?? 'unknown'],
        completedAt: Date.now(),
      });
    }

    return {
      kind: 'plan',
      review,
      report,
      planId: plan.id ?? 'unknown',
      sessionId,
      executionResult,
    };
  }

  /**
   * Phase 23 (CLI --dry-run): plan WITHOUT executing.
   *
   * Runs the same pipeline as `run()` up to the user-confirmation
   * point — clarification check, planning, feasibility gate, cycle
   * detection — and returns the formatted plan (or the reason it
   * could not be planned).  Nothing is persisted, confirmed, or
   * executed; no session interaction is recorded.
   */
  /**
   * v27.17.0: answer a request conversationally — the `chat` persona, the
   * read-only half of the catalog, and the SAME AgentRuntime a plan step uses
   * (so a chat that reads a file is journalled, counted, and streamed exactly
   * like any other tool call).
   *
   * The answer is the model's own text, in the user's language.  Nothing is
   * planned, confirmed or executed; `planId` stays `'none'` and the run's
   * outcome is `success`, because the question was answered.
   */
  private async answerRun(params: {
    userRequest: string;
    sessionId: string;
    interactionId?: string;
    modelId?: string;
    /** The model's draft from the assessment — used if the answer call fails. */
    draft?: string;
    mode: RunMode;
  }): Promise<OrchestratorResult> {
    const { userRequest, sessionId, interactionId, modelId, draft, mode } = params;
    const language = detectLanguage(userRequest);
    const toolIds = readOnlyToolIds();
    let text: string | undefined;
    let errors: string[] = [];

    try {
      const agent = this.planner.buildChatAgent(modelId, mode === 'chat' ? toolIds : undefined);
      const run = await this.agentRuntime.run({
        agent,
        taskId: `chat:${interactionId ?? sessionId}`,
        prompt: this.planner.buildAnswerPrompt(userRequest),
        eventBus: this.eventBus,
        maxSteps: this.config.maxSteps,
        timeoutMs: this.config.agentTimeoutMs,
        ...(this.config.onThought ? { onThought: this.config.onThought } : {}),
        ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
        ...(this.toolCallOptions ? { toolCallOptions: this.toolCallOptions } : {}),
      });
      // The aggregator already counts this turn from the run's own
      // agent:completed / agent:error event; only the per-run tally is added.
      if (run.usage) this.addRunUsage(run.usage);
      if (run.success && run.result.trim().length > 0) {
        text = run.result.trim();
      } else {
        errors = run.errors.length > 0 ? run.errors : ['The chat agent produced no answer.'];
      }
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }

    // A failed answer call is not a failed conversation when the assessment
    // already wrote the reply (auto mode) — the user still gets an answer.
    if (!text && draft) text = draft;

    const body = text ?? `The request could not be answered: ${errors.join('; ')}`;
    const report = `💬 Answer\n\n${body}`;

    this.observabilityLogger.log({
      eventType: 'system:info',
      message: text
        ? `Answered in ${mode === 'chat' ? 'chat' : 'auto'} mode (no plan).`
        : `Chat answer failed: ${errors.join('; ')}`,
      level: text ? 'info' : 'error',
      ...(text ? {} : { payload: { errors } }),
    });
    if (interactionId) {
      this.sessionStore.updateInteraction(sessionId, interactionId, {
        outcome: text ? 'success' : 'failure',
        reviewSummary: body,
        completedAt: Date.now(),
      });
    }

    return {
      kind: 'answer',
      review: {
        planId: 'none',
        goal: userRequest,
        outcome: text ? 'success' : 'failure',
        acceptedFindings: [],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: body,
        usage: this.totalReviewUsage(),
      },
      report,
      planId: 'none',
      sessionId,
      executionResult: {
        planId: 'none',
        status: text ? 'completed' : 'failed-partial',
        completedSteps: 0,
        failedSteps: 0,
        totalSteps: 0,
        incompleteSteps: [],
        replanningAttempts: 0,
      },
    };
  }

  async previewPlan(
    userRequest: string,
    modelSpec?: string,
    mode: RunMode = DEFAULT_RUN_MODE
  ): Promise<{
    ok: boolean;
    plan?: Plan;
    planText?: string;
    /**
     * v27.17.0: the chat reply, when the request was a conversation.  A
     * preview answers WITHOUT tools and without touching the project — it is
     * a preview — so the text comes from the model's own knowledge plus the
     * project context.
     */
    answer?: string;
    error?: string;
    /**
     * U4: the planner's clarification questions when the request was
     * not clear enough to plan (empty otherwise).  The HTTP preview
     * route surfaces these to the UI as a 400 payload.
     */
    needsClarification?: string[];
    /** U4: feasibility-gate outcome for the produced plan (when any). */
    feasibility?: FeasibilityCheckResult;
    /** U4: dependency-cycle detection result for the produced plan. */
    cycles?: CycleDetectionResult;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const modelId = modelSpec ? this.useModel(modelSpec) : undefined;
    const planningResult = await this.planner.plan(userRequest, undefined, modelId, mode);

    // A conversation has no steps to preview: show the answer as it is.
    if (planningResult.kind === 'answer') {
      return {
        ok: true,
        answer:
          planningResult.answer ??
          'This request would be answered in chat mode (nothing to preview).',
      };
    }

    if (!planningResult.isClear) {
      if (planningResult.needsClarification.length > 0) {
        const clarificationMsg = planningResult.needsClarification.join('\n');
        return {
          ok: false,
          needsClarification: planningResult.needsClarification,
          error: `The request needs clarification before a plan can be produced:\n${clarificationMsg}`,
        };
      }
      const errorMsg =
        planningResult.errors.join('\n') || 'The request could not be planned.';
      return { ok: false, error: errorMsg };
    }

    const plan = planningResult.plan!;

    const feasibility = runFeasibilityGate(plan, {
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
    });
    if (!feasibility.feasible) {
      const errorMsg = feasibility.errors
        .map((e) => `[${e.stepId}] ${e.field}: ${e.message}`)
        .join('\n');
      return {
        ok: false,
        plan,
        feasibility,
        error: `Plan failed feasibility check:\n${errorMsg}`,
      };
    }

    const cycleCheck = detectCycles(plan);
    if (cycleCheck.hasCycle) {
      return {
        ok: false,
        plan,
        feasibility,
        cycles: cycleCheck,
        error: `Circular dependency detected: ${cycleCheck.cyclePath?.join(' → ')}`,
      };
    }

    return {
      ok: true,
      plan,
      planText: formatPlanForUser(summarizePlan(plan)),
      feasibility,
      cycles: cycleCheck,
    };
  }

  /**
   * J-07: plan only, then report step count and an estimated token/USD cost.
   * Nothing is executed.
   */
  async estimatePlan(userRequest: string, modelSpec?: string, mode: RunMode = DEFAULT_RUN_MODE) {
    const preview = await this.previewPlan(userRequest, modelSpec, mode);
    const usage = this.usageAggregator.getSummary();
    const steps = preview.plan?.steps.length ?? 0;
    const estimate = estimatePlanCost(steps, {
      promptTokens: usage.totalPromptTokens,
      completionTokens: usage.totalCompletionTokens,
      totalTokens: usage.totalTokens,
    });
    return { ...preview, estimate, usage };
  }

  async cancelPlan(planId: string) {
    return this.cancellationManager.cancelPlan(planId);
  }

  getPlanStatus(planId: string) {
    const plan = this.planStore.load(planId);
    if (!plan) return undefined;
    return {
      planId: plan.id,
      status: plan.status,
      completedSteps: plan.steps.filter((s) => s.status === 'done').length,
      totalSteps: plan.steps.length,
    };
  }

  getUsageSummary() {
    return this.usageAggregator.getSummary();
  }

  /** B-01: true when this process or another live owner holds the plan. */
  hasLiveOwner(planId: string): boolean {
    if (this.livePlans.has(planId)) return true;
    if (!this.config.persistent) return false;
    return isPlanOwnerAlive(path.join(this.config.runtimeDir, 'plans'), planId);
  }

  livePlanIds(): string[] {
    return [...this.livePlans];
  }

  claimPlan(planId: string): void {
    if (this.livePlans.has(planId)) {
      throw new PlanLiveOwnerError(planId, process.pid);
    }
    if (this.config.persistent) {
      const handle = tryAcquirePlanOwner(path.join(this.config.runtimeDir, 'plans'), planId);
      if (!handle) {
        throw new PlanLiveOwnerError(planId);
      }
      this.planOwnerHandles.set(planId, handle);
    }
    this.livePlans.add(planId);
  }

  releasePlan(planId: string): void {
    this.livePlans.delete(planId);
    this.planOwnerHandles.get(planId)?.release();
    this.planOwnerHandles.delete(planId);
  }

  /**
   * B-06: close pending interactions whose plans are already terminal / draft.
   */
  reconcileAbandonedInteractions(): void {
    const terminal = new Set(['completed', 'cancelled', 'failed-partial', 'draft']);
    for (const sessionId of this.sessionStore.listSessions()) {
      const session = this.sessionStore.getSession(sessionId);
      if (!session) continue;
      for (const interaction of session.interactions) {
        if (interaction.completedAt) continue;
        // B-06: only an interaction whose process is gone is abandoned.  One
        // this process is running, or another live process owns (a CLI at
        // its confirmation prompt, a server run still planning), is not.
        if (this.liveInteractions.has(interaction.id)) continue;
        const owner = interaction.ownerPid;
        if (owner !== undefined && owner !== process.pid && isPidAlive(owner)) continue;
        const ids = interaction.planIds ?? [];
        if (ids.length === 0) {
          // C-13: chat/answer turns never get a planId; a killed process
          // left them pending forever.
          this.sessionStore.updateInteraction(sessionId, interaction.id, {
            outcome: 'cancelled',
            reviewSummary: interaction.reviewSummary ?? 'Reconciled abandoned chat turn.',
            completedAt: Date.now(),
          });
          continue;
        }
        const plans = ids.map((id) => this.planStore.load(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
        if (plans.length === 0) continue;
        if (!plans.every((p) => terminal.has(p.status))) continue;
        const cancelled = plans.every((p) => p.status === 'cancelled' || p.status === 'draft');
        for (const p of plans) {
          if (p.status === 'draft' && p.id) {
            p.status = 'cancelled';
            p.completedAt = p.completedAt ?? Date.now();
            this.planStore.save(p);
          }
        }
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: cancelled ? 'cancelled' : plans.some((p) => p.status === 'failed-partial') ? 'failure' : 'success',
          reviewSummary: interaction.reviewSummary ?? 'Reconciled after the owning process exited.',
          completedAt: Date.now(),
        });
      }
    }
  }

  async resumePlan(planId: string): Promise<OrchestratorResult | undefined> {
    const plan = this.planStore.load(planId);
    if (!plan) return undefined;
    // Phase 24: a plan that was never confirmed (still 'draft' — created
    // at plan time, rejected before execution) must not become
    // resumable without confirmation.
    if (plan.status === 'draft') return undefined;
    // B-01: a live owner still executing this plan — never re-dispatch.
    if (this.hasLiveOwner(planId)) {
      throw new PlanLiveOwnerError(planId, process.pid);
    }
    this.claimPlan(planId);

    const planRuntime = new PlanRuntime({
      taskRuntime: this.taskRuntime,
      planStore: this.planStore,
      planner: this.planner,
      feasibilityDeps: {
        personaRegistry: this.personaRegistry,
        skillRegistry: this.skillRegistry,
        toolRegistry: this.toolRegistry,
      },
      refs: {
        personaRegistry: this.personaRegistry,
        skillRegistry: this.skillRegistry,
        toolRegistry: this.toolRegistry,
        modelRegistry: this.modelRegistry,
      },
      maxReplanningAttempts: this.config.maxReplanningAttempts,
      defaultModelId: this.config.defaultModelId,
      projectRoot: this.config.projectRoot,
      modelRoutes: this.config.modelRoutes as ModelRoutes | undefined,
      budgetExceeded: () => (this.activeBudget?.exceeded() ? 'budget exceeded' : undefined),
      // Phase 20 (CORR-04): same explicit acceptance hook on resume
      acceptanceChecker: this.acceptanceChecker,
      onPersistError: (err) => {
        this.observabilityLogger.logSystemError(
          'plan-persist',
          err instanceof Error ? err.message : String(err),
        );
      },
    });

    // Phase 30 (P2 follow-up): a step that is still 'running' on disk belongs
    // to the process that was killed — that task can never write its own
    // terminal event, so `hootl tasks list` would show it as `running`
    // forever.  Capture the orphans first: `resume()` overwrites `taskId`
    // with the new task id for the very same step.
    const orphanedTasks = plan.steps
      .filter((step) => step.status === 'running' && step.taskId !== undefined)
      .map((step) => ({ stepId: step.id, taskId: step.taskId! }));

    let executionResult: PlanExecutionResult;
    try {
      executionResult = await planRuntime.resume(planId);
    } finally {
      this.releasePlan(planId);
    }
    // R1-10: `resume()` persists its own freshly-loaded plan object, which
    // is NOT the same reference as `plan` above — reload so the review sees
    // the post-resume step statuses instead of the pre-resume snapshot.
    const resumedPlan = this.planStore.load(planId) ?? plan;
    const review = await this.finalReviewer.review(resumedPlan, executionResult, resumedPlan.modelId);
    review.usage = this.planUsage(plan.id);
    const report = formatFinalReview(review);

    // Phase 30 (P2): the run that owned this plan was interrupted, so its
    // interaction is still open ('pending'); the resume is what finishes it.
    // Match the newest open interaction of the owning session (preferring the
    // one whose request is this plan's goal).
    if (plan.sessionId) {
      const session = this.sessionStore.getSession(plan.sessionId);
      const openList = (session?.interactions ?? []).filter((i) => !i.completedAt);
      // B-02: match the interaction that already lists this planId first;
      // never close another plan's open interaction.
      const open =
        openList.find((i) => (i.planIds ?? []).includes(planId)) ??
        openList.find((i) => i.userRequest === plan.goal && (i.planIds ?? []).length === 0);
      if (open) {
        const known = open.planIds ?? [];
        this.sessionStore.updateInteraction(plan.sessionId, open.id, {
          outcome: review.outcome,
          reviewSummary: review.finalSummary,
          planIds: known.includes(planId) ? known : [...known, planId],
          completedAt: Date.now(),
        });
      }
    }

    for (const orphan of orphanedTasks) {
      this.observabilityLogger.log({
        planId,
        stepId: orphan.stepId,
        taskId: orphan.taskId,
        eventType: 'task:interrupted',
        level: 'warn',
        message: `Task "${orphan.taskId}" was interrupted by a crash; step "${orphan.stepId}" was resumed.`,
        payload: { taskId: orphan.taskId, stepId: orphan.stepId },
      });
    }

    return {
      kind: 'plan',
      review,
      report,
      planId,
      sessionId: plan.sessionId ?? 'resumed',
      executionResult,
    };
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.livePlans]) {
      try {
        await this.cancelPlan(id);
      } catch {
        // best-effort
      }
      this.releasePlan(id);
    }
    // Phase 20 (CORR-02): let in-flight tasks finish BEFORE
    // unsubscribing — otherwise their completion events are lost.
    await this.taskRuntime.waitForAll();
    // Phase 30 (P6): release MCP connections (stdio children, HTTP sessions).
    await this.mcpConnector?.closeAll();
    this.streamingManager.stop();
    // Phase 20 (CORR-04): acceptanceChecker has no subscription to stop
    this.observabilityLogger.unsubscribeFromEventBus();
    // Phase 21 (PERF-04): release the reused log fd
    this.observabilityLogger.close();
    this.usageAggregator.unsubscribe();
    this.taskRuntime.destroy();
  }
}
