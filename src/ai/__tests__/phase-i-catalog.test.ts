import { describe, it, expect } from 'vitest';
import {
  CatalogError,
  parseAvailableCatalog,
  pickPersonaFromCatalog,
  requirePlannerCatalog,
  toolsForPersona,
} from '../../test-utils/catalog-from-prompt.js';

const CATALOG = `AVAILABLE CATALOG (use only these ids; never invent a persona, skill or tool):
Personas:
- reviewer: Code review | tools: read_file, git_diff
- architect: Architecture | tools: read_file, search_code
Skills:
- code_analysis: Analyse code
Tools: read_file, git_diff, search_code, write_file`;

describe('I-01 — fake LLM reads the planner catalog', () => {
  it('parses persona ids and their tools from AVAILABLE CATALOG', () => {
    const catalog = parseAvailableCatalog(CATALOG);
    expect(catalog?.personas).toEqual(['reviewer', 'architect']);
    expect(catalog?.personaTools.reviewer).toEqual(['read_file', 'git_diff']);
  });

  it('returns null when the prompt has no catalog', () => {
    expect(parseAvailableCatalog('USER REQUEST: do the thing')).toBeNull();
    expect(() => requirePlannerCatalog('no catalog here')).toThrow(CatalogError);
  });

  it('never invents coder when the catalog omitted it', () => {
    const catalog = parseAvailableCatalog(CATALOG)!;
    expect(catalog.personas).not.toContain('coder');
    expect(pickPersonaFromCatalog('USER REQUEST: ship it', catalog)).toBe('reviewer');
  });

  it('honours PERSONA:<id> only when that id is listed', () => {
    const catalog = parseAvailableCatalog(CATALOG)!;
    expect(pickPersonaFromCatalog('review notes PERSONA:architect', catalog)).toBe('architect');
    expect(() => pickPersonaFromCatalog('review notes PERSONA:ghost', catalog)).toThrow(
      /ghost.*AVAILABLE CATALOG/,
    );
  });

  it('does not assign write_file to a persona that cannot use it', () => {
    const catalog = parseAvailableCatalog(CATALOG)!;
    expect(toolsForPersona(catalog, 'reviewer', ['write_file'])).toEqual(['read_file']);
  });
});
