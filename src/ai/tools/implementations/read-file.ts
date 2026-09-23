import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { validateWorkspacePath } from './path-security.js';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
});

export const readFileTool = tool({
  description: 'Reads the full contents of a file at the given path and returns it as a string.',
  inputSchema,
  execute: async ({ filePath, encoding }) => {
    try {
      // Security: validate path is within workspace
      const validation = validateWorkspacePath(filePath);
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
        filePath: validation.resolvedPath,
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
