/**
 * Phase 23 (CLI, step 2): observability logs.
 *
 *   human-out-of-the-loop logs [--project-root DIR] [--plan <planId>] [--tail N] [--follow]
 *
 * Reads `<projectRoot>/.ai-runtime/observability.jsonl` (the
 * ObservabilityLogger sink), filters by plan, prints the last N lines,
 * and with --follow keeps streaming new entries (like `tail -f`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out } from '../utils/output.js';

export interface LogsCommandOptions {
  projectRoot?: string;
  /** Only entries for this plan */
  plan?: string;
  /** Number of trailing lines (default 50) */
  tail?: number;
  /** Keep following the file for new entries */
  follow?: boolean;
}

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  info: color.info,
  warn: color.warn,
  error: color.failed,
};

function logFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'observability.jsonl');
}

function parseLine(line: string):
  | {
      timestamp: string;
      level: string;
      eventType: string;
      message: string;
      planId?: string;
    }
  | undefined {
  try {
    const entry = JSON.parse(line) as {
      timestamp: string;
      level: string;
      eventType: string;
      message: string;
      planId?: string;
    };
    return entry;
  } catch {
    return undefined; // skip corrupt lines
  }
}

function formatEntry(entry: NonNullable<ReturnType<typeof parseLine>>): string {
  // `level` is optional on LogEntry — treat a missing level as dim text
  const levelLabel = entry.level ? entry.level.toUpperCase() : 'INFO';
  const level = entry.level ? LEVEL_COLOR[entry.level] ?? color.dim : color.dim;
  const plan = entry.planId ? color.dim(` [${entry.planId}]`) : '';
  return `${color.dim(entry.timestamp)} ${level(levelLabel.padEnd(5))} ${entry.eventType}${plan}: ${entry.message}`;
}

/** Read the current file content as entries (optional plan filter). */
/**
 * U7: exported so the server's follow-stream route shares the exact same
 * JSONL parsing/tail semantics as the CLI (single implementation).
 */
export function readEntries(file: string, planId?: string) {
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { entries: [] as Array<NonNullable<ReturnType<typeof parseLine>>>, size: 0 };
  }
  const entries = content
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(parseLine)
    .filter((e): e is NonNullable<ReturnType<typeof parseLine>> => e !== undefined && (!planId || e.planId === planId));
  return { entries, size: Buffer.byteLength(content, 'utf-8') };
}

export async function logsCommand(opts: LogsCommandOptions): Promise<number> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  const file = logFilePath(projectRoot);
  const tail = opts.tail ?? 50;

  // Phase 29: `--tail abc` used to parse to NaN and silently print nothing.
  if (!Number.isInteger(tail) || tail < 0) {
    err(color.failed('--tail must be a non-negative integer (0 = no initial lines).'));
    return 2;
  }

  if (!fs.existsSync(file)) {
    err(color.dim(`No observability log at ${file} (runs create it in persistent mode).`));
    return 0;
  }

  let { entries, size } = readEntries(file, opts.plan);
  // NOTE: `slice(-0)` is `slice(0)` in JS and would dump the WHOLE log,
  // so 0 is special-cased: no initial lines, only what --follow adds.
  const initial = tail > 0 ? entries.slice(-tail) : [];
  for (const entry of initial) out(formatEntry(entry));

  if (!opts.follow) {
    return 0;
  }

  out(color.dim('\n(Following — press Ctrl+C to stop.)'));
  // startAt = entries.length: the initial tail is already printed above;
  // the follower reports only NEW entries from here on.
  const stop = followLog(file, opts.plan, tail, (entry) => out(formatEntry(entry)), entries.length);
  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      stop();
      process.removeListener('SIGINT', onSigint);
      resolve();
    };
    process.on('SIGINT', onSigint);
  });
  return 0;
}

/**
 * Watch a JSONL log file and invoke `onEntry` for each new entry.
 *
 * Exported for tests (which stop the follower explicitly instead of
 * sending SIGINT).  `startAt` is the number of entries already shown
 * by the caller — the follower only reports entries beyond that.
 * Truncation/rotation is handled by re-syncing to the current tail.
 * Returns a `stop()` function.
 */
export function followLog(
  file: string,
  planId: string | undefined,
  _tail: number,
  onEntry: (entry: NonNullable<ReturnType<typeof parseLine>>) => void,
  _startAt = 0,
): () => void {
  const dir = path.dirname(file);
  let offset = 0;
  let inode: number | undefined;
  try {
    const initial = fs.statSync(file);
    offset = initial.size;
    inode = initial.ino;
  } catch {
    offset = 0;
  }
  let leftover = '';
  let stopped = false;

  const consume = (): void => {
    if (stopped) return;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return;
    }
    if (inode !== undefined && stats.ino !== inode) {
      // Rotated onto a new file at the same path.
      offset = 0;
      leftover = '';
    }
    inode = stats.ino;
    if (stats.size < offset) {
      // Truncated in place.
      offset = 0;
      leftover = '';
    }
    if (stats.size === offset) return;
    const length = stats.size - offset;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    offset = stats.size;
    const chunk = leftover + buf.toString('utf-8');
    const lines = chunk.split('\n');
    leftover = lines.pop() ?? '';
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry && (!planId || entry.planId === planId)) onEntry(entry);
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already there */
  }

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => {
      // Do not filter on `filename`: a rotate is `rename(log, log.1)` plus
      // a create, and some hosts only report the `.1` name.
      consume();
    });
  } catch {
    try {
      watcher = fs.watch(file, () => consume());
    } catch {
      watcher = undefined;
    }
  }

  // `watchFile` polls the path itself, so a rotate (unlink + recreate) is
  // visible even when the directory watcher swallows the rename.
  fs.watchFile(file, { interval: 150, persistent: true }, consume);

  return (): void => {
    if (stopped) return;
    stopped = true;
    fs.unwatchFile(file, consume);
    watcher?.close();
  };
}
