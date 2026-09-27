import { tool, type Tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { ensureRepo, failureResult, isFailure, rejectFlagLike, runGit } from '../git/git-runner.js';
import { changeReport, snapshotSummary, withSnapshot } from '../git/git-safe.js';
import { resolvePathInWorkspace } from './path-security.js';

/**
 * Phase 42 — `git_add`.
 *
 * Stages the paths it is given, or everything (`files: ['.']`) — the reference's
 * `git_add`, with the two halves of its defence kept and one added:
 *
 *   - every path is resolved inside the workspace (the reference resolves it
 *     against the repository root) — `../..` and an absolute path outside are
 *     refused with `PATH_TRAVERSAL_BLOCKED`;
 *   - the paths are passed after `--`, so a file called `-f` is a file;
 *   - a path that starts with `-` is refused outright (`BAD_ARGUMENT`), because
 *     `--` alone would still let a *value* look like an option in front of it.
 *
 * `paths` are relative to the repo directory the caller named, and the result
 * reports the before/after status so the staging is visible in the answer.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe('Paths to stage, relative to the directory. Use ["."] to stage everything.'),
});

export interface GitAddOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  staged?: string[];
  /** What the call changed — straight from the before/after snapshot. */
  headChanged?: boolean;
  branchChanged?: boolean;
  output?: string;
  before?: ReturnType<typeof snapshotSummary>;
  after?: ReturnType<typeof snapshotSummary>;
  changed?: boolean;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitAddInput = { directory: string; files: string[] };

export function createGitAddTool(projectRoot: string) {
  const addTool: Tool<GitAddInput, GitAddOutcome> & {
    execute: (input: Partial<GitAddInput>) => Promise<GitAddOutcome>;
  } = {
    description:
      'Stages files for the next commit (git add). Paths are relative to the directory and must stay ' +
      'inside it; use ["."] to stage everything. Returns the staged paths and the working-tree state ' +
      'before and after. It never commits — that is git_commit.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const files = input.files ?? [];
      if (files.length === 0) {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          error: 'Pass at least one path to stage (use ["."] for everything).',
        };
      }
      for (const file of files) {
        const bad = rejectFlagLike(file, 'path');
        if (bad) return failureResult(bad) as GitAddOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitAddOutcome;

      // Same check the reference does: every path must resolve inside the
      // workspace before git is allowed to see it (`..`, an absolute path, or a
      // symlink pointing out of the tree are all caught here).
      for (const file of files) {
        if (file === '.') continue;
        const candidate = path.resolve(repo.directory, file);
        const validation = await resolvePathInWorkspace(candidate, [projectRoot]);
        if (!validation.safe) {
          return {
            success: false,
            code: 'PATH_TRAVERSAL_BLOCKED',
            error: validation.reason ?? `Path "${file}" is outside the workspace.`,
            directory: repo.display,
            repository: repo.root,
          };
        }
        if (!isInsideRepo(validation.resolvedPath, repo.root, repo.directory)) {
          return {
            success: false,
            code: 'BAD_ARGUMENT',
            error: `Path "${file}" is inside the workspace but not inside the repository at ${repo.root}.`,
            directory: repo.display,
            repository: repo.root,
          };
        }
      }

      // `--` then the paths; a directory-wide staging keeps the reference's
      // single-dot form so `git add .` behaves exactly as a human expects.
      const args =
        files.length === 1 && files[0] === '.' ? ['add', '--', '.'] : ['add', '--', ...files];
      const snapshot = await withSnapshot(repo, () => runGit(repo.directory, args));
      const { result, before, after } = snapshot;
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitAddOutcome),
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
        staged: files,
        output: result.stdout.trim(),
        before: snapshotSummary(before),
        after: snapshotSummary(after),
        ...changeReport(snapshot),
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(addTool);
}

/** Is the resolved path inside the repository (either root or the work dir)? */
function isInsideRepo(resolved: string, root: string, workDir: string): boolean {
  const within = (base: string): boolean => {
    const relative = path.relative(base, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  return within(root) || within(workDir);
}
