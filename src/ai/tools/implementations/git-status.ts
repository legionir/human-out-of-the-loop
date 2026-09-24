import { tool } from 'ai';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  directory: z.string().default('.').describe('Working directory for git status'),
  short: z.boolean().default(true).describe('Use --short format'),
});

/**
 * Factory: creates a `git_status` tool bound to `projectRoot`
 * (phase 18 — PATH-04).  The working directory is validated against
 * `projectRoot` (previously the process working directory with no validation), and
 * the reported directory is relative to the workspace root (SEC-05).
 */
export function createGitStatusTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Runs `git status` in the specified directory and returns the output. Useful for understanding the current state of the working tree.',
    inputSchema,
    execute: async ({ directory, short }) => {
      try {
        // Security: the git working directory must stay inside the workspace
        // (phase 33: the ported reference check — symlink- and Unicode-aware)
        const validation = await resolvePathInWorkspace(directory, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }
        const cwd = validation.resolvedPath;
        const args = ['status'];
        if (short) args.push('--short');

        const { stdout, stderr } = await execFileAsync('git', args, {
          cwd,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });

        return {
          success: true as const,
          directory: path.relative(projectRoot, cwd) || '.',
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
}
