/**
 * Phase 32 — "the system is working" feedback.
 *
 * A model call can take a long time (a slow gateway, a reasoning model, a
 * rate-limited provider).  Until now the CLI printed nothing at all while
 * it waited: the user could not tell a working run from a hung one — the
 * exact confusion that produced this feature request.
 *
 * `ActivityIndicator` draws one self-overwriting line with a rotating
 * message while no result is available yet:
 *
 *     ⠹ Thinking deeply…
 *
 * The message changes every 3 seconds, picked at random from
 * `PROCESSING_MESSAGES` (never the same one twice in a row).  Every other
 * CLI line goes through `out()`, which erases the indicator first, so the
 * spinner never eats real output.
 *
 * It is deliberately quiet where it makes no sense: without a TTY (pipes,
 * CI, test capture) nothing is written at all, and `HOTL_NO_ACTIVITY=1`
 * turns it off in a terminal too.
 */
import chalk from 'chalk';

/**
 * The messages the indicator cycles through, in the order the request
 * listed them.  Chosen at random, one every rotation interval.
 */
export const PROCESSING_MESSAGES: readonly string[] = [
  'dreaming...',
  'Crunching the numbers...',
  'Analyzing the data...',
  'Generating insights...',
  'Processing your request...',
  'Thinking deeply...',
  'Working on it...',
  'Hold tight, almost there...',
  'Just a moment, please...',
  'Loading the magic...',
  'Preparing the response...',
  "Hang tight, we're on it...",
];

/** Default rotation: the user asked for one message every 3 seconds. */
export const ACTIVITY_INTERVAL_MS = 3000;

/** Spinner frames (braille, so they look the same in every terminal). */
export const ACTIVITY_FRAMES: readonly string[] = [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
];

export interface ActivityIndicatorOptions {
  /** Where the line is drawn (default: `process.stdout`). */
  stream?: NodeJS.WriteStream;
  /** Message rotation interval in ms (default: 3000). */
  intervalMs?: number;
  /** Spinner frame interval in ms (default: 120). */
  frameMs?: number;
  /** Frames to cycle (default: `ACTIVITY_FRAMES`). */
  frames?: readonly string[];
  /** Messages to cycle (default: `PROCESSING_MESSAGES`). */
  messages?: readonly string[];
  /** Random source, injectable for deterministic tests (default: `Math.random`). */
  random?: () => number;
  /** Force the indicator on/off (default: only when the stream is a TTY). */
  enabled?: boolean;
  /** Styling of the message (default: dim). */
  style?: (text: string) => string;
}

/** Truthy CLI/env flag (`1`, `true`, `yes`, `on`). */
function isOn(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Should the spinner be drawn at all?  Only in a terminal — a pipe, a CI
 * log or a test's captured stdout must stay byte-for-byte what it was —
 * unless `HOTL_NO_ACTIVITY=1` (or `HOTL_ACTIVITY=off`) says otherwise.
 */
export function resolveActivityEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (isOn(env.HOTL_NO_ACTIVITY) || env.HOTL_ACTIVITY?.trim().toLowerCase() === 'off') return false;
  return stdoutIsTTY;
}

/** Rotation interval: the requested 3 s, overridable with `HOTL_ACTIVITY_INTERVAL_MS`. */
export function resolveActivityIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HOTL_ACTIVITY_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : ACTIVITY_INTERVAL_MS;
}

// ─── Module-level registry ────────────────────────────────────────

/**
 * The indicator currently owning the cursor line.  `out()` erases it
 * before printing, so a spinner never corrupts a real line of output.
 * One at a time: only one terminal line can be rewritten.
 */
let active: ActivityIndicator | null = null;

/** Erase the active indicator's line (called by `out()` before writing). */
export function clearActiveActivityLine(): void {
  active?.clearLine();
}

/** Stop and forget the active indicator (used when a prompt takes over). */
export function stopActiveActivity(): void {
  active?.stop();
}

// ─── ActivityIndicator ────────────────────────────────────────────

export class ActivityIndicator {
  private readonly stream: NodeJS.WriteStream;
  private readonly intervalMs: number;
  private readonly frameMs: number;
  private readonly frames: readonly string[];
  private readonly messages: readonly string[];
  private readonly random: () => number;
  private readonly enabled: boolean;
  private readonly style: (text: string) => string;

  private messageTimer?: ReturnType<typeof setInterval>;
  private frameTimer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private message = '';
  private running = false;
  /** True while the line currently on screen belongs to the indicator. */
  private drawn = false;

  constructor(options: ActivityIndicatorOptions = {}) {
    this.stream = options.stream ?? (process.stdout as NodeJS.WriteStream);
    this.intervalMs = options.intervalMs ?? ACTIVITY_INTERVAL_MS;
    this.frameMs = options.frameMs ?? 120;
    this.frames = options.frames && options.frames.length > 0 ? options.frames : ACTIVITY_FRAMES;
    this.messages = options.messages && options.messages.length > 0 ? options.messages : PROCESSING_MESSAGES;
    this.random = options.random ?? Math.random;
    this.enabled = options.enabled ?? Boolean(this.stream.isTTY);
    this.style = options.style ?? ((text) => chalk.dim(text));
  }

  /** Whether the indicator currently owns a line. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Start drawing: immediately with a first message, then rotating. */
  start(): this {
    if (this.running || !this.enabled) return this;
    this.running = true;
    // Only one indicator can own the cursor line.
    if (active && active !== this) active.stop();
    active = this;
    this.message = this.pickMessage();
    this.frame = 0;
    this.draw();
    this.frameTimer = this.every(this.frameMs, () => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.draw();
    });
    this.messageTimer = this.every(this.intervalMs, () => {
      this.message = this.pickMessage();
      this.draw();
    });
    return this;
  }

  /** Stop drawing and leave the line clean. */
  stop(): void {
    this.running = false;
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.messageTimer) clearInterval(this.messageTimer);
    this.frameTimer = undefined;
    this.messageTimer = undefined;
    this.clearLine();
    if (active === this) active = null;
  }

  /**
   * Hide the line without giving up the indicator (a prompt, a streamed
   * thinking block).  `resume()` brings it back.
   */
  pause(): void {
    if (!this.running) return;
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.messageTimer) clearInterval(this.messageTimer);
    this.frameTimer = undefined;
    this.messageTimer = undefined;
    this.clearLine();
    if (active === this) active = null;
  }

  /** Bring a paused indicator back. */
  resume(): void {
    if (!this.running || !this.enabled) return;
    if (this.frameTimer) return; // already drawing
    if (active && active !== this) active.stop();
    active = this;
    this.draw();
    this.frameTimer = this.every(this.frameMs, () => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.draw();
    });
    this.messageTimer = this.every(this.intervalMs, () => {
      this.message = this.pickMessage();
      this.draw();
    });
  }

  /** Erase the indicator's line only if it is the one on screen. */
  clearLine(): void {
    if (!this.drawn) return;
    this.drawn = false;
    this.stream.write('\r\x1b[2K');
  }

  /** The message currently shown (tests, status lines). */
  get currentMessage(): string {
    return this.message;
  }

  // ── internals ────────────────────────────────────────────────

  /** A message that is not the one already on screen. */
  private pickMessage(): string {
    const index = Math.min(
      this.messages.length - 1,
      Math.max(0, Math.floor(this.random() * this.messages.length)),
    );
    const picked = this.messages[index]!;
    if (picked !== this.message) return picked;
    // Same pick twice in a row looks frozen: take the next one.
    return this.messages[(index + 1) % this.messages.length]!;
  }

  private draw(): void {
    if (!this.enabled) return;
    const spinner = chalk.cyan(this.frames[this.frame] ?? this.frames[0]!);
    this.stream.write(`\r\x1b[2K${spinner} ${this.style(this.message)}`);
    this.drawn = true;
  }

  /** `setInterval` that never keeps the process alive on its own. */
  private every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const timer = setInterval(fn, Math.max(20, ms));
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }
}
