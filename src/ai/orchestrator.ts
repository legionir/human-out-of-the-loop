import path from 'node:path';
import { z } from 'zod';
import { EventBus } from './runtime/event-bus.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import { TaskRuntime } from './runtime/task-runtime.js';
import { MemoryPlanStore, FilePlanStore, type PlanStore } from './runtime/plan-store.js';
import { PlanRuntime, type PlanExecutionResult } from './runtime/plan-runtime.js';
import { AcceptanceChecker } from './runtime/acceptance-checker.js';
import { FinalReviewer } from './runtime/final-reviewer.js';
import { StreamingManager, type ProgressEvent } from './runtime/streaming-manager.js';
import { CancellationManager } from './runtime/cancellation-manager.js';
import { RateLimiter } from './runtime/rate-limiter.js';
import { UsageAggregator } from './runtime/usage-aggregator.js';
import { MemorySessionStore, FileSessionStore, type SessionStore } from './runtime/session-store.js';
import { ObservabilityLogger } from './runtime/observability-logger.js';
import { formatReviewForUser as formatFinalReview } from './runtime/review-formatter.js';
import { RetryableAgentRuntime } from './runtime/agent-runtime-retry.js';

import { PersonaRegistry } from './registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from './registries/skill-registry.js';
import { ToolRegistry } from './registries/tool-registry.js';
import { ModelRegistry } from './registries/model-registry.js';
import { AgentRegistry } from './registries/agent-registry.js';

import { Planner } from './planning/planner.js';
import { runFeasibilityGate } from './planning/feasibility-gate.js';
import { detectCycles } from './planning/cycle-detector.js';
import {
  summarizePlan,
  formatPlanForUser,
} from './planning/plan-confirmation.js';

import { bootstrapCatalogTools } from './tools/catalog-bootstrap.js';
import { bootstrapDelegateTask } from './tools/delegate-bootstrap.js';
import type { DelegateTaskDeps } from './tools/implementations/delegate-task.js';
import { bootstrapTaskControlTools } from './tools/task-control-bootstrap.js';
import { bootstrapMcpServers } from './tools/mcp-bootstrap.js';
import { bootstrapTools } from './tools/bootstrap.js';
import { DelegationGuard } from './runtime/delegation-guard.js';

import {
  openaiProviderFactory,
  anthropicProviderFactory,
  localProviderFactory,
} from './models/providers/index.js';

import type { Plan } from './schemas/plan.js';
import { emptyReviewUsage, type Review } from './schemas/review.js';
import type { ResolvedAgent } from './agents/agent-factory.js';

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
  connectTimeoutMs: z.number().int().min(1000).default(10000),
  defaultModelId: z.string().default('gpt-4o'),
});

/**
 * Config shape accepted by the constructor (input type — everything
 * except `projectRoot` is optional).  `onProgress` (Phase 19) is a
 * callback and is validated structurally, not via the base schema.
 */
export type OrchestratorConfig = z.input<typeof OrchestratorConfigSchema> & {
  onProgress?: (event: ProgressEvent) => void;
};

export interface OrchestratorRunOptions {
  sessionId?: string;
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
  ) => Promise<{ confirmed: boolean; feedback?: string }>;
}

export interface OrchestratorResult {
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
  private readonly config: Required<OrchestratorConfig>;

  readonly personaRegistry: PersonaRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly modelRegistry: ModelRegistry;
  readonly agentRegistry: AgentRegistry;

  readonly eventBus: EventBus;
  readonly agentRuntime: AgentRuntime;
  readonly retryableAgentRuntime: RetryableAgentRuntime;
  readonly taskRuntime: TaskRuntime;
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly streamingManager: StreamingManager;
  readonly cancellationManager: CancellationManager;
  readonly rateLimiter: RateLimiter;
  readonly usageAggregator: UsageAggregator;
  readonly observabilityLogger: ObservabilityLogger;
  readonly acceptanceChecker: AcceptanceChecker;
  readonly finalReviewer: FinalReviewer;
  readonly planner: Planner;
  readonly delegationGuard: DelegationGuard;

  private initialized = false;

  constructor(config: OrchestratorConfig) {
    // Phase 22: validate FIRST — out-of-range config throws a ZodError
    // immediately instead of producing a silently misbehaving runtime.
    const parsed = OrchestratorConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw parsed.error;
    }
    const data = parsed.data;
    this.config = {
      projectRoot: data.projectRoot,
      persistent: data.persistent,
      // runtimeDir is optional in the schema — derive the default here
      // (it depends on projectRoot, so it cannot live in the schema).
      runtimeDir: data.runtimeDir ?? path.join(data.projectRoot, '.ai-runtime'),
      maxConcurrentTasks: data.maxConcurrentTasks,
      maxReplanningAttempts: data.maxReplanningAttempts,
      defaultModelId: data.defaultModelId,
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
      onProgress: config.onProgress ?? (() => {}),
    };

    this.personaRegistry = new PersonaRegistry();
    this.toolRegistry = new ToolRegistry();
    this.skillRegistry = new SkillRegistry({ toolRegistry: this.toolRegistry });
    this.modelRegistry = new ModelRegistry();
    this.agentRegistry = new AgentRegistry();

    // Phase 19 (SING-01/02): each Orchestrator owns its bus/runtime —
    // no shared singletons, full isolation between instances.
    this.eventBus = new EventBus();
    this.agentRuntime = new AgentRuntime();
    // Phase 19 (CFG-06): RateLimiter constructed from config
    this.rateLimiter = new RateLimiter({
      maxConcurrentPerProvider: this.config.maxConcurrentPerProvider,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
      maxBackoffMs: this.config.maxBackoffMs,
    });
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
    });
    // Phase 19 (CFG-03/04): DelegationGuard instantiated from config
    // and wired into the delegate_task tool.
    this.delegationGuard = new DelegationGuard({
      maxDepth: this.config.maxDelegationDepth,
      personaRegistry: this.personaRegistry,
    });

    const runtimeDir = this.config.runtimeDir;
    this.planStore = this.config.persistent
      ? new FilePlanStore(path.join(runtimeDir, 'plans'))
      : new MemoryPlanStore();
    this.sessionStore = this.config.persistent
      ? new FileSessionStore(path.join(runtimeDir, 'sessions'))
      : new MemorySessionStore();

    this.streamingManager = new StreamingManager({ eventBus: this.eventBus });
    this.cancellationManager = new CancellationManager(this.planStore, this.taskRuntime);
    this.usageAggregator = new UsageAggregator();
    this.observabilityLogger = new ObservabilityLogger({
      logFilePath: path.join(runtimeDir, 'observability.jsonl'),
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
      modelId: this.config.defaultModelId,
    });

    this.planner = new Planner({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      modelId: this.config.defaultModelId,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const root = this.config.projectRoot;
    const registryDir = path.join(root, 'registry');

    this.personaRegistry.loadFromDirectory(
      path.join(registryDir, 'personas'),
      true
    );

    // Phase 19 (CFG-01/CFG-02, Law 16): tool metadata comes from
    // registry/tools/*.json (single source of truth) and implementations
    // are bound to projectRoot by bootstrapTools — no hardcoded defs,
    // no duplicated catalog bootstrap.
    bootstrapTools(path.join(registryDir, 'tools'), this.toolRegistry, root);

    await bootstrapMcpServers(
      path.join(registryDir, 'mcp-servers'),
      this.toolRegistry
    );

    // Catalog tools must exist before skills load (skills cross-validate
    // their tool references against the ToolRegistry).
    bootstrapCatalogTools({
      toolRegistry: this.toolRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
    });

    loadSkillsFromDirectory(
      path.join(registryDir, 'skills'),
      this.skillRegistry,
      true
    );

    this.modelRegistry.registerProvider(openaiProviderFactory);
    this.modelRegistry.registerProvider(anthropicProviderFactory);
    this.modelRegistry.registerProvider(localProviderFactory);
    this.modelRegistry.loadConfigsFromDirectory(
      path.join(registryDir, 'models'),
      false
    );

    try {
      this.modelRegistry.resolveAll(false);
    } catch (err) {
      this.observabilityLogger.logSystemError(
        'model-resolution',
        `Some models could not be resolved: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.agentRegistry.loadFromFile(path.join(registryDir, 'agents.json'));

    const delegateDeps: DelegateTaskDeps = {
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      // Phase 22: typed (was `any`)
      onTaskCreated: async (resolved: ResolvedAgent, prompt: string) => {
        return this.taskRuntime.createTask({
          agent: resolved,
          prompt,
        });
      },
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

    const sessionId = options?.sessionId ?? this.sessionStore.createSession();
    const interaction = this.sessionStore.addInteraction(sessionId, userRequest);
    this.observabilityLogger.logSessionCreated(sessionId);

    this.observabilityLogger.log({
      eventType: 'system:info',
      message: 'Starting planning phase.',
      level: 'info',
    });

    const planningResult = await this.planner.plan(userRequest);

    if (!planningResult.isClear) {
      const clarificationMsg = planningResult.needsClarification.join('\n');
      if (interaction) {
        this.sessionStore.updateInteraction(sessionId, interaction.id, {
          outcome: 'failure',
          reviewSummary: `Clarification needed: ${clarificationMsg}`,
          completedAt: Date.now(),
        });
      }

      return {
        review: {
          planId: 'none',
          goal: userRequest,
          outcome: 'failure',
          acceptedFindings: [],
          rejectedFindings: [],
          incompleteSteps: [],
          finalSummary: `The request needs clarification before a plan can be produced:\n${clarificationMsg}`,
          usage: emptyReviewUsage,
        },
        report: `⚠️ Clarification needed:\n${clarificationMsg}`,
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
    this.observabilityLogger.logPlanCreated(plan);
    // Phase 24 (UI): persist at creation so the plan is visible to the
    // user WHILE the confirmation is pending (UI modal / plans list).
    // Rejected plans remain in the store as 'draft'.
    this.planStore.save(plan);

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

      return {
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

      return {
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
    const planText = formatPlanForUser(summary);

    const confirmation = await options.confirmCallback(planText, plan);
    if (!confirmation.confirmed) {
      return {
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

    plan.status = 'confirmed';
    this.observabilityLogger.log({
      planId: plan.id,
      eventType: 'plan:confirmed',
      message: 'Plan confirmed by user. Starting execution.',
      level: 'info',
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
      maxReplanningAttempts: this.config.maxReplanningAttempts,
      defaultModelId: this.config.defaultModelId,
      onStatusChange: (p, event) => {
        this.streamingManager.handlePlanStatusChange(p, event);
      },
      // Phase 20 (CORR-04): explicit acceptance hook instead of the old
      // EventBus-subscription wiring (wireAcceptanceChecker removed).
      acceptanceChecker: this.acceptanceChecker,
    });

    this.cancellationManager.registerRuntime(plan.id!, planRuntime);

    let executionResult: PlanExecutionResult;
    try {
      executionResult = await planRuntime.execute(plan);
    } finally {
      this.cancellationManager.unregisterRuntime(plan.id!);
    }

    this.observabilityLogger.logPlanCompleted(plan);

    const review = await this.finalReviewer.review(plan, executionResult);

    const usageSummary = this.usageAggregator.getSummary();
    review.usage = {
      totalPromptTokens: usageSummary.totalPromptTokens,
      totalCompletionTokens: usageSummary.totalCompletionTokens,
      totalTokens: usageSummary.totalTokens,
    };

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
  async previewPlan(userRequest: string): Promise<{
    ok: boolean;
    plan?: Plan;
    planText?: string;
    error?: string;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const planningResult = await this.planner.plan(userRequest);

    if (!planningResult.isClear) {
      const clarificationMsg =
        planningResult.needsClarification.length > 0
          ? planningResult.needsClarification.join('\n')
          : planningResult.errors.join('\n');
      return {
        ok: false,
        error: `The request needs clarification before a plan can be produced:\n${clarificationMsg}`,
      };
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
      return { ok: false, plan, error: `Plan failed feasibility check:\n${errorMsg}` };
    }

    const cycleCheck = detectCycles(plan);
    if (cycleCheck.hasCycle) {
      return {
        ok: false,
        plan,
        error: `Circular dependency detected: ${cycleCheck.cyclePath?.join(' → ')}`,
      };
    }

    return { ok: true, plan, planText: formatPlanForUser(summarizePlan(plan)) };
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

  async resumePlan(planId: string): Promise<OrchestratorResult | undefined> {
    const plan = this.planStore.load(planId);
    if (!plan) return undefined;
    // Phase 24: a plan that was never confirmed (still 'draft' — created
    // at plan time, rejected before execution) must not become
    // resumable without confirmation.
    if (plan.status === 'draft') return undefined;

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
      // Phase 20 (CORR-04): same explicit acceptance hook on resume
      acceptanceChecker: this.acceptanceChecker,
    });

    const executionResult = await planRuntime.resume(planId);
    const review = await this.finalReviewer.review(plan, executionResult);
    const report = formatFinalReview(review);

    return {
      review,
      report,
      planId,
      sessionId: 'resumed',
      executionResult,
    };
  }

  async shutdown(): Promise<void> {
    // Phase 20 (CORR-02): let in-flight tasks finish BEFORE
    // unsubscribing — otherwise their completion events are lost.
    await this.taskRuntime.waitForAll();
    this.streamingManager.stop();
    // Phase 20 (CORR-04): acceptanceChecker has no subscription to stop
    this.observabilityLogger.unsubscribeFromEventBus();
    // Phase 21 (PERF-04): release the reused log fd
    this.observabilityLogger.close();
    this.usageAggregator.unsubscribe();
    this.taskRuntime.destroy();
  }
}
