/**
 * `@chat …` / `@plan …` — the mode inside the request itself.
 *
 * Typing the mode where the request is written is the shortest way to say what
 * you want, and it works in every surface that takes a goal: `hootl run`, the
 * REPL line, a resumed session.  The prefix is stripped before the request is
 * used for anything (session title, logs, the planner), so `@plan tidy up`
 * records `tidy up`.
 *
 * Only the three mode words followed by whitespace (or the end of the line)
 * count.  `@aur/auto fix the tests` is an @mention, not a mode, and stays in
 * the request untouched — the same for any other `@word`.
 */
import {
  DEFAULT_RUN_MODE,
  RUN_MODES,
  looksLikeModePrefix,
  parseRunMode,
  type RunMode,
} from '../../ai/modes.js';

export interface ParsedModePrefix {
  /** The mode the user typed, when a prefix was present. */
  mode?: RunMode;
  /** The request with the prefix removed (and outer whitespace trimmed). */
  text: string;
  /** True when at least one `@mode` prefix was found. */
  explicit: boolean;
}

/**
 * Strip leading `@mode` prefixes.  Repeats are allowed and the LAST one wins
 * (`@chat @plan x` plans), so a stray prefix from an earlier edit cannot
 * silently decide the run.  A prefix with nothing after it is left in place —
 * the caller reports "nothing to do" instead of running an empty goal.
 */
export function parseModePrefix(input: string): ParsedModePrefix {
  let text = input.trim();
  let mode: RunMode | undefined;

  for (;;) {
    const match = /^(\S+)\s+([\s\S]*)$/.exec(text);
    if (!match) break;
    const candidate = looksLikeModePrefix(match[1] ?? '');
    if (!candidate) break;
    const rest = (match[2] ?? '').trim();
    if (rest === '') break; // `@chat` alone: nothing to run, keep it as the goal
    mode = candidate;
    text = rest;
  }

  return { ...(mode ? { mode } : {}), text, explicit: mode !== undefined };
}

/** Every mode word, for help text and error messages. */
export function modeWords(): string {
  return RUN_MODES.map((mode) => `@${mode}`).join(', ');
}

export interface ResolvedMode {
  mode: RunMode;
  /** Where it came from — the CLI says so when it is not the default. */
  source: 'prefix' | 'flag' | 'env' | 'config' | 'default';
}

/**
 * Which mode this run uses, and who chose it.
 *
 *   `@chat` in the request  >  `--mode`  >  `HOTL_MODE`  >  `defaultMode`  >  auto
 *
 * The prefix wins over the flag on purpose: it is written inside the request
 * itself, so it is the most local statement of intent (and a typo in one of
 * the two is visible in the run's own output — see `source`).
 */
export function resolveRunMode(opts: {
  /** From `parseModePrefix` — only when the user actually typed one. */
  prefix?: RunMode;
  flag?: string;
  env?: NodeJS.ProcessEnv;
  config?: { defaultMode?: string };
}): { resolved: ResolvedMode; invalid?: { value: string; source: string } } {
  const candidates: Array<[RunMode | undefined, ResolvedMode['source'], string | undefined]> = [
    [opts.prefix, 'prefix', opts.prefix],
    [undefined, 'flag', opts.flag],
    [undefined, 'env', (opts.env ?? process.env).HOTL_MODE],
    [undefined, 'config', opts.config?.defaultMode],
  ];

  const invalid: { value: string; source: string }[] = [];
  for (const [literal, source, raw] of candidates) {
    if (literal) return { resolved: { mode: literal, source } };
    if (raw === undefined || raw === null) continue;
    const parsed = parseRunMode(raw);
    if (parsed) return { resolved: { mode: parsed, source } };
    if (String(raw).trim() !== '') invalid.push({ value: String(raw), source });
  }

  return {
    resolved: { mode: DEFAULT_RUN_MODE, source: 'default' },
    ...(invalid.length > 0 ? { invalid: invalid[0] } : {}),
  };
}
