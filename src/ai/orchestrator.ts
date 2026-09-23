import path from 'node:path';
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
import { wireAcceptanceChecker } from './runtime/plan-runtime-hooks.js';

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

import { readFileTool } from './tools/implementations/read-file.js';
import { searchCodeTool } from './tools/implementations/search-code.js';
import { writeFileTool } from './tools/implementations/write-file.js';
import { gitStatusTool } from './tools/implementations/git-status.js';

import {
  openaiProviderFactory,
  anthropicProviderFactory,
  localProviderFactory,
} from './models/providers/index.js';

import type { Plan } from './schemas/plan.js';
import type { Review } from './schemas/review.js';

// ─── Types ────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Root directory of the project (for resolving registry paths) */
  projectRoot: string;
  /** Use file-based persistence (default: false = in-memory for dev) */
  persistent?: boolean;
  /** Directory for plan/session/log storage (default: .ai-runtime/) */
  runtimeDir?: string;
  /** Maximum concurrent tasks (default: 5) */
  maxConcurrentTasks?: number;
  /** Maximum re-planning attempts (default: 3) */
  maxReplanningAttempts?: number;
  /** Default model id (default: "gpt-4o") */
  defaultModelId?: string;
  /** Agent timeout in ms (default: 120000) */
  agentTimeoutMs?: number;
  /** Maximum delegation depth (default: 1 — sub-agents cannot delegate) */
  maxDelegationDepth?: number;
  /** Progress event callback (for streaming to user) */
  onProgress?: (event: ProgressEvent) => void;
}

export interface OrchestratorResult {
  /** The final review (structured output — Law 15) */
  review: Review;
  /** Human-readable report */
  report: string;
  /** Plan id for reference */
  planId: string;
  /** Session id for continuity */
  sessionId: string;
  /** Execution result details */
  executionResult: PlanExecutionResult;
}

// ─── Orchestrator ────────────────────────────────────────────────

/**
 * The Orchestrator is the single entry point that wires all 14
 * phases together into a complete end-to-end flow:
 *
 *   User Request
 *     → Planning (Phase 9: assess → clarify → plan → feasibility → cycles)
 *     → User Confirmation (Phase 9, Step 7)
 *     → PlanRuntime (Phase 10: execute → priority → re-plan)
 *     → Acceptance Check (Phase 11: per-step quality gate)
 *     → Final Review (Phase 12: structured output)
 *     → Report to User
 *
 * All operational layers are active throughout:
 *   - Streaming (Phase 13): progress events to the user
 *   - Cancellation (Phase 13): user can stop at any time
 *   - Rate-limiting (Phase 13): per-provider backoff
 *   - Usage tracking (Phase 13): token aggregation
 *   - Session persistence (Phase 14): cross-request continuity
 *   - Observability (Phase 14): structured JSONL logging
 *
 * Law 17 (Human-Out-Of-Loop): after the user confirms the plan,
 * the entire execution runs to completion without any human
 * intervention.  The only permitted interaction is cancellation.
 */
export class Orchestrator {
  private readonly config: Required<OrchestratorConfig>;

  // Registries (Phases 1-6)
  readonly personaRegistry: PersonaRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly modelRegistry: ModelRegistry;
  readonly agentRegistry: AgentRegistry;

  // Runtime components (Phases 7-14)
  readonly eventBus: EventBus;
  readonly agentRuntime: AgentRuntime;
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

  private initialized = false;

  constructor(config: OrchestratorConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      persistent: config.persistent ?? false,
      runtimeDir: config.runtimeDir ?? path.join(config.projectRoot, '.ai-runtime'),
      maxConcurrentTasks: config.maxConcurrentTasks ?? 5,
      maxReplanningAttempts: config.maxReplanningAttempts ?? 3,
      defaultModelId: config.defaultModelId ?? 'gpt-4o',
      agentTimeoutMs: config.agentTimeoutMs ?? 120_000,
      maxDelegationDepth: config.maxDelegationDepth ?? 1,
      onProgress: config.onProgress ?? (() => {}),
    };

    // ── Instantiate registries ──────────────────────────────
    this.personaRegistry = new PersonaRegistry();
    this.toolRegistry = new ToolRegistry();
    this.skillRegistry = new SkillRegistry({ toolRegistry: this.toolRegistry });
    this.modelRegistry = new ModelRegistry();
    this.agentRegistry = new AgentRegistry();

    // ── Instantiate runtime ─────────────────────────────────
    this.eventBus = new EventBus();
    this.agentRuntime = new AgentRuntime();
    this.taskRuntime = new TaskRuntime({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      eventBus: this.eventBus,
      agentRuntime: this.agentRuntime,
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
    this.rateLimiter = new RateLimiter();
    this.usageAggregator = new UsageAggregator();
    this.observabilityLogger = new ObservabilityLogger({
      logFilePath: path.join(runtimeDir, 'observability.jsonl'),
    });

    this.acceptanceChecker = new AcceptanceChecker({
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      eventBus: this.eventBus,
      planStore: this.planStore,
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

  // ── Initialization ────────────────────────────────────────────

  /**
   * Bootstrap all registries and tools.  Must be called once
   * before `run()`.  Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const root = this.config.projectRoot;
    const registryDir = path.join(root, 'registry');

    // 1. Load personas
    this.personaRegistry.loadFromDirectory(
      path.join(registryDir, 'personas'),
      true
    );

    // 2. Load local tools
    const localToolDefs = [
      { id: 'read_file', name: 'Read File', description: 'Reads file contents', source: 'local' as const, modulePath: './read-file', category: 'filesystem' },
      { id: 'search_code', name: 'Search Code', description: 'Searches code patterns', source: 'local' as const, modulePath: './search-code', category: 'filesystem' },
      { id: 'write_file', name: 'Write File', description: 'Writes file contents', source: 'local' as const, modulePath: './write-file', category: 'filesystem' },
      { id: 'git_status', name: 'Git Status', description: 'Runs git status', source: 'local' as const, modulePath: './git-status', category: 'git' },
    ];
    for (const d of localToolDefs) this.toolRegistry.registerDefinition(d);
    this.toolRegistry.registerImplementation('read_file', readFileTool);
    this.toolRegistry.registerImplementation('search_code', searchCodeTool);
    this.toolRegistry.registerImplementation('write_file', writeFileTool);
    this.toolRegistry.registerImplementation('git_status', gitStatusTool);

    // 3. Load MCP servers (non-fatal if none configured)
    await bootstrapMcpServers(
      path.join(registryDir, 'mcp-servers'),
      this.toolRegistry
    );

    // 4. Bootstrap catalog tools BEFORE loading skills (task_decomposition depends on them)
    bootstrapCatalogTools({
      toolRegistry: this.toolRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
    });

    // 5. Load skills
    loadSkillsFromDirectory(
      path.join(registryDir, 'skills'),
      this.skillRegistry,
      true
    );

    // 6. Re-bootstrap catalog tools idempotently (ensures impl registered after skill load)
    bootstrapCatalogTools({
      toolRegistry: this.toolRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
    });

    // 7. Load models
    this.modelRegistry.registerProvider(openaiProviderFactory);
    this.modelRegistry.registerProvider(anthropicProviderFactory);
    this.modelRegistry.registerProvider(localProviderFactory);
    this.modelRegistry.loadConfigsFromDirectory(
      path.join(registryDir, 'models'),
      false // Non-fatal: some providers may lack API keys
    );

    // 8. Load agents
    this.agentRegistry.loadFromFile(path.join(registryDir, 'agents.json'));

    // 9. Bootstrap delegate_task
    const delegateDeps: DelegateTaskDeps = {
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      modelRegistry: this.modelRegistry,
      onTaskCreated: async (resolved: any, prompt: string) => {
        return this.taskRuntime.createTask({
          agent: resolved,
          prompt,
        });
      },
      resolveAgentId: (id: string) => this.agentRegistry.get(id),
    };
    bootstrapDelegateTask(this.toolRegistry, delegateDeps);

    // 10. Bootstrap task control tools
    bootstrapTaskControlTools(this.toolRegistry, this.taskRuntime);

    // 11. Wire observability
    this.observabilityLogger.subscribeToEventBus(this.eventBus);

    // 12. Wire streaming
    this.streamingManager.start();
    this.streamingManager.subscribe(this.config.onProgress);

    // 13. Validate cross-registry references
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
      // Log but don't throw — some agents may still work
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

  // ── Main execution flow ───────────────────────────────────────

  /**
   * Execute the full flow for a user request.
   *
   * @param userRequest  The user's natural-language request.
   * @param sessionId    Optional existing session id for continuity.
   * @param confirmCallback  Callback to get user confirmation of the plan.
   *                         Receives the formatted plan text, returns
   *                         true (confirmed) or false + feedback.
   *                         This is the ONLY human interaction point.
   */
  async run(
    userRequest: string,
    options?: {
      sessionId?: string;
      confirmCallback?: (planText: string) => Promise<{ confirmed: boolean; feedback?: string }>;
    }
  ): Promise<OrchestratorResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // ── Session management ──────────────────────────────────
    const sessionId = options?.sessionId ?? this.sessionStore.createSession();
    const interaction = this.sessionStore.addInteraction(sessionId, userRequest);
    this.observabilityLogger.logSessionCreated(sessionId);

    // ── Phase 9: Planning ───────────────────────────────────
    this.observabilityLogger.log({
      eventType: 'system:info',
      message: 'Starting planning phase.',
      level: 'info',
    });

    const planningResult = await this.planner.plan(userRequest);

    // Handle ambiguity
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

    // ── Feasibility Gate ────────────────────────────────────
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

    // ── Cycle Detection ─────────────────────────────────────
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

    // ── User Confirmation (Law 17: the ONLY human touchpoint) ──
    const summary = summarizePlan(plan);
    const planText = formatPlanForUser(summary);

    if (options?.confirmCallback) {
      const confirmation = await options.confirmCallback(planText);
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
    }

    plan.status = 'confirmed';
    this.observabilityLogger.log({
      planId: plan.id,
      eventType: 'plan:confirmed',
      message: 'Plan confirmed by user. Starting execution.',
      level: 'info',
    });

    // ── Phase 10-11: Execution ──────────────────────────────
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
        this.streamingManager.emitProgress({
          type: event.includes('replanning') ? 'plan:replanning' : 'plan:started',
          planId: p.id ?? 'unknown',
          timestamp: Date.now(),
          message: event,
        });
      },
    });

    // Register for cancellation
    this.cancellationManager.registerRuntime(plan.id!, planRuntime);

    // Wire acceptance checker
    const cleanupAcceptance = wireAcceptanceChecker(plan, this.acceptanceChecker);

    let executionResult: PlanExecutionResult;
    try {
      executionResult = await planRuntime.execute(plan);
    } finally {
      cleanupAcceptance();
      this.cancellationManager.unregisterRuntime(plan.id!);
    }

    this.observabilityLogger.logPlanCompleted(plan);

    // ── Phase 12: Final Review ──────────────────────────────
    const review = await this.finalReviewer.review(plan, executionResult);

    // Enrich with usage data
    const usageSummary = this.usageAggregator.getSummary();
    review.usage = {
      totalPromptTokens: usageSummary.totalPromptTokens,
      totalCompletionTokens: usageSummary.totalCompletionTokens,
      totalTokens: usageSummary.totalTokens,
    };

    const report = formatFinalReview(review);

    // ── Update session ──────────────────────────────────────
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

  // ── Public API ────────────────────────────────────────────────

  /**
   * Cancel a running plan.
   */
  async cancelPlan(planId: string) {
    return this.cancellationManager.cancelPlan(planId);
  }

  /**
   * Get the current status of a plan.
   */
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

  /**
   * Get usage summary for the current session.
   */
  getUsageSummary() {
    return this.usageAggregator.getSummary();
  }

  /**
   * Resume a previously interrupted plan.
   */
  async resumePlan(planId: string): Promise<OrchestratorResult | undefined> {
    const plan = this.planStore.load(planId);
    if (!plan) return undefined;

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

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    this.streamingManager.stop();
    this.acceptanceChecker.stop();
    this.observabilityLogger.unsubscribeFromEventBus();
    this.taskRuntime.destroy();
    await this.taskRuntime.waitForAll();
  }
}
