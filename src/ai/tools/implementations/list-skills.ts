import { tool } from 'ai';
import { z } from 'zod';
import type { SkillRegistry } from '../../registries/skill-registry.js';

/**
 * Returns a lightweight summary of each skill: id, name, description,
 * required tools, and priority.  Does NOT include the full instructions
 * text to avoid consuming the caller's context budget.
 */
export function createListSkillsTool(skillRegistry: SkillRegistry) {
  return tool({
    description:
      'Lists all available skills with their id, name, description, ' +
      'required tool ids, and priority. Use this to decide which skills ' +
      'a plan step needs. Returns a lightweight summary only.',
    inputSchema: z.object({}),
    execute: async () => {
      const skills = skillRegistry.list().map((s) => ({
        id: s.id,
        name: s.name,
        version: s.version,
        description: s.description ?? '',
        tools: s.resolvedTools,
        priority: s.priority ?? 50,
      }));

      return {
        success: true as const,
        count: skills.length,
        skills,
      };
    },
  });
}
