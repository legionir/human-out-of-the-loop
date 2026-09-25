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
import { LOG_FORMAT, parseDiff, parseLog, type DiffFile, type LogEntry } from '../git/parse.js';

/**
 * Phase 41 — `git_show`.
 *
 * One revision, in full: the commit object parsed into the same `LogEntry`
 * shape `git_log` returns, plus the patch it introduced (`files`, `additions`,
 * `deletions`). `path` narrows the patch to one file — which is the question
 * usually being asked ("what did this commit do to *this* file?"), and the
 * reason the tool exists next to `git_log`.
 *
 * `statOnly` keeps a merge-heavy commit from flooding the context: the metadata
 * still comes back, the patch does not.
 */

const DEFAULT_CONTEXT_LINES = 3;

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  revision: z
    .string()
    .default('HEAD')
    .describe('Commit, tag, ref or range ("HEAD", "HEAD~2", a sha, "main", "v1.2.0").'),
  path: z.string().optional().describe('Only show the changes to this path.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(DEFAULT_CONTEXT_LINES)
    .describe(`Lines of context around each change (default ${DEFAULT_CONTEXT_LINES}).`),
  statOnly: z
    .boolean()
    .default(false)
    .describe('Return metadata and the diffstat, without the patch.'),
});

export interface GitShowOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  revision?: string;
  commit?: LogEntry;
  show?: string;
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

type GitShowInput = {
  directory: string;
  revision: string;
  path?: string;
  contextLines: number;
  statOnly: boolean;
};

export function createGitShowTool(projectRoot: string) {
  const showTool: Tool<GitShowInput, GitShowOutcome> & {
    execute: (input: Partial<GitShowInput>) => Promise<GitShowOutcome>;
  } = {
    description:
      'Shows one revision: the commit metadata (author, ISO date, subject, body, parents, refs) plus the ' +
      'patch it introduced, with files/additions/deletions. Pass path to see only what it did to one file, ' +
      'or statOnly for the summary. Requires a repository inside the workspace.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const revision = input.revision ?? 'HEAD';
      const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
      const statOnly = input.statOnly ?? false;

      const badRevision = rejectFlagLike(revision, 'revision');
      if (badRevision) return failureResult(badRevision) as GitShowOutcome;
      if (!isCleanGitName(revision)) {
        return {
          success: false,
          code: 'BAD_ARGUMENT',
          error: 'Invalid revision: it must be a single line with no control characters.',
        };
      }
      if (input.path !== undefined) {
        const badPath = rejectFlagLike(input.path, 'path');
        if (badPath) return failureResult(badPath) as GitShowOutcome;
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitShowOutcome;

      // Metadata first: the commit object is small, and a huge patch must not
      // cost us the answer to "what is this commit?".
      const metaArgs = [
        'show',
        '--no-patch',
        `--pretty=format:${LOG_FORMAT}`,
        '--end-of-options',
        revision,
      ];
      const meta = await runGit(repo.directory, metaArgs);
      if (!meta.ok) {
        return {
          ...(failureResult(meta) as GitShowOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }
      const commit = parseLog(meta.stdout)[0];

      // Two git details decide this argv, both learned the hard way:
      //   - an option must come *before* a non-option argument (git refuses
      //     the other order), and `--end-of-options` is that boundary;
      //   - `--unified=N` implies `--patch`, so a stat-only run must not pass
      //     it at all (with just `--stat`, git prints the diffstat alone).
      const patchArgs = ['show', '--format='];
      if (statOnly) patchArgs.push('--stat');
      else patchArgs.push(`--unified=${contextLines}`);
      patchArgs.push('--end-of-options', revision);
      if (input.path !== undefined) patchArgs.push('--', input.path);
      const patch = await runGit(repo.directory, patchArgs);
      if (!patch.ok) {
        return {
          ...(failureResult(patch) as GitShowOutcome),
          directory: repo.display,
          repository: repo.root,
          ...(commit ? { commit } : {}),
        };
      }

      const summary = statOnly
        ? { files: [], additions: 0, deletions: 0 }
        : parseDiff(patch.stdout);
      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        revision,
        ...(commit ? { commit } : {}),
        show: patch.stdout.trimEnd(),
        files: summary.files,
        paths: summary.files.map((file) => file.path),
        filesChanged: summary.files.length,
        additions: summary.additions,
        deletions: summary.deletions,
        bytes: Buffer.byteLength(patch.stdout),
        truncated: patch.truncated || meta.truncated,
        warnings: (patch.stderr || meta.stderr).trim() || undefined,
      };
    },
  };

  return tool(showTool);
}
