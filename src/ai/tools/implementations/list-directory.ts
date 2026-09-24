import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';

const inputSchema = z.object({
  path: z.string().default('.').describe('Directory to list, relative to the workspace root'),
});

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

/**
 * Phase 33: `list_directory`, ported from the MCP reference filesystem server.
 *
 * The model used to have no way to look at a directory: it either knew a file
 * name or it searched for content.  Entries are reported both structured and as
 * the reference's `[DIR] name` / `[FILE] name` lines, which models read well.
 *
 * A symlink is reported as `symlink` (never silently followed): whether it is
 * usable inside the workspace is decided by the path check on the *next* tool
 * call, not hidden here.
 */
export function createListDirectoryTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Lists the files and directories in a directory. Results mark each entry as [DIR] or [FILE].',
    inputSchema,
    execute: async ({ path: requestedPath }) => {
      try {
        const target = requestedPath ?? '.';
        const validation = await resolvePathInWorkspace(target, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const resolved = validation.resolvedPath;
        const entries = await fs.readdir(resolved, { withFileTypes: true });

        const described = entries.map((entry) => {
          const type: EntryType = entry.isSymbolicLink()
            ? 'symlink'
            : entry.isDirectory()
              ? 'directory'
              : entry.isFile()
                ? 'file'
                : 'other';
          return { name: entry.name, type };
        });

        // Directories first, then files — the reference's [DIR]/[FILE] format.
        const sorted = described.sort((a, b) => {
          if (a.type !== b.type) {
            if (a.type === 'directory') return -1;
            if (b.type === 'directory') return 1;
          }
          return a.name.localeCompare(b.name);
        });

        const formatted = sorted
          .map((entry) => `${entry.type === 'directory' ? '[DIR]' : '[FILE]'} ${entry.name}`)
          .join('\n');

        return {
          success: true as const,
          path: path.relative(projectRoot, resolved) || '.',
          count: sorted.length,
          directories: sorted.filter((e) => e.type === 'directory').length,
          files: sorted.filter((e) => e.type === 'file').length,
          entries: sorted,
          formatted: formatted || '(empty directory)',
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
