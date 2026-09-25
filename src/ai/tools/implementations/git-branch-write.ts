import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ensureRepo,
  failureResult,
  gitExitOk,
  isCleanGitName,
  isFailure,
  rejectFlagLike,
  runGit,
} from '../git/git-runner.js';
import {
  changeReport,
  protectedBranches,
  protectedBranchFailure,
  protectedMatch,
  readDirty,
  snapshotSummary,
  withSnapshot,
} from '../git/git-safe.js';

/**
 * Phase 42 — `git_create_branch` and `git_checkout`.
 *
 * Creating a branch is the safe way to do work, so it is deliberately easy:
 * a name (validated by git itself, `check-ref-format --branch`, which is the
 * only authority on what a branch name may be), an optional base, and an
 * optional `checkout` to switch to it in the same call.
 *
 * Checking out is where a repository can lose work: switching away from a
 * branch with uncommitted changes either fails (git's default, and the right
 * default) or, with `discardChanges: true`, throws those changes away forever.
 * That flag therefore needs `confirmDestructive: true`, and the refusal names
 * the files that would be lost.
 *
 * Neither tool touches a protected branch's *content*: `git_create_branch` may
 * create a branch *from* `main` (that is how work starts), and checking out
 * `main` is allowed — what is refused is rewriting it (phase 42's push/reset
 * rules), not reading or standing on it.
 */

const createSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  name: z.string().min(1).describe('New branch name (e.g. "feature/login"), validated by git.'),
  base: z.string().optional().describe('Start from this branch/ref instead of the current HEAD.'),
  checkout: z
    .boolean()
    .default(true)
    .describe('Switch to the new branch (default) or leave HEAD where it is.'),
});

const checkoutSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  branch: z.string().min(1).describe('Branch or ref to switch to.'),
  create: z
    .boolean()
    .default(false)
    .describe('Create the branch first (equivalent to git checkout -b).'),
  discardChanges: z
    .boolean()
    .default(false)
    .describe(
      'Throw away uncommitted changes to switch anyway (requires confirmDestructive: true).'
    ),
  confirmDestructive: z
    .boolean()
    .default(false)
    .describe('Acknowledges that discardChanges will lose uncommitted work.'),
});

export interface GitBranchWriteOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  branch?: string;
  previousBranch?: string;
  base?: string;
  created?: boolean;
  discarded?: string[];
  /** What the call changed — straight from the before/after snapshot. */
  changed?: boolean;
  headChanged?: boolean;
  branchChanged?: boolean;
  before?: ReturnType<typeof snapshotSummary>;
  after?: ReturnType<typeof snapshotSummary>;
  warnings?: string;
  error?: string;
  code?: string;
}

type CreateInput = { directory: string; name: string; base?: string; checkout: boolean };
type CheckoutInput = {
  directory: string;
  branch: string;
  create: boolean;
  discardChanges: boolean;
  confirmDestructive: boolean;
};

export function createGitCreateBranchTool(projectRoot: string) {
  const branchTool: Tool<CreateInput, GitBranchWriteOutcome> & {
    execute: (input: Partial<CreateInput>) => Promise<GitBranchWriteOutcome>;
  } = {
    description:
      'Creates a branch (git branch / git checkout -b), optionally from a base ref, and switches to it by ' +
      'default. The name is validated by git itself. Creating a branch never changes tracked files, so it ' +
      'needs no confirmation — this is the safe way to start work.',
    inputSchema: createSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const name = (input.name ?? '').trim();
      const checkout = input.checkout ?? true;

      const bad = rejectFlagLike(name, 'branch name');
      if (bad) return failureResult(bad) as GitBranchWriteOutcome;
      if (input.base !== undefined) {
        const badBase = rejectFlagLike(input.base, 'base');
        if (badBase) return failureResult(badBase) as GitBranchWriteOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitBranchWriteOutcome;

      // git is the authority on names: it also rejects `..`, `~`, spaces, a
      // leading dash and anything else that would break a ref.
      const valid = await runGit(repo.directory, ['check-ref-format', '--branch', name], {
        allowFailure: true,
      });
      if (!gitExitOk(valid)) {
        const why = valid.ok ? valid.stderr.trim().split('\n')[0] : valid.error.split('\n')[0];
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          directory: repo.display,
          error: `"${name}" is not a valid branch name (${why || 'git rejected it'}).`,
        };
      }

      const args = ['checkout', '-b', name];
      if (input.base) args.push(input.base);
      const snapshot = await withSnapshot(repo, () =>
        runGit(
          repo.directory,
          checkout ? args : ['branch', name, ...(input.base ? [input.base] : [])]
        )
      );
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitBranchWriteOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }

      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        branch: checkout ? after.branch : name,
        previousBranch: before.branch,
        ...(input.base ? { base: input.base } : {}),
        created: true,
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        ...changeReport(snapshot),
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(branchTool);
}

export function createGitCheckoutTool(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {}
) {
  const checkoutTool: Tool<CheckoutInput, GitBranchWriteOutcome> & {
    execute: (input: Partial<CheckoutInput>) => Promise<GitBranchWriteOutcome>;
  } = {
    description:
      'Switches branches or refs (git checkout). Uncommitted changes make it fail by default — pass ' +
      'discardChanges: true together with confirmDestructive: true to throw them away, and the refusal will ' +
      'list exactly which files are at risk.',
    inputSchema: checkoutSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const branch = (input.branch ?? '').trim();
      const create = input.create ?? false;
      const discard = input.discardChanges ?? false;
      const confirmed = input.confirmDestructive ?? false;

      const bad = rejectFlagLike(branch, 'branch');
      if (bad) return failureResult(bad) as GitBranchWriteOutcome;

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitBranchWriteOutcome;

      // A destructive checkout is gated on *confirmation*, not on the branch:
      // throwing away uncommitted work is the caller's call to make, once.
      if (discard) {
        const dirty = await readDirty(repo);
        if (!confirmed) {
          return {
            success: false,
            code: 'CONFIRM_REQUIRED',
            directory: repo.display,
            error:
              `Refusing to discard uncommitted changes while switching to "${branch}". ` +
              (dirty.paths.length > 0
                ? `These files would lose their uncommitted changes:\n${dirty.paths
                    .map((p) => `  - ${p}`)
                    .join('\n')}`
                : 'The tree is clean, so nothing tracked is at risk (untracked files stay).') +
              `\nCall again with confirmDestructive: true if losing them is intended ` +
              `(git cannot recover them afterwards).`,
          };
        }
      }

      if (!isCleanGitName(branch)) {
        return { success: false, code: 'BAD_ARGUMENT', error: 'Invalid branch name.' };
      }
      if (create) {
        const valid = await runGit(repo.directory, ['check-ref-format', '--branch', branch], {
          allowFailure: true,
        });
        if (!gitExitOk(valid)) {
          return {
            success: false,
            code: 'BAD_ARGUMENT',
            directory: repo.display,
            error: `"${branch}" is not a valid branch name.`,
          };
        }
      }

      // `git checkout` (2.39) has no `--end-of-options` — it would be read as a
      // pathspec — so, as with reset, the dash guard carries the weight.
      const args = ['checkout'];
      if (create) args.push('-b');
      if (discard) args.push('-f');
      args.push(branch);

      const snapshot = await withSnapshot(repo, () => runGit(repo.directory, args));
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitBranchWriteOutcome),
          directory: repo.display,
          repository: repo.root,
          before: snapshotSummary(before),
          after: snapshotSummary(after),
        };
      }

      const protectedList = protectedBranches(options.env);
      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        branch: after.branch,
        previousBranch: before.branch,
        created: create,
        ...(discard ? { discarded: before.status } : {}),
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        // Standing on a protected branch is fine; the guards are on rewriting
        // it (reset --hard, push), so this only informs.
        ...(protectedMatch(after.branch, protectedList)
          ? {
              warnings: `On protected branch "${after.branch}" — it cannot be pushed to or hard-reset by a tool.`,
            }
          : {}),
        ...changeReport(snapshot),
      };
    },
  };

  return tool(checkoutTool);
}
