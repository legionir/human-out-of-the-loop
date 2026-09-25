import type { Tool } from 'ai';

// Phase 33: the local (non-MCP) filesystem + git toolset in one place.
// `bootstrapTools` binds these to the definitions in `registry/tools/*.json`;
// tests that build a partial registry use `LOCAL_TOOL_FACTORIES` too, so the
// in-memory catalog can never drift from the packaged one.
import { createReadFileTool } from './implementations/read-file.js';
import { createSearchCodeTool } from './implementations/search-code.js';
import { createWriteFileTool } from './implementations/write-file.js';
import { createGitStatusTool } from './implementations/git-status.js';
import { createEditFileTool } from './implementations/edit-file.js';
import { createReadMultipleFilesTool } from './implementations/read-multiple-files.js';
import { createWriteMultipleFilesTool } from './implementations/write-multiple-files.js';
import { createListDirectoryTool } from './implementations/list-directory.js';
import { createDirectoryTreeTool } from './implementations/directory-tree.js';
import { createMoveFileTool } from './implementations/move-file.js';
import { createGetFileInfoTool } from './implementations/get-file-info.js';
import { createCreateDirectoryTool } from './implementations/create-directory.js';
import { createSearchFilesTool } from './implementations/search-files.js';
import { createListAllowedDirectoriesTool } from './implementations/list-allowed-directories.js';
import { createListDirectoryWithSizesTool } from './implementations/list-directory-with-sizes.js';
import { createReadMediaFileTool } from './implementations/read-media-file.js';
import { createGetCurrentTimeTool } from './implementations/get-current-time.js';
import { createConvertTimeTool } from './implementations/convert-time.js';
import { createSequentialThinkingTool } from './implementations/sequential-thinking.js';

/**
 * Every local tool, keyed by the id used in `registry/tools/*.json`.
 * Each factory is bound to a workspace root (phase 18), so two Orchestrators in
 * the same process never share a sandbox.
 */
export const LOCAL_TOOL_FACTORIES: Readonly<Record<string, (projectRoot: string) => Tool>> = {
  // The four original tools (phase 2), rewritten on the ported reference core.
  read_file: createReadFileTool,
  write_file: createWriteFileTool,
  search_code: createSearchCodeTool,
  git_status: createGitStatusTool,
  // Phase 33 — the reference filesystem toolset.
  edit_file: createEditFileTool,
  read_multiple_files: createReadMultipleFilesTool,
  read_media_file: createReadMediaFileTool,
  write_multiple_files: createWriteMultipleFilesTool,
  list_directory: createListDirectoryTool,
  list_directory_with_sizes: createListDirectoryWithSizesTool,
  directory_tree: createDirectoryTreeTool,
  move_file: createMoveFileTool,
  get_file_info: createGetFileInfoTool,
  create_directory: createCreateDirectoryTool,
  search_files: createSearchFilesTool,
  list_allowed_directories: createListAllowedDirectoriesTool,
  // Phase 38 — time and structured reasoning.
  get_current_time: createGetCurrentTimeTool,
  convert_time: createConvertTimeTool,
  sequentialthinking: createSequentialThinkingTool,
};

/** Ids of the local tools above — used by tests and by the bootstrap check. */
export const LOCAL_TOOL_IDS: readonly string[] = Object.keys(LOCAL_TOOL_FACTORIES);

/** Create one instance of every local tool, bound to `projectRoot`. */
export function createLocalTools(projectRoot: string): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [id, factory] of Object.entries(LOCAL_TOOL_FACTORIES)) {
    tools[id] = factory(projectRoot);
  }
  return tools;
}
