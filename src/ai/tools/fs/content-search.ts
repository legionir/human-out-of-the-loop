/**
 * Phase 34 — the content-search engine behind `search_code`.
 *
 * The phase-2 tool could only answer "find this regex somewhere under this
 * directory": one pattern, one file-extension filter, one matching line per
 * line of code.  This is the VS Code "find in files" model instead:
 *
 *   - a **content** pattern (regex, or literal text, case-insensitive by
 *     default, optionally whole-word) — VS Code's three toggles;
 *   - a **path** pattern (regex over the workspace-relative path) plus glob
 *     `excludePatterns` — VS Code's "files to include / exclude";
 *   - every occurrence is reported with its 1-based line **and column**, and
 *     optional context lines around the match;
 *   - results carry the matched file list, so "where is this used?" is one
 *     field instead of a scan of the match array.
 *
 * Everything the phase-27 SEC-02 contract requires is preserved: an unreadable
 * file or directory is reported with its path, kind and error, the count is
 * exact while the reported array is capped, and a refused path is never
 * followed.  Two classes of skips that are *not* errors have their own counters
 * — binary files (`skippedBinary`) and files above `maxFileSizeBytes`
 * (`skippedTooLarge`) — so they cannot pollute the `skipped` contract.
 *
 * Symlinks are never followed: one that points outside the workspace is exactly
 * how a search escapes, and one that points inside is surprising enough that
 * the caller should name the real path.  They are counted
 * (`skippedSymlinks`) instead of vanishing silently.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_EXCLUDE_DIRS, isExcludedPath } from './lib.js';

export interface ContentMatch {
  /** Path relative to the workspace root (native separators). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character of the match in the original line. */
  column: number;
  /** The matching line, trimmed of surrounding whitespace and capped at 200 chars. */
  text: string;
  /** `contextLines` lines above the match (only present when contextLines > 0). */
  contextBefore?: string[];
  /** `contextLines` lines below the match (only present when contextLines > 0). */
  contextAfter?: string[];
}

export interface SkippedEntry {
  path: string;
  kind: 'file' | 'directory';
  error: string;
}

export interface ContentSearchOptions {
  /** Absolute, already-validated directory to search. */
  baseDirectory: string;
  /** Absolute workspace root — every reported path is relative to it. */
  workspaceRoot: string;
  /** Content matcher.  A copy is made per file, so the caller need not care about `lastIndex`. */
  contentRegex: RegExp;
  /** Optional include filter: regex over the workspace-relative path (POSIX separators). */
  pathRegex?: RegExp;
  /** Globs excluded from the walk (a bare name excludes it at any depth). */
  excludePatterns?: string[];
  /** Optional file-extension filter, e.g. `['.ts', '.tsx']`. */
  fileExtensions?: string[];
  /** Lines of context to include around each match (0 = none). */
  contextLines?: number;
  /** Total match ceiling — the walk stops as soon as it is reached (PERF-05). */
  maxResults: number;
  /** Ceiling per file, so one noisy file cannot consume the whole budget. */
  maxMatchesPerFile?: number;
  /** Files larger than this are not read at all. */
  maxFileSizeBytes?: number;
}

export interface ContentSearchOutcome {
  matches: ContentMatch[];
  /** Unique matched files, sorted — the "which files" answer. */
  files: string[];
  /** Unreadable files/directories (SEC-02). */
  skipped: SkippedEntry[];
  skippedBinary: number;
  skippedTooLarge: number;
  skippedSymlinks: number;
  /** Files actually read and scanned (not skipped, not filtered out). */
  filesScanned: number;
  /** True when a ceiling stopped the walk before the tree was exhausted. */
  truncated: boolean;
}

/** Directories that are never searched unless explicitly targeted — re-exported
 * from `lib.ts` (phase 36) so the content search and the glob scan share one list. */
export { DEFAULT_EXCLUDE_DIRS };

export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
/** Longest line reported in `text` (and each context line). */
const MAX_LINE_LENGTH = 200;
/** Occurrences reported per line — a minified file must not explode the payload. */
const MAX_COLUMNS_PER_LINE = 20;

/**
 * All match columns of one line, 1-based.
 *
 * A fresh global copy of the regex is used per line, so a `g`-less caller regex
 * still finds every occurrence and no `lastIndex` state leaks between lines.
 * Zero-length matches advance `lastIndex` by hand — otherwise `exec` loops
 * forever on patterns like `^` or `a*`.
 */
function matchColumns(line: string, regex: RegExp): number[] {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const scanner = new RegExp(regex.source, flags);
  const columns: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = scanner.exec(line)) !== null) {
    columns.push(match.index + 1);
    if (columns.length >= MAX_COLUMNS_PER_LINE) break;
    if (match[0] === '') scanner.lastIndex += 1;
  }

  return columns;
}

/** `path.relative` with POSIX separators — the shape every pattern is matched against. */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

export async function searchContentTree(
  options: ContentSearchOptions
): Promise<ContentSearchOutcome> {
  const {
    baseDirectory,
    workspaceRoot,
    contentRegex,
    pathRegex,
    excludePatterns = [],
    fileExtensions,
    contextLines = 0,
    maxResults,
    maxMatchesPerFile,
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
  } = options;

  const matches: ContentMatch[] = [];
  const skipped: SkippedEntry[] = [];
  let skippedBinary = 0;
  let skippedTooLarge = 0;
  let skippedSymlinks = 0;
  let filesScanned = 0;
  let truncated = false;
  let stopped = false;

  const relativeOf = (absolute: string): string => path.relative(workspaceRoot, absolute) || '.';

  const scanFile = async (filePath: string): Promise<void> => {
    // A stat that fails (vanished file, synthetic entry in a fixture) is not
    // fatal: the read below reports the real error.
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (stats && stats.size > maxFileSizeBytes) {
      skippedTooLarge++;
      return;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      // SEC-02: an unreadable file must be visible, not look like "no match".
      skipped.push({
        path: relativeOf(filePath),
        kind: 'file',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (content.includes('\u0000')) {
      skippedBinary++;
      return;
    }

    filesScanned++;
    const lines = content.split('\n');
    const file = relativeOf(filePath);
    let matchesInFile = 0;

    for (let index = 0; index < lines.length; index++) {
      if (stopped) return;
      if (maxMatchesPerFile !== undefined && matchesInFile >= maxMatchesPerFile) {
        // This file has said enough; the walk continues with the next one.
        truncated = true;
        return;
      }

      const columns = matchColumns(lines[index]!, contentRegex);
      for (const column of columns) {
        if (matches.length >= maxResults) {
          truncated = true;
          stopped = true;
          return;
        }

        const match: ContentMatch = {
          file,
          line: index + 1,
          column,
          text: lines[index]!.trim().slice(0, MAX_LINE_LENGTH),
        };

        if (contextLines > 0) {
          match.contextBefore = lines
            .slice(Math.max(0, index - contextLines), index)
            .map((line) => line.trim().slice(0, MAX_LINE_LENGTH));
          match.contextAfter = lines
            .slice(index + 1, index + 1 + contextLines)
            .map((line) => line.trim().slice(0, MAX_LINE_LENGTH));
        }

        matches.push(match);
        matchesInFile++;
        if (matches.length >= maxResults) {
          truncated = true;
          stopped = true;
          return;
        }
      }
    }
  };

  const walk = async (directory: string): Promise<void> => {
    if (stopped) return;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      // SEC-02: report the unreadable directory instead of pretending it was empty.
      skipped.push({
        path: relativeOf(directory),
        kind: 'directory',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(directory, entry.name);
      const relative = relativeOf(full);
      const posixRelative = toPosix(relative);

      // Never follow a symlink — that is the one way a walk leaves the sandbox.
      if (entry.isSymbolicLink?.()) {
        skippedSymlinks++;
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
        if (isExcludedPath(relative, excludePatterns)) continue;
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (fileExtensions && fileExtensions.length > 0) {
        if (!fileExtensions.some((extension) => entry.name.endsWith(extension))) continue;
      }
      if (pathRegex && !pathRegex.test(posixRelative)) continue;
      if (isExcludedPath(relative, excludePatterns)) continue;

      await scanFile(full);
    }
  };

  await walk(baseDirectory);

  // Deterministic order: file, then position in the file.
  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return {
    matches,
    files: [...new Set(matches.map((match) => match.file))].sort(),
    skipped,
    skippedBinary,
    skippedTooLarge,
    skippedSymlinks,
    filesScanned,
    truncated,
  };
}

/**
 * `path:line:column: text` — the line-per-match shape grep and ripgrep print,
 * which models read without having to correlate arrays.
 */
export function formatContentMatches(
  matches: readonly ContentMatch[],
  { maxLines = 200 }: { maxLines?: number } = {}
): string {
  if (matches.length === 0) return '(no matches)';

  const lines = matches
    .slice(0, maxLines)
    .map((match) => `${toPosix(match.file)}:${match.line}:${match.column}: ${match.text}`);

  const hidden = matches.length - lines.length;
  if (hidden > 0) lines.push(`… ${hidden} more match(es) not shown`);

  return lines.join('\n');
}
