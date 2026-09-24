/**
 * Validates that a file path is within the allowed workspace root.
 * Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 * Phase 18 (PATH-09): `workspaceRoot` is ALWAYS required — it must be injected
 * by the factory, never inferred from the process working directory, so tool
 * behavior is independent of where the process happens to be launched from.
 *
 * Phase 20 (PATH-07/08): the lexical check no longer stands alone — symlinks
 * and `..` are resolved to their real locations and re-checked, and everything
 * is compared case-insensitively on Windows.
 *
 * Phase 33: the real check is the ported reference implementation
 * (`../fs/path-validation.ts` + `../fs/lib.ts`).  The two functions below stay
 * exactly as they were for the callers that need a **synchronous, non-throwing**
 * answer (`validateWorkspacePath` / `isPathWithinWorkspace`), while every
 * filesystem tool now goes through `resolvePathInWorkspace`, which adds what the
 * reference server does on top of the lexical check:
 *
 *   - per-component symlink resolution (a symlinked *parent* is caught even
 *     when the target file does not exist yet),
 *   - Unicode-equivalent (NFC/NFD) component resolution,
 *   - a Windows drive path on a POSIX host is refused instead of being
 *     reinterpreted as a relative file name.
 *
 * The synchronous variant keeps working for a workspace root that does not
 * exist yet (a path cannot escape a tree that has no symlinks in it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithinAllowedDirectories } from '../fs/path-validation.js';
import { PathAccessError, validatePath } from '../fs/lib.js';

export interface PathCheckResult {
  safe: boolean;
  resolvedPath: string;
  reason?: string;
}

/** Phase 20 (PATH-08): case-insensitive compare on Windows. */
function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function withSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/**
 * Resolve the deepest existing ancestor of `p` to its real path
 * (following symlinks).  Returns undefined when nothing can be resolved.
 */
function realPathOfDeepestExisting(p: string): string | undefined {
  let current = p;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export function isPathWithinWorkspace(
  filePath: string,
  workspaceRoot: string
): PathCheckResult {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error(
      '[PathSecurity] "workspaceRoot" is required and must be a non-empty string. ' +
        'Pass the project root explicitly — process.cwd() is forbidden (PATH-09).'
    );
  }

  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  // Containment is decided by the ported reference check (separator-aware,
  // Windows-aware, null-byte safe).
  if (
    !isPathWithinAllowedDirectories(resolved, [normalizedRoot]) &&
    norm(resolved) !== norm(normalizedRoot)
  ) {
    return {
      safe: false,
      resolvedPath: resolved,
      reason: `Path "${filePath}" resolves to "${resolved}" which is outside workspace "${normalizedRoot}".`,
    };
  }

  // Symlink escape check — only meaningful when the root exists.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(normalizedRoot);
  } catch {
    return { safe: true, resolvedPath: resolved };
  }

  const realAncestor = realPathOfDeepestExisting(resolved);
  if (realAncestor !== undefined) {
    const realPrefix = withSep(realRoot);
    if (norm(realAncestor) !== norm(realRoot) && !norm(realAncestor).startsWith(norm(realPrefix))) {
      return {
        safe: false,
        resolvedPath: resolved,
        reason: `Path "${filePath}" resolves (via symlink) to "${realAncestor}", which is outside workspace "${normalizedRoot}".`,
      };
    }
  }

  return { safe: true, resolvedPath: resolved };
}

/**
 * Wrapper that validates a path before passing it to a filesystem operation.
 *
 * Phase 33: this is the synchronous, non-throwing variant.  Tools use
 * `resolvePathInWorkspace` (same result shape, stricter checks).
 */
export function validateWorkspacePath(
  filePath: string,
  workspaceRoot: string
): PathCheckResult {
  return isPathWithinWorkspace(filePath, workspaceRoot);
}

/**
 * Phase 33: the check every filesystem tool runs before touching disk.
 *
 * Same `{ safe, resolvedPath, reason }` contract as the synchronous variant,
 * but implemented on the ported reference core, so a symlinked parent, a
 * Unicode-equivalent name and a Windows-shaped path are all handled the way the
 * MCP reference filesystem server handles them.  Never throws for a refusal —
 * the caller turns `safe: false` into a structured tool error.
 */
export async function resolvePathInWorkspace(
  requestedPath: string,
  allowedDirectories: readonly string[]
): Promise<PathCheckResult> {
  const roots = allowedDirectories.filter((root) => typeof root === 'string' && root.length > 0);
  if (roots.length === 0) {
    throw new Error(
      '[PathSecurity] "allowedDirectories" must contain at least one root. ' +
        'Pass the project root explicitly — process.cwd() is forbidden (PATH-09).'
    );
  }

  const lexical = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(roots[0]!, requestedPath);

  try {
    return { safe: true, resolvedPath: await validatePath(requestedPath, roots) };
  } catch (error) {
    if (error instanceof PathAccessError) {
      // A workspace that does not exist yet contains no symlinks, so the
      // lexical check is the best available answer (same as the sync variant).
      if (error.code === 'PARENT_MISSING' && !roots.some((root) => fs.existsSync(root))) {
        return isPathWithinWorkspace(requestedPath, roots[0]!);
      }
      return { safe: false, resolvedPath: lexical, reason: error.message };
    }
    throw error;
  }
}
