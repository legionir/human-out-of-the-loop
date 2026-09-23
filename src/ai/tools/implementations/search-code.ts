import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkspacePath } from './path-security.js';
import { isUnsafeRegex, MAX_PATTERN_LENGTH } from './regex-guard.js';

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1, 'Search pattern must not be empty')
    .max(MAX_PATTERN_LENGTH, `Search pattern must be at most ${MAX_PATTERN_LENGTH} characters`),
  directory: z.string().default('.'),
  fileExtension: z.string().optional(),
  maxResults: z.number().int().min(1).max(500).default(50),
});

interface Match {
  file: string;
  line: number;
  text: string;
}

const NOISE_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);

/**
 * Phase 21 (PERF-05): single-pass search with EARLY EXIT.
 *
 * The old design was two-phase: `walkDir` collected EVERY file first
 * (O(entire tree) syscalls) and only then did the matching loop stop
 * at `maxResults`.  Now walking and matching are one recursion that
 * aborts the moment `maxResults` matches are collected — a tree of
 * 10k files with a match in the first directory costs ~1 readdir +
 * 1 readFile instead of 10k+ reads.
 */
interface SearchOptions {
  ext?: string;
  regex: RegExp;
  maxResults: number;
  projectRoot: string;
  matches: Match[];
}

async function searchFiles(dir: string, opts: SearchOptions): Promise<void> {
  // Early exit: a parent call found enough matches while we were recursing
  if (opts.matches.length >= opts.maxResults) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (opts.matches.length >= opts.maxResults) return; // early exit
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (NOISE_DIRS.has(entry.name)) continue;
      await searchFiles(full, opts);
    } else if (entry.isFile()) {
      if (opts.ext && !entry.name.endsWith(opts.ext)) continue;
      try {
        const content = await fs.readFile(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && opts.matches.length < opts.maxResults; i++) {
          if (opts.regex.test(lines[i])) {
            opts.matches.push({
              file: path.relative(opts.projectRoot, full),
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
          }
          // Reset regex lastIndex for global flag
          opts.regex.lastIndex = 0;
        }
      } catch {
        // Skip unreadable files silently
      }
    }
  }
}

/**
 * Factory: creates a `search_code` tool bound to `projectRoot`
 * (phase 18 — PATH-03, SEC-01, SEC-06):
 *   - `directory` is validated against `projectRoot` (no more
 *     the process working directory),
 *   - the pattern is checked for catastrophic backtracking (ReDoS)
 *     and capped at `MAX_PATTERN_LENGTH`,
 *   - matched file paths are reported relative to `projectRoot`.
 */
export function createSearchCodeTool(projectRoot: string) {
  return tool({
    description:
      'Searches for a regex pattern across files in a directory. Returns matching lines with file path and line number.',
    inputSchema,
    execute: async ({ pattern, directory, fileExtension, maxResults }) => {
      try {
        // Security: the search directory must stay inside the workspace
        const validation = validateWorkspacePath(directory, projectRoot);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }
        const resolvedDir = validation.resolvedPath;

        // Security: ReDoS guard (defensive — the schema already caps length)
        if (pattern.length > MAX_PATTERN_LENGTH) {
          return {
            success: false as const,
            error: `Search pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH} characters).`,
            code: 'PATTERN_TOO_LONG',
          };
        }
        if (isUnsafeRegex(pattern)) {
          return {
            success: false as const,
            error:
              'Search pattern rejected: it contains nested quantifiers that can cause catastrophic backtracking. Rewrite the pattern without quantified groups containing quantifiers (e.g. use "a+b" instead of "(a+)+").',
            code: 'UNSAFE_REGEX',
          };
        }

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'gi');
        } catch (err) {
          return {
            success: false as const,
            error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
            code: 'INVALID_REGEX',
          };
        }

        // Phase 21 (PERF-05): walk + match in one pass, stopping early
        const matches: Match[] = [];
        await searchFiles(resolvedDir, {
          ext: fileExtension,
          regex,
          maxResults,
          projectRoot,
          matches,
        });

        return {
          success: true as const,
          pattern,
          totalMatches: matches.length,
          truncated: matches.length >= maxResults,
          matches,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false as const,
          error: message,
        };
      }
    },
  });
}
