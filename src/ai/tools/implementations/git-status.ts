import { tool, type Tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { ensureRepo, failureResult, isFailure, rejectFlagLike, runGit } from '../git/git-runner.js';
import { parseStatusV1, parseStatusV2, summarizeStatus, type StatusEntry } from '../git/parse.js';

/**
 * Phase 41 — `git_status`, extended.
 *
 * The phase-18 tool answered one question ("what does `git status` print?").
 * This one answers the question a model actually has — *what is the state of
 * this repository?* — with the same argument surface it always had
 * (`directory`, `short`) plus:
 *
 *   - `porcelain: 'v1' | 'v2'` — the machine formats, parsed into `entries`
 *     (`index`/`worktree` characters, renames with their `from`, untracked and
 *     unmerged marked) and `counts` (modified/added/deleted/renamed/untracked/
 *     conflicted/staged);
 *   - `branch: true` — the `## main...origin/main [ahead 2]` line, parsed into
 *     `{ name, upstream, ahead, behind }` (or `detached: true`);
 *   - `path` — restrict the answer to one path, so a fifty-file tree does not
 *     bury the two files the model is working on.
 *
 * Nothing that used to work changed: `short` still defaults to true and
 * `output` is still the text git printed. The one renamed thing is the error
 * code — phase 18's `NOT_A_GIT_REPO` is now the plan's shared `NOT_A_REPO`,
 * which every git tool returns.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  short: z
    .boolean()
    .default(true)
    .describe('Use the short format (ignored when porcelain is set).'),
  porcelain: z
    .enum(['v1', 'v2'])
    .optional()
    .describe("Use git's machine format and parse it into entries/counts."),
  branch: z
    .boolean()
    .default(false)
    .describe('Include the branch line (name, upstream, ahead/behind) — parsed, not just printed.'),
  path: z.string().optional().describe('Limit the answer to this path (workspace-relative).'),
});

export interface GitStatusOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  output?: string;
  branch?: { name: string; upstream?: string; ahead?: number; behind?: number; detached?: boolean };
  entries?: StatusEntry[];
  counts?: ReturnType<typeof summarizeStatus>;
  clean?: boolean;
  porcelain?: 'v1' | 'v2';
  truncated?: boolean;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitStatusInput = {
  directory: string;
  short: boolean;
  porcelain?: 'v1' | 'v2';
  branch: boolean;
  path?: string;
};

export function createGitStatusTool(projectRoot: string) {
  const statusTool: Tool<GitStatusInput, GitStatusOutcome> & {
    execute: (input: Partial<GitStatusInput>) => Promise<GitStatusOutcome>;
  } = {
    description:
      'Reports the state of the git working tree: the raw `git status` text plus, when asked, the branch ' +
      '(name, upstream, ahead/behind) and a parsed entry list with counts. Use it before editing or ' +
      'committing, and pass path to focus on one file. Requires a repository inside the workspace.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const short = input.short ?? true;
      const withBranch = input.branch ?? false;
      const porcelain = input.porcelain;
      const pathArg = input.path;

      if (pathArg !== undefined) {
        const bad = rejectFlagLike(pathArg, 'path');
        if (bad) return failureResult(bad);
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) {
        return failureResult(repo) as GitStatusOutcome;
      }

      const args = ['status'];
      const format = porcelain ?? (short ? 'v1' : undefined);
      if (format === 'v1') args.push('--porcelain=v1');
      else if (format === 'v2') args.push('--porcelain=v2');
      else if (short) args.push('--short');
      if (withBranch) args.push('--branch');
      if (pathArg) args.push('--', pathArg);

      const result = await runGit(repo.directory, args);
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitStatusOutcome),
          directory: repo.display,
          repository: displayRoot(repo.root, projectRoot),
        };
      }

      const text = result.stdout;
      const parsed =
        format === 'v2'
          ? parseStatusV2(text)
          : format === 'v1'
            ? parseStatusV1(text)
            : { entries: [] };
      const entries = parsed.entries;
      const counts = summarizeStatus(entries);

      const outcome: GitStatusOutcome = {
        success: true,
        directory: repo.display,
        repository: displayRoot(repo.root, projectRoot),
        output: text.trimEnd(),
        counts,
        clean: entries.length === 0,
        truncated: result.truncated,
        warnings: result.stderr.trim() || undefined,
      };
      if (format !== undefined) {
        outcome.porcelain = format;
        outcome.entries = entries;
      }
      if (parsed.branch) outcome.branch = parsed.branch;
      return outcome;
    },
  };

  return tool(statusTool);
}

/** The repository root relative to the workspace (absolute when it sits above). */
function displayRoot(root: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, root);
  return relative === '' ? '.' : relative.startsWith('..') ? root : relative;
}
