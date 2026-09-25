/**
 * How a request is handled: as a plan, as a conversation, or by asking.
 *
 *   auto   the planner decides (default): a question or greeting is answered,
 *          real work becomes a plan, an ambiguous request asks first;
 *   chat   never plan — answer, even if the request sounds like work;
 *   plan   always plan — never answer, even for a greeting.
 *
 * The user picks it with `--mode <auto|chat|plan>`, with a prefix inside the
 * request itself (`@chat …`, `@plan …`), with the `HOTL_MODE` env var, or with
 * `defaultMode` in `~/.human-out-of-the-loop/config.json`.
 */
import { z } from 'zod';

export const RUN_MODES = ['auto', 'chat', 'plan'] as const satisfies readonly string[];

export type RunMode = (typeof RUN_MODES)[number];

export const DEFAULT_RUN_MODE: RunMode = 'auto';

export const RunModeSchema = z.enum(['auto', 'chat', 'plan']);

/** Case-insensitive, tolerant of `@CHAT` / ` chat `.  `undefined` when invalid. */
export function parseRunMode(value: unknown): RunMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (RUN_MODES as readonly string[]).includes(normalized)
    ? (normalized as RunMode)
    : undefined;
}

/**
 * The prefix a user can type in front of a request: `@chat سلام`, `@plan …`.
 *
 * `looksLikeModePrefix` is what the CLI uses to distinguish "the user chose a
 * mode" from "the request starts with an @mention" (`@aur/auto …`): only the
 * three mode words followed by whitespace (or the end of the line) count.
 */
export function looksLikeModePrefix(word: string): RunMode | undefined {
  if (!word.startsWith('@')) return undefined;
  return parseRunMode(word.slice(1));
}
