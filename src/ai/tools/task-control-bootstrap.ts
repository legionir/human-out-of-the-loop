import type { ToolRegistry } from '../registries/tool-registry.js';
import type { TaskRuntime } from '../runtime/task-runtime.js';
import {
  createCreateTaskTool,
  createGetAgentStatusTool,
  createGetAgentResultTool,
  createGetTaskDetailsTool,
} from './implementations/task-control-tools.js';

/**
 * Register the four task-control tools into the ToolRegistry.
 * These belong to the "control" category and are intended for
 * Main Agent / Planner personas only.
 */
export function bootstrapTaskControlTools(
  toolRegistry: ToolRegistry,
  taskRuntime: TaskRuntime
): void {
  const tools = [
    {
      id: 'create_task',
      name: 'Create Task',
      description: 'Creates a new sub-agent task',
      impl: createCreateTaskTool(taskRuntime),
    },
    {
      id: 'get_agent_status',
      name: 'Get Agent Status',
      description: 'Returns the current status of a task',
      impl: createGetAgentStatusTool(taskRuntime),
    },
    {
      id: 'get_agent_result',
      name: 'Get Agent Result',
      description: 'Returns the result of a completed task',
      impl: createGetAgentResultTool(taskRuntime),
    },
    {
      id: 'get_task_details',
      name: 'Get Task Details',
      description: 'Returns detailed task information',
      impl: createGetTaskDetailsTool(taskRuntime),
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
