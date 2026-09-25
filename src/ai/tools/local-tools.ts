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
import { createFetchTool } from './implementations/fetch.js';
import { createGitDiffTool } from './implementations/git-diff.js';
import { createGitLogTool } from './implementations/git-log.js';
import { createGitShowTool } from './implementations/git-show.js';
import { createGitBranchListTool } from './implementations/git-branch-list.js';
import { createGitRemoteListTool } from './implementations/git-remote-list.js';
import { createGitAddTool } from './implementations/git-add.js';
import { createGitCommitTool } from './implementations/git-commit.js';
import { createGitCreateBranchTool, createGitCheckoutTool } from './implementations/git-branch-write.js';
import { createGitResetTool } from './implementations/git-reset.js';
import { createGitPushTool } from './implementations/git-push.js';
import { createGitStashTool } from './implementations/git-stash.js';
import {
  createGitPrCommentTool,
  createGitPrCreateTool,
  createGitPrListTool,
  createGitPrViewTool,
} from './implementations/git-pr.js';
import {
  createAddObservationsTool,
  createCreateEntitiesTool,
  createCreateRelationsTool,
  createDeleteEntitiesTool,
  createDeleteObservationsTool,
  createDeleteRelationsTool,
  createOpenNodesTool,
  createReadGraphTool,
  createSearchNodesTool,
} from './implementations/memory-tools.js';

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
  // Phase 39 — the memory knowledge graph (reference `memory` server).
  create_entities: createCreateEntitiesTool,
  create_relations: createCreateRelationsTool,
  add_observations: createAddObservationsTool,
  delete_entities: createDeleteEntitiesTool,
  delete_observations: createDeleteObservationsTool,
  delete_relations: createDeleteRelationsTool,
  read_graph: createReadGraphTool,
  search_nodes: createSearchNodesTool,
  open_nodes: createOpenNodesTool,
  // Phase 40 — the web, read as Markdown.
  fetch: createFetchTool,
  // Phase 41 — git, read-only (phase 42 adds the write half).
  git_diff: createGitDiffTool,
  git_log: createGitLogTool,
  git_show: createGitShowTool,
  git_branch_list: createGitBranchListTool,
  git_remote_list: createGitRemoteListTool,
  // Phase 42 — git, writing (all guarded: protected branches, explicit
  // confirmation for anything irreversible, no force anywhere).
  git_add: createGitAddTool,
  git_commit: createGitCommitTool,
  git_create_branch: createGitCreateBranchTool,
  git_checkout: createGitCheckoutTool,
  git_reset: createGitResetTool,
  git_push: createGitPushTool,
  git_stash: createGitStashTool,
  // Phase 42 — pull requests (gh CLI first, GitHub REST with a token second).
  git_pr_create: createGitPrCreateTool,
  git_pr_list: createGitPrListTool,
  git_pr_view: createGitPrViewTool,
  git_pr_comment: createGitPrCommentTool,
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
