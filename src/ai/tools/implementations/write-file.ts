import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkspacePath } from './path-security.js';

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
      // Security: validate path is within workspace
      const validation = validateWorkspacePath(filePath);
      if (!validation.safe) {
        return {
          success: false as const,
          error: validation.reason!,
          code: 'PATH_TRAVERSAL_BLOCKED',
        };
      }

      const resolved = validation.resolvedPath;

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
