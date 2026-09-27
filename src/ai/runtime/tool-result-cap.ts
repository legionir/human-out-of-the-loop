/**
 * F-03 — hard ceiling on a tool result handed back to the model.
 * Individual tools (directory_tree, read_file, git_*) apply their own
 * tighter caps; this is the last wrapper every execute path goes through.
 */

export const TOOL_RESULT_CHAR_CAP = 30_000;

const SHRINK_KEYS = [
  'content',
  'diff',
  'show',
  'formatted',
  'tree',
  'result',
  'matches',
  'entries',
  'files',
] as const;

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return TOOL_RESULT_CHAR_CAP + 1;
  }
}

/**
 * If `value` serialises under the cap it is returned unchanged; otherwise
 * large string/array fields are clipped and `truncated: true` is set.
 */
export function capToolResult(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (jsonLength(value) <= TOOL_RESULT_CHAR_CAP) return value;

  if (typeof value === 'string') {
    return `${value.slice(0, TOOL_RESULT_CHAR_CAP)}…`;
  }

  if (Array.isArray(value)) {
    return {
      truncated: true,
      preview: value.slice(0, 20),
    };
  }

  if (typeof value !== 'object') return value;

  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>), truncated: true };
  for (const key of SHRINK_KEYS) {
    const field = clone[key];
    if (typeof field === 'string' && field.length > 2_000) {
      clone[key] = `${field.slice(0, 2_000)}…`;
    } else if (Array.isArray(field) && field.length > 40) {
      clone[key] = field.slice(0, 40);
    }
  }

  if (jsonLength(clone) <= TOOL_RESULT_CHAR_CAP) return clone;

  return {
    success: clone.success ?? true,
    truncated: true,
    preview: JSON.stringify(clone).slice(0, 2_000),
  };
}
