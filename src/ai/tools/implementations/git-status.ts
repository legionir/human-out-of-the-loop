import { tool } from 'ai';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  directory: z.string().default('.').describe('Working directory for git status'),
  short: z.boolean().default(true).describe('Use --short format'),
});

export const gitStatusTool = tool({
  description:
    'Runs `git status` in the specified directory and returns the output. Useful for understanding the current state of the working tree.',
  inputSchema,
  execute: async ({ directory, short }) => {
    try {
      const cwd = path.resolve(process.cwd(), directory);
      const args = ['status'];
      if (short) args.push('--short');

      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });

      return {
        success: true as const,
        directory: cwd,
        output: stdout.trim(),
        warnings: stderr.trim() || undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;

      // Distinguish "git not found" / "not a repo" from generic errors
      if (message.includes('not a git repository') || code === 'ENOENT') {
        return {
          success: false as const,
          error: message,
          code: 'NOT_A_GIT_REPO',
        };
      }

      return {
        success: false as const,
        error: message,
        code: code ?? 'UNKNOWN',
      };
    }
  },
});
