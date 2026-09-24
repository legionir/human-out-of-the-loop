import type { TokenUsage } from './event-bus.js';
import type { Task } from '../schemas/task.js';
import type { EventBus, UnsubscribeFn, AgentCompletedEvent } from './event-bus.js';

// ─── Types ────────────────────────────────────────────────────────

export interface UsageRecord {
  taskId: string;
  planId?: string;
  agentId: string;
  personaId?: string;
  usage: TokenUsage;
  timestamp: number;
  /**
   * Set for a structured model call (planning, acceptance, review) rather
   * than an agent task: its tokens count toward every total, but it is not
   * a task, so it does not count toward `taskCount`.
   */
  llmCall?: boolean;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  taskCount: number;
  /** Breakdown by agent/persona */
  byAgent: Record<string, TokenUsage & { count: number }>;
  /** Breakdown by plan */
  byPlan: Record<string, TokenUsage & { count: number }>;
}

// ─── UsageAggregator ─────────────────────────────────────────────

/**
 * Collects and aggregates token usage across all tasks and plans.
 *
 * Usage data flows from:
 *   AgentRuntime.run() → AgentRunResult.usage → Task.usage → here
 *
 * The aggregator provides:
 *   - Per-task records (for detailed auditing)
 *   - Per-plan summaries (for the final report in Phase 12)
 *   - Per-agent breakdowns (for cost optimization)
 */
export class UsageAggregator {
  private readonly records: UsageRecord[] = [];
  private unsubscribeFn?: UnsubscribeFn;

  /**
   * Automatically collect usage from agent:completed events.
   *
   * Phase 20 (CORR-03): events now carry `planId` (set by TaskRuntime
   * from the task), so per-plan breakdowns are no longer "unassigned".
   */
  subscribeToEventBus(eventBus: EventBus): void {
    this.unsubscribeFn = eventBus.subscribe('agent:completed', (event) => {
      const completedEvent = event as AgentCompletedEvent;
      if (completedEvent.usage) {
        this.recordDirect({
          taskId: completedEvent.taskId,
          planId: completedEvent.planId,
          agentId: completedEvent.agentId,
          usage: completedEvent.usage,
          timestamp: completedEvent.timestamp,
        });
      }
    });
  }

  unsubscribe(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = undefined;
  }

  /**
   * Record usage from a completed task.
   *
   * Phase 20 (CORR-03): reads the real `task.planId` (previously
   * misused `planStepId`, which is a STEP id, not a plan id).
   */
  record(task: Task, agentId: string, personaId?: string): void {
    if (!task.usage) return;

    this.records.push({
      taskId: task.id,
      planId: task.planId,
      agentId,
      personaId,
      usage: task.usage,
      timestamp: task.completedAt ?? Date.now(),
    });
  }

  /**
   * Record usage directly (e.g. from AgentRuntime events).
   */
  recordDirect(record: UsageRecord): void {
    this.records.push(record);
  }

  /**
   * Get the overall usage summary.
   */
  getSummary(): UsageSummary {
    const summary: UsageSummary = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      taskCount: this.records.filter((r) => !r.llmCall).length,
      byAgent: {},
      byPlan: {},
    };

    for (const r of this.records) {
      summary.totalPromptTokens += r.usage.promptTokens;
      summary.totalCompletionTokens += r.usage.completionTokens;
      summary.totalTokens += r.usage.totalTokens;

      // By agent
      if (!summary.byAgent[r.agentId]) {
        summary.byAgent[r.agentId] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          count: 0,
        };
      }
      const agentUsage = summary.byAgent[r.agentId];
      agentUsage.promptTokens += r.usage.promptTokens;
      agentUsage.completionTokens += r.usage.completionTokens;
      agentUsage.totalTokens += r.usage.totalTokens;
      agentUsage.count++;

      // By plan
      const planKey = r.planId ?? 'unassigned';
      if (!summary.byPlan[planKey]) {
        summary.byPlan[planKey] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          count: 0,
        };
      }
      const planUsage = summary.byPlan[planKey];
      planUsage.promptTokens += r.usage.promptTokens;
      planUsage.completionTokens += r.usage.completionTokens;
      planUsage.totalTokens += r.usage.totalTokens;
      planUsage.count++;
    }

    return summary;
  }

  /**
   * Get usage for a specific plan.
   */
  getPlanUsage(planId: string): TokenUsage & { taskCount: number } {
    const planRecords = this.records.filter((r) => r.planId === planId);
    return {
      promptTokens: planRecords.reduce((sum, r) => sum + r.usage.promptTokens, 0),
      completionTokens: planRecords.reduce((sum, r) => sum + r.usage.completionTokens, 0),
      totalTokens: planRecords.reduce((sum, r) => sum + r.usage.totalTokens, 0),
      taskCount: planRecords.filter((r) => !r.llmCall).length,
    };
  }

  /**
   * Get all raw records (for auditing / Phase 14 observability).
   */
  getRecords(): ReadonlyArray<UsageRecord> {
    return this.records;
  }

  /**
   * Clear all records (e.g. between test runs).
   */
  clear(): void {
    this.records.length = 0;
  }
}
