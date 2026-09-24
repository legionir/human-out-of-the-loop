import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkspacePath } from './path-security.js';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
});

/**
 * Factory: creates a `read_file` tool bound to `projectRoot`
 * (phase 18 — PATH-01).  The root is injected, never inferred from
 * the process working directory, and the result reports a path RELATIVE to the
 * workspace root so absolute paths of the host are not leaked to the
 * model (SEC-05).
 */
export function createReadFileTool(projectRoot: string) {
  return tool({
    description: 'Reads the full contents of a file at the given path and returns it as a string.',
    inputSchema,
    execute: async ({ filePath, encoding }) => {
      try {
        // Security: validate path is within workspace
        const validation = validateWorkspacePath(filePath, projectRoot);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const content = await fs.readFile(validation.resolvedPath, { encoding: encoding as BufferEncoding });
        return {
          success: true as const,
          filePath: path.relative(projectRoot, validation.resolvedPath),
          content: content as string,
          sizeBytes: Buffer.byteLength(content as string, encoding as BufferEncoding),
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
