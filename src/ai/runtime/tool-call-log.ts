/**
 * v27.17.3 — one structured record per tool call: **type, name, input, status**.
 *
 * The runtime already has three views of a tool call, and none of them is the
 * one a human (or a UI) actually wants:
 *
 * | | what it carries | why it is not enough |
 * |---|---|---|
 * | `agent:tool_call` event | the tool NAME only | Law 14 keeps transcripts out of the event stream (and the bus has no room for arguments) |
 * | `journal/YYYY-MM-DD.jsonl` | everything, redacted, on disk | it is a file, not a signal — nothing live reads it |
 * | `agent:tool_error` event | name + one-line error | only the failures, only after the fact |
 *
 * This module is the missing one: a *sink* (the same seam as `onThought` and
 * `LlmUsageReporter`) that every tool execution reports through with exactly
 * the fields a log line needs —
 *
 *     type    the tool's category ("filesystem", "git", "memory", "mcp", …)
 *     name    the tool's id ("write_file")
 *     input   the arguments the model passed (redacted, size-capped)
 *     status  running → success | failure
 *
 * The runtime knows NOTHING about registries: the category is resolved through
 * an injected resolver (`toolType`), the input through the shared redactor.
 * Two phases are reported per call (`start`, then `end`) so a consumer can
 * print a line per call (the CLI) *and* show a call in flight (a UI), from the
 * same records.
 *
 * Guarantees (the same ones the other sinks make):
 *   - a sink that throws never breaks the tool call or the run;
 *   - without a sink the tool set is returned untouched (identity preserved —
 *     tests and callers can compare objects);
 *   - the CLI path is display-only: nothing here is persisted, and the input
 *     shown has credentials scrubbed by key name *and* by known value.
 */
import { DEFAULT_REDACT_KEYS, outcomeStatus } from './journal.js';
import { scrubSecretValues } from './secret-scrub.js';

// ─── Types ────────────────────────────────────────────────────────

/** `start` when the tool is about to run, `end` when it returned or threw. */
export type ToolCallPhase = 'start' | 'end';

/** `running` is the status of a `start` record. */
export type ToolCallStatus = 'running' | 'success' | 'failure';

/** One record; a `start` and its `end` share `callId` (when the SDK gives one). */
export interface ToolCallRecord {
  phase: ToolCallPhase;
  status: ToolCallStatus;
  /** Registry category — `inferToolType` is the fallback. */
  toolType: string;
  /** Tool id, exactly as the model called it. */
  toolName: string;
  /** Arguments, redacted and capped (see `redactToolInput`). */
  input?: unknown;
  /** SDK call id, so the two phases (and the journal) can be correlated. */
  callId?: string;
  taskId?: string;
  agentId?: string;
  planId?: string;
  planStepId?: string;
  /** `end` records only. */
  durationMs?: number;
  /** `end` records whose status is `failure`. */
  error?: string;
  /** Tool's own error code (`PATH_TRAVERSAL_BLOCKED`, …), when it has one. */
  code?: string;
}

/** Consumer of tool-call records: the CLI's line renderer, a UI's event feed. */
export type ToolCallSink = (record: ToolCallRecord) => void;

/** Resolves a tool id to its category, live (a registry may grow). */
export type ToolTypeResolver = (toolName: string) => string | undefined;

export interface ToolCallLogOptions {
  /** Authoritative category lookup (the ToolRegistry) — wins over inference. */
  toolType?: ToolTypeResolver;
  /** Static id → category map, for callers without a registry. */
  toolTypes?: Readonly<Record<string, string>>;
  /** Literal credential values scrubbed out of the displayed input. */
  secrets?: readonly string[];
  /** Cap on the rendered input (JSON) — default `DEFAULT_TOOL_INPUT_MAX_CHARS`. */
  maxInputChars?: number;
}

/** Call-site context, attached to both records of a call. */
export interface ToolCallContext {
  taskId?: string;
  agentId?: string;
  planId?: string;
  planStepId?: string;
}

export const DEFAULT_TOOL_INPUT_MAX_CHARS = 400;
/** Used when neither a resolver nor inference knows better. */
export const UNKNOWN_TOOL_TYPE = 'other';

// ─── Emitting ─────────────────────────────────────────────────────

/**
 * Forward one record.  Never throws: a broken sink (a closed terminal, a
 * failing UI socket) must not fail the tool call it is describing.
 */
export function emitToolCall(sink: ToolCallSink | undefined, record: ToolCallRecord): void {
  if (!sink) return;
  try {
    sink(record);
  } catch {
    // User-facing output must never break a run.
  }
}

// ─── The tool's category ──────────────────────────────────────────

/**
 * Best-effort category from the tool's name, for callers that have no
 * registry to ask (a bare `AgentRuntime`, a third-party embedder).  The
 * orchestrator always resolves through the ToolRegistry instead, which is
 * authoritative — including for MCP tools, whose ids are server-defined.
 */
const TOOL_TYPE_BY_NAME: Readonly<Record<string, string>> = {
  // memory (the reference knowledge-graph server's ids)
  create_entities: 'memory',
  delete_entities: 'memory',
  create_relations: 'memory',
  delete_relations: 'memory',
  add_observations: 'memory',
  delete_observations: 'memory',
  read_graph: 'memory',
  search_nodes: 'memory',
  open_nodes: 'memory',
  // time and reasoning
  get_current_time: 'time',
  convert_time: 'time',
  sequentialthinking: 'reasoning',
  // filesystem (names that carry no usable prefix)
  directory_tree: 'filesystem',
  get_file_info: 'filesystem',
  read_multiple_files: 'filesystem',
  read_media_file: 'filesystem',
  list_allowed_directories: 'filesystem',
  search_files: 'filesystem',
  search_code: 'filesystem',
  list_directory: 'filesystem',
  list_directory_with_sizes: 'filesystem',
  list_files: 'filesystem',
  // control / catalog / web
  fetch: 'web',
  delegate_task: 'control',
  list_tools: 'catalog',
  list_personas: 'catalog',
  list_skills: 'catalog',
};

const TOOL_TYPE_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['git_', 'git'],
  ['read_', 'filesystem'],
  ['write_', 'filesystem'],
  ['edit_', 'filesystem'],
  ['move_', 'filesystem'],
  ['create_', 'filesystem'],
  ['delete_', 'filesystem'],
  ['list_', 'filesystem'],
  ['search_', 'filesystem'],
];

/** Category from the tool's own name — see `TOOL_TYPE_BY_NAME`. */
export function inferToolType(toolName: string): string {
  const exact = TOOL_TYPE_BY_NAME[toolName];
  if (exact) return exact;
  for (const [prefix, type] of TOOL_TYPE_BY_PREFIX) {
    if (toolName.startsWith(prefix)) return type;
  }
  return UNKNOWN_TOOL_TYPE;
}

/** The category of one call: resolver → static map → name inference. */
export function resolveToolType(
  toolName: string,
  options: Pick<ToolCallLogOptions, 'toolType' | 'toolTypes'> = {}
): string {
  const resolved = options.toolType?.(toolName) ?? options.toolTypes?.[toolName];
  return resolved && resolved.length > 0 ? resolved : inferToolType(toolName);
}

// ─── The input ────────────────────────────────────────────────────

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const REDACTED_KEYS = new Set(DEFAULT_REDACT_KEYS.map(normalizeKey));

/**
 * The arguments as they may be shown: credential-shaped keys are replaced
 * with a marker (by name, like the journal does), the literal values of the
 * credentials this process holds are scrubbed out of every string, and the
 * whole value is a plain JSON-safe structure a UI can render.
 */
export function redactToolInput(input: unknown, secrets: readonly string[] = []): unknown {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 12) return '[depth limit]';
    if (typeof value === 'string') return scrubSecretValues(value, secrets);
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = REDACTED_KEYS.has(normalizeKey(key)) ? '***REDACTED***' : walk(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  return walk(input, 0);
}

/**
 * One line of input for a log: redacted, JSON, capped.  `undefined` when the
 * tool takes no arguments (an empty string would print `input:` and nothing).
 */
export function formatToolInput(
  input: unknown,
  options: Pick<ToolCallLogOptions, 'secrets' | 'maxInputChars'> = {}
): string {
  if (input === undefined || input === null) return '';
  const redacted = redactToolInput(input, options.secrets ?? []);
  let text: string;
  try {
    text = JSON.stringify(redacted) ?? '';
  } catch {
    text = String(redacted);
  }
  if (text === '{}' || text === '') return '';
  const max = options.maxInputChars ?? DEFAULT_TOOL_INPUT_MAX_CHARS;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ─── The hook ─────────────────────────────────────────────────────

/**
 * Wrap a tool set so every execution reports a `start` and an `end` record.
 *
 * The same shape as `withJournal` — deliberately, because both are applied to
 * the ONE tool set the runtime hands to the model, so this module needs no
 * change when a tool is added, and the streaming (`streamText`) branch is
 * covered by exactly the same wiring.
 *
 * A failing tool is reported as `status: 'failure'` with the message and code
 * of the project's failure contract (`{ success: false, error, code }`, an SDK
 * error output, an MCP `isError` result) — the three ways a tool can refuse —
 * and a thrown error is reported the same way before it is re-thrown.
 */
export function withToolCallLog<T extends Record<string, unknown>>(
  tools: T,
  context: ToolCallContext,
  sink?: ToolCallSink,
  options: ToolCallLogOptions = {}
): T {
  if (!sink) return tools;

  const secrets = options.secrets ?? [];
  const wrapped: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(tools)) {
    const tool = value as {
      execute?: (input: unknown, callOptions?: { toolCallId?: string }) => Promise<unknown>;
    };
    if (typeof tool.execute !== 'function') {
      wrapped[name] = value;
      continue;
    }

    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, callOptions?: { toolCallId?: string }) => {
        const startedAt = Date.now();
        const toolType = resolveToolType(name, options);
        const shownInput = redactToolInput(input, secrets);
        const base = {
          toolName: name,
          toolType,
          ...(callOptions?.toolCallId ? { callId: callOptions.toolCallId } : {}),
          ...context,
          ...(input === undefined ? {} : { input: shownInput }),
        };

        emitToolCall(sink, { ...base, phase: 'start', status: 'running' });

        try {
          const output = await originalExecute(input, callOptions);
          const outcome = outcomeStatus(output);
          emitToolCall(sink, {
            ...base,
            phase: 'end',
            status: outcome.ok ? 'success' : 'failure',
            durationMs: Date.now() - startedAt,
            ...(outcome.ok
              ? {}
              : { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) }),
          });
          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = (error as NodeJS.ErrnoException)?.code;
          emitToolCall(sink, {
            ...base,
            phase: 'end',
            status: 'failure',
            durationMs: Date.now() - startedAt,
            error: message,
            ...(typeof code === 'string' ? { code } : {}),
          });
          throw error;
        }
      },
    };
  }

  return wrapped as T;
}
