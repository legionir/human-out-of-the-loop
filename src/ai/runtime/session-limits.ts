/**
 * G-15: one label ceiling for CLI and server, and per-interaction caps so a
 * session file cannot grow without bound from a single turn.
 */
export const SESSION_LABEL_MAX_CHARS = 64;
export const SESSION_REVIEW_SUMMARY_MAX_CHARS = 500;
export const SESSION_USER_REQUEST_MAX_CHARS = 4000;

export const SESSION_TRUNCATED_MARK = '… [truncated]';

export function clipSessionText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= max) return value;
  const mark = SESSION_TRUNCATED_MARK;
  const keep = Math.max(0, max - mark.length);
  return value.slice(0, keep) + mark;
}
