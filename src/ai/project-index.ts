/**
 * Project tree index for agent context.
 *
 * Two maps, never mixed:
 *   structure  — directories + direct file counts (static context)
 *   files      — per-directory name → { size, lines } (loaded on demand)
 *
 * Directory traversal uses `readdir({ withFileTypes: true })` in parallel.
 * File metadata is a single `readFile` (size = buffer.length; no extra stat).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';

export const DEFAULT_INDEX_IGNORED = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '.next',
  '.angular',
  '.ai-runtime',
]);

export const DEFAULT_INDEX_CONCURRENCY = 64;

export interface FileMeta {
  size: number;
  lines: number;
}

/** Directory node: `files` is the count of files *directly* in this folder. */
export interface StructureNode {
  files: number;
  [name: string]: StructureNode | number;
}

/** Relative directory path (posix, `"."` for the root) → filename → meta. */
export type FilesIndex = Record<string, Record<string, FileMeta>>;

export interface ProjectIndex {
  structure: StructureNode;
  files: FilesIndex;
}

export interface DirectoryFiles {
  path: string;
  files: Record<string, FileMeta>;
}

export interface BuildIndexOptions {
  ignored?: Set<string>;
  concurrency?: number;
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function shouldSkip(name: string, ignored: Set<string>): boolean {
  if (ignored.has(name)) return true;
  if (name.startsWith('.') && name !== '.env') return true;
  return false;
}

/** Count lines from a buffer: empty → 0; a trailing newline does not add a line. */
export function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) lines++;
  }
  if (buffer[buffer.length - 1] === 10) lines--;
  return lines;
}

function posixRel(from: string, to: string): string {
  const rel = path.relative(from, to);
  if (rel === '') return '.';
  return rel.split(path.sep).join('/');
}

/**
 * Walk `root` and build both indexes.
 * Subdirectories are scanned in parallel; file bodies are read with a cap.
 */
export async function buildProjectIndex(
  root: string,
  options: BuildIndexOptions = {},
): Promise<ProjectIndex> {
  const absRoot = path.resolve(root);
  const ignored = options.ignored ?? DEFAULT_INDEX_IGNORED;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_INDEX_CONCURRENCY);
  const limit = createLimiter(concurrency);

  const structure: StructureNode = { files: 0 };
  const files: FilesIndex = {};
  const pending: Array<{ abs: string; name: string; relDir: string }> = [];

  async function scan(dir: string, node: StructureNode, relDir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await limit(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      node.files = 0;
      return;
    }

    const subdirs: Array<{ abs: string; name: string; child: StructureNode }> = [];
    const localFiles: string[] = [];

    for (const entry of entries) {
      if (shouldSkip(entry.name, ignored)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const child: StructureNode = { files: 0 };
        node[entry.name] = child;
        subdirs.push({ abs: full, name: entry.name, child });
      } else if (entry.isFile()) {
        localFiles.push(entry.name);
        pending.push({ abs: full, name: entry.name, relDir });
      }
    }

    node.files = localFiles.length;
    files[relDir] = {};

    await Promise.all(
      subdirs.map((sub) => {
        const childRel = relDir === '.' ? sub.name : `${relDir}/${sub.name}`;
        return scan(sub.abs, sub.child, childRel);
      }),
    );
  }

  await scan(absRoot, structure, '.');

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= pending.length) return;
      const item = pending[i]!;
      try {
        const buffer = await limit(() => fs.readFile(item.abs));
        const bucket = files[item.relDir] ?? (files[item.relDir] = {});
        bucket[item.name] = { size: buffer.length, lines: countLines(buffer) };
      } catch {
        const bucket = files[item.relDir] ?? (files[item.relDir] = {});
        bucket[item.name] = { size: 0, lines: 0 };
      }
    }
  }

  const workers = Math.min(concurrency, Math.max(1, pending.length));
  if (pending.length > 0) {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  return { structure, files };
}

/** Static context: the whole directory tree with direct file counts. */
export function listTree(index: ProjectIndex): StructureNode {
  return index.structure;
}

/** On-demand metadata for one directory (posix path relative to the root). */
export function listFiles(index: ProjectIndex, dirPath: string): DirectoryFiles {
  const normalized = normalizeDir(dirPath);
  return {
    path: normalized,
    files: { ...(index.files[normalized] ?? {}) },
  };
}

function normalizeDir(dirPath: string): string {
  const trimmed = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
}

/** Find file names matching a glob, optionally under `dirPath`. */
export function findFiles(
  index: ProjectIndex,
  pattern: string,
  dirPath?: string,
): string[] {
  const prefix = dirPath !== undefined ? normalizeDir(dirPath) : undefined;
  const hits: string[] = [];
  for (const [dir, names] of Object.entries(index.files)) {
    if (prefix && prefix !== '.' && dir !== prefix && !dir.startsWith(`${prefix}/`)) continue;
    for (const name of Object.keys(names)) {
      const rel = dir === '.' ? name : `${dir}/${name}`;
      if (
        minimatch(name, pattern, { dot: true, matchBase: true }) ||
        minimatch(rel, pattern, { dot: true })
      ) {
        hits.push(rel);
      }
    }
  }
  hits.sort();
  return hits;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Text/regex search over indexed files. Reads matching files from disk
 * (never dumps the whole tree into context).
 */
export async function searchProject(
  root: string,
  index: ProjectIndex,
  query: string,
  dirPath?: string,
): Promise<SearchHit[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(query);
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const prefix = dirPath !== undefined ? normalizeDir(dirPath) : undefined;
  const hits: SearchHit[] = [];
  const absRoot = path.resolve(root);

  for (const [dir, names] of Object.entries(index.files)) {
    if (prefix && prefix !== '.' && dir !== prefix && !dir.startsWith(`${prefix}/`)) continue;
    for (const name of Object.keys(names)) {
      const rel = dir === '.' ? name : `${dir}/${name}`;
      let text: string;
      try {
        text = await fs.readFile(path.join(absRoot, ...rel.split('/')), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          hits.push({ path: rel, line: i + 1, text: lines[i]! });
        }
      }
    }
  }
  return hits;
}

export async function readFileRange(
  root: string,
  relPath: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  const abs = path.join(path.resolve(root), ...relPath.split('/'));
  const text = await fs.readFile(abs, 'utf8');
  const lines = text.split('\n');
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from - 1, to).join('\n');
}

export const PROJECT_INDEX_DIR = 'project-index';

export function indexOutputPaths(outDir: string): { structure: string; files: string } {
  return {
    structure: path.join(outDir, 'structure.json'),
    files: path.join(outDir, 'files.json'),
  };
}

export async function writeProjectIndex(outDir: string, index: ProjectIndex): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const paths = indexOutputPaths(outDir);
  await fs.writeFile(paths.structure, `${JSON.stringify(index.structure, null, 2)}\n`, 'utf8');
  await fs.writeFile(paths.files, `${JSON.stringify(index.files, null, 2)}\n`, 'utf8');
}
