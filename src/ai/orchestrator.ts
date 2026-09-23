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

import { createReadFileTool } from './tools/implementations/read-file.js';
import { createSearchCodeTool } from './tools/implementations/search-code.js';
import { createWriteFileTool } from './tools/implementations/write-file.js';
import { createGitStatusTool } from './tools/implementations/git-status.js';

import {
  openaiProviderFactory,
  anthropicProviderFactory,
  localProviderFactory,
} from './models/providers/index.js';

import type { Plan } from './schemas/plan.js';
import type { Review } from './schemas/review.js';

// ─── Types ────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  projectRoot: string;
  persistent?: boolean;
  runtimeDir?: string;
  maxConcurrentTasks?: number;
  maxReplanningAttempts?: number;
  defaultModelId?: string;
  agentTimeoutMs?: number;
  maxDelegationDepth?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export interface OrchestratorRunOptions {
  sessionId?: string;
  /**
   * Callback to get user confirmation of the plan.
   * REQUIRED — Law 17 mandates explicit user approval before execution.
   * Receives the formatted plan text, returns confirmation result.
   */
  confirmCallback: (planText: string) => Promise<{ confirmed: boolean; feedback?: string }>;
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
      console.log('\n' + planText + '\n');
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

    this.personaRegistry = new PersonaRegistry();
    this.toolRegistry = new ToolRegistry();
    this.skillRegistry = new SkillRegistry({ toolRegistry: this.toolRegistry });
    this.modelRegistry = new ModelRegistry();
    this.agentRegistry = new AgentRegistry();

    this.eventBus = new EventBus();
    this.agentRuntime = new AgentRuntime();
    this.rateLimiter = new RateLimiter();
    this.retryableAgentRuntime = new RetryableAgentRuntime(
      this.agentRuntime,
      this.rateLimiter
    );
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
      taskRuntime: this.taskRuntime,
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

    const localToolDefs = [
      { id: 'read_file', name: 'Read File', description: 'Reads file contents', source: 'local' as const, modulePath: './read-file', category: 'filesystem' },
      { id: 'search_code', name: 'Search Code', description: 'Searches code patterns', source: 'local' as const, modulePath: './search-code', category: 'filesystem' },
      { id: 'write_file', name: 'Write File', description: 'Writes file contents', source: 'local' as const, modulePath: './write-file', category: 'filesystem' },
      { id: 'git_status', name: 'Git Status', description: 'Runs git status', source: 'local' as const, modulePath: './git-status', category: 'git' },
    ];
    for (const d of localToolDefs) this.toolRegistry.registerDefinition(d);
    // Phase 18 (PATH-01..04): tools are created bound to the
    // Orchestrator's projectRoot — never to process.cwd().
    this.toolRegistry.registerImplementation('read_file', createReadFileTool(root));
    this.toolRegistry.registerImplementation('search_code', createSearchCodeTool(root));
    this.toolRegistry.registerImplementation('write_file', createWriteFileTool(root));
    this.toolRegistry.registerImplementation('git_status', createGitStatusTool(root));

    await bootstrapMcpServers(
      path.join(registryDir, 'mcp-servers'),
      this.toolRegistry
    );

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

    bootstrapCatalogTools({
      toolRegistry: this.toolRegistry,
      personaRegistry: this.personaRegistry,
      skillRegistry: this.skillRegistry,
    });

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
      onTaskCreated: async (resolved: any, prompt: string) => {
        return this.taskRuntime.createTask({
          agent: resolved,
          prompt,
        });
      },
      resolveAgentId: (id: string) => this.agentRegistry.get(id),
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

    const summary = summarizePlan(plan);
    const planText = formatPlanForUser(summary);

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
    });

    this.cancellationManager.registerRuntime(plan.id!, planRuntime);

    const cleanupAcceptance = wireAcceptanceChecker(plan, this.acceptanceChecker);

    let executionResult: PlanExecutionResult;
    try {
      executionResult = await planRuntime.execute(plan);
    } finally {
      cleanupAcceptance();
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

  async shutdown(): Promise<void> {
    this.streamingManager.stop();
    this.acceptanceChecker.stop();
    this.observabilityLogger.unsubscribeFromEventBus();
    this.usageAggregator.unsubscribe();
    this.taskRuntime.destroy();
    await this.taskRuntime.waitForAll();
  }
}
