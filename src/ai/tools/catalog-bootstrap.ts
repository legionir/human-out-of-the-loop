import type { ToolRegistry } from '../registries/tool-registry.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import { createListPersonasTool } from './implementations/list-personas.js';
import { createListSkillsTool } from './implementations/list-skills.js';
import { createListToolsTool } from './implementations/list-tools.js';

export interface CatalogBootstrapDeps {
  toolRegistry: ToolRegistry;
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
}

/**
 * Register the three catalog tools (list_personas, list_skills,
 * list_tools) into the ToolRegistry.  These are read-only tools
 * intended for the Planner/Main Agent only.
 */
export function bootstrapCatalogTools(deps: CatalogBootstrapDeps): void {
  const { toolRegistry, personaRegistry, skillRegistry } = deps;

  const catalogTools = [
    {
      id: 'list_personas',
      name: 'List Personas',
      description: 'Lists all available personas with id, name, description, and allowed tools',
      source: 'local' as const,
      modulePath: './implementations/list-personas',
      category: 'catalog',
      impl: createListPersonasTool(personaRegistry),
    },
    {
      id: 'list_skills',
      name: 'List Skills',
      description: 'Lists all available skills with id, name, description, tools, and priority',
      source: 'local' as const,
      modulePath: './implementations/list-skills',
      category: 'catalog',
      impl: createListSkillsTool(skillRegistry),
    },
    {
      id: 'list_tools',
      name: 'List Tools',
      description: 'Lists all available tools with id, name, description, source, and category',
      source: 'local' as const,
      modulePath: './implementations/list-tools',
      category: 'catalog',
      impl: createListToolsTool(toolRegistry),
    },
  ];

  for (const ct of catalogTools) {
    // Skip if already registered (idempotent)
    if (toolRegistry.hasDefinition(ct.id)) continue;

    toolRegistry.registerDefinition({
      id: ct.id,
      name: ct.name,
      description: ct.description,
      source: ct.source,
      modulePath: ct.modulePath,
      category: ct.category,
    });
    toolRegistry.registerImplementation(ct.id, ct.impl);
  }
}
