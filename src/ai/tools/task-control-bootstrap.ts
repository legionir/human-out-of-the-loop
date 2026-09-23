import type { ToolRegistry } from '../registries/tool-registry.js';
import type { TaskRuntime } from '../runtime/task-runtime.js';
import type { AgentRegistry } from '../registries/agent-registry.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import {
  createCreateTaskTool,
  createGetAgentStatusTool,
  createGetAgentResultTool,
  createGetTaskDetailsTool,
  type CreateTaskToolDeps,
} from './implementations/task-control-tools.js';

export interface TaskControlBootstrapDeps {
  toolRegistry: ToolRegistry;
  taskRuntime: TaskRuntime;
  agentRegistry: AgentRegistry;
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  modelRegistry: ModelRegistry;
}

/**
 * Register the four task-control tools into the ToolRegistry.
 * Supports both legacy signature (toolRegistry, taskRuntime)
 * and new full-deps signature.
 */
export function bootstrapTaskControlTools(
  toolRegistryOrDeps: ToolRegistry | TaskControlBootstrapDeps,
  taskRuntime?: TaskRuntime
): void {
  let toolRegistry: ToolRegistry;
  let runtime: TaskRuntime;
  let fullDeps: TaskControlBootstrapDeps | undefined;

  if (taskRuntime) {
    toolRegistry = toolRegistryOrDeps as ToolRegistry;
    runtime = taskRuntime;
  } else {
    const deps = toolRegistryOrDeps as TaskControlBootstrapDeps;
    toolRegistry = deps.toolRegistry;
    runtime = deps.taskRuntime;
    fullDeps = deps;
  }

  const tools = [
    {
      id: 'create_task',
      name: 'Create Task',
      description: 'Creates and schedules a new sub-agent task',
      impl: fullDeps
        ? createCreateTaskTool({
            taskRuntime: fullDeps.taskRuntime,
            agentRegistry: fullDeps.agentRegistry,
            personaRegistry: fullDeps.personaRegistry,
            skillRegistry: fullDeps.skillRegistry,
            toolRegistry: fullDeps.toolRegistry,
            modelRegistry: fullDeps.modelRegistry,
          } as CreateTaskToolDeps)
        : createCreateTaskTool(runtime),
    },
    {
      id: 'get_agent_status',
      name: 'Get Agent Status',
      description: 'Returns the current status of a task',
      impl: createGetAgentStatusTool(runtime),
    },
    {
      id: 'get_agent_result',
      name: 'Get Agent Result',
      description: 'Returns the result of a completed task',
      impl: createGetAgentResultTool(runtime),
    },
    {
      id: 'get_task_details',
      name: 'Get Task Details',
      description: 'Returns detailed task information',
      impl: createGetTaskDetailsTool(runtime),
    },
  ];

  for (const t of tools) {
    if (toolRegistry.hasDefinition(t.id)) continue;

    toolRegistry.registerDefinition({
      id: t.id,
      name: t.name,
      description: t.description,
      source: 'local',
      modulePath: './implementations/task-control-tools',
      category: 'control',
    });
    toolRegistry.registerImplementation(t.id, t.impl);
  }
}
