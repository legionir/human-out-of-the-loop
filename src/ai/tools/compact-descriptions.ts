/**
 * F-02 — tool definitions eat prompt tokens.  Four tools shipped with
 * paragraph-length descriptions; a coder step that only needs a handful
 * of ids should not pay for the rest of the catalog either (see
 * `createAgent` requesting `def.toolIds` when that list is non-empty).
 */

export const MAX_TOOL_DESCRIPTION_CHARS = 180;

const SHORT: Record<string, string> = {
  search_code:
    'Search file contents with a regex. Returns relative path, line, column, and matching text.',
  search_files:
    'Find files/directories by glob. Skips build/vendor dirs by default. Returns workspace-relative paths.',
  fetch:
    'Fetch an http(s) URL as Markdown. Truncated pages include nextStartIndex. Loopback/private blocked.',
  sequentialthinking:
    'Record one numbered reasoning step (revisable, branchable). Persists for later turns.',
};

export function compactToolDescription(id: string, description: string): string {
  const short = SHORT[id];
  if (short) return short;
  if (description.length <= MAX_TOOL_DESCRIPTION_CHARS) return description;
  return `${description.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`;
}

/** Mutates `tools` in place: every description is compacted. */
export function compactToolDescriptions<T extends Record<string, unknown>>(tools: T): T {
  for (const [id, tool] of Object.entries(tools)) {
    if (
      tool &&
      typeof tool === 'object' &&
      'description' in tool &&
      typeof (tool as { description?: unknown }).description === 'string'
    ) {
      (tool as { description: string }).description = compactToolDescription(
        id,
        (tool as { description: string }).description,
      );
    }
  }
  return tools;
}

/** Rough token estimate of the tool catalog the model will see (chars/4). */
export function estimateToolCatalogTokens(tools: Record<string, unknown>): number {
  let chars = 2;
  for (const [id, tool] of Object.entries(tools)) {
    const description =
      tool && typeof tool === 'object' && 'description' in tool && typeof (tool as { description?: unknown }).description === 'string'
        ? (tool as { description: string }).description
        : '';
    chars += id.length + 8 + description.length;
  }
  return Math.ceil(chars / 4);
}
