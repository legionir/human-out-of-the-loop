import { tool } from 'ai';
import { z } from 'zod';
import type { PersonaRegistry } from '../../registries/persona-registry.js';

/**
 * Factory function — the tool needs a live reference to the
 * PersonaRegistry, so we inject it at bootstrap time rather
 * than importing a global singleton (Law 12: no direct coupling).
 */
export function createListPersonasTool(personaRegistry: PersonaRegistry) {
  return tool({
    description:
      'Lists all available personas with their id, name, description, and allowed tools. ' +
      'Use this to decide which persona to assign to a plan step. ' +
      'Returns a lightweight summary — not the full system prompt.',
    inputSchema: z.object({}),
    execute: async () => {
      const personas = personaRegistry.list().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? '',
        allowedTools: p.allowedTools,
      }));

      return {
        success: true as const,
        count: personas.length,
        personas,
      };
    },
  });
}
