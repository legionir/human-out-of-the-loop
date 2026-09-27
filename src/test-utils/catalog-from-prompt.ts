/**
 * Parse the compact AVAILABLE CATALOG the planner injects into its prompt.
 *
 * The e2e stub must assign only ids that appear there — inventing `coder`
 * when the catalog omitted it is exactly the hole E-01 / I-01 close.
 */

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

export interface PromptCatalog {
  personas: string[];
  /** Listed tool ids; `['*']` = any tool; `[]` = the persona has none. */
  personaTools: Record<string, string[]>;
  /** The catalog cut the persona's list short (`…+N`): more tools exist. */
  personaToolsTruncated?: Record<string, boolean>;
}

export function parseAvailableCatalog(promptText: string): PromptCatalog | null {
  if (typeof promptText !== 'string' || !promptText.includes('AVAILABLE CATALOG')) {
    return null;
  }
  const section = /Personas:\n([\s\S]*?)\nSkills:/.exec(promptText);
  if (!section) {
    return { personas: [], personaTools: {} };
  }
  const personas: string[] = [];
  const personaTools: Record<string, string[]> = {};
  const personaToolsTruncated: Record<string, boolean> = {};
  for (const raw of section[1]!.split('\n')) {
    const line = raw.trim();
    const match = /^- ([a-z0-9_-]+):/i.exec(line);
    if (!match) continue;
    const id = match[1]!;
    personas.push(id);
    const toolsMatch = /\|\s*tools:\s*(.+)$/.exec(line);
    const listed = toolsMatch ? toolsMatch[1]!.trim() : '';
    if (!listed || listed === '(none)') {
      personaTools[id] = [];
    } else if (listed === '*') {
      personaTools[id] = ['*'];
    } else {
      const parts = listed.split(',').map((part) => part.trim());
      personaToolsTruncated[id] = parts.some((part) => part.startsWith('…'));
      personaTools[id] = parts.filter((part) => part && !part.startsWith('…'));
    }
  }
  return { personas, personaTools, personaToolsTruncated };
}

export function requirePlannerCatalog(promptText: string): PromptCatalog {
  const catalog = parseAvailableCatalog(promptText);
  if (!catalog) {
    throw new CatalogError('AVAILABLE CATALOG missing from planner prompt');
  }
  return catalog;
}

/**
 * PERSONA:<id> in the goal wins when that id is in the catalog.
 * Otherwise pick a listed persona — never invent `coder`.
 */
export function pickPersonaFromCatalog(
  promptText: string,
  catalog: PromptCatalog,
  wantedTools: string[] = [],
): string {
  const marked = /(?:^|\s)PERSONA:([a-z0-9_-]+)/i.exec(promptText);
  if (marked) {
    const id = marked[1]!;
    if (!catalog.personas.includes(id)) {
      throw new CatalogError(`persona "${id}" is not in the AVAILABLE CATALOG`);
    }
    return id;
  }
  // A persona without tools (e.g. the neutral `judge`) cannot run a step.
  const usable = catalog.personas.filter(
    (id) => id !== 'planner' && id !== 'chat' && (catalog.personaTools[id] ?? []).length > 0,
  );
  const needed = [...new Set(['read_file', ...wantedTools])];
  const fit = usable.find((id) => needed.every((tool) => personaMayUse(catalog, id, tool)));
  if (fit) return fit;
  if (catalog.personas.includes('coder')) return 'coder';
  if (usable.length > 0) return usable[0]!;
  if (catalog.personas.length > 0) return catalog.personas[0]!;
  throw new CatalogError('AVAILABLE CATALOG listed no personas');
}

/** Is `tool` allowed for the persona as far as the (possibly cut) catalog shows? */
function personaMayUse(catalog: PromptCatalog, personaId: string, tool: string): boolean {
  const allowed = catalog.personaTools[personaId] ?? [];
  if (allowed.includes('*') || allowed.includes(tool)) return true;
  return catalog.personaToolsTruncated?.[personaId] === true;
}

export function toolsForPersona(catalog: PromptCatalog, personaId: string, extra: string[] = []): string[] {
  const wanted = [...new Set(['read_file', ...extra])];
  const kept = wanted.filter((id) => personaMayUse(catalog, personaId, id));
  return kept.length > 0 ? kept : (catalog.personaTools[personaId] ?? []).slice(0, 1);
}
