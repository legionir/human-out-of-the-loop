import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Phase 37 — the Journal: what the AI *did*, kept automatically.
 *
 * The observability log and the Journal answer different questions, and the
 * project needs both:
 *
 * | | `observability.jsonl` | `journal/YYYY-MM-DD.jsonl` |
 * |---|---|---|
 * | question | what happened to the *run* | what did the AI *do* |
 * | tool arguments | never recorded | recorded (redacted, size-capped) |
 * | tool results | never recorded | summary, or full on request |
 * | written by | events, step lifecycle, errors | every tool execution + plan/step transitions |
 *
 * The hook is the one place every tool call passes through — `AgentRuntime`
 * hands its tool set to `generateText`/`streamText` (see `withJournal` below) —
 * so a new tool is journalled without touching its implementation, and the
 * `streamText` branch (phase 32, live thinking) is covered by the same wiring
 * as `generateText` rather than by a second code path.
 *
 * Guarantees:
 *   - **append-only JSONL**, one line per action, `fsync`-free but written with a
 *     reused descriptor (the phase-21 pattern) so a crash right after the line
 *     still finds it on disk;
 *   - **redaction**: keys that look like credentials and the *values* of the
 *     credentials this process knows (`secret-scrub`) are replaced before the
 *     line is serialised — a journal is worthless if reading it leaks a token;
 *   - **size cap** (`maxEntryBytes`, default 8 KB): an oversized entry keeps its
 *     metadata and a truncated preview instead of flooding the file;
 *   - **rotation by day** + `retentionDays` pruning, so the directory cannot
 *     grow forever;
 *   - **never fatal**: a journal write that fails (read-only disk, deleted
 *     directory) must not break the run that is being observed.
 */
import {
  MIN_REDACT_VALUE_LENGTH,
  SECRET_REDACTION_MARKER,
  scrubSecretValues,
} from './secret-scrub.js';

/** Marker written where a redacted key's value would be. */
export const JOURNAL_REDACTED = SECRET_REDACTION_MARKER;

/** Key names are compared with separators and case removed: `api_key` == `apiKey`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scrubValue(value: string, secrets: readonly string[]): string {
  return scrubSecretValues(value, secrets);
}

export type JournalKind = 'tool' | 'plan' | 'step' | 'agent';

/** One file the action touched, with what we can prove about it. */
export interface JournalArtifact {
  path: string;
  bytes?: number;
  /** sha256 of the content the tool was asked to write (small content only). */
  sha256?: string;
}

export interface JournalEntry {
  /** ISO timestamp. */
  ts: string;
  kind: JournalKind;
  /** Tool name for `kind: 'tool'`. */
  tool?: string;
  callId?: string;
  taskId?: string;
  agentId?: string;
  planId?: string;
  planStepId?: string;
  durationMs?: number;
  ok?: boolean;
  /** What the tool was asked to do (redacted, capped). */
  input?: unknown;
  /** What it returned — only when `includeResults` says so. */
  result?: unknown;
  /** One human line: "wrote 240 bytes to src/x.ts". */
  summary?: string;
  artifacts?: JournalArtifact[];
  error?: string;
  code?: string;
  /** Present when the entry was shrunk to fit `maxEntryBytes`. */
  truncated?: boolean;
}

export type JournalIncludeResults = 'none' | 'summary' | 'full';

export interface JournalOptions {
  /** `<project>/.ai-runtime` — the journal lives in `journal/` below it. */
  runtimeDir: string;
  enabled?: boolean;
  includeResults?: JournalIncludeResults;
  maxEntryBytes?: number;
  /** Days to keep; 0 disables pruning. */
  retentionDays?: number;
  redactKeys?: string[];
  redactValues?: string[];
  /** Injectable clock (tests). */
  now?: () => Date;
}

export const DEFAULT_JOURNAL_MAX_ENTRY_BYTES = 8 * 1024;
export const DEFAULT_JOURNAL_RETENTION_DAYS = 30;
const PREVIEW_CHARS = 2000;
const MAX_HASH_BYTES = 256 * 1024;

/** Key names whose VALUE is never written to a journal entry or shown in a tool log. */
export const DEFAULT_REDACT_KEYS = [
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'private_key',
];

/** `2026-09-25` — the rotation unit of the journal. */
export function journalDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `<runtimeDir>/journal` — the directory every entry of one project lands in. */
export function journalDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'journal');
}

export function journalFileFor(runtimeDir: string, date: Date): string {
  return path.join(journalDir(runtimeDir), `${journalDay(date)}.jsonl`);
}

/**
 * The journal settings an env var can override, so a one-off
 * `HOTL_JOURNAL=0 npm run …` disables it without touching config.
 */
export function journalOptionsFromEnv(env: NodeJS.ProcessEnv): Partial<JournalOptions> {
  const out: Partial<JournalOptions> = {};
  const enabled = env.HOTL_JOURNAL;
  if (enabled !== undefined && enabled !== '') {
    out.enabled = !/^(0|false|off|no)$/i.test(enabled.trim());
  }
  const results = env.HOTL_JOURNAL_RESULTS;
  if (results === 'none' || results === 'summary' || results === 'full') {
    out.includeResults = results;
  }
  return out;
}

function normalizeKeys(keys: readonly string[]): Set<string> {
  return new Set(keys.map(normalizeKey));
}

function isRedactedKey(key: string, keys: Set<string>): boolean {
  const normalized = normalizeKey(key);
  for (const pattern of keys) {
    if (normalized.includes(pattern)) return true;
  }
  return false;
}

/** Deep-copy `value`, redacting by key name and by known secret value. */
function redact(value: unknown, keys: Set<string>, secrets: string[], depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return scrubValue(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, keys, secrets, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedKey(key, keys)
        ? JOURNAL_REDACTED
        : redact(item, keys, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

function byteLength(value: unknown): number | undefined {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
  return undefined;
}

/**
 * What the entry's tool did to the filesystem, as far as the result and the
 * input say.  Written files get a sha256 of the content the model asked for
 * (small content only), which is what makes a journal auditable later: the
 * line proves *what* was written, not merely that something was.
 */
export function artifactsOf(input: unknown, output: unknown): JournalArtifact[] | undefined {
  const artifacts: JournalArtifact[] = [];
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

  const withHash = (artifact: JournalArtifact, content: unknown): JournalArtifact => {
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf-8') <= MAX_HASH_BYTES) {
      return {
        ...artifact,
        sha256: createHash('sha256').update(content, 'utf-8').digest('hex'),
      };
    }
    return artifact;
  };

  const inRecord = asRecord(input);
  const outRecord = asRecord(output);

  const singlePath =
    (typeof outRecord?.path === 'string' && outRecord.path) ||
    (typeof outRecord?.filePath === 'string' && outRecord.filePath) ||
    (typeof inRecord?.path === 'string' && inRecord.path) ||
    (typeof inRecord?.filePath === 'string' && inRecord.filePath) ||
    undefined;
  if (singlePath) {
    artifacts.push(
      withHash(
        {
          path: singlePath,
          bytes:
            typeof outRecord?.bytes === 'number' ? outRecord.bytes : byteLength(inRecord?.content),
        },
        inRecord?.content
      )
    );
  }

  // write_multiple_files: one artifact per filed entry of the batch.
  const files = Array.isArray(outRecord?.files)
    ? (outRecord?.files as unknown[])
    : Array.isArray(inRecord?.files)
      ? (inRecord?.files as unknown[])
      : undefined;
  if (files) {
    const inputs = Array.isArray(inRecord?.files) ? (inRecord?.files as unknown[]) : [];
    for (const [index, raw] of files.entries()) {
      const file = asRecord(raw);
      const p = typeof file?.path === 'string' ? file.path : undefined;
      if (!p) continue;
      const content = asRecord(inputs[index])?.content;
      artifacts.push(
        withHash(
          {
            path: p,
            bytes: typeof file?.bytes === 'number' ? file.bytes : byteLength(content),
          },
          content
        )
      );
    }
  }

  return artifacts.length > 0 ? artifacts : undefined;
}

/**
 * The project's tool-result contract, read the same way for the journal as the
 * runtime reads it for `agent:tool_error`:
 * `{ success: false }`, an SDK error output, or an MCP `isError: true` result.
 */
export function outcomeStatus(output: unknown): { ok: boolean; error?: string; code?: string } {
  if (output && typeof output === 'object') {
    const out = output as Record<string, unknown>;
    if (out.type === 'error-text' || out.type === 'error-json') {
      return { ok: false, error: typeof out.value === 'string' ? out.value : 'tool error' };
    }
    if (out.success === false) {
      return {
        ok: false,
        error: typeof out.error === 'string' ? out.error : 'tool reported failure',
        ...(typeof out.code === 'string' ? { code: out.code } : {}),
      };
    }
    if (out.isError === true) {
      return { ok: false, error: 'MCP tool reported an error' };
    }
  }
  return { ok: true };
}

/** One line, human-readable, without dumping the payload into it. */
function summarize(tool: string, input: unknown, output: unknown, ok: boolean): string {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const inRecord = record(input);
  const outRecord = record(output);
  const target =
    (typeof inRecord?.filePath === 'string' && inRecord.filePath) ||
    (typeof inRecord?.path === 'string' && inRecord.path) ||
    (typeof inRecord?.directory === 'string' && inRecord.directory) ||
    (typeof inRecord?.pattern === 'string' && `pattern ${inRecord.pattern}`) ||
    '';

  if (!ok) {
    const error = typeof outRecord?.error === 'string' ? outRecord.error : 'failed';
    return `${tool} failed${target ? ` on ${target}` : ''}: ${error}`.slice(0, 300);
  }

  const details: string[] = [];
  if (typeof outRecord?.bytesWritten === 'number') details.push(`${outRecord.bytesWritten} bytes`);
  else if (typeof outRecord?.bytes === 'number') details.push(`${outRecord.bytes} bytes`);
  else if (typeof outRecord?.totalMatches === 'number')
    details.push(`${outRecord.totalMatches} matches`);
  else if (typeof outRecord?.count === 'number') details.push(`${outRecord.count} entries`);
  return `${tool}${target ? ` → ${target}` : ''}${details.length ? ` (${details.join(', ')})` : ''}`.slice(
    0,
    300
  );
}

export interface JournalContext {
  taskId?: string;
  agentId?: string;
  planId?: string;
  planStepId?: string;
}

/**
 * Append-only writer for one project's journal.
 *
 * The descriptor is opened once and reused (one `write` syscall per entry);
 * if the file disappears under a running process (`rm -rf .ai-runtime` — the
 * phase-21 lesson) the next write reopens it.  A day boundary reopens as the
 * next file, so `journal/` rotates without a daemon.
 */
export class JournalWriter {
  readonly enabled: boolean;
  readonly includeResults: JournalIncludeResults;
  readonly directory: string;
  private readonly maxEntryBytes: number;
  private readonly retentionDays: number;
  private readonly redactKeys: Set<string>;
  private readonly redactValues: string[];
  private readonly now: () => Date;

  private fd: number | null = null;
  private openPath: string | null = null;
  private openIno: number | null = null;
  /** Set when a write failed — the run continues, the failure is reported once. */
  private failureReported = false;

  constructor(options: JournalOptions) {
    this.enabled = options.enabled ?? true;
    this.includeResults = options.includeResults ?? 'summary';
    this.directory = journalDir(options.runtimeDir);
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_JOURNAL_MAX_ENTRY_BYTES;
    this.retentionDays = options.retentionDays ?? DEFAULT_JOURNAL_RETENTION_DAYS;
    this.redactKeys = normalizeKeys(
      options.redactKeys && options.redactKeys.length > 0 ? options.redactKeys : DEFAULT_REDACT_KEYS
    );
    this.redactValues = (options.redactValues ?? [])
      .filter((value) => typeof value === 'string' && value.length >= MIN_REDACT_VALUE_LENGTH)
      .sort((a, b) => b.length - a.length);
    this.now = options.now ?? (() => new Date());
  }

  /** The file the (current or next) entry goes to. */
  get currentPath(): string {
    return journalFileFor(path.dirname(this.directory), this.now());
  }

  /** Write one entry.  Never throws. */
  log(entry: JournalEntry): void {
    if (!this.enabled) return;
    try {
      this.write(this.encode(entry), this.fdFor(this.now()));
    } catch {
      this.reportFailure();
    }
  }

  /** Remove journal files older than `retentionDays`.  Never throws. */
  prune(): number {
    if (!this.enabled || this.retentionDays <= 0) return 0;
    try {
      if (!fs.existsSync(this.directory)) return 0;
      const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const file of fs.readdirSync(this.directory)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!match) continue;
        const day = new Date(`${match[1]}T00:00:00.000Z`).getTime();
        if (Number.isNaN(day) || day >= cutoff) continue;
        fs.rmSync(path.join(this.directory, file), { force: true });
        removed++;
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /** True while a descriptor is held. */
  get isOpen(): boolean {
    return this.fd !== null;
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already gone */
    }
    this.fd = null;
    this.openPath = null;
    this.openIno = null;
  }

  // ── Private ────────────────────────────────────────────────────

  /** Redact once, stringify once (F-08). Oversized entries stringify a trimmed copy. */
  private encode(entry: JournalEntry): string {
    const redacted: JournalEntry = {
      ...entry,
      ...(entry.input !== undefined
        ? { input: redact(entry.input, this.redactKeys, this.redactValues) }
        : {}),
      ...(entry.result !== undefined
        ? { result: redact(entry.result, this.redactKeys, this.redactValues) }
        : {}),
    };

    if (this.includeResults !== 'full' && redacted.result !== undefined) {
      delete redacted.result;
    }

    const encoded = JSON.stringify(redacted);
    if (encoded.length <= this.maxEntryBytes) return `${encoded}\n`;

    const preview = (value: unknown): string => {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
    };
    const trimmed: JournalEntry = {
      ...redacted,
      truncated: true,
      ...(redacted.input !== undefined ? { input: { preview: preview(redacted.input) } } : {}),
      ...(redacted.result !== undefined && this.includeResults === 'full'
        ? { result: { preview: preview(redacted.result) } }
        : {}),
    };
    if (this.includeResults === 'summary') delete trimmed.result;
    return `${JSON.stringify(trimmed)}\n`;
  }

  /** Open (or reopen) the file for `date`, rotating on a day change. */
  private fdFor(date: Date): number {
    const target = journalFileFor(path.dirname(this.directory), date);
    if (this.fd !== null && this.openPath === target) {
      // Detect a deleted/replaced file (inode changed or gone).
      try {
        const stats = fs.statSync(target);
        if (this.openIno === stats.ino) return this.fd;
      } catch {
        /* gone — fall through and reopen */
      }
      this.close();
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'a');
    const stats = fs.fstatSync(fd);
    this.fd = fd;
    this.openPath = target;
    this.openIno = stats.ino;
    return fd;
  }

  private write(line: string, fd: number): void {
    try {
      fs.writeSync(fd, line);
    } catch {
      // The descriptor may point at a deleted file: reopen once, then report.
      this.close();
      fs.writeSync(this.fdFor(this.now()), line);
    }
  }

  private reportFailure(): void {
    if (this.failureReported) return;
    this.failureReported = true;
    // The journal must never be the reason a run fails; a stderr note is the
    // most we do (the CLI shows it, tests can assert on it).
    process.emitWarning(`[journal] could not write to ${this.directory} — continuing without it`);
  }
}

/**
 * Wrap every tool in `tools` so its execution is journalled.
 *
 * This is the phase-37 hook the user asked for: it sits exactly where the
 * runtime hands tools to `generateText`/`streamText`, so local tools, MCP tools
 * and future tools are all covered without a single change in their
 * implementations.
 *
 * The wrapper is transparent: the return value and any thrown error pass
 * through untouched, so the AI SDK and `describeToolFailure` see exactly what
 * they saw before.
 */
export function withJournal<T extends Record<string, unknown>>(
  tools: T,
  context: JournalContext,
  writer?: JournalWriter | null
): T {
  if (!writer || !writer.enabled) return tools;

  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools)) {
    const tool = value as {
      execute?: (input: unknown, options?: { toolCallId?: string }) => Promise<unknown>;
    };
    if (typeof tool.execute !== 'function') {
      wrapped[name] = value;
      continue;
    }
    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options?: { toolCallId?: string }) => {
        const startedAt = Date.now();
        try {
          const output = await originalExecute(input, options);
          const status = outcomeStatus(output);
          writer.log({
            ts: new Date().toISOString(),
            kind: 'tool',
            tool: name,
            ...(options?.toolCallId ? { callId: options.toolCallId } : {}),
            ...context,
            durationMs: Date.now() - startedAt,
            ok: status.ok,
            input,
            ...(writer.includeResults === 'full' ? { result: output } : {}),
            summary: summarize(name, input, output, status.ok),
            ...(() => {
              const artifacts = artifactsOf(input, output);
              return artifacts ? { artifacts } : {};
            })(),
            ...(status.ok
              ? {}
              : { error: status.error, ...(status.code ? { code: status.code } : {}) }),
          });
          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writer.log({
            ts: new Date().toISOString(),
            kind: 'tool',
            tool: name,
            ...(options?.toolCallId ? { callId: options.toolCallId } : {}),
            ...context,
            durationMs: Date.now() - startedAt,
            ok: false,
            input,
            summary: `${name} threw: ${message}`.slice(0, 300),
            error: message,
            ...(typeof (error as NodeJS.ErrnoException)?.code === 'string'
              ? { code: (error as NodeJS.ErrnoException).code as string }
              : {}),
          });
          throw error;
        }
      },
    };
  }
  return wrapped as T;
}
