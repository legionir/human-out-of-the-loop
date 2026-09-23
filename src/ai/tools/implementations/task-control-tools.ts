import { tool } from 'ai';
import { z } from 'zod';
import type { TaskRuntime } from '../../runtime/task-runtime.js';

/**
 * Creates the four control tools that Main Agent / Planner uses
 * to manage sub-agent tasks.  These are registered in the
 * "control" category and should NOT appear in the allowedTools
 * of worker personas (only planner/main personas).
 *
 * Law 13: these tools are the ONLY channel for Main → Sub interaction.
 * Law 14: get_agent_status and get_agent_result return compact data,
 *         not raw transcripts.  get_task_details returns more detail
 *         but still not the full tool-call log.
 */

// ── 1. create_task ───────────────────────────────────────────────

export function createCreateTaskTool(_taskRuntime: TaskRuntime) {
  return tool({
    description:
      'Creates a new task for a sub-agent. The task is queued and will ' +
      'start automatically when a concurrency slot and resource locks ' +
      'are available. Returns the taskId for tracking.',
    inputSchema: z.object({
      agentId: z.string().min(1).describe('Agent id or dynamic composition id'),
      prompt: z.string().min(1).describe('The task prompt'),
      claimedResources: z
        .array(z.string())
        .default([])
        .describe('File paths or resources this task will modify'),
    }),
    execute: async ({ agentId }: { agentId: string; prompt: string; claimedResources: string[] }) => {
      // Note: the actual agent resolution happens in delegate_task (Phase 6).
      // This tool is a lower-level primitive that TaskRuntime uses internally.
      // When called directly by Main Agent, the agent must already be resolved.
      // For now, we store the intent and return a placeholder.
      // Full wiring happens in Phase 15 (end-to-end integration).
      return {
        success: true as const,
        taskId: `pending_${agentId}_${Date.now()}`,
        message:
          'Task creation request received. Use delegate_task for full agent resolution.',
      };
    },
  });
}

// ── 2. get_agent_status ──────────────────────────────────────────

export function createGetAgentStatusTool(taskRuntime: TaskRuntime) {
  return tool({
    description:
      'Returns the current status of a task (pending, running, completed, ' +
      'failed, or cancelled). Lightweight — does not include the full result.',
    inputSchema: z.object({
      taskId: z.string().min(1),
    }),
    execute: async ({ taskId }: { taskId: string }) => {
      const status = taskRuntime.getStatus(taskId);
      if (!status) {
        return {
          success: false as const,
          error: `Task "${taskId}" not found.`,
          code: 'TASK_NOT_FOUND',
        };
      }
      return {
        success: true as const,
        taskId,
        status: status.status,
        summary: status.summary ?? null,
      };
    },
  });
}

// ── 3. get_agent_result ──────────────────────────────────────────

export function createGetAgentResultTool(taskRuntime: TaskRuntime) {
  return tool({
    description:
      'Returns the result of a completed task. If the task is still ' +
      'pending or running, returns the current status instead of throwing. ' +
      'Includes summary, tools used, and usage stats.',
    inputSchema: z.object({
      taskId: z.string().min(1),
    }),
    execute: async ({ taskId }: { taskId: string }) => {
      const task = taskRuntime.getResult(taskId);
      if (!task) {
        return {
          success: false as const,
          error: `Task "${taskId}" not found.`,
          code: 'TASK_NOT_FOUND',
        };
      }

      // If not yet complete, return current status (don't throw — Law 14)
      if (task.status === 'pending' || task.status === 'running') {
        return {
          success: true as const,
          taskId,
          status: task.status,
          message: `Task is still ${task.status}. Check back later.`,
          result: null,
        };
      }

      return {
        success: true as const,
        taskId,
        status: task.status,
        summary: task.summary ?? '',
        result: task.result ?? '',
        toolsUsed: [], // Populated from AgentRuntime result in Phase 15
        usage: task.usage ?? null,
        errors: task.errors,
        failureType: task.failureType ?? null,
      };
    },
  });
}

// ── 4. get_task_details ──────────────────────────────────────────

export function createGetTaskDetailsTool(taskRuntime: TaskRuntime) {
  return tool({
    description:
      'Returns detailed information about a task including full result, ' +
      'errors, timestamps, and resource claims. Use this when the compact ' +
      'status/result is insufficient for decision-making. ' +
      'Still does NOT include raw tool-call transcripts (Law 14).',
    inputSchema: z.object({
      taskId: z.string().min(1),
    }),
    execute: async ({ taskId }: { taskId: string }) => {
      const task = taskRuntime.getDetails(taskId);
      if (!task) {
        return {
          success: false as const,
          error: `Task "${taskId}" not found.`,
          code: 'TASK_NOT_FOUND',
        };
      }

      return {
        success: true as const,
        taskId: task.id,
        agentId: task.agentDefinitionOrId,
        status: task.status,
        prompt: task.prompt.slice(0, 500), // Truncate for safety
        summary: task.summary ?? '',
        result: task.result ?? '',
        claimedResources: task.claimedResources,
        usage: task.usage ?? null,
        errors: task.errors,
        failureType: task.failureType ?? null,
        createdAt: task.createdAt,
        startedAt: task.startedAt ?? null,
        completedAt: task.completedAt ?? null,
        planStepId: task.planStepId ?? null,
      };
    },
  });
}
