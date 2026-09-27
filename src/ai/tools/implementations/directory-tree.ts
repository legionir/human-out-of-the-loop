import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { DEFAULT_EXCLUDE_DIRS, isExcludedPath } from '../fs/lib.js';

export const DIRECTORY_TREE_MAX_ENTRIES = 500;

const inputSchema = z.object({
  path: z.string().default('.').describe('Root of the tree, relative to the workspace root'),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe("Extra glob patterns to skip, e.g. ['*.log']. Build/vendor dirs are skipped by default."),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('How deep to recurse (default 5) — keeps a huge tree from flooding the context'),
});

interface TreeEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  children?: TreeEntry[];
  /** Set when the recursion stopped here, so the model knows it is incomplete. */
  truncated?: true;
}

/**
 * Phase 33: `directory_tree`, ported from the MCP reference filesystem server.
 *
 * F-03: build/vendor directories are skipped by default, the walk stops at
 * 500 entries, and the result is JSON only (no duplicate `formatted` blob).
 */
export function createDirectoryTreeTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Returns a recursive JSON tree of files and directories. Skips build/vendor dirs by default; caps at 500 entries.',
    inputSchema,
    execute: async ({ path: requestedPath, excludePatterns, maxDepth }) => {
      try {
        const root = requestedPath ?? '.';
        const excludes = [
          ...DEFAULT_EXCLUDE_DIRS,
          ...((excludePatterns ?? []).filter((p) => !DEFAULT_EXCLUDE_DIRS.has(p))),
        ];
        const depthLimit = maxDepth ?? 5;
        const validation = await resolvePathInWorkspace(root, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const rootPath = validation.resolvedPath;
        let entriesVisited = 0;
        let truncated = false;

        const buildTree = async (currentPath: string, depth: number): Promise<TreeEntry[]> => {
          if (entriesVisited >= DIRECTORY_TREE_MAX_ENTRIES) {
            truncated = true;
            return [];
          }
          const entries = await fs.readdir(currentPath, { withFileTypes: true });
          const result: TreeEntry[] = [];

          for (const entry of entries) {
            if (entriesVisited >= DIRECTORY_TREE_MAX_ENTRIES) {
              truncated = true;
              break;
            }
            const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
            if (isExcludedPath(relativePath, excludes)) continue;
            if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;

            entriesVisited++;
            if (entry.isSymbolicLink()) {
              result.push({ name: entry.name, type: 'symlink' });
              continue;
            }

            const entryData: TreeEntry = {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
            };

            if (entry.isDirectory()) {
              if (depth >= depthLimit) {
                entryData.children = [];
                entryData.truncated = true;
                truncated = true;
              } else {
                entryData.children = await buildTree(path.join(currentPath, entry.name), depth + 1);
              }
            }

            result.push(entryData);
          }

          return result;
        };

        const tree = await buildTree(rootPath, 1);
        const payload: {
          success: true;
          path: string;
          maxDepth: number;
          entriesVisited: number;
          truncated?: true;
          tree: TreeEntry[];
        } = {
          success: true as const,
          path: path.relative(projectRoot, rootPath) || '.',
          maxDepth: depthLimit,
          entriesVisited,
          ...(truncated ? { truncated: true as const } : {}),
          tree,
        };
        const MAX_RESULT_BYTES = 19_000;
        while (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RESULT_BYTES && payload.tree.length > 0) {
          payload.tree.pop();
          payload.truncated = true;
          payload.entriesVisited = Math.max(0, payload.entriesVisited - 1);
        }
        return payload;
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
