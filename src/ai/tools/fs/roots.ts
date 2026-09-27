/**
 * Phase 33 — allowed directories ("roots"), adapted from the MCP reference
 * filesystem server (`servers-main/src/filesystem/roots-utils.ts`).
 *
 * The reference server learns its roots from the MCP client and accepts them
 * as `file://` URIs or plain paths; each one is expanded (`~`), resolved and
 * made real (`fs.realpath`) before it is trusted — a root that does not exist,
 * or is a file rather than a directory, is reported and skipped instead of
 * silently becoming a hole in the sandbox.
 *
 * In this runtime the roots come from the CLI (`--project-root`) and the
 * Orchestrator, so the same rules apply with one root in practice — the
 * functions stay list-shaped so multiple roots (a workspace plus a read-only
 * reference tree) need no redesign later.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, normalizePath } from './path-utils.js';

/**
 * Turn one root specification into a real directory path.
 *
 * Returns `null` when the path cannot be used: it does not exist, is not a
 * directory, or is not reachable at all.  Symlinks are resolved here (this is
 * the one place where a symlinked root is acceptable — it becomes its real
 * target, and every later check compares against that target).
 */
export async function parseRoot(root: string): Promise<string | null> {
  try {
    const rawPath = root.startsWith('file://') ? fileURLToPath(root) : root;
    const expandedPath = expandHome(rawPath);
    const absolutePath = path.resolve(expandedPath);
    const resolvedPath = await fs.realpath(absolutePath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) return null;
    return normalizePath(resolvedPath);
  } catch {
    return null;
  }
}

export interface ResolvedRoots {
  /** Usable, real, absolute directories — in the order they were given. */
  directories: string[];
  /** Roots that were dropped, with the reason (for logs, never for the model). */
  rejected: Array<{ root: string; reason: string }>;
}

/**
 * Resolve every root, dropping the unusable ones.
 *
 * A dropped root is never a hard error: a stale `--project-root` should not
 * make `list_allowed_directories` lie about the roots that DO work.
 */
export async function resolveAllowedDirectories(roots: readonly string[]): Promise<ResolvedRoots> {
  const directories: string[] = [];
  const rejected: Array<{ root: string; reason: string }> = [];

  for (const root of roots) {
    if (!root || typeof root !== 'string') {
      rejected.push({ root: String(root), reason: 'not a non-empty string' });
      continue;
    }
    const resolved = await parseRoot(root);
    if (resolved === null) {
      rejected.push({ root, reason: 'does not exist, is not a directory, or is inaccessible' });
      continue;
    }
    if (!directories.includes(resolved)) directories.push(resolved);
  }

  return { directories, rejected };
}
