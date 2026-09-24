import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { moveFile } from '../fs/lib.js';

const inputSchema = z.object({
  source: z.string().min(1, 'source must not be empty'),
  destination: z.string().min(1, 'destination must not be empty'),
});

/**
 * Phase 33: `move_file`, ported from the MCP reference filesystem server.
 *
 * Renaming or relocating a file is a normal part of a coding task, and until now
 * it could only be faked by writing a copy and leaving the original behind.
 *
 * Both ends are validated *before* anything moves, and an existing destination
 * is refused instead of overwritten (the reference's contract — `rename` alone
 * would silently destroy it).
 */
export function createMoveFileTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Moves or renames a file or directory. Both source and destination must be inside the ' +
      'workspace. Fails if the destination already exists.',
    inputSchema,
    execute: async ({ source, destination }) => {
      try {
        const sourceCheck = await resolvePathInWorkspace(source, allowed);
        if (!sourceCheck.safe) {
          return {
            success: false as const,
            error: sourceCheck.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const destinationCheck = await resolvePathInWorkspace(destination, allowed);
        if (!destinationCheck.safe) {
          return {
            success: false as const,
            error: destinationCheck.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        // Like write_file, a move may target a directory that does not exist yet.
        await fs.mkdir(path.dirname(destinationCheck.resolvedPath), { recursive: true });
        await moveFile(sourceCheck.resolvedPath, destinationCheck.resolvedPath);

        return {
          success: true as const,
          source: path.relative(projectRoot, sourceCheck.resolvedPath) || '.',
          destination: path.relative(projectRoot, destinationCheck.resolvedPath) || '.',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false as const,
          error: message,
          code: message.startsWith('Destination already exists:')
            ? 'EEXIST'
            : ((err as NodeJS.ErrnoException).code ?? 'UNKNOWN'),
        };
      }
    },
  });
}
