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

/**
 * Recursively walks `dir` and returns files matching the optional extension.
 */
async function walkDir(dir: string, ext?: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip common noise directories
      if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
      results.push(...(await walkDir(full, ext)));
    } else if (entry.isFile()) {
      if (!ext || entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  }
  return results;
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

        const files = await walkDir(resolvedDir, fileExtension);
        const matches: Match[] = [];

        for (const file of files) {
          if (matches.length >= maxResults) break;
          try {
            const content = await fs.readFile(file, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push({
                  file: path.relative(projectRoot, file),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
                if (matches.length >= maxResults) break;
              }
              // Reset regex lastIndex for global flag
              regex.lastIndex = 0;
            }
          } catch {
            // Skip unreadable files silently
          }
        }

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
