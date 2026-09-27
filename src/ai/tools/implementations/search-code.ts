import { tool } from 'ai';
import { z } from 'zod';
import { resolvePathInWorkspace } from './path-security.js';
import { formatContentMatches, searchContentTree } from '../fs/content-search.js';
import { isUnsafeRegex, MAX_PATTERN_LENGTH } from './regex-guard.js';

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1, 'Search pattern must not be empty')
    .max(MAX_PATTERN_LENGTH, `Search pattern must be at most ${MAX_PATTERN_LENGTH} characters`)
    .describe('Content to search for: a regular expression (or literal text with literal=true)'),
  directory: z.string().default('.').describe('Directory to search in, relative to the workspace root'),
  pathPattern: z
    .string()
    .max(MAX_PATTERN_LENGTH)
    .optional()
    .describe(
      "Only search files whose workspace-relative path matches this regular expression, e.g. '\\.tsx?$' or '^src/'. Case follows caseSensitive."
    ),
  fileExtension: z
    .string()
    .optional()
    .describe("Shorthand include filter, e.g. '.ts'. Prefer pathPattern when several extensions are involved."),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe(
      "Glob patterns to skip, e.g. ['**/*.min.js', 'vendor']. A bare name excludes it at any depth. " +
        'Build/vendor directories (node_modules, dist, .git, …) are skipped by default.'
    ),
  caseSensitive: z
    .boolean()
    .default(false)
    .describe('VS Code "Match Case": when false (default) the search ignores letter case.'),
  wholeWord: z
    .boolean()
    .default(false)
    .describe('VS Code "Match Whole Word": the match must not be part of a larger word.'),
  literal: z
    .boolean()
    .default(false)
    .describe('VS Code "Use Regular Expression" turned OFF: treat pattern as plain text, not a regex.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe('How many lines of surrounding context to include for each match (default 0).'),
  maxMatchesPerFile: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(20)
    .describe('Ceiling per file, so one generated/large file cannot consume the whole result budget.'),
  maxResults: z.number().int().min(1).max(500).default(50).describe('Total match ceiling'),
});

/**
 * Factory: creates a `search_code` tool bound to `projectRoot`
 * (phase 18 — PATH-03, SEC-01, SEC-06).
 *
 * Phase 34 — VS Code-style search.  `pattern` finds content; `pathPattern` and
 * `excludePatterns` decide which files are worth reading; `caseSensitive`,
 * `wholeWord` and `literal` are VS Code's three toggles; every occurrence is
 * reported with its line **and column**, optionally with context lines.
 *
 * The old contract is intact: the same input names (`pattern`, `directory`,
 * `fileExtension`, `maxResults`) mean the same thing, matches carry
 * `{file, line, text}` relative to the workspace root, and unreadable entries
 * are reported through the exact `skippedCount` / capped `skipped` pair
 * (SEC-02).  The walk and match engine itself now lives in
 * `../fs/content-search.ts`, next to the other filesystem primitives.
 */
export function createSearchCodeTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Search file contents with a regex. Returns relative path, line, column, and matching text.',
    inputSchema,
    execute: async (input) => {
      const {
        pattern,
        directory,
        pathPattern,
        fileExtension,
        excludePatterns,
        caseSensitive,
        wholeWord,
        literal,
        contextLines,
        maxMatchesPerFile,
        maxResults,
      } = input;

      // Defaults are re-applied here: `execute` can also be called directly.
      const target = directory ?? '.';
      const excludes = excludePatterns ?? [];
      const sensitive = caseSensitive ?? false;
      const asText = literal ?? false;
      const exactWord = wholeWord ?? false;
      const context = contextLines ?? 0;
      const perFile = maxMatchesPerFile ?? 20;
      const limit = maxResults ?? 50;

      try {
        // Security: the search directory must stay inside the workspace
        // (phase 33: the ported reference check — symlink- and Unicode-aware)
        const validation = await resolvePathInWorkspace(target, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        // Security: ReDoS guard (defensive — the schema already caps length).
        // Both patterns are model-supplied and both are executed against
        // untrusted file names/lines, so both are checked.
        for (const [field, value] of [
          ['pattern', pattern],
          ['pathPattern', pathPattern],
        ] as const) {
          if (value === undefined) continue;
          if (value.length > MAX_PATTERN_LENGTH) {
            return {
              success: false as const,
              error: `${field} too long (${value.length} > ${MAX_PATTERN_LENGTH} characters).`,
              code: 'PATTERN_TOO_LONG',
            };
          }
          if (isUnsafeRegex(value)) {
            return {
              success: false as const,
              error:
                `${field} rejected: it contains nested quantifiers that can cause catastrophic ` +
                'backtracking. Rewrite it without quantified groups containing quantifiers ' +
                '(e.g. use "a+b" instead of "(a+)").',
              code: 'UNSAFE_REGEX',
            };
          }
        }

        const flags = sensitive ? '' : 'i';
        let source = pattern;
        if (asText) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Whole-word via lookarounds rather than \b: a pattern that starts or
        // ends with punctuation ("\.ts") must still match at a word boundary.
        if (exactWord) source = `(?<![A-Za-z0-9_$])(?:${source})(?![A-Za-z0-9_$])`;

        let contentRegex: RegExp;
        let pathRegex: RegExp | undefined;
        try {
          contentRegex = new RegExp(source, flags);
          if (pathPattern !== undefined) pathRegex = new RegExp(pathPattern, flags);
        } catch (err) {
          return {
            success: false as const,
            error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
            code: 'INVALID_REGEX',
          };
        }

        const outcome = await searchContentTree({
          baseDirectory: validation.resolvedPath,
          workspaceRoot: projectRoot,
          contentRegex,
          pathRegex,
          excludePatterns: excludes,
          fileExtensions: fileExtension ? [fileExtension] : undefined,
          contextLines: context,
          maxResults: limit,
          maxMatchesPerFile: perFile,
        });

        return {
          success: true as const,
          pattern,
          ...(pathPattern !== undefined ? { pathPattern } : {}),
          totalMatches: outcome.matches.length,
          fileCount: outcome.files.length,
          files: outcome.files,
          truncated: outcome.truncated || outcome.matches.length >= limit,
          matches: outcome.matches,
          formatted: formatContentMatches(outcome.matches),
          filesScanned: outcome.filesScanned,
          // SEC-02: `skippedCount` is exact; `skipped` is capped for payload size.
          skippedCount: outcome.skipped.length,
          skipped: outcome.skipped.slice(0, SKIPPED_REPORT_LIMIT),
          // Not errors — a binary or oversized file simply has no text to search.
          skippedBinary: outcome.skippedBinary,
          skippedTooLarge: outcome.skippedTooLarge,
          skippedSymlinks: outcome.skippedSymlinks,
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

/**
 * Phase 27 (SEC-02): a path the search could not read.  The old code
 * swallowed read errors entirely, so a permission problem looked
 * identical to "no matches" — the model (and the user) never learned
 * that part of the tree was skipped.
 */
/** Cap on reported entries — the COUNT is always exact. */
const SKIPPED_REPORT_LIMIT = 20;
