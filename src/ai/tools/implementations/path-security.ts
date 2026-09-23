import path from 'node:path';

/**
 * Validates that a file path is within the allowed workspace root.
 * Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 * Used by all filesystem tools (read_file, write_file, search_code).
 */
export function isPathWithinWorkspace(
  filePath: string,
  workspaceRoot: string
): { safe: boolean; resolvedPath: string; reason?: string } {
  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  // Ensure the resolved path starts with the workspace root
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return {
      safe: false,
      resolvedPath: resolved,
      reason: `Path "${filePath}" resolves to "${resolved}" which is outside workspace "${normalizedRoot}".`,
    };
  }

  return { safe: true, resolvedPath: resolved };
}

/**
 * Wrapper that validates a path before passing it to a filesystem operation.
 * Returns a structured error if the path is unsafe.
 */
export function validateWorkspacePath(
  filePath: string,
  workspaceRoot?: string
): { safe: boolean; resolvedPath: string; reason?: string } {
  const root = workspaceRoot ?? process.cwd();
  return isPathWithinWorkspace(filePath, root);
}
