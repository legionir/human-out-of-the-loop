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
import { changeReport, readDirty, snapshotSummary, withSnapshot } from '../git/git-safe.js';

/**
 * Phase 42 — `git_stash` (the plan's optional tool, included because it is what
 * makes a "tidy up before you switch" workflow possible without a hard reset).
 *
 * Six actions, one flag-array each:
 *   - `push` stores the current changes (with `includeUntracked` for `-u`) and
 *     leaves a clean tree;
 *   - `list` reads the stack;
 *   - `pop` / `apply` restore the newest entry (`pop` also drops it);
 *   - `drop` / `clear` delete stash entries — the only irreversible actions
 *     here, so they need `confirmDestructive: true`.
 *
 * A stash is not a backup: `pop` can conflict, and a dropped stash is gone, so
 * the refusal for `drop`/`clear` says exactly that.
 */

const ACTIONS = ['push', 'list', 'pop', 'apply', 'drop', 'clear'] as const;

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  action: z
    .enum(ACTIONS)
    .default('push')
    .describe('push (default), list, pop, apply, drop or clear.'),
  message: z.string().optional().describe('Label for a push (e.g. "before the refactor").'),
  includeUntracked: z.boolean().default(false).describe('push: also stash untracked files (-u).'),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Which stash entry drop/pop/apply works on (default 0 = newest).'),
  confirmDestructive: z
    .boolean()
    .default(false)
    .describe('Required for drop and clear — a dropped stash cannot be recovered by this tool.'),
});

export interface GitStashOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  action?: (typeof ACTIONS)[number];
  stashes?: string[];
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

type GitStashInput = {
  directory: string;
  action: (typeof ACTIONS)[number];
  message?: string;
  includeUntracked: boolean;
  index?: number;
  confirmDestructive: boolean;
};

export function createGitStashTool(projectRoot: string) {
  const stashTool: Tool<GitStashInput, GitStashOutcome> & {
    execute: (input: Partial<GitStashInput>) => Promise<GitStashOutcome>;
  } = {
    description:
      'Stashes and restores uncommitted work: push (with includeUntracked for -u), list, pop, apply, drop ' +
      'or clear. push is the safe way to get a clean tree before switching branches; drop and clear delete ' +
      'a stash forever and require confirmDestructive: true.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const action = input.action ?? 'push';
      const message = (input.message ?? '').trim();
      const entry = input.index ?? 0;
      const confirmed = input.confirmDestructive ?? false;

      if (message !== '' && !isCleanGitName(message)) {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          error: 'The stash message must be a single line.',
        };
      }
      const badMessage = message === '' ? undefined : rejectFlagLike(message, 'message');
      if (badMessage) return failureResult(badMessage) as GitStashOutcome;

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitStashOutcome;

      if (action === 'push') {
        const dirty = await readDirty(repo);
        if (dirty.paths.length === 0) {
          return {
            success: false,
            code: 'NOTHING_TO_STASH',
            directory: repo.display,
            repository: repo.root,
            error: 'The working tree is clean — there is nothing to stash.',
          };
        }
      }
      if ((action === 'drop' || action === 'clear') && !confirmed) {
        const list = await runGit(repo.directory, ['stash', 'list']);
        const count = gitExitOk(list) ? list.stdout.split('\n').filter(Boolean).length : 0;
        return {
          success: false,
          code: 'CONFIRM_REQUIRED',
          directory: repo.display,
          repository: repo.root,
          stashes: gitExitOk(list) ? list.stdout.split('\n').filter(Boolean) : [],
          error:
            `Refusing to ${action} ${action === 'clear' ? `all ${count} stash entries` : `stash@\{${entry}\}`} ` +
            `without confirmation. A dropped stash is not recoverable by this tool ` +
            `(only the reflog of the stash ref might still have it). ` +
            `Call again with confirmDestructive: true if that is intended.`,
        };
      }

      const args: string[] = action === 'push' ? ['stash', 'push'] : ['stash', action];
      if (action === 'push') {
        if (input.includeUntracked) args.push('-u');
        if (message !== '') args.push('-m', message);
        // R0-10: the repository root may sit above the workspace (a project
        // directory inside a bigger checkout) — a plain `git stash push`
        // stashes changes repo-wide, including files outside the workspace
        // (verified: a change in `../outside.txt` was picked up). A `--`
        // pathspec of `.` (cwd = repo.directory, the workspace) scopes the
        // stash to exactly the workspace regardless of where the repo root is.
        args.push('--', '.');
      } else if (action === 'drop' || action === 'pop' || action === 'apply') {
        args.push('--end-of-options', `stash@{${entry}}`);
      }

      const snapshot = await withSnapshot(repo, () => runGit(repo.directory, args));
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitStashOutcome),
          directory: repo.display,
          repository: repo.root,
          before: snapshotSummary(before),
          after: snapshotSummary(after),
        };
      }

      const list = await runGit(repo.directory, ['stash', 'list']);
      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        action,
        stashes: gitExitOk(list) ? list.stdout.split('\n').filter(Boolean) : [],
        // `git stash push` reports "Saved working directory…" on stdout.
        output: (result.stdout || result.stderr).trim(),
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        ...changeReport(snapshot),
        warnings: result.stderr.trim() && action === 'push' ? result.stderr.trim() : undefined,
      };
    },
  };

  return tool(stashTool);
}
