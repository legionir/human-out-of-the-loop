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
  readDirty,
  snapshotSummary,
  withSnapshot,
} from '../git/git-safe.js';

/**
 * Phase 42 — `git_reset`.
 *
 * The reference server's `git_reset` does one thing: unstage everything
 * (`repo.index.reset()`). That is the *default* here too, and it is completely
 * safe — the files keep their content, only the index changes.
 *
 * The other two modes exist because a real workflow needs them, and both are
 * guarded:
 *
 *   - `mode: 'soft'` moves HEAD back and leaves the index alone;
 *   - `mode: 'hard'` throws away every uncommitted change in the tree. It needs
 *     `confirmDestructive: true`, and the refusal lists the files that would be
 *     lost. It is also refused outright on a protected branch — losing work on
 *     `main` is not something an agent gets to do, even with a flag.
 *
 * Note the asymmetry: `mixed` (the default) is the *safe* mode even though
 * `git reset --mixed` can also drop staged content — it only unstages, and the
 * work tree is untouched. `hard` is the one that deletes.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  mode: z
    .enum(['mixed', 'soft', 'hard'])
    .default('mixed')
    .describe(
      'mixed unstages (default, safe), soft moves HEAD only, hard discards uncommitted changes.'
    ),
  target: z
    .string()
    .optional()
    .describe('Commit/ref to reset to (default HEAD, i.e. unstage everything).'),
  paths: z
    .array(z.string().min(1))
    .optional()
    .describe('Unstage only these paths (mixed mode only; git reset -- <paths>).'),
  confirmDestructive: z
    .boolean()
    .default(false)
    .describe('Required for mode: "hard" — it discards uncommitted changes irrecoverably.'),
});

export interface GitResetOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  mode?: 'mixed' | 'soft' | 'hard';
  target?: string;
  unstaged?: string[];
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

type GitResetInput = {
  directory: string;
  mode: 'mixed' | 'soft' | 'hard';
  target?: string;
  paths?: string[];
  confirmDestructive: boolean;
};

export function createGitResetTool(projectRoot: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const resetTool: Tool<GitResetInput, GitResetOutcome> & {
    execute: (input: Partial<GitResetInput>) => Promise<GitResetOutcome>;
  } = {
    description:
      "Unstages everything by default (like the reference's git_reset) — safe, nothing is lost. mode: " +
      '"soft" moves HEAD back, mode: "hard" discards uncommitted changes and requires ' +
      'confirmDestructive: true (it is refused on a protected branch). Pass paths to unstage only those.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const mode = input.mode ?? 'mixed';
      const target = input.target;
      const paths = input.paths;
      const confirmed = input.confirmDestructive ?? false;

      if (target !== undefined) {
        const bad = rejectFlagLike(target, 'target');
        if (bad) return failureResult(bad) as GitResetOutcome;
      }
      for (const file of paths ?? []) {
        const bad = rejectFlagLike(file, 'path');
        if (bad) return failureResult(bad) as GitResetOutcome;
      }
      if (paths && paths.length > 0 && mode !== 'mixed') {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          error: `paths only applies to mode: "mixed" — a hard reset takes the whole tree, not a file list.`,
        };
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitResetOutcome;

      const protectedList = protectedBranches(options.env);
      const branchResult = await runGit(repo.directory, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        allowFailure: true,
      });
      const branch = gitExitOk(branchResult) ? branchResult.stdout.trim() : '';

      if (mode === 'hard') {
        if (protectedMatch(branch, protectedList)) {
          return {
            ...(failureResult(
              protectedBranchFailure(branch, 'hard-reset', protectedList)
            ) as GitResetOutcome),
            directory: repo.display,
            repository: repo.root,
          };
        }
        const dirty = await readDirty(repo);
        if (!confirmed) {
          return {
            success: false,
            code: 'CONFIRM_REQUIRED',
            directory: repo.display,
            repository: repo.root,
            error:
              `Refusing to hard-reset "${branch}" without confirmation. ` +
              (dirty.paths.length > 0
                ? `These files would lose their uncommitted changes permanently:\n${dirty.paths
                    .map((p) => `  - ${p}`)
                    .join('\n')}`
                : 'The tree is clean, so only the branch pointer moves (the commits stay in the reflog).') +
              `\nCall again with confirmDestructive: true if that is intended.`,
          };
        }
      }

      // Note: `git reset` has no `--end-of-options` in git 2.39 (it reads the
      // word as a revision), so the leading-dash guard above is the defence
      // here — there is no way to sneak an option in as the target.
      const args = ['reset'];
      if (mode === 'soft') args.push('--soft');
      else if (mode === 'hard') args.push('--hard');
      if (paths && paths.length > 0) args.push('--', ...paths);
      else if (target !== undefined) args.push(target);
      else args.push('HEAD');

      const snapshot = await withSnapshot(repo, () => runGit(repo.directory, args));
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitResetOutcome),
          directory: repo.display,
          repository: repo.root,
          before: snapshotSummary(before),
          after: snapshotSummary(after),
        };
      }

      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        mode,
        ...(target !== undefined ? { target } : {}),
        ...(paths && paths.length > 0 ? { unstaged: paths } : { unstaged: before.status }),
        ...(mode === 'hard' ? { discarded: before.status } : {}),
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        ...changeReport(snapshot),
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(resetTool);
}
