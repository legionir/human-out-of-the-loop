import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ensureRepo,
  failureResult,
  isFailure,
  isCleanGitName,
  rejectFlagLike,
  runGit,
} from '../git/git-runner.js';
import { LOG_FORMAT, parseLog, type LogEntry } from '../git/parse.js';

/**
 * Phase 41 — `git_log`.
 *
 * History, with the two halves a model needs kept apart: the entries are always
 * parsed (`sha`, author, ISO date, parents, refs, subject, body), while
 * `format` decides how much *text* comes back — `oneline` for a glance, `short`
 * (the default) for a faithful `git log --stat`-free listing, `json` when the
 * caller wants the data and nothing else.
 *
 * `since`/`until` are git's own date parser (`2 weeks ago`, `2026-09-01`), and
 * both are matched against `--since`/`--until`; the reference's
 * `start_timestamp`/`end_timestamp` are the same two knobs under different
 * names, noted in the description.
 */

const MAX_ENTRIES = 200;

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  maxCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTRIES)
    .default(20)
    .describe(`How many commits to return (default 20, max ${MAX_ENTRIES}).`),
  path: z.string().optional().describe("Only commits touching this path (the file's history)."),
  author: z
    .string()
    .optional()
    .describe('Only commits by this author (substring match, as git does).'),
  since: z
    .string()
    .optional()
    .describe('Only commits after this date (e.g. "2 weeks ago", "2026-09-01").'),
  until: z.string().optional().describe('Only commits before this date.'),
  format: z
    .enum(['oneline', 'short', 'json'])
    .default('short')
    .describe(
      'How to render: "oneline" for one line per commit, "short" for a block each, "json" for entries only.'
    ),
});

export interface GitLogOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  entries?: LogEntry[];
  /** Rendered text for the `oneline`/`short` formats. */
  log?: string;
  format?: 'oneline' | 'short' | 'json';
  count?: number;
  /** The branch/HEAD the log was taken from. */
  revision?: string;
  truncated?: boolean;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitLogInput = {
  directory: string;
  maxCount: number;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  format: 'oneline' | 'short' | 'json';
};

export function createGitLogTool(projectRoot: string) {
  const logTool: Tool<GitLogInput, GitLogOutcome> & {
    execute: (input: Partial<GitLogInput>) => Promise<GitLogOutcome>;
  } = {
    description:
      'Reads the commit history: entries parsed (sha, author, ISO date, parents, refs, subject, body) in ' +
      '"oneline", "short" or "json" format, filtered by path, author, since or until (git\'s date parser: ' +
      '"2 weeks ago", a date, an ISO timestamp — the reference\'s start_timestamp/end_timestamp).',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const maxCount = input.maxCount ?? 20;
      const format = input.format ?? 'short';
      const filters: Array<[string, string | undefined, string]> = [
        ['path', input.path, 'path'],
        ['author', input.author, 'author'],
        ['since', input.since, 'since'],
        ['until', input.until, 'until'],
      ];
      for (const [, value, label] of filters) {
        if (value === undefined) continue;
        const bad = rejectFlagLike(value, label);
        if (bad) return failureResult(bad) as GitLogOutcome;
        if (!isCleanGitName(value)) {
          return {
            success: false,
            code: 'BAD_ARGUMENT',
            error: `Invalid ${label}: it must be a single line with no control characters.`,
          };
        }
      }

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitLogOutcome;

      const args = ['log', `--max-count=${maxCount}`, `--pretty=format:${LOG_FORMAT}`];
      if (input.since) args.push(`--since=${input.since}`);
      if (input.until) args.push(`--until=${input.until}`);
      if (input.author) args.push(`--author=${input.author}`);
      // `--end-of-options` then the ref-less path filter: a path is a pathspec,
      // never an option, even when it looks like one.
      if (input.path !== undefined) args.push('--end-of-options', '--', input.path);

      const result = await runGit(repo.directory, args);
      if (!result.ok) {
        // A repository with no commits is a young repository, not an error:
        // `git log` exits 128 there, and the honest answer is an empty history.
        if (
          result.code === 'GIT_FAILED' &&
          /does not have any commits yet|does not point to a commit/i.test(result.error)
        ) {
          return {
            success: true,
            directory: repo.display,
            repository: repo.root,
            format,
            entries: [],
            count: 0,
            ...(format === 'json' ? {} : { log: '' }),
            warnings: 'The repository has no commits yet.',
          };
        }
        return {
          ...(failureResult(result) as GitLogOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }

      const entries = parseLog(result.stdout);
      const head = await runGit(repo.directory, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        allowFailure: true,
      });

      const outcome: GitLogOutcome = {
        success: true,
        directory: repo.display,
        repository: repo.root,
        format,
        entries,
        count: entries.length,
        ...(head.ok && head.stdout.trim() !== '' ? { revision: head.stdout.trim() } : {}),
        truncated: result.truncated,
        warnings: result.stderr.trim() || undefined,
      };
      if (format !== 'json') outcome.log = renderLog(entries, format);
      return outcome;
    },
  };

  return tool(logTool);
}

function renderLog(entries: LogEntry[], format: 'oneline' | 'short'): string {
  if (format === 'oneline') {
    return entries.map((entry) => `${entry.shortSha} ${entry.subject}`).join('\n');
  }
  return entries
    .map((entry) =>
      [
        `commit ${entry.sha}`,
        entry.refs && entry.refs.length > 0 ? `Refs: ${entry.refs.join(', ')}` : undefined,
        `Author: ${entry.author} <${entry.authorEmail}>`,
        `Date:   ${entry.date}`,
        ...(entry.parents.length > 1
          ? [`Merge:  ${entry.parents.map((p) => p.slice(0, 7)).join(' ')}`]
          : []),
        '',
        `    ${entry.subject}`,
        ...(entry.body ? ['', ...entry.body.split('\n').map((line) => `    ${line}`)] : []),
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n')
    )
    .join('\n\n');
}
