import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  content: z.string(),
  overwrite: z
    .boolean()
    .default(false)
    .describe('If false and the file already exists, the write is rejected.'),
});

export const writeFileTool = tool({
  description:
    'Writes content to a file. Creates parent directories if needed. Refuses to overwrite existing files unless overwrite=true.',
  inputSchema,
  execute: async ({ filePath, content, overwrite }) => {
    try {
      const resolved = path.resolve(process.cwd(), filePath);

      // Check existence when overwrite is false
      if (!overwrite) {
        try {
          await fs.access(resolved);
          return {
            success: false as const,
            error: `File already exists: ${resolved}. Set overwrite=true to replace.`,
            code: 'EEXIST',
          };
        } catch {
          // File does not exist — safe to create
        }
      }

      // Ensure parent directories
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');

      return {
        success: true as const,
        filePath: resolved,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
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
