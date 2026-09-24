import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { formatSize, getFileStats } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must not be empty'),
});

/**
 * Phase 33: `get_file_info`, ported from the MCP reference filesystem server.
 *
 * Answers "is this a file or a directory, how big is it, when did it change?"
 * without reading the content — the cheap check before deciding how to read a
 * large or binary file.
 */
export function createGetFileInfoTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Returns metadata about a file or directory: size, type, permissions and timestamps. ' +
      'Reads no content.',
    inputSchema,
    execute: async ({ path: requestedPath }) => {
      try {
        const validation = await resolvePathInWorkspace(requestedPath, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const resolved = validation.resolvedPath;
        const info = await getFileStats(resolved);
        const linkStats = await fs.lstat(resolved);

        return {
          success: true as const,
          path: path.relative(projectRoot, resolved) || '.',
          name: path.basename(resolved),
          ...info,
          created: info.created.toISOString(),
          modified: info.modified.toISOString(),
          accessed: info.accessed.toISOString(),
          sizeFormatted: formatSize(info.size),
          isSymlink: linkStats.isSymbolicLink(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false as const,
          error: message,
          code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        };
      }
    },
  });
}
