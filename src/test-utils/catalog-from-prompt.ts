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
  personaTools: Record<string, string[]>;
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
      personaTools[id] = listed
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith('…'));
    }
  }
  return { personas, personaTools };
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
  const usable = catalog.personas.filter((id) => id !== 'planner' && id !== 'chat');
  if (wantedTools.length > 0) {
    const fit = usable.find((id) => {
      const allowed = catalog.personaTools[id] ?? [];
      if (allowed.includes('*') || allowed.length === 0) return true;
      return wantedTools.every((tool) => allowed.includes(tool) || tool === 'read_file');
    });
    if (fit) return fit;
  }
  if (catalog.personas.includes('coder')) return 'coder';
  if (usable.length > 0) return usable[0]!;
  if (catalog.personas.length > 0) return catalog.personas[0]!;
  throw new CatalogError('AVAILABLE CATALOG listed no personas');
}

export function toolsForPersona(catalog: PromptCatalog, personaId: string, extra: string[] = []): string[] {
  const allowed = catalog.personaTools[personaId] ?? [];
  const wanted = [...new Set(['read_file', ...extra])];
  if (allowed.includes('*') || allowed.length === 0) return wanted;
  const kept = wanted.filter((id) => allowed.includes(id) || id === 'read_file');
  return kept.length > 0 ? kept : ['read_file'];
}
