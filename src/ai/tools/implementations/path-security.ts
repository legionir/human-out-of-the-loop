import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates that a file path is within the allowed workspace root.
 * Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 * Used by all filesystem tools (read_file, write_file, search_code,
 * git_status).  `workspaceRoot` is ALWAYS required (phase 18 — PATH-09):
 * the root must be injected by the factory, never inferred from
 * the process working directory, so tool behavior is independent of where the
 * process happens to be launched from.
 *
 * Phase 20 (PATH-07): the check no longer trusts the lexical path alone.
 * When the workspace root exists, the target (or its deepest existing
 * ancestor) is resolved with `fs.realpathSync` — symlinks and `..`
 * segments are resolved to their REAL locations and re-checked against
 * the REAL workspace root.  A symlink inside the workspace pointing
 * outside (e.g. `./link -> /etc/passwd`, or a directory symlink used to
 * write outside) is now blocked.
 *
 * Phase 20 (PATH-08): all comparisons are case-insensitive on
 * `process.platform === 'win32'` (Windows paths are case-insensitive).
 */

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

  // Ensure the resolved path starts with the workspace root.
  // Handle the filesystem root (e.g. "/") where appending path.sep
  // would produce "//" which path.resolve never emits.
  const isFsRoot = normalizedRoot === path.parse(normalizedRoot).root;
  const prefix = isFsRoot ? normalizedRoot : withSep(normalizedRoot);

  // Allow the root itself (e.g. directory ".") and everything beneath it.
  // Phase 20 (PATH-08): case-insensitive on Windows.
  if (norm(resolved) !== norm(normalizedRoot) && !norm(resolved).startsWith(norm(prefix))) {
    return {
      safe: false,
      resolvedPath: resolved,
      reason: `Path "${filePath}" resolves to "${resolved}" which is outside workspace "${normalizedRoot}".`,
    };
  }

  // ── Phase 20 (PATH-07): symlink escape check ─────────────────
  // Only meaningful when the root actually exists — a nonexistent root
  // cannot contain symlinks, so the lexical check suffices.
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
 * Wrapper that validates a path before passing it to a filesystem
 * operation.  Returns a structured error if the path is unsafe.
 *
 * Phase 18 (PATH-09): `workspaceRoot` is now MANDATORY — there is no
 * silent fallback to the process working directory.  Callers must inject the
 * Orchestrator's `projectRoot`.
 */
export function validateWorkspacePath(
  filePath: string,
  workspaceRoot: string
): PathCheckResult {
  return isPathWithinWorkspace(filePath, workspaceRoot);
}
