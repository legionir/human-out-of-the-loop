import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
});

export const readFileTool = tool({
  description: 'Reads the full contents of a file at the given path and returns it as a string.',
  inputSchema,
  execute: async ({ filePath, encoding }) => {
    try {
      const resolved = path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(resolved, { encoding: encoding as BufferEncoding });
      return {
        success: true as const,
        filePath: resolved,
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
