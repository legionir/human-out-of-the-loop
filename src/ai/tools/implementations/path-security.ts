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
 */
export function isPathWithinWorkspace(
  filePath: string,
  workspaceRoot: string
): { safe: boolean; resolvedPath: string; reason?: string } {
  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  // Ensure the resolved path starts with the workspace root.
  // Handle the filesystem root (e.g. "/") where appending path.sep
  // would produce "//" which path.resolve never emits.
  const isFsRoot = normalizedRoot === path.parse(normalizedRoot).root;
  const prefix = isFsRoot ? normalizedRoot : normalizedRoot + path.sep;

  // Allow the root itself (e.g. directory ".") and everything beneath it.
  if (resolved !== normalizedRoot && !resolved.startsWith(prefix)) {
    return {
      safe: false,
      resolvedPath: resolved,
      reason: `Path "${filePath}" resolves to "${resolved}" which is outside workspace "${normalizedRoot}".`,
    };
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
): { safe: boolean; resolvedPath: string; reason?: string } {
  return isPathWithinWorkspace(filePath, workspaceRoot);
}
