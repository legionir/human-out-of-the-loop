import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-run context for the agent currently executing inside `AgentRuntime`.
 * Tools (especially `delegate_task`) read the CALLER persona, depth, and
 * parent task/plan ids from here instead of guessing from their input.
 */
export interface AgentRunContext {
  taskId: string;
  agentId: string;
  personaId: string;
  delegationDepth: number;
  planId?: string;
  planStepId?: string;
  abortSignal?: AbortSignal;
}

const storage = new AsyncLocalStorage<AgentRunContext>();

export function runWithAgentContext<T>(ctx: AgentRunContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getAgentRunContext(): AgentRunContext | undefined {
  return storage.getStore();
}
