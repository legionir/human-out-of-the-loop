import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace, checkProtectedPath } from './path-security.js';
import { writeFileContent } from '../fs/lib.js';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  content: z.string(),
  overwrite: z
    .boolean()
    .default(false)
    .describe('If false and the file already exists, the write is rejected.'),
});

/**
 * Factory: creates a `write_file` tool bound to `projectRoot`
 * (phase 18 — PATH-02).  The root is injected, never inferred from
 * the process working directory.  Paths reported back to the model are relative to
 * the workspace root (SEC-05).
 *
 * Phase 33: the write itself is the ported reference implementation
 * (`writeFileContent`): `wx` for a new file (never writing through a
 * pre-existing symlink), temp file + `rename` for an existing one (atomic,
 * symlink-safe, original permissions restored).
 */
export function createWriteFileTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Writes content to a file. Creates parent directories if needed. Refuses to overwrite existing files unless overwrite=true.',
    inputSchema,
    execute: async ({ filePath, content, overwrite }, options) => {
      if (options?.abortSignal?.aborted) {
        return { success: false as const, error: 'Aborted', code: 'ABORTED' };
      }
      try {
        // Schema defaults are not applied when execute() is called directly.
        const replaceExisting = overwrite ?? false;
        // Security: validate path is within workspace (symlink/unicode aware)
        const validation = await resolvePathInWorkspace(filePath, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const resolved = validation.resolvedPath;
        const protectedCheck = checkProtectedPath(resolved, allowed);
        if (protectedCheck.protected) {
          return {
            success: false as const,
            error: protectedCheck.reason!,
            code: 'PROTECTED_PATH',
          };
        }
        const relative = path.relative(projectRoot, resolved) || '.';

        if (!replaceExisting) {
          try {
            await fs.access(resolved);
            return {
              success: false as const,
              error: `File already exists: ${relative}. Set overwrite=true to replace.`,
              code: 'EEXIST',
            };
          } catch {
            // File does not exist — safe to create
          }
        }

        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await writeFileContent(resolved, content);

        return {
          success: true as const,
          filePath: relative,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          overwritten: replaceExisting,
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
