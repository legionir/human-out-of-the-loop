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

/** A clipped field keeps at least this much, so it still says something. */
const MIN_FIELD_CHARS = 500;
const TRUNCATION_MARK = '…';

/**
 * If `value` serialises under the cap it is returned unchanged; otherwise the
 * large string/array fields are clipped — by just as much as the cap needs,
 * biggest field first — and `truncated: true` is set.  A 31 000-char file
 * therefore still hands the model ~30 000 chars, not a 2 000-char stub.
 */
export function capToolResult(value: unknown, cap: number = TOOL_RESULT_CHAR_CAP): unknown {
  if (value === undefined || value === null) return value;
  if (jsonLength(value) <= cap) return value;

  if (typeof value === 'string') {
    return `${value.slice(0, cap)}${TRUNCATION_MARK}`;
  }

  if (Array.isArray(value)) {
    let keep = value.length;
    while (keep > 0 && jsonLength({ truncated: true, preview: value.slice(0, keep) }) > cap) {
      keep = Math.floor(keep / 2);
    }
    return { truncated: true, total: value.length, preview: value.slice(0, keep) };
  }

  if (typeof value !== 'object') return value;

  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>), truncated: true };
  const fields = SHRINK_KEYS.filter((key) => {
    const field = clone[key];
    return (typeof field === 'string' && field.length > MIN_FIELD_CHARS) || Array.isArray(field);
  }).sort((a, b) => jsonLength(clone[b]) - jsonLength(clone[a]));

  for (const key of fields) {
    const over = jsonLength(clone) - cap;
    if (over <= 0) break;
    const field = clone[key];
    if (typeof field === 'string') {
      // JSON escaping can make a char cost more than one; aim a little low.
      const target = Math.max(MIN_FIELD_CHARS, field.length - over - 64);
      clone[key] = `${field.slice(0, target)}${TRUNCATION_MARK}`;
      // Escape-heavy text: keep halving until it fits or hits the floor.
      while (jsonLength(clone) > cap && (clone[key] as string).length > MIN_FIELD_CHARS + 1) {
        const cur = clone[key] as string;
        clone[key] = `${cur.slice(0, Math.max(MIN_FIELD_CHARS, Math.floor(cur.length / 2)))}${TRUNCATION_MARK}`;
      }
    } else if (Array.isArray(field)) {
      let keep = field.length;
      while (keep > 0 && jsonLength(clone) > cap) {
        keep = Math.floor(keep / 2);
        clone[key] = field.slice(0, keep);
      }
    }
  }

  if (jsonLength(clone) <= cap) return clone;

  return {
    success: clone.success ?? true,
    truncated: true,
    preview: JSON.stringify(clone).slice(0, cap - 200),
  };
}
