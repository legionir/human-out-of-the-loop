import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { headFile, readFileContent, tailFile } from '../fs/lib.js';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
  head: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Return only the first N lines (phase 33, from the MCP reference server)'),
  tail: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Return only the last N lines (phase 33, from the MCP reference server)'),
});

/**
 * Factory: creates a `read_file` tool bound to `projectRoot`
 * (phase 18 — PATH-01).  The root is injected, never inferred from
 * the process working directory, and the result reports a path RELATIVE to the
 * workspace root so absolute paths of the host are not leaked to the
 * model (SEC-05).
 *
 * Phase 33: validation and the line-slicing helpers come from the ported
 * reference filesystem core (`../fs/`): a symlinked parent, a Unicode-equivalent
 * name and a Windows-shaped path are handled exactly like the MCP reference
 * server's `read_text_file`.
 */
export function createReadFileTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Reads the full contents of a file at the given path and returns it as a string. ' +
      'Optionally returns only the first (head) or last (tail) N lines.',
    inputSchema,
    execute: async ({ filePath, encoding, head, tail }, options) => {
      if (options?.abortSignal?.aborted) {
        return { success: false as const, error: 'Aborted', code: 'ABORTED' };
      }
      try {
        // `execute` may also be called directly (tests, programmatic use), so the
        // schema defaults are re-applied here — the SDK applies them only when it
        // validates input itself.
        const enc = encoding ?? 'utf-8';
        // Security: validate path is within workspace (symlink/unicode aware)
        const validation = await resolvePathInWorkspace(filePath, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        if ((head !== undefined || tail !== undefined) && enc !== 'utf-8') {
          return {
            success: false as const,
            error: 'head/tail can only be used with the utf-8 encoding.',
            code: 'INVALID_ARGUMENTS',
          };
        }

        // Reference parity (`read_text_file`): asking for both is ambiguous,
        // and silently returning the head would hide the mistake.
        if (head !== undefined && tail !== undefined) {
          return {
            success: false as const,
            error: 'Cannot specify both head and tail parameters simultaneously.',
            code: 'INVALID_ARGUMENTS',
          };
        }

        const relative = path.relative(projectRoot, validation.resolvedPath) || '.';
        const sliced = head !== undefined ? 'head' : tail !== undefined ? 'tail' : undefined;
        const content =
          head !== undefined
            ? await headFile(validation.resolvedPath, head)
            : tail !== undefined
              ? await tailFile(validation.resolvedPath, tail)
              : ((await readFileContent(validation.resolvedPath, enc)) as string);

        const stats = await fs.stat(validation.resolvedPath);
        return {
          success: true as const,
          filePath: relative,
          content,
          sizeBytes: stats.size,
          ...(sliced ? { sliced, lines: content.length === 0 ? 0 : content.split('\n').length } : {}),
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
