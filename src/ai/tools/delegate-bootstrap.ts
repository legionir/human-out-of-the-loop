import type { ToolRegistry } from '../registries/tool-registry.js';
import type { DelegateTaskDeps } from './implementations/delegate-task.js';
import { createDelegateTaskTool } from './implementations/delegate-task.js';

/**
 * Register the `delegate_task` tool into the ToolRegistry.
 * This tool is intended ONLY for Main Agent / Planner personas —
 * it should NOT appear in the allowedTools of worker personas.
 */
export function bootstrapDelegateTask(
  toolRegistry: ToolRegistry,
  deps: DelegateTaskDeps
): void {
  const id = 'delegate_task';
  if (toolRegistry.hasDefinition(id)) return;

  toolRegistry.registerDefinition({
    id,
    name: 'Delegate Task',
    description:
      'Delegates a task to a sub-agent (static or dynamic composition). ' +
      'Main Agent / Planner only.',
    source: 'local',
    modulePath: './implementations/delegate-task',
    category: 'control',
  });

  toolRegistry.registerImplementation(id, createDelegateTaskTool(deps));
}
