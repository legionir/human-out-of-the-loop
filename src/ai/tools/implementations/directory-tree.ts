import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { isExcludedPath } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().default('.').describe('Root of the tree, relative to the workspace root'),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe("Glob patterns to skip, e.g. ['node_modules', '*.log', 'dist/**']"),
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
 * "What does this project look like?" is the first question every agent asks,
 * and it used to be answered with a pile of `search_code` calls.  The reference
 * returns a JSON tree; this port keeps that shape, adds `maxDepth` (so a
 * `node_modules`-sized tree cannot flood the context) and reports symlinks as
 * `symlink` instead of following them.
 */
export function createDirectoryTreeTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Returns a recursive tree of files and directories as JSON. Supports glob excludePatterns ' +
      "(e.g. ['node_modules', '*.log']) and a maxDepth.",
    inputSchema,
    execute: async ({ path: requestedPath, excludePatterns, maxDepth }) => {
      try {
        // Schema defaults are not applied when execute() is called directly.
        const root = requestedPath ?? '.';
        const excludes = excludePatterns ?? [];
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

        const buildTree = async (currentPath: string, depth: number): Promise<TreeEntry[]> => {
          const entries = await fs.readdir(currentPath, { withFileTypes: true });
          const result: TreeEntry[] = [];

          for (const entry of entries) {
            const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
            const shouldExclude = isExcludedPath(relativePath, excludes);
            if (shouldExclude) continue;

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
              } else {
                entryData.children = await buildTree(path.join(currentPath, entry.name), depth + 1);
              }
            }

            result.push(entryData);
          }

          return result;
        };

        const tree = await buildTree(rootPath, 1);
        return {
          success: true as const,
          path: path.relative(projectRoot, rootPath) || '.',
          maxDepth: depthLimit,
          excluded: excludes,
          entriesVisited,
          tree,
          formatted: JSON.stringify(tree, null, 2),
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
