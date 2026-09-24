import { tool } from 'ai';
import { z } from 'zod';
import type { ToolRegistry } from '../../registries/tool-registry.js';

/**
 * Returns a lightweight summary of each registered tool: id, name,
 * description, source (local/mcp), and category.  Does NOT include
 * the full inputSchema to avoid context bloat.
 */
export function createListToolsTool(toolRegistry: ToolRegistry) {
  return tool({
    description:
      'Lists all available tools with their id, name, description, ' +
      'source (local or mcp), and category. Use this to verify which ' +
      'tools exist before assigning them to a plan step.',
    inputSchema: z.object({
      /** Optional filter: only return tools from this source */
      source: z.enum(['local', 'mcp', 'all']).default('all'),
    }),
    execute: async ({ source }: { source: 'local' | 'mcp' | 'all' }) => {
      const allDefs = toolRegistry.listDefinitions();

      const filtered =
        source === 'all'
          ? allDefs
          : allDefs.filter((d) => d.source === source);

      const tools = filtered.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        source: d.source,
        category: d.category ?? '',
        hasImplementation: toolRegistry.getImplementation(d.id) !== undefined,
      }));

      return {
        success: true as const,
        count: tools.length,
        tools,
      };
    },
  });
}
