import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ensureRepo,
  failureResult,
  gitExitOk,
  isFailure,
  rejectFlagLike,
  runGit,
} from '../git/git-runner.js';
import {
  changeReport,
  protectedBranches,
  protectedBranchFailure,
  protectedMatch,
  snapshotSummary,
  withSnapshot,
} from '../git/git-safe.js';

/**
 * Phase 42 — `git_push`.
 *
 * Pushing is how an agent's mistake leaves the machine, so this tool is the
 * most tightly specified one in the set:
 *
 *   - **no force, ever.** There is no `force`, `--force-with-lease`, `--mirror`
 *     or `--no-verify` in the schema, so no prompt, file or clever caller can
 *     produce one. A rejected push is a rejected push: fetch and merge, or ask.
 *   - **protected branches are refused** (`PROTECTED_BRANCH`) — pushing to
 *     `main` is a human's decision, and the answer explains the alternative
 *     (push a feature branch and open a pull request).
 *   - **it never prompts**: the shared runner sets `GIT_TERMINAL_PROMPT=0`, so
 *     a repository needing credentials fails with git's own message instead of
 *     hanging a run.
 *   - the remote and branch are validated like every other caller value, and
 *     `--` keeps a branch called `-x` from becoming an option.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  remote: z.string().default('origin').describe('Remote to push to (default "origin").'),
  branch: z.string().optional().describe('Branch to push (default: the current branch).'),
  setUpstream: z
    .boolean()
    .default(false)
    .describe('Add --set-upstream, so the branch tracks the remote (first push of a new branch).'),
});

export interface GitPushOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  remote?: string;
  branch?: string;
  upstreamSet?: boolean;
  /** What the call changed — straight from the before/after snapshot. */
  changed?: boolean;
  headChanged?: boolean;
  branchChanged?: boolean;
  output?: string;
  before?: ReturnType<typeof snapshotSummary>;
  after?: ReturnType<typeof snapshotSummary>;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitPushInput = {
  directory: string;
  remote: string;
  branch?: string;
  setUpstream: boolean;
};

export function createGitPushTool(projectRoot: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const pushTool: Tool<GitPushInput, GitPushOutcome> & {
    execute: (input: Partial<GitPushInput>) => Promise<GitPushOutcome>;
  } = {
    description:
      'Pushes a branch to a remote (default origin/current branch). It has no force option by design: a ' +
      'push that would need one is refused by git and must be resolved by fetching and merging. Pushing a ' +
      'protected branch (main/master) is refused — push a feature branch and open a pull request instead.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const remote = (input.remote ?? 'origin').trim();
      const setUpstream = input.setUpstream ?? false;

      const badRemote = rejectFlagLike(remote, 'remote');
      if (badRemote) return failureResult(badRemote) as GitPushOutcome;
      if (input.branch !== undefined) {
        const badBranch = rejectFlagLike(input.branch, 'branch');
        if (badBranch) return failureResult(badBranch) as GitPushOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitPushOutcome;

      const currentResult = await runGit(repo.directory, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        allowFailure: true,
      });
      const current = gitExitOk(currentResult) ? currentResult.stdout.trim() : '';
      const branch = (input.branch ?? current).trim();

      if (branch === '' || branch === 'HEAD') {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          directory: repo.display,
          error: 'HEAD is detached — name the branch to push (branch: "…").',
        };
      }

      const protectedList = protectedBranches(options.env);
      if (protectedMatch(branch, protectedList)) {
        return {
          ...(failureResult(
            protectedBranchFailure(branch, 'push', protectedList)
          ) as GitPushOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }

      // Pushing to a protected *remote* branch from a differently-named local
      // branch is the same mistake wearing a hat: `branch: main` is caught
      // above, and a refspec-style destination is not expressible here.
      const remoteExists = await runGit(repo.directory, ['remote', 'get-url', '--', remote], {
        allowFailure: true,
      });
      if (!gitExitOk(remoteExists)) {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          directory: repo.display,
          repository: repo.root,
          error: `No remote called "${remote}" is configured (see git_remote_list).`,
        };
      }

      const args = ['push'];
      if (setUpstream) args.push('--set-upstream');
      args.push('--end-of-options', remote, branch);

      const snapshot = await withSnapshot(repo, () =>
        runGit(repo.directory, args, { timeoutMs: 120_000 })
      );
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitPushOutcome),
          directory: repo.display,
          repository: repo.root,
          remote,
          branch,
          before: snapshotSummary(before),
          after: snapshotSummary(after),
        };
      }

      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        remote,
        branch,
        upstreamSet: setUpstream,
        // git prints the progress on stderr; that *is* the useful output here.
        output: (result.stderr || result.stdout).trim(),
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        // A push does not touch the working tree: `changed` is normally false
        // here, and the interesting fields are the remote, the branch and git's
        // own report of what it sent.
        ...changeReport(snapshot),
        ...(result.stderr.trim() === '' && result.stdout.trim() === ''
          ? { warnings: 'Nothing was pushed — the remote is already up to date.' }
          : {}),
      };
    },
  };

  return tool(pushTool);
}
