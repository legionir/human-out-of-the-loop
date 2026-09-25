import { tool, type Tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { scanFilesWithValidation, type SearchMatch } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().default('.').describe('Directory to search in, relative to the workspace root'),
  pattern: z
    .string()
    .min(1, 'pattern must not be empty')
    .refine((value) => !value.startsWith('!'), {
      message: "Excluding with '!' is not supported here — put exclusions in excludePatterns.",
    })
    .describe(
      "Glob pattern, POSIX style: '*.ts' matches that name at any depth, 'src/**/*.test.ts' a path. " +
        'Match method mirrors the reference (glob against the relative path).'
    ),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe(
      "Glob patterns to skip, e.g. ['dist', '**/*.min.js']. A bare name excludes it at any depth and a " +
        "leading '!' re-includes ([... '!**/keep.js']). Build/vendor directories are skipped unless " +
        'skipBuildDirs is false.'
    ),
  matchBaseName: z
    .boolean()
    .default(true)
    .describe(
      "A pattern without '/' is matched against the entry NAME at any depth (editor-style '*.ts'), " +
        'not only against the path relative to the search root.'
    ),
  skipBuildDirs: z
    .boolean()
    .default(true)
    .describe(
      'Skip node_modules, .git, dist, build, out, coverage, .next, target, vendor … while walking, ' +
        'the same list search_code uses. Turn off to search them deliberately.'
    ),
  includeFiles: z.boolean().default(true).describe('Include files in the results'),
  includeDirectories: z.boolean().default(true).describe('Include directories in the results'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(200)
    .describe('Ceiling on returned matches; totalMatches still reports the true count'),
});

interface SearchFilesOutcome {
  success: boolean;
  path?: string;
  pattern?: string;
  matchMode?: 'basename' | 'path';
  totalMatches?: number;
  truncated?: boolean;
  matches?: string[];
  counts?: { files: number; directories: number };
  entries?: Array<{ path: string; type: 'file' | 'directory'; size: number; modified: string }>;
  filesScanned?: number;
  directoriesScanned?: number;
  skippedExcluded?: number;
  skippedSymlinks?: number;
  ignoredDirectories?: string[];
  error?: string;
  code?: string;
}

type SearchFilesInput = {
  path: string;
  pattern: string;
  excludePatterns: string[];
  matchBaseName: boolean;
  skipBuildDirs: boolean;
  includeFiles: boolean;
  includeDirectories: boolean;
  maxResults: number;
};

/**
 * Phase 36: `search_files`, brought up to `search_code`'s level.
 *
 * The phase-33 port was faithful to the reference and therefore a little thin:
 * the pattern was matched against the relative path only (`*.ts` found nothing
 * below the root — you had to know to write the `**` + slash form), there were no default
 * excludes, so a scan walked `node_modules` unless the caller named it, and the
 * result was a bare path list with no way to tell "file" from "directory".
 *
 * This version keeps the reference contract — a glob over the workspace,
 * `excludePatterns`, a total, a sorted relative path list — and adds what makes
 * a file finder usable:
 *   - `matchBaseName` (default **true**): `*.ts` is a *name*, matched at any
 *     depth, like an editor's file finder and like `search_code`'s defaults;
 *   - `skipBuildDirs` (default **true**): `node_modules`, `dist`, `.git`, … are
 *     not walked, and the skipped names are reported in `ignoredDirectories`;
 *   - `!` re-includes inside `excludePatterns`;
 *   - `includeFiles` / `includeDirectories` and a `counts` summary, so
 *     "find the test directories" is one call;
 *   - `withMetadata`-style sizes: matched files carry `size` and `modified`
 *     (via `lstat` — a symlink is reported as itself, never followed);
 *   - `filesScanned`, `directoriesScanned`, `skippedExcluded`, `skippedSymlinks`
 *     — an empty result now says *why* it is empty.
 *
 * Matching is done on POSIX separators on every host, which fixes a real
 * Windows bug in the port: a relative path with `\` was handed to `minimatch`,
 * where a backslash is an escape character, so a path pattern like `src/**` + `/*.ts` matched nothing on Windows.
 */
export function createSearchFilesTool(projectRoot: string) {
  const allowed = [projectRoot];

  const searchFilesTool: Tool<SearchFilesInput, SearchFilesOutcome> & {
    execute: (input: SearchFilesInput) => Promise<SearchFilesOutcome>;
  } = {
    description:
      'Recursively finds files and directories whose name or path matches a glob pattern. ' +
      "'*.ts' matches that name at any depth (set matchBaseName: false to match the whole relative " +
      'path), directory names are matched too, and build/vendor directories are skipped unless ' +
      'skipBuildDirs is false. Returns workspace-relative paths, sorted, with per-type counts.',
    inputSchema,
    execute: async (input) => {
      const {
        path: requestedPath = '.',
        pattern,
        excludePatterns = [],
        matchBaseName = true,
        skipBuildDirs = true,
        includeFiles = true,
        includeDirectories = true,
        maxResults = 200,
      } = input ?? {};

      try {
        if (!includeFiles && !includeDirectories) {
          return {
            success: false,
            error:
              'includeFiles and includeDirectories cannot both be false — nothing could match.',
            code: 'INVALID_ARGUMENTS',
          };
        }

        const validation = await resolvePathInWorkspace(requestedPath, allowed);
        if (!validation.safe) {
          return {
            success: false,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const rootPath = validation.resolvedPath;
        const scan = await scanFilesWithValidation(rootPath, pattern, allowed, {
          excludePatterns,
          matchBaseName,
          skipBuildDirs,
          includeFiles,
          includeDirectories,
        });

        const sorted = [...scan.matches].sort((left, right) =>
          left.relative.localeCompare(right.relative)
        );
        const truncated = sorted.length > maxResults;
        const limited: SearchMatch[] = sorted.slice(0, maxResults);

        const counts = {
          files: scan.matches.filter((match) => match.type === 'file').length,
          directories: scan.matches.filter((match) => match.type === 'directory').length,
        };

        return {
          success: true,
          path: path.relative(projectRoot, rootPath) || '.',
          pattern,
          matchMode: matchBaseName && !pattern.includes('/') ? 'basename' : 'path',
          totalMatches: scan.matches.length,
          truncated,
          matches: limited.map((match) => match.relative),
          counts,
          entries: limited.map((match) => ({
            path: match.relative,
            type: match.type,
            size: match.size,
            modified: match.modified,
          })),
          filesScanned: scan.filesScanned,
          directoriesScanned: scan.directoriesScanned,
          skippedExcluded: scan.skippedExcluded,
          skippedSymlinks: scan.skippedSymlinks,
          ignoredDirectories: scan.ignoredDirectories,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: message,
          code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        };
      }
    },
  };

  return tool(searchFilesTool);
}
