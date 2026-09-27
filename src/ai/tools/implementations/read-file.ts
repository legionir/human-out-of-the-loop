import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { headFile, tailFile } from '../fs/lib.js';

export const DEFAULT_READ_MAX_BYTES = 65_536;

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Byte offset to start reading from (F-03 pagination)'),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(DEFAULT_READ_MAX_BYTES)
    .describe(`Maximum bytes to return (default ${DEFAULT_READ_MAX_BYTES})`),
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
      'Reads a file. Defaults to the first 64KiB; pass offset/maxBytes to page. Optionally head/tail lines.',
    inputSchema,
    execute: async ({ filePath, encoding, offset, maxBytes, head, tail }, options) => {
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
        const stats = await fs.stat(validation.resolvedPath);
        const start = offset ?? 0;
        const cap = maxBytes ?? DEFAULT_READ_MAX_BYTES;

        let content: string;
        let truncated = false;
        if (head !== undefined) {
          content = await headFile(validation.resolvedPath, head);
        } else if (tail !== undefined) {
          content = await tailFile(validation.resolvedPath, tail);
        } else {
          const handle = await fs.open(validation.resolvedPath, 'r');
          try {
            const length = Math.min(cap, Math.max(0, stats.size - start));
            const slice = Buffer.alloc(length);
            const { bytesRead } = await handle.read(slice, 0, slice.length, start);
            const buf = slice.subarray(0, bytesRead);
            content = enc === 'base64' ? buf.toString('base64') : buf.toString('utf-8');
            truncated = start + bytesRead < stats.size;
          } finally {
            await handle.close();
          }
        }

        if (Buffer.byteLength(content, enc === 'base64' ? 'ascii' : 'utf-8') > cap) {
          const buf = Buffer.from(content, enc === 'base64' ? 'base64' : 'utf-8').subarray(0, cap);
          content = enc === 'base64' ? buf.toString('base64') : buf.toString('utf-8');
          truncated = true;
        }

        return {
          success: true as const,
          filePath: relative,
          content,
          sizeBytes: stats.size,
          offset: start,
          maxBytes: cap,
          truncated,
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
