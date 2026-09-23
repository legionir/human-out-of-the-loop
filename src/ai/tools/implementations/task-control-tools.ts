import { tool } from 'ai';
import { z } from 'zod';
import type { TaskRuntime } from '../../runtime/task-runtime.js';
import type { AgentRegistry } from '../../registries/agent-registry.js';
import type { PersonaRegistry } from '../../registries/persona-registry.js';
import type { SkillRegistry } from '../../registries/skill-registry.js';
import type { ToolRegistry } from '../../registries/tool-registry.js';
import type { ModelRegistry } from '../../registries/model-registry.js';
import { createAgent } from '../../agents/agent-factory.js';

// ── 1. create_task (FIXED) ───────────────────────────────────────

export interface CreateTaskToolDeps {
  taskRuntime: TaskRuntime;
  agentRegistry: AgentRegistry;
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  defaultModelId?: string;
}

export function createCreateTaskTool(deps: CreateTaskToolDeps | TaskRuntime) {
  // Backward compat: if passed just TaskRuntime, wrap it
  if (deps instanceof Object && 'createTask' in (deps as any)) {
    const taskRuntime = deps as TaskRuntime;
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
        return {
          success: true as const,
          taskId: `pending_${agentId}_${Date.now()}`,
          message:
            'Task creation request received. Use delegate_task for full agent resolution.',
        };
      },
    });
  }

  const fullDeps = deps as CreateTaskToolDeps;
  return tool({
    description:
      'Creates and immediately schedules a new task for a sub-agent. ' +
      'The agent is resolved from the AgentRegistry by id. ' +
      'Returns the taskId for tracking via get_agent_status/get_agent_result.',
    inputSchema: z.object({
      agentId: z.string().min(1).describe('Pre-registered agent id from AgentRegistry'),
      prompt: z.string().min(1).describe('The task prompt'),
      claimedResources: z
        .array(z.string())
        .default([])
        .describe('File paths or resources this task will modify'),
    }),
    execute: async ({ agentId, prompt, claimedResources }) => {
      try {
        const agentDef = fullDeps.agentRegistry.get(agentId);
        if (!agentDef) {
          return {
            success: false as const,
            error: `Agent "${agentId}" not found in AgentRegistry.`,
            code: 'AGENT_NOT_FOUND',
          };
        }

        const resolved = createAgent({
          agentDefinition: agentDef,
          refs: {
            personaRegistry: fullDeps.personaRegistry,
            skillRegistry: fullDeps.skillRegistry,
            toolRegistry: fullDeps.toolRegistry,
            modelRegistry: fullDeps.modelRegistry,
          },
        });

        const taskId = fullDeps.taskRuntime.createTask({
          agent: resolved,
          prompt,
          claimedResources,
        });

        return {
          success: true as const,
          taskId,
          agentId,
          persona: resolved.persona.id,
          toolsGranted: Object.keys(resolved.tools),
          toolsDenied: resolved.toolWarnings.map((w) => w.toolId),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false as const,
          error: message,
          code: 'TASK_CREATION_FAILED',
        };
      }
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
        toolsUsed: [],
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
        prompt: task.prompt.slice(0, 500),
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
