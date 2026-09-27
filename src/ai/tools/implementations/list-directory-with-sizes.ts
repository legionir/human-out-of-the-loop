import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { formatSize } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().default('.').describe('Directory to list, relative to the workspace root'),
  sortBy: z
    .enum(['name', 'size'])
    .default('name')
    .describe("Sort entries by 'name' (default) or by 'size' (largest first)"),
});

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

interface SizedEntry {
  name: string;
  type: EntryType;
  size: number;
  sizeFormatted: string;
  modified: string;
}

/**
 * Phase 35: `list_directory_with_sizes`, the last listing tool of the MCP
 * reference filesystem server.
 *
 * `list_directory` answers "what is here?"; this answers "what is heavy?" —
 * which is the question that precedes any cleanup, review or "why is the repo
 * 40 MB?" investigation. It reports each entry's size and mtime, sorts by name
 * or by size (largest first), and renders the reference's padded layout:
 *
 *     [DIR] src
 *     [FILE] package-lock.json          512.00 KB
 *
 *     Total: 12 files, 3 directories
 *     Combined size: 1.20 MB
 *
 * Sizes are reported for *files* only: a directory's inode size says
 * nothing about its contents and a symlink's is the length of its target path,
 * so both report 0 and the totals/ordering talk about bytes on disk.
 *
 * Two deliberate deviations from the reference:
 *   - `lstat` instead of `stat`: a symlink is reported as `[LINK]` rather
 *     than followed, so listing a directory can never resolve a path outside
 *     the workspace (the same rule `list_directory` follows);
 *   - an entry whose metadata cannot be read is reported with `size: 0` and an
 *     `unreadable: true` flag instead of silently pretending it is empty —
 *     the phase-27 lesson applied to listing.
 */
export function createListDirectoryWithSizesTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Lists a directory with each entry size, type and modification time, sorted by name or by ' +
      'size (largest first), plus the totals for the directory.',
    inputSchema,
    execute: async ({ path: requestedPath, sortBy }) => {
      const target = requestedPath ?? '.';
      const order = sortBy ?? 'name';

      try {
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

        const described: Array<SizedEntry & { unreadable?: true }> = await Promise.all(
          entries.map(async (entry) => {
            const entryPath = path.join(resolved, entry.name);
            const type: EntryType = entry.isSymbolicLink()
              ? 'symlink'
              : entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                  ? 'file'
                  : 'other';

            try {
              // `lstat`: never follow a link while listing.
              const stats = await fs.lstat(entryPath);
              // Only a regular file has a meaningful "size": a directory's
              // inode size says nothing about its contents, and a symlink's is
              // the length of its target path.  Both report 0, so the totals
              // and the by-size ordering talk about bytes on disk.
              const size = type === 'file' ? stats.size : 0;
              return {
                name: entry.name,
                type,
                size,
                sizeFormatted: size > 0 ? formatSize(size) : '',
                modified: stats.mtime.toISOString(),
              };
            } catch {
              return {
                name: entry.name,
                type,
                size: 0,
                sizeFormatted: '',
                modified: new Date(0).toISOString(),
                unreadable: true as const,
              };
            }
          })
        );

        const sorted = [...described].sort((left, right) =>
          order === 'size'
            ? right.size - left.size || left.name.localeCompare(right.name)
            : left.name.localeCompare(right.name)
        );

        const marker = (type: EntryType): string =>
          type === 'directory' ? '[DIR]' : type === 'symlink' ? '[LINK]' : '[FILE]';

        const formattedEntries = sorted.map(
          (entry) =>
            `${marker(entry.type)} ${entry.name.padEnd(30)} ` +
            `${entry.size > 0 ? entry.sizeFormatted.padStart(10) : ''}`.trimEnd()
        );

        const files = described.filter((entry) => entry.type === 'file');
        const directories = described.filter((entry) => entry.type === 'directory');
        const totalSize = files.reduce((sum, entry) => sum + entry.size, 0);

        const summary = [
          '',
          `Total: ${files.length} files, ${directories.length} directories`,
          `Combined size: ${formatSize(totalSize)}`,
        ];

        return {
          success: true as const,
          path: path.relative(projectRoot, resolved) || '.',
          sortBy: order,
          count: sorted.length,
          entries: sorted,
          totalFiles: files.length,
          totalDirectories: directories.length,
          totalSize,
          totalSizeFormatted: formatSize(totalSize),
          unreadableCount: described.filter((entry) => entry.unreadable).length,
          formatted: [...formattedEntries, ...summary].join('\n'),
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
