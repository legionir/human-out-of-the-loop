import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { searchFilesWithValidation } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().default('.').describe('Directory to search in, relative to the workspace root'),
  pattern: z
    .string()
    .min(1, 'pattern must not be empty')
    .describe("Glob pattern relative to the search path, e.g. '*.ts' or '**/*.test.ts'"),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe("Glob patterns to skip, e.g. ['node_modules/**', 'dist/**']"),
  maxResults: z.number().int().min(1).max(1000).default(200),
});

/**
 * Phase 33: `search_files`, ported from the MCP reference filesystem server.
 *
 * The glob counterpart of `search_code`: `search_code` finds *content*
 * (regex), this finds *names* — the difference between "where is fooBar
 * called?" and "which test files exist?".  Symlinks that leave the workspace are
 * skipped by the shared path validation, and a refused or unreadable entry never
 * fails the whole search.
 */
export function createSearchFilesTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Recursively finds files and directories whose path matches a glob pattern ' +
      "(e.g. '**/*.test.ts'). Returns paths relative to the workspace root.",
    inputSchema,
    execute: async ({ path: requestedPath, pattern, excludePatterns, maxResults }) => {
      try {
        const root = requestedPath ?? '.';
        const excludes = excludePatterns ?? [];
        const limit = maxResults ?? 200;
        const validation = await resolvePathInWorkspace(root, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const rootPath = validation.resolvedPath;
        const found = await searchFilesWithValidation(rootPath, pattern, allowed, {
          excludePatterns: excludes,
        });

        const truncated = found.length > limit;
        const matches = found
          .slice(0, limit)
          .map((absolute) => path.relative(projectRoot, absolute))
          .sort();

        return {
          success: true as const,
          path: path.relative(projectRoot, rootPath) || '.',
          pattern,
          totalMatches: found.length,
          truncated,
          matches,
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
