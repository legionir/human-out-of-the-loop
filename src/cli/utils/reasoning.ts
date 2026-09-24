/**
 * Phase 32 — the model's thinking, streamed to the terminal.
 *
 * When a turn runs with `streamText` (see `AgentRuntime.streamWithThoughts`)
 * the reasoning deltas reach the CLI while the model is still answering.
 * This renderer draws them as one italic, violet block:
 *
 *     💭 The goal asks for a file listing, so I will use…
 *        … the file_management skill and then write the report.
 *
 * Details that matter:
 *   - the text is written **inline** as it arrives (no buffering), which is
 *     what makes it feel live;
 *   - the block is styled `italic` in a colour of its own, so thinking is
 *     never confused with the run's own progress lines;
 *   - the activity spinner is paused while a block is open — the block IS
 *     the progress display — and resumed when it closes;
 *   - a block is capped (`maxChars`) so one very chatty model cannot flood
 *     the terminal, and nothing here is ever persisted: thinking text is
 *     display-only (Law 14 keeps transcripts out of the event stream and
 *     the observability log).
 */
import chalk from 'chalk';
import type { ThoughtChunk } from '../../ai/runtime/thought-stream.js';
import { color } from './output.js';

/** Thinking blocks longer than this are cut off with a marker. */
export const REASONING_MAX_CHARS = 4000;

export interface ReasoningRendererOptions {
  stream?: NodeJS.WriteStream;
  /** The spinner to pause while thinking is on screen. */
  indicator?: { pause(): void; resume(): void };
  /** Prefix written once per block (default: `💭 `). */
  prefix?: string;
  /** Indentation for wrapped lines of a block (default: '   '). */
  indent?: string;
  /** Cap per block in characters (default: `REASONING_MAX_CHARS`). */
  maxChars?: number;
  /** Styling of the text (default: italic violet). */
  style?: (text: string) => string;
}

/** Renderer signature; the returned function is called with each chunk. */
export interface ReasoningRenderer {
  (chunk: ThoughtChunk): void;
  /** Close an open block (end of a run, Ctrl-C, a prompt taking over). */
  close(): void;
}

/**
 * Build the renderer for one run.  It owns a single open block at a time:
 * `start` opens, `delta` streams, `end` closes — and a `delta` without a
 * `start` opens the block implicitly (a provider is free to skip it).
 */
export function createReasoningRenderer(
  options: ReasoningRendererOptions = {},
): ReasoningRenderer {
  const stream = options.stream ?? (process.stdout as NodeJS.WriteStream);
  const indicator = options.indicator;
  const prefix = options.prefix ?? '💭 ';
  const indent = options.indent ?? '   ';
  const maxChars = options.maxChars ?? REASONING_MAX_CHARS;
  const style = options.style ?? color.thinking;

  let open = false;
  let written = 0;
  let truncated = false;

  const openBlock = (): void => {
    if (open) return;
    open = true;
    written = 0;
    truncated = false;
    indicator?.pause();
    stream.write(color.thinking(prefix));
  };

  const closeBlock = (): void => {
    if (!open) return;
    open = false;
    stream.write('\n');
    indicator?.resume();
  };

  const render = (chunk: ThoughtChunk): void => {
    if (chunk.kind === 'end') {
      closeBlock();
      return;
    }
    if (chunk.kind === 'start') {
      openBlock();
      return;
    }
    const text = chunk.text ?? '';
    if (text.length === 0) return;
    openBlock();
    if (truncated) return;
    const room = maxChars - written;
    if (text.length > room) {
      const first = text.slice(0, Math.max(0, room));
      stream.write(style(first));
      stream.write(chalk.dim(' …(thinking truncated)'));
      written = maxChars;
      truncated = true;
      return;
    }
    written += text.length;
    // Keep the indent after every embedded newline of the model's own text.
    stream.write(style(text.replace(/\n/g, `\n${indent}`)));
  };

  const renderer = ((chunk: ThoughtChunk): void => render(chunk)) as ReasoningRenderer;
  renderer.close = closeBlock;
  return renderer;
}

// ─── When is thinking shown? ──────────────────────────────────────

/** `--thinking <mode>`; `auto` means "on when a terminal is watching". */
export type ThinkingMode = 'auto' | 'on' | 'off';

function parseFlag(value: string | undefined): boolean | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolve whether the model's thinking text is shown.
 *
 *   1. `--thinking on|off` wins (a script can force it either way);
 *   2. `HOTL_THINKING` / `HOTL_SHOW_THINKING` (`on`/`off`/`1`/`0`);
 *   3. `auto`: only in a terminal — a pipe or CI log gets the plain run
 *      output, and every existing non-interactive behaviour is unchanged.
 */
export function resolveThinkingMode(
  requested?: ThinkingMode | string,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  const mode = (requested ?? 'auto').trim().toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;

  const fromEnv = parseFlag(env.HOTL_THINKING) ?? parseFlag(env.HOTL_SHOW_THINKING);
  if (fromEnv !== undefined) return fromEnv;

  return stdoutIsTTY;
}
