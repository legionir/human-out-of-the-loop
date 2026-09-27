import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

/**
 * A persona's tool list is shown in full up to this many ids: the planner
 * assigns tools per step and can only assign what it can see (a cut at 16
 * hid most of coder's 48 tools — memory, git writes, run_command).  Ids are
 * short, so even a full catalog stays around a thousand tokens.
 */
const MAX_TOOLS_PER_PERSONA = 80;

/**
 * Compact catalog injected into planner prompts so the model assigns only
 * ids that exist — `generateObject` cannot call `list_personas`.
 */
export function buildCatalogBlock(deps: {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry?: ToolRegistry;
}): string {
  const personas = deps.personaRegistry.list();
  const skills = deps.skillRegistry.list();
  const tools = deps.toolRegistry?.listDefinitions() ?? [];

  const personaLines = personas.map((persona) => {
    const toolsList = persona.allowedTools.includes('*')
      ? '*'
      : persona.allowedTools.slice(0, MAX_TOOLS_PER_PERSONA).join(', ') +
        (persona.allowedTools.length > MAX_TOOLS_PER_PERSONA
          ? `, …+${persona.allowedTools.length - MAX_TOOLS_PER_PERSONA}`
          : '');
    const purpose = persona.description || persona.name;
    return `- ${persona.id}: ${purpose} | tools: ${toolsList || '(none)'}`;
  });

  const skillLines = skills.map((skill) => {
    const purpose = skill.description || skill.name;
    return `- ${skill.id}: ${purpose}`;
  });

  const toolIds = tools.map((tool) => tool.id).sort();

  const lines = [
    'AVAILABLE CATALOG (use only these ids; never invent a persona, skill or tool):',
    'Personas:',
    ...(personaLines.length > 0 ? personaLines : ['- (none registered)']),
    'Skills:',
    ...(skillLines.length > 0 ? skillLines : ['- (none registered)']),
  ];
  if (toolIds.length > 0) {
    lines.push(`Tools: ${toolIds.join(', ')}`);
  }
  return lines.join('\n');
}
