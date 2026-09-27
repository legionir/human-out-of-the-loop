import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace, checkProtectedPath } from './path-security.js';

export function createDeleteFileTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Deletes a file inside the workspace. Directories are refused. Protected paths (.git, .env, …) are refused.',
    inputSchema: z.object({
      filePath: z.string().min(1, 'filePath must not be empty'),
    }),
    execute: async ({ filePath }, options) => {
      if (options?.abortSignal?.aborted) {
        return { success: false as const, error: 'Aborted', code: 'ABORTED' };
      }
      const validation = await resolvePathInWorkspace(filePath, allowed);
      if (!validation.safe) {
        return { success: false as const, error: validation.reason!, code: 'PATH_TRAVERSAL_BLOCKED' };
      }
      const resolved = validation.resolvedPath;
      const protectedCheck = checkProtectedPath(resolved, allowed);
      if (protectedCheck.protected) {
        return { success: false as const, error: protectedCheck.reason!, code: 'PROTECTED_PATH' };
      }
      const relative = path.relative(projectRoot, resolved) || '.';
      try {
        const stats = await fs.lstat(resolved);
        if (stats.isDirectory()) {
          return {
            success: false as const,
            error: `Refusing to delete directory ${relative}.`,
            code: 'IS_DIRECTORY',
          };
        }
        await fs.unlink(resolved);
        return { success: true as const, path: relative };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { success: false as const, error: `File not found: ${relative}`, code: 'ENOENT' };
        }
        return {
          success: false as const,
          error: err instanceof Error ? err.message : String(err),
          code: code ?? 'DELETE_FAILED',
        };
      }
    },
  });
}
