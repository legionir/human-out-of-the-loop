/**
 * v27.17.3 — the CLI's tool-call log.
 *
 * One line per tool the AI runs, with the four things that answer "what did it
 * actually do?":
 *
 *     🔧 tool: write_file  type: filesystem  input: {"filePath":"notes/a.txt"}  status: ✅ success
 *
 * The records come from the runtime (`tool-call-log.ts`), which means the same
 * data can feed a UI, a web socket or a log file without touching the tool
 * implementations — the CLI is only one renderer for it.
 *
 * Details that matter:
 *   - the input is already redacted (credential-shaped keys, known secret
 *     values) and capped by the runtime; this renderer never widens it;
 *   - a failed call carries the tool's own message and code
 *     (`status: ❌ failed — PATH_TRAVERSAL_BLOCKED: …`), so a refusal is never
 *     just a red cross;
 *   - lines go through `out()`, which erases the activity spinner first, so
 *     the log and the "still working" line cannot collide;
 *   - a `start` record is ignored by default: the line appears when the call
 *     has an answer (a tool that takes a while is covered by the spinner).
 */
import { formatToolInput, type ToolCallRecord } from '../../ai/runtime/tool-call-log.js';
import { color, out } from './output.js';

export interface ToolLogRendererOptions {
  /** Show a line when a call starts as well (default: false). */
  onStart?: boolean;
  /** Set false to make the renderer a no-op (the `off` mode). */
  enabled?: boolean;
}

/** Renders one record; safe to call for every record the runtime emits. */
export type ToolLogRenderer = (record: ToolCallRecord) => void;

/**
 * `✅ success` / `❌ failed` / `⏳ running`, with the failure's own words.
 *
 * A tool that follows the project's contract reports its code *next to* the
 * message (`{ success: false, error, code }`), so the code is shown; a thrown
 * error already begins with its code (`ENOENT: no such file …`), so it is not
 * printed twice.
 */
export function formatToolStatus(record: ToolCallRecord): string {
  if (record.status === 'running') return `${color.running('⏳ running')}`;
  if (record.status === 'success') return `${color.done('✅ success')}`;
  const error = record.error ?? '';
  const code = record.code ?? '';
  const detail =
    error === ''
      ? code
      : code !== '' && !error.toLowerCase().startsWith(`${code.toLowerCase()}:`)
        ? `${code}: ${error}`
        : error;
  return `${color.failed('❌ failed')}${detail === '' ? '' : ` — ${detail}`}`;
}

/**
 * The line itself: name, type, input, status — in that order, so a grep for
 * `tool:` finds every call and a grep for `status: ❌` finds every failure.
 *
 * The input is rendered through the runtime's own formatter (same cap, same
 * redaction), so what a log shows can never be wider than what the runtime
 * decided to hand out.
 */
export function formatToolCallLine(
  record: ToolCallRecord,
  options: { maxInputChars?: number } = {}
): string {
  const type = record.toolType ? `  ${color.dim(`type: ${record.toolType}`)}` : '';
  const shown = formatToolInput(record.input, options);
  const input = shown === '' ? '' : `  ${color.dim(`input: ${shown}`)}`;
  return (
    `${color.info('🔧')} ${color.dim('tool:')} ${color.bold(record.toolName)}${type}` +
    `${input}  ${color.dim('status:')} ${formatToolStatus(record)}`
  );
}

/** Build the renderer for one run. */
export function createToolLogRenderer(options: ToolLogRendererOptions = {}): ToolLogRenderer {
  const enabled = options.enabled ?? true;
  const showStart = options.onStart ?? false;

  return (record: ToolCallRecord): void => {
    if (!enabled) return;
    if (record.phase === 'start' && !showStart) return;
    out(formatToolCallLine(record));
  };
}

/**
 * `--tool-log on|off`, else `HOTL_TOOL_LOG`, else on.
 *
 * `auto` — and an absent flag, which is the same thing — defers to the
 * environment, so `HOTL_TOOL_LOG=0` keeps a scripted run quiet without a flag
 * on every invocation.
 */
export function resolveToolLogEnabled(
  flag: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = typeof flag === 'string' ? flag.trim().toLowerCase() : flag;
  if (value === 'on' || value === true) return true;
  if (value === 'off' || value === false) return false;
  const raw = (env.HOTL_TOOL_LOG ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}
