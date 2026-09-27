/**
 * Which of the runtime's tools cannot change anything.
 *
 * One definition, three consumers: `hootl serve --mcp --read-only`, chat mode
 * (which may read the project to answer but must never write), and any future
 * read-only surface.  A tool is read-only when its id is on the explicit list
 * or starts with `read_`/`list_`/`search_`/`get_` — the same rule that decided
 * `readOnlyHint` in the MCP tool schema.
 */

import { LOCAL_TOOL_IDS } from './local-tools.js';

/** Prefixes whose tools only ever read. */
export const READ_ONLY_PREFIXES = ['read_', 'list_', 'search_', 'get_'] as const;

/**
 * Read-only tools whose names do not start with one of the prefixes above.
 * Anything added to the catalog that can *change* state must not be listed
 * here (the prefixes are what keep new `read_*`/`list_*` tools covered).
 */
export const READ_ONLY_IDS: ReadonlySet<string> = new Set([
  'directory_tree',
  'convert_time',
  'fetch',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch_list',
  'git_remote_list',
  'git_pr_list',
  'git_pr_view',
  'read_graph',
  'search_nodes',
  'open_nodes',
]);

export function isReadOnlyTool(id: string): boolean {
  if (READ_ONLY_IDS.has(id)) return true;
  return READ_ONLY_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * The ids a read-only surface may expose.  Defaults to the full local catalog,
 * so `readOnlyToolIds()` answers "what would `--read-only` expose?".
 */
export function readOnlyToolIds(ids: readonly string[] = LOCAL_TOOL_IDS): string[] {
  return ids.filter(isReadOnlyTool);
}
