/**
 * G-15: one label ceiling for CLI and server, and per-interaction caps so a
 * session file cannot grow without bound from a single turn.
 */
export const SESSION_LABEL_MAX_CHARS = 64;
export const SESSION_REVIEW_SUMMARY_MAX_CHARS = 500;
export const SESSION_USER_REQUEST_MAX_CHARS = 4000;

export function clipSessionText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}
