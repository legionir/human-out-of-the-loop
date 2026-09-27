import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ensureRepo,
  failureResult,
  isCleanGitName,
  isFailure,
  rejectFlagLike,
  runGit,
} from '../git/git-runner.js';
import {
  BRANCH_FORMAT,
  LOG_FIELD_SEPARATOR,
  parseBranches,
  type BranchInfo,
} from '../git/parse.js';

/**
 * Phase 41 — `git_branch_list`.
 *
 * The reference's `git_branch` renders `git branch -v` text and offers
 * `contains`/`not_contains` (which branches have a commit). This returns the
 * same information as data — `for-each-ref` with an explicit field list, so the
 * parser reads a format git guarantees instead of the human output, where a
 * branch whose subject contains a tab would break every column assumption.
 *
 * `contains`/`notContains` are kept from the reference (they answer "which
 * branches already have this fix?") and run through the same flag-injection
 * refusal as every other caller-supplied value.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  all: z
    .boolean()
    .default(false)
    .describe('Include remote-tracking branches (the reference\'s branch_type: "all").'),
  remoteOnly: z.boolean().default(false).describe('Only remote-tracking branches.'),
  verbose: z
    .boolean()
    .default(true)
    .describe(
      "Include each branch's last commit (sha, date, subject) — on by default, like the reference's -v."
    ),
  contains: z.string().optional().describe('Only branches whose history contains this commit.'),
  notContains: z
    .string()
    .optional()
    .describe('Only branches whose history does not contain this commit.'),
});

export interface GitBranchListOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  branches?: BranchInfo[];
  current?: string;
  /** The raw `git branch` rendering, for a human reading the log. */
  output?: string;
  count?: number;
  detached?: boolean;
  detachedAt?: string;
  truncated?: boolean;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitBranchListInput = {
  directory: string;
  all: boolean;
  remoteOnly: boolean;
  verbose: boolean;
  contains?: string;
  notContains?: string;
};

export function createGitBranchListTool(projectRoot: string) {
  const branchTool: Tool<GitBranchListInput, GitBranchListOutcome> & {
    execute: (input: Partial<GitBranchListInput>) => Promise<GitBranchListOutcome>;
  } = {
    description:
      'Lists branches as data: name, current flag, sha, upstream, ahead/behind, last commit date and ' +
      'subject — local by default, remote-tracking with all: true. contains/notContains filter by the ' +
      "commits a branch has (the reference's git_branch with -a/-r and --contains/--no-contains).",
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const all = input.all ?? false;
      const remoteOnly = input.remoteOnly ?? false;
      const verbose = input.verbose ?? true;

      for (const [label, value] of [
        ['contains', input.contains],
        ['notContains', input.notContains],
      ] as const) {
        if (value === undefined) continue;
        const bad = rejectFlagLike(value, label);
        if (bad) return failureResult(bad) as GitBranchListOutcome;
        if (!isCleanGitName(value)) {
          return { success: false, code: 'BAD_ARGUMENT', error: `Invalid ${label}.` };
        }
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitBranchListOutcome;

      const patterns = remoteOnly
        ? ['refs/remotes']
        : all
          ? ['refs/heads', 'refs/remotes']
          : ['refs/heads'];
      const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`];
      if (input.contains) args.push(`--contains=${input.contains}`);
      if (input.notContains) args.push(`--no-contains=${input.notContains}`);
      args.push(...patterns);

      const result = await runGit(repo.directory, args);
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitBranchListOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }

      let branches = parseBranches(result.stdout);
      if (!verbose) branches = branches.map((branch) => ({ ...branch, date: '', subject: '' }));

      const head = await runGit(repo.directory, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        allowFailure: true,
      });
      const headName = head.ok ? head.stdout.trim() : '';

      const outcome: GitBranchListOutcome = {
        success: true,
        directory: repo.display,
        repository: repo.root,
        branches,
        count: branches.length,
        output: renderBranches(branches),
        truncated: result.truncated,
        warnings: result.stderr.trim() || undefined,
      };

      // A detached HEAD is not a branch: say so, and say where it points,
      // rather than leaving the caller to infer it from `current`.
      if (headName === '' || headName === 'HEAD') {
        const sha = await runGit(repo.directory, ['rev-parse', 'HEAD'], { allowFailure: true });
        outcome.detached = true;
        if (sha.ok && sha.stdout.trim() !== '') outcome.detachedAt = sha.stdout.trim();
      } else {
        outcome.current = headName;
      }
      return outcome;
    },
  };

  return tool(branchTool);
}

/** A `git branch -v`-shaped rendering, from the parsed data. */
function renderBranches(branches: BranchInfo[]): string {
  return branches
    .map((branch) => {
      const marker = branch.current ? '*' : ' ';
      const track = branch.track ? ` ${branch.track}` : '';
      const upstream = branch.upstream ? ` -> ${branch.upstream}` : '';
      return `${marker} ${branch.name}${upstream} ${branch.sha}${track} ${branch.subject}`.trimEnd();
    })
    .join('\n');
}

export { LOG_FIELD_SEPARATOR };
