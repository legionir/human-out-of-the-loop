/**
 * Phase 33 — the ported filesystem core (see the module headers for the
 * reference sources and the deliberate differences).
 */
export {
  convertToWindowsPath,
  expandHome,
  normalizePath,
} from './path-utils.js';
export { isPathWithinAllowedDirectories } from './path-validation.js';
export { parseRoot, resolveAllowedDirectories, type ResolvedRoots } from './roots.js';
export {
  PathAccessError,
  applyFileEdits,
  createUnifiedDiff,
  formatSize,
  getFileStats,
  headFile,
  moveFile,
  normalizeLineEndings,
  readFileContent,
  searchFilesWithValidation,
  tailFile,
  validatePath,
  writeFileContent,
  type FileEdit,
  type FileInfo,
  type PathAccessCode,
  type SearchOptions,
  type SearchResult,
} from './lib.js';
