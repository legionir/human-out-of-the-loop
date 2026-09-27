/**
 * Re-export the catalog parser the stub uses.  Source of truth is
 * `src/test-utils/catalog-from-prompt.ts` (compiled into dist).
 */
export {
  CatalogError,
  parseAvailableCatalog,
  requirePlannerCatalog,
  pickPersonaFromCatalog,
  toolsForPersona,
} from '../dist/src/test-utils/catalog-from-prompt.js';
