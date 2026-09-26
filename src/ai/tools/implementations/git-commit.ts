import { tool, type Tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
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
import { resolvePathInWorkspace } from './path-security.js';

/**
 * Phase 42 — `git_commit`.
 *
 * Commits what is staged, or stages `paths` first and commits those. Three
 * rules come straight from the plan:
 *
 *   - **the message is required and non-empty** (a commit with no message is a
 *     commit nobody can read later);
 *   - **the identity is read, never written** — `git config user.name/email` is
 *     consulted, and a repository without one is refused (`MISSING_IDENTITY`)
 *     with instructions, because an agent that quietly invents an author has
 *     forged a commit;
 *   - **nothing is committed by accident**: an empty stage is
 *     `NOTHING_TO_COMMIT`, and there is no `--allow-empty`.
 *
 * `amend: true` rewrites the previous commit, so it is gated like the other
 * history-rewriting operations (`confirmDestructive: true`), and — like a push
 * — it is refused on a protected branch.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  message: z
    .string()
    .min(1)
    .describe('Commit message (required). A conventional-commit subject is fine.'),
  paths: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Stage these paths first, then commit them (otherwise the existing index is committed).'
    ),
  amend: z
    .boolean()
    .default(false)
    .describe(
      'Rewrite the previous commit (requires confirmDestructive: true; refused on protected branches).'
    ),
  confirmDestructive: z
    .boolean()
    .default(false)
    .describe('Acknowledges that amend rewrites the previous commit.'),
});

export interface GitCommitOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  commit?: string;
  shortCommit?: string;
  subject?: string;
  branch?: string;
  filesChanged?: number;
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

type GitCommitInput = {
  directory: string;
  message: string;
  paths?: string[];
  amend: boolean;
  confirmDestructive: boolean;
};

export function createGitCommitTool(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {}
) {
  const commitTool: Tool<GitCommitInput, GitCommitOutcome> & {
    execute: (input: Partial<GitCommitInput>) => Promise<GitCommitOutcome>;
  } = {
    description:
      'Creates a commit from the staged changes (or from paths it stages first). The message is required; ' +
      "the author identity comes from the repository's git config and is never written. amend: true " +
      'rewrites the previous commit and needs confirmDestructive: true. Fails when there is nothing to commit.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const message = (input.message ?? '').trim();
      const paths = input.paths;
      const amend = input.amend ?? false;
      const confirmed = input.confirmDestructive ?? false;

      if (message === '') {
        return { success: false, code: 'BAD_ARGUMENT', error: 'A commit message is required.' };
      }
      if (!isCleanGitName(message)) {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          error:
            'The commit message must be a single line with no control characters (use \\n in the body instead).',
        };
      }
      for (const file of paths ?? []) {
        const bad = rejectFlagLike(file, 'path');
        if (bad) return failureResult(bad) as GitCommitOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitCommitOutcome;

      const protectedList = protectedBranches(options.env);
      const currentBranchResult = await runGit(
        repo.directory,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        {
          allowFailure: true,
          env: options.env,
        }
      );
      const currentBranch = gitExitOk(currentBranchResult) ? currentBranchResult.stdout.trim() : '';
      const isProtected = protectedMatch(currentBranch, protectedList);

      if (amend) {
        if (isProtected) {
          return {
            ...(failureResult(
              protectedBranchFailure(currentBranch, 'amend a commit on', protectedList)
            ) as GitCommitOutcome),
            directory: repo.display,
          };
        }
        if (!confirmed) {
          return {
            success: false,
            code: 'CONFIRM_REQUIRED',
            directory: repo.display,
            error:
              `Refusing to amend the previous commit without confirmation: amend rewrites ` +
              `"${currentBranch}"'s last commit — its message and its content — and the original is ` +
              `only recoverable from the reflog. Call again with confirmDestructive: true if that is intended.`,
          };
        }
      }

      // Identity: read it, never set it.
      const [name, email] = await Promise.all([
        runGit(repo.directory, ['config', 'user.name'], { allowFailure: true, env: options.env }),
        runGit(repo.directory, ['config', 'user.email'], { allowFailure: true, env: options.env }),
      ]);
      const authorName = gitExitOk(name) ? name.stdout.trim() : '';
      const authorEmail = gitExitOk(email) ? email.stdout.trim() : '';
      if (authorName === '' || authorEmail === '') {
        return {
          success: false,
          code: 'MISSING_IDENTITY',
          directory: repo.display,
          error:
            `This repository has no commit identity configured (user.name/user.email are ` +
            `${authorName === '' ? 'missing' : 'set'} / ${authorEmail === '' ? 'missing' : 'set'}). ` +
            `Ask the user to run \`git config user.name "…"\` and \`git config user.email "…"\` — this ` +
            `tool will not write them, because a commit must carry the identity its owner chose.`,
        };
      }

      // Stage first when paths were given, so "commit exactly these" is one call.
      if (paths && paths.length > 0) {
        for (const file of paths) {
          const validation = await resolvePathInWorkspace(path.resolve(repo.directory, file), [
            projectRoot,
          ]);
          if (!validation.safe) {
            return {
              success: false,
              code: 'PATH_TRAVERSAL_BLOCKED',
              error: validation.reason ?? `Path "${file}" is outside the workspace.`,
              directory: repo.display,
            };
          }
        }
        const staged = await runGit(repo.directory, ['add', '--', ...paths]);
        if (!staged.ok) {
          return { ...(failureResult(staged) as GitCommitOutcome), directory: repo.display };
        }
      }

      // Nothing staged → nothing to commit. `commit --dry-run` is the quietest
      // way to ask, and it does not create the commit.
      const pending = await runGit(repo.directory, ['diff', '--cached', '--name-only']);
      const stagedFiles = gitExitOk(pending)
        ? pending.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
      if (!amend && stagedFiles.length === 0) {
        const dirty = await readDirty(repo);
        return {
          success: false,
          code: 'NOTHING_TO_COMMIT',
          directory: repo.display,
          error:
            `Nothing is staged, so there is no commit to make.` +
            (dirty.paths.length > 0
              ? ` Unstaged changes present:\n${dirty.paths.map((p) => `  - ${p}`).join('\n')}\n` +
                `Stage them with git_add (or pass paths to this tool) and commit again.`
              : ' The working tree is clean.'),
        };
      }

      const args = ['commit', '-m', message, '--cleanup=strip'];
      if (amend) args.push('--amend');
      // R0-11: when the caller named specific `paths`, commit ONLY those —
      // `git add -- paths` followed by a plain `git commit` would also
      // commit anything the USER had already staged before this call
      // (verified: a user's staged file landed in the agent's commit).
      // `--only -- <paths>` restricts the commit's tree to exactly the
      // named paths regardless of what else is in the index, and leaves
      // the user's own staged entries staged afterwards.
      if (!amend && paths && paths.length > 0) {
        args.push('--only', '--', ...paths);
      }
      const snapshot = await withSnapshot(repo, () => runGit(repo.directory, args));
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitCommitOutcome),
          directory: repo.display,
          repository: repo.root,
          before: snapshotSummary(before),
          after: snapshotSummary(after),
        };
      }

      const sha = await runGit(repo.directory, ['rev-parse', 'HEAD'], { allowFailure: true });
      const subject = await runGit(repo.directory, ['log', '-1', '--pretty=%s'], {
        allowFailure: true,
      });
      const changed = await runGit(
        repo.directory,
        ['show', '--stat', '--format=', '--name-only', 'HEAD'],
        {
          allowFailure: true,
        }
      );

      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        commit: gitExitOk(sha) ? sha.stdout.trim() : '',
        shortCommit: gitExitOk(sha) ? sha.stdout.trim().slice(0, 7) : '',
        subject: gitExitOk(subject) ? subject.stdout.trim() : message,
        branch: after.branch,
        filesChanged: gitExitOk(changed)
          ? changed.stdout.split('\n').filter((line) => line.trim() !== '').length
          : undefined,
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        ...changeReport(snapshot),
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(commitTool);
}
