import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must not be empty'),
});

/**
 * Phase 33: `create_directory`, ported from the MCP reference filesystem server.
 *
 * `write_file` could already create a parent chain as a side effect; this makes
 * the intent explicit (and says whether anything was actually created), which
 * matters because a plan step "set up the directory layout" is verifiable only
 * if it has its own tool call.
 *
 * Creating a directory that already exists succeeds silently — that is the
 * reference's contract and the one that keeps re-runs idempotent.
 */
export function createCreateDirectoryTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Creates a directory (and any missing parents). Succeeds silently when it already exists.',
    inputSchema,
    execute: async ({ path: requestedPath }) => {
      try {
        // A directory that does not exist yet is the point of the call, so the
        // check resolves the path and its existing ancestors (never `mkdir` of a
        // path that escapes the workspace through a symlinked parent).
        const target = path.isAbsolute(requestedPath)
          ? requestedPath
          : path.resolve(projectRoot, requestedPath);
        const validation = await resolvePathInWorkspace(target, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const resolved = validation.resolvedPath;
        const existed = await fs
          .stat(resolved)
          .then(() => true)
          .catch(() => false);

        await fs.mkdir(resolved, { recursive: true });

        return {
          success: true as const,
          path: path.relative(projectRoot, resolved) || '.',
          created: !existed,
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
