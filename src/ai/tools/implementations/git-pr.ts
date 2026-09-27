import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ensureRepo,
  failureResult,
  gitExitOk,
  isFailure,
  isCleanGitName,
  rejectFlagLike,
  runGit,
} from '../git/git-runner.js';
import {
  prComment,
  prCreate,
  prList,
  prView,
  resolvePrBackend,
  type GhRunner,
  type PrBackend,
  type PrBackendOptions,
  type PrInfo,
} from '../git/pr-backend.js';

/**
 * Phase 42 — the pull-request tools: `git_pr_create`, `git_pr_list`,
 * `git_pr_view`, `git_pr_comment`.
 *
 * Four small tools over one backend (`../git/pr-backend.ts`), which prefers the
 * `gh` CLI and falls back to the GitHub REST API with `GITHUB_TOKEN`/`GH_TOKEN`.
 * Three properties matter more than the features:
 *
 *   - **no silent failure**: with neither backend available the answer is
 *     `PR_UNAVAILABLE` plus the two ways to fix it, and with a remote that is
 *     not GitHub-shaped it is `NOT_GITHUB_REMOTE`. A model can act on both.
 *   - **no invented repository**: the owner/name are parsed from the remote URL
 *     git actually has, so a PR always targets the repository the branch is
 *     really connected to.
 *   - **no credential leaks**: the token is read from the environment per call
 *     and never appears in a result (and the Journal scrubs the values of the
 *     process environment from every entry it writes).
 *
 * Creating a PR is intentionally *not* gated behind a confirmation flag: it
 * changes nothing locally, and the plan's make-it-hard rule is about
 * destructive git operations. What it does require is that the branch was
 * pushed — GitHub answers with a clear error otherwise.
 */

const DEFAULT_REMOTE = 'origin';

async function resolvePrRefs(
  directory: string,
  remote: string,
  headInput?: string,
  baseInput?: string
): Promise<
  | { ok: true; head: string; base: string }
  | { ok: false; code: string; error: string }
> {
  const current = await runGit(directory, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    allowFailure: true,
  });
  const currentBranch = gitExitOk(current) ? current.stdout.trim() : '';
  const head = (headInput ?? currentBranch).trim();
  if (head === '' || head === 'HEAD') {
    return {
      ok: false,
      code: 'DETACHED_HEAD',
      error: 'HEAD is detached — name the branch to open a pull request from (head: "…").',
    };
  }
  // `owner:branch` is a fork head — GitHub resolves it; there is no local tracking ref.
  if (!head.includes(':')) {
    const tracking = await runGit(
      directory,
      ['rev-parse', '--verify', `refs/remotes/${remote}/${head}`],
      { allowFailure: true }
    );
    if (!gitExitOk(tracking)) {
      return {
        ok: false,
        code: 'BRANCH_NOT_PUSHED',
        error: `Branch "${head}" has not been pushed to "${remote}". Push it first, then open the PR.`,
      };
    }
  }
  if (baseInput && baseInput.trim() !== '') {
    return { ok: true, head, base: baseInput.trim() };
  }
  const remoteHead = await runGit(directory, ['symbolic-ref', `refs/remotes/${remote}/HEAD`], {
    allowFailure: true,
  });
  let base = 'main';
  if (gitExitOk(remoteHead)) {
    const ref = remoteHead.stdout.trim();
    const parts = ref.split('/');
    const name = parts[parts.length - 1];
    if (name) base = name;
  }
  return { ok: true, head, base };
}

const createSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  title: z.string().min(1).describe('Pull-request title (required).'),
  body: z.string().optional().describe('Description in Markdown.'),
  base: z
    .string()
    .optional()
    .describe('Branch to merge into (default: the repository default branch).'),
  head: z
    .string()
    .optional()
    .describe("Branch with the changes (default: the remote's current branch)."),
  draft: z.boolean().default(false).describe('Open as a draft PR.'),
  remote: z
    .string()
    .default(DEFAULT_REMOTE)
    .describe('Remote to read the repository identity from.'),
});

const listSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  state: z.enum(['open', 'closed', 'merged', 'all']).default('open').describe('Which PRs to list.'),
  limit: z.number().int().min(1).max(100).default(10).describe('How many PRs to return.'),
  base: z.string().optional().describe('Only PRs targeting this base branch.'),
  head: z.string().optional().describe('Only PRs from this head branch.'),
  remote: z
    .string()
    .default(DEFAULT_REMOTE)
    .describe('Remote to read the repository identity from.'),
});

const viewSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  number: z.number().int().min(1).describe('Pull-request number.'),
  remote: z
    .string()
    .default(DEFAULT_REMOTE)
    .describe('Remote to read the repository identity from.'),
});

const commentSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  number: z.number().int().min(1).describe('Pull-request number to comment on.'),
  body: z.string().min(1).describe('Comment text (Markdown).'),
  remote: z
    .string()
    .default(DEFAULT_REMOTE)
    .describe('Remote to read the repository identity from.'),
});

export interface PrOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  backend?: 'gh' | 'rest';
  pr?: PrInfo;
  pulls?: PrInfo[];
  count?: number;
  url?: string;
  comment?: string;
  output?: string;
  error?: string;
  code?: string;
}

type ToolOptions = PrBackendOptions & { env?: NodeJS.ProcessEnv };
type BackendOptionsResolver = (options: ToolOptions) => ToolOptions;

/**
 * Shared plumbing: resolve the repo, resolve the backend, run one operation,
 * and translate failures into the same `{ success: false, code }` shape every
 * other tool uses.
 */
async function withBackend<T extends { directory?: string; remote: string }>(
  input: T,
  projectRoot: string,
  options: ToolOptions,
  operation: (
    resolved: { backend: PrBackend },
    repo: { display: string; root: string }
  ) => Promise<{ ok: boolean; error?: string; code?: string } & Record<string, unknown>>
): Promise<PrOutcome> {
  const repo = await ensureRepo(input.directory ?? '.', projectRoot);
  if (isFailure(repo)) return failureResult(repo) as PrOutcome;

  const bad = rejectFlagLike(input.remote, 'remote');
  if (bad) return { ...(failureResult(bad) as PrOutcome), directory: repo.display };

  const resolved = await resolvePrBackend(repo, input.remote, options);
  if (isFailure(resolved)) {
    return {
      ...(failureResult(resolved) as PrOutcome),
      directory: repo.display,
      repository: repo.root,
    };
  }

  const outcome = await operation(resolved, repo);
  if (!outcome.ok) {
    return {
      success: false,
      code: outcome.code ?? 'PR_FAILED',
      error: outcome.error ?? 'The pull-request operation failed.',
      directory: repo.display,
      repository: repo.root,
      backend: resolved.backend.kind,
    };
  }
  return {
    success: true,
    directory: repo.display,
    repository: repo.root,
    backend: resolved.backend.kind,
    ...outcome,
  } as PrOutcome;
}

export function createGitPrCreateTool(projectRoot: string, options: ToolOptions = {}) {
  const prCreateTool: Tool<
    {
      directory: string;
      title: string;
      body?: string;
      base?: string;
      head?: string;
      draft: boolean;
      remote: string;
    },
    PrOutcome
  > & {
    execute: (input: Record<string, unknown>) => Promise<PrOutcome>;
  } = {
    description:
      "Opens a pull request on the repository's GitHub remote (gh CLI when available, otherwise the REST " +
      'API with GITHUB_TOKEN/GH_TOKEN). The branch must already be pushed. Answers PR_UNAVAILABLE when no ' +
      'backend exists, NOT_GITHUB_REMOTE when the remote is not GitHub-shaped.',
    inputSchema: createSchema,
    execute: async (raw) =>
      withBackend(
        {
          directory: (raw.directory as string) ?? '.',
          remote: (raw.remote as string) ?? DEFAULT_REMOTE,
        },
        projectRoot,
        options,
        async (resolved, repo) => {
          const title = String(raw.title ?? '').trim();
          if (title === '') {
            return { ok: false, code: 'BAD_ARGUMENT', error: 'A pull-request title is required.' };
          }
          if (!isCleanGitName(title)) {
            return { ok: false, code: 'BAD_ARGUMENT', error: 'The title must be a single line.' };
          }
          const refs = await resolvePrRefs(
            resolved.backend.cwd,
            (raw.remote as string) ?? DEFAULT_REMOTE,
            raw.head === undefined ? undefined : String(raw.head),
            raw.base === undefined ? undefined : String(raw.base)
          );
          if (!refs.ok) return refs;
          const result = await prCreate(resolved.backend, {
            title,
            ...(raw.body === undefined ? {} : { body: String(raw.body) }),
            base: refs.base,
            head: refs.head,
            draft: raw.draft === true,
          });
          if (!result.ok) return { ok: false, code: result.code, error: result.error };
          const pr =
            result.data && typeof result.data === 'object' && 'number' in (result.data as object)
              ? (result.data as PrInfo)
              : undefined;
          return {
            ok: true,
            ...(pr ? { pr } : {}),
            ...(result.text ? { output: result.text } : {}),
            ...(pr?.url ? { url: pr.url } : {}),
          };
        }
      ),
  };

  return tool(prCreateTool);
}

export function createGitPrListTool(projectRoot: string, options: ToolOptions = {}) {
  const prListTool: Tool<
    {
      directory: string;
      state: 'open' | 'closed' | 'merged' | 'all';
      limit: number;
      base?: string;
      head?: string;
      remote: string;
    },
    PrOutcome
  > & {
    execute: (input: Record<string, unknown>) => Promise<PrOutcome>;
  } = {
    description:
      'Lists pull requests on the GitHub remote for this repository (gh CLI or the REST API), with number, ' +
      'title, state, author, head/base and URL. Filters: state, limit, base, head.',
    inputSchema: listSchema,
    execute: async (raw) =>
      withBackend(
        {
          directory: (raw.directory as string) ?? '.',
          remote: (raw.remote as string) ?? DEFAULT_REMOTE,
        },
        projectRoot,
        options,
        async (resolved) => {
          const result = await prList(resolved.backend, {
            state: (raw.state as string) ?? 'open',
            limit: Number(raw.limit ?? 10),
            ...(raw.base === undefined ? {} : { base: String(raw.base) }),
            ...(raw.head === undefined ? {} : { head: String(raw.head) }),
          });
          if (!result.ok) return { ok: false, code: result.code, error: result.error };
          const pulls = (result.data as PrInfo[]) ?? [];
          return {
            ok: true,
            pulls,
            count: pulls.length,
            ...(result.text ? { output: result.text } : {}),
          };
        }
      ),
  };

  return tool(prListTool);
}

export function createGitPrViewTool(projectRoot: string, options: ToolOptions = {}) {
  const prViewTool: Tool<{ directory: string; number: number; remote: string }, PrOutcome> & {
    execute: (input: Record<string, unknown>) => Promise<PrOutcome>;
  } = {
    description:
      'Shows one pull request: title, state, author, head/base, URL and body (gh CLI or the REST API). ' +
      'Answers PR_NOT_FOUND when the number does not exist.',
    inputSchema: viewSchema,
    execute: async (raw) =>
      withBackend(
        {
          directory: (raw.directory as string) ?? '.',
          remote: (raw.remote as string) ?? DEFAULT_REMOTE,
        },
        projectRoot,
        options,
        async (resolved) => {
          const number = Number(raw.number ?? 0);
          if (!Number.isInteger(number) || number < 1) {
            return { ok: false, code: 'BAD_ARGUMENT', error: 'A pull-request number is required.' };
          }
          const result = await prView(resolved.backend, number);
          if (!result.ok) return { ok: false, code: result.code, error: result.error };
          const pr = result.data as PrInfo;
          return { ok: true, pr, ...(pr?.url ? { url: pr.url } : {}) };
        }
      ),
  };

  return tool(prViewTool);
}

export function createGitPrCommentTool(projectRoot: string, options: ToolOptions = {}) {
  const prCommentTool: Tool<
    { directory: string; number: number; body: string; remote: string },
    PrOutcome
  > & {
    execute: (input: Record<string, unknown>) => Promise<PrOutcome>;
  } = {
    description:
      'Adds a comment to a pull request (gh CLI or the REST API). Use it to report progress, a review ' +
      'finding, or the result of a run on the branch.',
    inputSchema: commentSchema,
    execute: async (raw) =>
      withBackend(
        {
          directory: (raw.directory as string) ?? '.',
          remote: (raw.remote as string) ?? DEFAULT_REMOTE,
        },
        projectRoot,
        options,
        async (resolved) => {
          const body = String(raw.body ?? '');
          if (body.trim() === '') {
            return { ok: false, code: 'BAD_ARGUMENT', error: 'A comment body is required.' };
          }
          const result = await prComment(resolved.backend, Number(raw.number ?? 0), body);
          if (!result.ok) return { ok: false, code: result.code, error: result.error };
          const url =
            result.data && typeof result.data === 'object' && 'url' in (result.data as object)
              ? String((result.data as { url?: string }).url ?? '')
              : '';
          return {
            ok: true,
            comment: body,
            ...(url ? { url } : {}),
            ...(result.text ? { output: result.text } : {}),
          };
        }
      ),
  };

  return tool(prCommentTool);
}

/** The injectable seams, exported for tests that need to fake a backend. */
export type { GhRunner, ToolOptions as PrToolOptions };
