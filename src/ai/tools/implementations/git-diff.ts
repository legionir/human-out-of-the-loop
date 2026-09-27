import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { ensureRepo, failureResult, isFailure, rejectFlagLike, runGit } from '../git/git-runner.js';
import { parseDiff, type DiffFile } from '../git/parse.js';

/**
 * Phase 41 — `git_diff`.
 *
 * The reference server ships three tools here (`git_diff_unstaged`,
 * `git_diff_staged`, `git_diff`) which differ only in their arguments. One tool
 * with a `staged` flag covers all three, and one tool is easier for a model to
 * hold in mind than three near-identical ones — the plan's call, and the
 * mapping is spelled out in the description so a reader coming from the
 * reference is not lost:
 *
 *   - `git_diff_unstaged`  → `{}`                      (working tree)
 *   - `git_diff_staged`    → `{ staged: true }`        (`--cached`)
 *   - `git_diff`           → `{ target: 'HEAD~1' }`    (a ref)
 *
 * `statOnly` answers "did anything change, and how much" (the `--stat` shape),
 * `path` narrows it to one file, and `nameOnly` returns just the paths.
 */

const DEFAULT_CONTEXT_LINES = 3;
/** F-03: a full patch larger than this is truncated (prefer `statOnly`). */
const GIT_PATCH_CHAR_CAP = 16_000;

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  staged: z
    .boolean()
    .default(false)
    .describe(
      "Compare the index against HEAD (the reference's git_diff_staged) instead of the working tree."
    ),
  target: z
    .string()
    .optional()
    .describe(
      'A commit, tag or ref to compare against (e.g. "HEAD~1", "main", a sha). Mutually exclusive with staged.'
    ),
  path: z.string().optional().describe('Restrict the diff to this path (workspace-relative).'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(DEFAULT_CONTEXT_LINES)
    .describe(`Lines of context around each change (default ${DEFAULT_CONTEXT_LINES}).`),
  statOnly: z.boolean().default(false).describe('Return the diffstat instead of the patch.'),
  nameOnly: z.boolean().default(false).describe('Return only the changed paths.'),
});

export interface GitDiffOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  /** Which comparison produced this: working tree, index, or a ref. */
  scope?: 'worktree' | 'staged' | 'target';
  target?: string;
  diff?: string;
  files?: DiffFile[];
  paths?: string[];
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  bytes?: number;
  truncated?: boolean;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitDiffInput = {
  directory: string;
  staged: boolean;
  target?: string;
  path?: string;
  contextLines: number;
  statOnly: boolean;
  nameOnly: boolean;
};

const executeWithDefaults = (
  input: Partial<GitDiffInput>
): Required<
  Pick<GitDiffInput, 'directory' | 'staged' | 'contextLines' | 'statOnly' | 'nameOnly'>
> & {
  target?: string;
  path?: string;
} => ({
  directory: input.directory ?? '.',
  staged: input.staged ?? false,
  contextLines: input.contextLines ?? DEFAULT_CONTEXT_LINES,
  statOnly: input.statOnly ?? false,
  nameOnly: input.nameOnly ?? false,
  ...(input.target === undefined ? {} : { target: input.target }),
  ...(input.path === undefined ? {} : { path: input.path }),
});

export function createGitDiffTool(projectRoot: string) {
  const diffTool: Tool<GitDiffInput, GitDiffOutcome> & {
    execute: (input: Partial<GitDiffInput>) => Promise<GitDiffOutcome>;
  } = {
    description:
      "Shows what changed: the working tree by default, the index with staged: true (the reference's " +
      'git_diff_staged), or a commit/ref with target (its git_diff). Returns the patch plus files, ' +
      'additions and deletions; statOnly or nameOnly for summaries. Requires a repository inside the workspace.',
    inputSchema,
    execute: async (input) => {
      const {
        directory,
        staged,
        target,
        path: pathArg,
        contextLines,
        statOnly,
        nameOnly,
      } = executeWithDefaults(input);

      if (target !== undefined) {
        const badTarget = rejectFlagLike(target, 'target');
        if (badTarget) return failureResult(badTarget) as GitDiffOutcome;
        if (staged) {
          return {
            success: false,
            code: 'BAD_ARGUMENT',
            error:
              'Pass either staged: true or a target, not both — they compare different things.',
          };
        }
      }
      if (pathArg !== undefined) {
        const badPath = rejectFlagLike(pathArg, 'path');
        if (badPath) return failureResult(badPath) as GitDiffOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitDiffOutcome;

      const args = ['diff', `--unified=${contextLines}`];
      if (statOnly) args.push('--stat');
      if (nameOnly) args.push('--name-only');
      if (staged) args.push('--cached');
      if (target !== undefined) args.push('--end-of-options', target);
      if (pathArg !== undefined) args.push('--', pathArg);

      const result = await runGit(repo.directory, args);
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitDiffOutcome),
          directory: repo.display,
        };
      }

      let text = result.stdout;
      let truncated = Boolean(result.truncated);
      if (!statOnly && !nameOnly && text.length > GIT_PATCH_CHAR_CAP) {
        text = text.slice(0, GIT_PATCH_CHAR_CAP);
        truncated = true;
      }
      const summary =
        statOnly || nameOnly ? { files: [], additions: 0, deletions: 0 } : parseDiff(text);
      const paths = nameOnly
        ? text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : summary.files.map((file) => file.path);

      return {
        success: true,
        directory: repo.display,
        scope: target !== undefined ? 'target' : staged ? 'staged' : 'worktree',
        ...(target !== undefined ? { target } : {}),
        diff: text.trimEnd(),
        files: summary.files,
        paths,
        filesChanged: paths.length,
        additions: summary.additions,
        deletions: summary.deletions,
        bytes: Buffer.byteLength(text),
        truncated,
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(diffTool);
}

/** Re-exported for tests and for callers that want the same default. */
export const DEFAULT_DIFF_CONTEXT_LINES = DEFAULT_CONTEXT_LINES;
export { ensureRepo as ensureGitRepo };
