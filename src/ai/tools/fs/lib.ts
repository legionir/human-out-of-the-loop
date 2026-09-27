/**
 * Phase 33 — the filesystem core, ported from the MCP reference filesystem
 * server (`servers-main/src/filesystem/lib.ts`).
 *
 * Why this module exists: the tools in `src/ai/tools/implementations/` used to
 * check a path with a lexical `startsWith` (plus a best-effort realpath of the
 * deepest existing ancestor).  The reference server's implementation is
 * stricter in ways that matter for an agent that reads and writes a real
 * project:
 *
 *   - **Symlinks are resolved per component.**  A symlinked *parent* used to
 *     write a brand-new file outside the workspace (`link/new.txt`) is caught,
 *     because every existing component is `realpath`ed and re-checked.
 *   - **Unicode-equivalent names resolve to the file that exists** (NFC vs NFD,
 *     macOS vs Linux), and an ambiguous match is refused instead of picking one.
 *   - **A Windows drive path on a POSIX host is refused**, instead of being
 *     silently treated as a relative name and written inside the workspace.
 *   - **Writes are atomic.**  A new file is created with the `wx` flag (never
 *     following a pre-existing symlink); an existing file is replaced through a
 *     temp file + `rename`, which does not follow symlinks — and the original
 *     permission bits are restored afterwards.
 *   - **`move_file` refuses to overwrite** (the reference's contract; `rename`
 *     would silently destroy the destination).
 *
 * Differences from the reference, all deliberate:
 *   - allowed directories are a **parameter**, not module-level global state:
 *     two Orchestrators in one process must not share a sandbox;
 *   - a denial throws `PathAccessError` carrying a `code`, so the tools can
 *     turn it into their structured `{ success: false, code }` result instead
 *     of leaking an exception into the agent loop.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { expandHome, normalizePath } from './path-utils.js';
import { isPathWithinAllowedDirectories } from './path-validation.js';

// ─── Errors ──────────────────────────────────────────────────────

/** Machine-readable reasons a path was refused. */
export type PathAccessCode =
  | 'PATH_OUTSIDE_ALLOWED'
  | 'SYMLINK_ESCAPE'
  | 'WINDOWS_PATH_ON_POSIX'
  | 'AMBIGUOUS_UNICODE'
  | 'PARENT_MISSING';

/** A path that failed validation.  `message` is human-readable and safe to show. */
export class PathAccessError extends Error {
  readonly code: PathAccessCode;

  constructor(code: PathAccessCode, message: string) {
    super(message);
    this.name = 'PathAccessError';
    this.code = code;
  }
}

// ─── Types ───────────────────────────────────────────────────────

export interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

export interface SearchOptions {
  excludePatterns?: string[];
  /**
   * Phase 36 — treat a slash-free pattern as a *name* matched at any depth
   * (`*.ts` finds `src/lib/util.ts`), which is what an editor's file finder and
   * the `search_code` defaults already do.  Off by default here, because the
   * MCP reference matched globs against the relative path only.
   */
  matchBaseName?: boolean;
  /** Skip build/vendor directories (`node_modules`, `dist`, …) while walking. */
  skipBuildDirs?: boolean;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  /** Called for every entry that matched, before the caller applies a limit. */
  onMatch?: (entry: SearchMatch) => void;
}

/** One entry a glob scan matched. */
export interface SearchMatch {
  /** Absolute path. */
  path: string;
  /** Workspace-relative path, POSIX separators (the shape patterns match). */
  relative: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

/** What a scan walked, skipped and found. */
export interface SearchScanOutcome {
  matches: SearchMatch[];
  filesScanned: number;
  directoriesScanned: number;
  skippedExcluded: number;
  skippedSymlinks: number;
  /** Names skipped because of `skipBuildDirs` (e.g. `node_modules`), deduped. */
  ignoredDirectories: string[];
}

export interface SearchResult {
  path: string;
  isDirectory: boolean;
}

export interface FileEdit {
  oldText: string;
  newText: string;
}

// ─── Pure utilities ──────────────────────────────────────────────

/** `1536` → `"1.50 KB"` (the reference's human-readable size format). */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes <= 0) return '0 B';

  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i < 0 || i === 0) return `${bytes} ${units[0]}`;

  const unitIndex = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

/** CRLF → LF.  Every edit/diff in this module works on normalized text. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** A git-style unified diff between two strings. */
export function createUnifiedDiff(
  originalContent: string,
  newContent: string,
  filepath: string = 'file'
): string {
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

// ─── Path resolution (security) ──────────────────────────────────

/**
 * Resolve a relative path against the allowed directories.
 *
 * The first root that keeps the path inside itself wins; when no root does, the
 * first root is used as the base so the caller still gets a concrete path that
 * the containment check will refuse with a clear message.
 */
function resolveRelativePathAgainstAllowedDirectories(
  relativePath: string,
  allowedDirectories: string[]
): string {
  if (allowedDirectories.length === 0) {
    // No roots at all: the caller must pass an absolute path.  `resolve()`
    // against cwd is still the least surprising answer, and it will be refused
    // by the containment check right after.
    return path.resolve(process.cwd(), relativePath);
  }

  for (const allowedDir of allowedDirectories) {
    const candidate = path.resolve(allowedDir, relativePath);
    const normalizedCandidate = normalizePath(candidate);
    if (isPathWithinAllowedDirectories(normalizedCandidate, allowedDirectories)) {
      return candidate;
    }
  }

  return path.resolve(allowedDirectories[0]!, relativePath);
}

/**
 * Resolve the Unicode-equivalent (NFC/NFD) form of a path that does not exist
 * yet, component by component, refusing ambiguous matches.
 *
 * Returns the (partly) real path; the still-missing tail is appended as-is so
 * `create_directory` / `write_file` can create nested paths in one step.
 */
async function resolveUnicodeEquivalentPath(
  absolutePath: string,
  allowedDirectories: string[]
): Promise<string> {
  const allowedDirectory = [...allowedDirectories]
    .sort((left, right) => right.length - left.length)
    .find((directory) => isPathWithinAllowedDirectories(normalizePath(absolutePath), [directory]));

  if (!allowedDirectory) return absolutePath;

  let currentPath = await fs.realpath(allowedDirectory);
  const relativeParts = path
    .relative(allowedDirectory, absolutePath)
    .split(path.sep)
    .filter(Boolean);

  for (let index = 0; index < relativeParts.length; index++) {
    const requestedPart = relativeParts[index]!;
    const entries = await fs.readdir(currentPath);
    const exactMatch = entries.find((entry) => entry === requestedPart);
    const equivalentMatches = exactMatch
      ? [exactMatch]
      : entries.filter((entry) => entry.normalize('NFC') === requestedPart.normalize('NFC'));

    if (equivalentMatches.length > 1) {
      throw new PathAccessError(
        'AMBIGUOUS_UNICODE',
        `Ambiguous Unicode path component: ${requestedPart}`
      );
    }

    if (equivalentMatches.length === 0) {
      // Nothing below this point exists yet, so there are no symlinks left to
      // resolve: append the missing tail so mkdir -p / write can create it.
      return path.join(currentPath, ...relativeParts.slice(index));
    }

    currentPath = await fs.realpath(path.join(currentPath, equivalentMatches[0]!));
    if (!isPathWithinAllowedDirectories(normalizePath(currentPath), allowedDirectories)) {
      throw new PathAccessError(
        'SYMLINK_ESCAPE',
        `Access denied - symlink target outside allowed directories: ${currentPath} not in ${allowedDirectories.join(', ')}`
      );
    }
  }

  return currentPath;
}

/**
 * Validate a requested path and return the real path to operate on.
 *
 * The order matters: expand `~`, refuse a Windows drive path on POSIX, resolve
 * relative paths against the roots, check containment lexically, then check the
 * real path (symlinks).  A path that does not exist yet is resolved through its
 * existing ancestors — the point of the whole exercise is that
 * `<root>/symlink-to-outside/new.txt` is refused *before* anything is created.
 */
export async function validatePath(
  requestedPath: string,
  allowedDirectories: string[]
): Promise<string> {
  const expandedPath = expandHome(requestedPath);

  // Do not silently reinterpret a Windows drive path as a relative POSIX path:
  // that creates a literal file named `C:\Users\...` inside the root and
  // reports success for the wrong location.
  if (process.platform !== 'win32' && /^[a-zA-Z]:(?:[\\/]|$)/.test(expandedPath)) {
    throw new PathAccessError(
      'WINDOWS_PATH_ON_POSIX',
      `Access denied - Windows-style path received on a POSIX host: ${requestedPath}`
    );
  }

  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : resolveRelativePathAgainstAllowedDirectories(expandedPath, allowedDirectories);

  const normalizedRequested = normalizePath(absolute);

  if (!isPathWithinAllowedDirectories(normalizedRequested, allowedDirectories)) {
    throw new PathAccessError(
      'PATH_OUTSIDE_ALLOWED',
      `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`
    );
  }

  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    if (!isPathWithinAllowedDirectories(normalizedReal, allowedDirectories)) {
      throw new PathAccessError(
        'SYMLINK_ESCAPE',
        `Access denied - symlink target outside allowed directories: ${realPath} not in ${allowedDirectories.join(', ')}`
      );
    }
    return realPath;
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    // For a path that does not exist yet, resolve its existing ancestors.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        return await resolveUnicodeEquivalentPath(absolute, allowedDirectories);
      } catch (resolutionError) {
        if (resolutionError instanceof PathAccessError) throw resolutionError;
        if ((resolutionError as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new PathAccessError(
            'PARENT_MISSING',
            `Parent directory does not exist: ${path.dirname(absolute)}`
          );
        }
        throw resolutionError;
      }
    }
    throw error;
  }
}

// ─── File operations ─────────────────────────────────────────────

export async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

export async function readFileContent(
  filePath: string,
  encoding: string = 'utf-8'
): Promise<string> {
  return await fs.readFile(filePath, encoding as BufferEncoding);
}

/**
 * Media types by extension — the reference server's table
 * (`servers-main/src/filesystem/index.ts`, `read_media_file`).
 */
const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** The MIME type of a file, from its extension (the reference's mapping). */
export function mediaTypeForFile(filePath: string): string {
  return (
    MEDIA_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  );
}

/**
 * Read a file as base64 through a stream (the reference's
 * `readFileAsBase64Stream`), so a large image is not held twice in memory.
 */
export async function readFileAsBase64(filePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', (error) => reject(error));
  });
  return Buffer.concat(chunks).toString('base64');
}

/**
 * Write a file atomically, without ever following a symlink.
 *
 * 1. `wx` — exclusive creation; fails when anything (including a symlink)
 *    already occupies the path, so a pre-existing link cannot be written
 *    through.
 * 2. The file exists: write a random temp file next to it and `rename` it over
 *    the target.  `rename` replaces the directory entry and does not follow
 *    symlinks, which closes the check-then-write race.
 * 3. Restore the original permission bits — the new inode would otherwise carry
 *    the temp file's default (0644).  A failed chmod never fails the write:
 *    the content is already safely in place.
 */
export async function writeFileContent(
  filePath: string,
  content: string | Uint8Array
): Promise<void> {
  const writeOnce = async (target: string, flag?: string): Promise<void> => {
    if (typeof content === 'string') {
      await fs.writeFile(target, content, { encoding: 'utf-8', ...(flag ? { flag } : {}) });
    } else {
      await fs.writeFile(target, content, flag ? { flag } : undefined);
    }
  };

  try {
    await writeOnce(filePath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const origStats = await fs.stat(filePath);
    const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      await writeOnce(tempPath);
      await fs.rename(tempPath, filePath);
    } catch (renameError) {
      try {
        await fs.unlink(tempPath);
      } catch {
        /* the temp file may not exist; nothing else to do */
      }
      throw renameError;
    }

    try {
      await fs.chmod(filePath, origStats.mode & 0o777);
    } catch {
      /* chmod is best-effort (Windows, exotic filesystems) */
    }
  }
}

/**
 * Move a file or directory, refusing to overwrite the destination.
 *
 * `lstat` (not `stat`) so an existing *symlink* at the destination counts as
 * "occupied" — `rename` would replace it silently, which is data loss.
 */
export async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.lstat(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.rename(sourcePath, destinationPath);
      return;
    }
    throw error;
  }
  throw new Error(`Destination already exists: ${destinationPath}`);
}

// ─── File editing ────────────────────────────────────────────────

/**
 * Index of the first line in `contentLines` where `oldLines` matches exactly,
 * or -1.  Line-aligned matching is tried before substring matching so a quoted
 * *indented* block does not match the tail of a more-indented line.
 */
export type FileEditCode =
  | 'AMBIGUOUS_MATCH'
  | 'EDIT_NOT_FOUND'
  | 'ENCODING_UNSUPPORTED'
  | 'EMPTY_OLD_TEXT';

/** Structured failure from `applyFileEdits` so tools can return a code. */
export class FileEditError extends Error {
  readonly code: FileEditCode;
  readonly matchCount?: number;

  constructor(code: FileEditCode, message: string, matchCount?: number) {
    super(message);
    this.name = 'FileEditError';
    this.code = code;
    if (matchCount !== undefined) this.matchCount = matchCount;
  }
}

function findExactLineSequence(contentLines: string[], oldLines: string[]): number {
  if (oldLines.length === 0) return -1;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matches = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j] !== oldLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function countExactLineSequence(contentLines: string[], oldLines: string[]): number {
  if (oldLines.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matches = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j] !== oldLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) count += 1;
  }
  return count;
}

function countWhitespaceLineSequence(contentLines: string[], oldLines: string[]): number {
  if (oldLines.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const potentialMatch = contentLines.slice(i, i + oldLines.length);
    if (oldLines.every((oldLine, j) => oldLine.trim() === potentialMatch[j]!.trim())) count += 1;
  }
  return count;
}

function countSubstrings(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

/** Keep the original line's indent characters (tabs stay tabs). */
function reindentReplacement(originalFirstLine: string, normalizedNew: string): string[] {
  const originalIndent = originalFirstLine.match(/^[\t ]*/)?.[0] ?? '';
  const newLines = normalizedNew.split('\n');
  const firstNewIndent = newLines[0]!.match(/^[\t ]*/)?.[0] ?? '';
  return newLines.map((line) => {
    if (line.trim() === '') return line;
    const thisIndent = line.match(/^[\t ]*/)?.[0] ?? '';
    const extra = thisIndent.startsWith(firstNewIndent)
      ? thisIndent.slice(firstNewIndent.length)
      : '';
    return originalIndent + extra + line.trimStart();
  });
}

function decodeUtf8Strict(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new FileEditError(
      'ENCODING_UNSUPPORTED',
      'File is not valid UTF-8; refuse to edit so the bytes stay intact. Use write_file with encoding=base64 for binary content.'
    );
  }
}

/**
 * Apply line-based edits to a text file and return a fenced unified diff.
 *
 * Matching tries three strategies in order: exact line-aligned, then
 * whitespace-tolerant line-aligned (shifting the whole replacement by the
 * indentation difference — a model that re-indents a block should not corrupt
 * the file), then a literal substring (partial-line edits such as a rename).
 * An edit that matches nowhere is an error — silently skipping it would leave
 * the caller believing a change happened.
 */
export async function applyFileEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun: boolean = false
): Promise<string> {
  const originalBytes = await fs.readFile(filePath);
  const originalText = decodeUtf8Strict(originalBytes);
  const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
  const content = normalizeLineEndings(originalText);

  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);
    if (normalizedOld.length === 0) {
      throw new FileEditError('EMPTY_OLD_TEXT', 'oldText must not be empty.');
    }
    const oldLines = normalizedOld.split('\n');

    // 1. Exact, line-aligned match — the common case: the model quoted the
    //    block as it appears in the file.  Splicing whole lines leaves every
    //    other byte (including indentation) untouched.
    const lines = modifiedContent.split('\n');
    const exactCount = countExactLineSequence(lines, oldLines);
    if (exactCount > 1) {
      throw new FileEditError(
        'AMBIGUOUS_MATCH',
        `oldText matched ${exactCount} times; refuse to guess which occurrence to edit.`,
        exactCount
      );
    }
    if (exactCount === 1) {
      const lineStart = findExactLineSequence(lines, oldLines);
      lines.splice(lineStart, oldLines.length, ...normalizedNew.split('\n'));
      modifiedContent = lines.join('\n');
      continue;
    }

    // 2. Whitespace-flexible, line-by-line match — the model re-indented
    //    the block it quoted. Original indent characters (tabs) are kept.
    const contentLines = modifiedContent.split('\n');
    const wsCount = countWhitespaceLineSequence(contentLines, oldLines);
    if (wsCount > 1) {
      throw new FileEditError(
        'AMBIGUOUS_MATCH',
        `oldText matched ${wsCount} times; refuse to guess which occurrence to edit.`,
        wsCount
      );
    }
    if (wsCount === 1) {
      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        const potentialMatch = contentLines.slice(i, i + oldLines.length);
        const isMatch = oldLines.every(
          (oldLine, j) => oldLine.trim() === potentialMatch[j]!.trim()
        );
        if (!isMatch) continue;
        const adjustedNewLines = reindentReplacement(contentLines[i]!, normalizedNew);
        contentLines.splice(i, oldLines.length, ...adjustedNewLines);
        modifiedContent = contentLines.join('\n');
        break;
      }
      continue;
    }

    // 3. Last resort: exact substring (partial-line edit, e.g. a rename).
    const subCount = countSubstrings(modifiedContent, normalizedOld);
    if (subCount > 1) {
      throw new FileEditError(
        'AMBIGUOUS_MATCH',
        `oldText matched ${subCount} times; refuse to guess which occurrence to edit.`,
        subCount
      );
    }
    if (subCount === 1) {
      modifiedContent = modifiedContent.replace(normalizedOld, () => normalizedNew);
      continue;
    }

    throw new FileEditError(
      'EDIT_NOT_FOUND',
      `Could not find exact match for edit:\n${edit.oldText}`
    );
  }

  const diff = createUnifiedDiff(content, modifiedContent, filePath);
  const outputText = eol === '\r\n' ? modifiedContent.replace(/\n/g, '\r\n') : modifiedContent;

  // Fence the diff with one more backtick than the diff itself contains.
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) numBackticks++;
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    const origStats = await fs.stat(filePath);
    const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, outputText, 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        /* best effort */
      }
      throw error;
    }
    try {
      await fs.chmod(filePath, origStats.mode & 0o777);
    } catch {
      /* best effort */
    }
  }

  return formattedDiff;
}

/** The last `numLines` lines of a file, read backwards in 1 KB chunks. */
export async function tailFile(filePath: string, numLines: number): Promise<string> {
  const CHUNK_SIZE = 1024;
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  if (fileSize === 0) return '';

  const fileHandle = await fs.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = fileSize;
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let newlinesFound = 0;

    while (position > 0 && newlinesFound < numLines) {
      const size = Math.min(CHUNK_SIZE, position);
      position -= size;

      const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
      if (!bytesRead) break;

      const readData = Buffer.from(chunk.subarray(0, bytesRead));
      chunks.unshift(readData);
      for (const byte of readData) {
        if (byte === 0x0a) newlinesFound++;
      }
    }

    const text = normalizeLineEndings(Buffer.concat(chunks).toString('utf-8'));
    // A trailing newline is a line *terminator*, not an extra empty line —
    // without this, `tail: 2` on a file ending in `\n` returns one line plus ''.
    const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
    return withoutTrailingNewline.split('\n').slice(-numLines).join('\n');
  } finally {
    await fileHandle.close();
  }
}

/** The first `numLines` lines of a file (streamed through a UTF-8 decoder). */
export async function headFile(filePath: string, numLines: number): Promise<string> {
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const lines: string[] = [];
    let buffer = '';
    let bytesRead = 0;
    const chunk = Buffer.alloc(1024);
    const decoder = new StringDecoder('utf-8');

    while (lines.length < numLines) {
      const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      buffer += decoder.write(chunk.subarray(0, result.bytesRead));

      const newLineIndex = buffer.lastIndexOf('\n');
      if (newLineIndex !== -1) {
        const completeLines = buffer.slice(0, newLineIndex).split('\n');
        buffer = buffer.slice(newLineIndex + 1);
        for (const line of completeLines) {
          lines.push(line);
          if (lines.length >= numLines) break;
        }
      }
    }

    buffer += decoder.end();

    if (buffer.length > 0 && lines.length < numLines) {
      lines.push(buffer);
    }

    return lines.join('\n');
  } finally {
    await fileHandle.close();
  }
}

// ─── Search ──────────────────────────────────────────────────────

/**
 * Does a workspace-relative path match one of the exclude globs?
 *
 * Phase 34: one implementation shared by the content search, the directory tree
 * and `search_files`, so "exclude node_modules" means the same thing in all of
 * them.  Two rules:
 *   - the path is matched as written (`dist/**`, `*.log`),
 *   - a pattern with no glob magic is a *name* and excludes that entry at any
 *     depth (`node_modules` also excludes `packages/app/node_modules`).
 */
export function isExcludedPath(
  relativePath: string,
  patterns: readonly string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) return false;

  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/');

  return patterns.some((pattern) => {
    if (minimatch(normalized, pattern, { dot: true })) return true;
    if (pattern.includes('*')) return false;
    return segments.includes(pattern);
  });
}

/**
 * Build/vendor directories skipped by default once `skipBuildDirs` is on —
 * the same list `search_code` uses, so a glob scan and a content search agree
 * on what "the project" means.
 */
export const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  'vendor',
  // this runtime's own state (plans, logs, sessions)
  '.ai-runtime',
]);

/**
 * Is the path excluded, honouring `!` re-includes?
 *
 * A leading `!` turns a pattern into a re-include (`['**\/*.js', '!**\/keep.js']`
 * reads the way a `.gitignore`/glob-list does), so one call can carve a hole in
 * a broad exclusion instead of needing two calls.
 */
export function isExcludedWithNegation(
  relativePath: string,
  patterns: readonly string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const positives = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  if (positives.length === 0) return false;
  if (negatives.length > 0 && isExcludedPath(relativePath, negatives)) return false;
  return isExcludedPath(relativePath, positives);
}

/**
 * Recursively find entries whose path (relative to `rootPath`) matches the
 * glob `pattern` — the phase-33 port, extended in phase 36 so `search_files`
 * can hold its own next to `search_code`.
 *
 * What the reference did, and is kept here:
 *   - the path is matched as written (`*.ext` in the root, `**\/*.ext` anywhere),
 *   - a refused or unreadable entry never fails the whole search,
 *   - the validation call per entry is the security boundary: a symlink leading
 *     outside the allowed directories is skipped, never followed.
 *
 * What phase 36 adds:
 *   - **POSIX matching on every host**: the relative path is converted to `/`
 *     before `minimatch` sees it, so a Windows `\` can no longer be read as a
 *     glob escape (a pattern like `src/**\/*.ts` used to match nothing there),
 *   - **`matchBaseName`**: a slash-free pattern is a name, matched at any depth,
 *   - **`skipBuildDirs`** with the shared {@link DEFAULT_EXCLUDE_DIRS},
 *   - **`!` re-includes** through {@link isExcludedWithNegation},
 *   - **counters** (files/directories scanned, what was skipped) and the type
 *     filter, so a caller can report *why* a scan was empty instead of guessing.
 */
export async function scanFilesWithValidation(
  rootPath: string,
  pattern: string,
  allowedDirectories: string[],
  options: SearchOptions = {}
): Promise<SearchScanOutcome> {
  const {
    excludePatterns = [],
    matchBaseName = false,
    skipBuildDirs = false,
    includeFiles = true,
    includeDirectories = true,
  } = options;

  const outcome: SearchScanOutcome = {
    matches: [],
    filesScanned: 0,
    directoriesScanned: 0,
    skippedExcluded: 0,
    skippedSymlinks: 0,
    ignoredDirectories: [],
  };

  const ignored = new Set<string>();
  const matchesByName = matchBaseName && !pattern.includes('/');
  const matcher = (relative: string): boolean =>
    matchesByName
      ? minimatch(relative.split('/').pop() ?? relative, pattern, { dot: true })
      : minimatch(relative, pattern, { dot: true });

  async function search(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        await validatePath(fullPath, allowedDirectories);

        // POSIX shape for every pattern decision, on every host.
        const relative = path.relative(rootPath, fullPath).split(path.sep).join('/');

        if (skipBuildDirs && entry.isDirectory() && DEFAULT_EXCLUDE_DIRS.has(entry.name)) {
          ignored.add(entry.name);
          continue;
        }

        if (isExcludedWithNegation(relative, excludePatterns)) {
          outcome.skippedExcluded++;
          continue; // an excluded directory is not descended into either
        }

        const isDirectory = entry.isDirectory();
        if (isDirectory) outcome.directoriesScanned++;
        else outcome.filesScanned++;

        const wanted = isDirectory ? includeDirectories : includeFiles;
        if (wanted && matcher(relative)) {
          // lstat, never stat: a symlink is reported as itself, not resolved.
          const stats = await fs.lstat(fullPath).catch(() => undefined);
          outcome.matches.push({
            path: fullPath,
            relative,
            type: isDirectory ? 'directory' : 'file',
            size: !isDirectory && stats ? stats.size : 0,
            modified: (stats?.mtime ?? new Date(0)).toISOString(),
          });
        }

        if (isDirectory) {
          await search(fullPath);
        }
      } catch {
        // Unreadable or refused entries are skipped, never fatal: one bad
        // symlink in a big tree must not fail the whole search.
        if (entry.isSymbolicLink()) outcome.skippedSymlinks++;
        continue;
      }
    }
  }

  await search(rootPath);
  outcome.ignoredDirectories = [...ignored].sort();
  return outcome;
}

/**
 * The phase-33 contract, unchanged: the absolute paths of everything the scan
 * matched.  Kept as the thin form of {@link scanFilesWithValidation} so the
 * existing callers and tests keep the reference behaviour (no base-name
 * matching, no default excludes) while `search_files` opts into the richer set.
 */
export async function searchFilesWithValidation(
  rootPath: string,
  pattern: string,
  allowedDirectories: string[],
  options: SearchOptions = {}
): Promise<string[]> {
  const outcome = await scanFilesWithValidation(rootPath, pattern, allowedDirectories, options);
  return outcome.matches.map((match) => match.path);
}
