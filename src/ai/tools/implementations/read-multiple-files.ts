import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { readFileContent } from '../fs/lib.js';

const inputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1, 'at least one path is required')
    .max(50, 'at most 50 files per call')
    .describe('File paths to read, relative to the workspace root'),
});

/** Cap per file so one huge file cannot swallow the whole context window. */
const MAX_CHARS_PER_FILE = 100_000;

/**
 * Phase 33: `read_multiple_files`, ported from the MCP reference filesystem
 * server.
 *
 * Reading five files to compare them used to cost five tool calls and five
 * round-trips.  One failure does not abort the batch — the caller gets the
 * content of what could be read and an explicit error for what could not, which
 * is exactly what "compare these files" needs.
 */
export function createReadMultipleFilesTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Reads several files in one call and returns each file with its path. ' +
      'A file that cannot be read is reported with its error; the others are still returned.',
    inputSchema,
    execute: async ({ paths }) => {
      const files = await Promise.all(
        paths.map(async (requestedPath) => {
          try {
            const validation = await resolvePathInWorkspace(requestedPath, allowed);
            if (!validation.safe) {
              return { path: requestedPath, error: validation.reason!, code: 'PATH_TRAVERSAL_BLOCKED' };
            }

            const relative = path.relative(projectRoot, validation.resolvedPath) || '.';
            const content = (await readFileContent(validation.resolvedPath, 'utf-8')) as string;
            const truncated = content.length > MAX_CHARS_PER_FILE;
            return {
              path: relative,
              content: truncated ? content.slice(0, MAX_CHARS_PER_FILE) : content,
              bytes: Buffer.byteLength(content, 'utf-8'),
              ...(truncated ? { truncated: true } : {}),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              path: requestedPath,
              error: message,
              code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
            };
          }
        })
      );

      const failed = files.filter((file) => 'error' in file);
      return {
        success: failed.length === 0,
        requested: paths.length,
        read: files.length - failed.length,
        failed: failed.length,
        files,
      };
    },
  });
}
