import { execFile } from 'node:child_process';
import { runGit, gitEnv, type GitFailure, type ResolvedRepo } from './git-runner.js';

/**
 * Phase 42 — the pull-request backend.
 *
 * The plan's decision (§۶.۲) was "both": use the `gh` CLI when it is installed
 * and authenticated (it already knows the host, the token and the enterprise
 * configuration), and fall back to the GitHub REST API with `GITHUB_TOKEN` /
 * `GH_TOKEN` when it is not. If neither is available the answer is a code —
 * `PR_UNAVAILABLE` — with instructions, never a silent failure and never a
 * prompt for a credential.
 *
 * Three things this module refuses to do:
 *   - **run a shell**: `gh` is spawned like `git` (argv array, no shell), with
 *     the same prompt/pager-neutral environment;
 *   - **leak a token**: the token is read from the environment at call time and
 *     used in a header; it is never echoed into a result, and the Journal's
 *     secret scrubber removes it from arguments and results (phase 37 asserts
 *     exactly this);
 *   - **guess a repository**: the owner/name come from a remote URL the caller
 *     can see (`git remote get-url <remote>`), not from a directory name.
 *
 * Both backends speak JSON at the boundary: `gh --json` where the subcommand
 * supports it, and the REST shapes otherwise, so one parser serves both and the
 * tool results do not change shape depending on which one ran.
 */

export type PrBackendKind = 'gh' | 'rest';

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable so tests can stub `gh` without a PATH trick. */
export type GhRunner = (
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<GhResult>;

export const PR_TIMEOUT_MS = 30_000;

export async function runGhDefault(
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<GhResult> {
  return new Promise<GhResult>((resolve) => {
    execFile(
      'gh',
      [...args],
      {
        cwd: options.cwd,
        env: {
          ...gitEnv(options.env),
          // gh must never open a browser or prompt for a device code.
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
        },
        timeout: options.timeoutMs ?? PR_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (error ? String(error.message) : ''),
          code: typeof code === 'number' ? code : 1,
        });
      }
    );
  });
}

// ─── remote URL → repository identity ───────────────────────────

export interface RepoIdentity {
  host: string;
  owner: string;
  name: string;
  /** REST base for this host (github.com → api.github.com). */
  apiBase: string;
}

/**
 * Parse the GitHub-shaped remote URLs git actually stores:
 * `https://github.com/o/r.git`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`, `git://github.com/o/r.git`.
 */
export function parseRemoteUrl(url: string): RepoIdentity | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return undefined;

  // Two shapes: a real URL (https, http, git, ssh) and the scp-like
  // `user@host:owner/repo` git prints for SSH remotes.
  const schemeMatch = /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(trimmed);
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);

  let host = '';
  let pathPart = '';
  if (schemeMatch) {
    host = schemeMatch[1] ?? '';
    pathPart = schemeMatch[2] ?? '';
  } else if (scpLike && !trimmed.includes('://')) {
    host = scpLike[1] ?? '';
    pathPart = scpLike[2] ?? '';
  } else {
    return undefined;
  }

  const cleaned = pathPart.replace(/\.git$/, '').replace(/\/+$/, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const owner = segments[segments.length - 2]!;
  const name = segments[segments.length - 1]!;
  return {
    host,
    owner,
    name,
    apiBase: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
  };
}

/** `git remote get-url <remote>` through the shared runner. */
export async function remoteUrl(repo: ResolvedRepo, remote: string): Promise<string | undefined> {
  const result = await runGit(repo.directory, ['remote', 'get-url', '--', remote], {
    allowFailure: false,
  });
  if (!result.ok) return undefined;
  return result.stdout.trim() || undefined;
}

// ─── backend resolution ─────────────────────────────────────────

export interface PrBackendOptions {
  env?: NodeJS.ProcessEnv;
  runGh?: GhRunner;
  fetchImpl?: typeof fetch;
  ghAvailable?: boolean;
}

export interface PrBackend {
  kind: PrBackendKind;
  identity: RepoIdentity;
  remote: string;
  /** Repository directory every backend call runs in. */
  cwd: string;
  /** The environment `gh` runs in — the same one the token was read from. */
  env?: NodeJS.ProcessEnv;
  /** Present for the REST backend only. */
  token?: string;
  runGh: GhRunner;
  fetchImpl: typeof fetch;
}

export type PrBackendResult = { ok: true; backend: PrBackend } | GitFailure;

function prUnavailable(reason: string): GitFailure {
  return {
    ok: false,
    code: 'PR_UNAVAILABLE',
    error:
      `No pull-request backend is available (${reason}). Install the GitHub CLI and sign in ` +
      `(\`gh auth login\`), or export GITHUB_TOKEN/GH_TOKEN with a token that can read and write ` +
      `pull requests on this repository.`,
  };
}

/**
 * Decide how PR calls will be made.
 *
 * `gh` wins when present because it already knows which host and account to
 * use; the REST path exists for machines where installing a CLI is not an
 * option, and both end up talking to the same API.
 */
export async function resolvePrBackend(
  repo: ResolvedRepo,
  remote: string,
  options: PrBackendOptions = {}
): Promise<PrBackendResult> {
  const env = options.env ?? process.env;
  const runGh = options.runGh ?? runGhDefault;

  const url = await remoteUrl(repo, remote);
  if (url === undefined) {
    return {
      ok: false,
      code: 'NOT_GITHUB_REMOTE',
      error: `The repository has no remote called "${remote}". Add one, or pass the right remote name.`,
    };
  }
  const identity = parseRemoteUrl(url);
  if (!identity) {
    return {
      ok: false,
      code: 'NOT_GITHUB_REMOTE',
      error:
        `The remote "${remote}" points at "${url}", which is not a GitHub-shaped URL ` +
        `(https://github.com/owner/repo or git@github.com:owner/repo).`,
    };
  }

  let ghWorks = options.ghAvailable;
  if (ghWorks === undefined) {
    const probe = await runGh(['--version'], { cwd: repo.directory, env, timeoutMs: 5_000 });
    ghWorks = probe.ok;
  }

  if (ghWorks) {
    return {
      ok: true,
      backend: {
        kind: 'gh',
        identity,
        remote,
        cwd: repo.directory,
        env,
        runGh,
        fetchImpl: options.fetchImpl ?? fetch,
      },
    };
  }

  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (!token) {
    return prUnavailable(
      `the \`gh\` CLI was not found and neither GITHUB_TOKEN nor GH_TOKEN is set`
    );
  }
  return {
    ok: true,
    backend: {
      kind: 'rest',
      identity,
      remote,
      cwd: repo.directory,
      env,
      token,
      runGh,
      fetchImpl: options.fetchImpl ?? fetch,
    },
  };
}

// ─── operations ─────────────────────────────────────────────────

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  draft?: boolean;
  author?: string;
  head?: string;
  base?: string;
  createdAt?: string;
  updatedAt?: string;
  body?: string;
}

/** Normalise whatever either backend returned into one `PrInfo` shape. */
export function normalizePr(raw: Record<string, unknown>): PrInfo {
  const author = raw.author;
  const authorName =
    typeof author === 'string'
      ? author
      : author && typeof author === 'object'
        ? String((author as { login?: string }).login ?? '')
        : undefined;
  const number = Number(raw.number ?? 0);
  return {
    number,
    title: String(raw.title ?? ''),
    state: String(raw.state ?? '').toLowerCase(),
    url: String(raw.url ?? raw.html_url ?? ''),
    ...(raw.draft === undefined && raw.isDraft === undefined
      ? {}
      : { draft: Boolean(raw.draft ?? raw.isDraft) }),
    ...(authorName ? { author: authorName } : {}),
    ...((raw.head ?? raw.headRefName) ? { head: String(raw.headRefName ?? raw.head) } : {}),
    ...((raw.base ?? raw.baseRefName) ? { base: String(raw.baseRefName ?? raw.base) } : {}),
    ...((raw.createdAt ?? raw.created_at)
      ? { createdAt: String(raw.createdAt ?? raw.created_at) }
      : {}),
    ...((raw.updatedAt ?? raw.updated_at)
      ? { updatedAt: String(raw.updatedAt ?? raw.updated_at) }
      : {}),
    ...(raw.body === undefined ? {} : { body: String(raw.body) }),
  };
}

export interface PrOperationResult {
  ok: boolean;
  data?: unknown;
  /** Text the backend printed (used for create/comment, which answer with a URL). */
  text?: string;
  error?: string;
  code?: string;
  status?: number;
}

function ghFailure(result: GhResult, action: string): PrOperationResult {
  const message = (result.stderr || result.stdout).trim();
  if (/not logged in|authentication|credential|gh auth login/i.test(message)) {
    return {
      ok: false,
      code: 'PR_UNAVAILABLE',
      error:
        `\`gh\` is installed but not authenticated (${message.split('\n')[0]}). ` +
        `Run \`gh auth login\` once, or export GITHUB_TOKEN/GH_TOKEN.`,
    };
  }
  if (/could not resolve to a pull request|not found/i.test(message)) {
    return { ok: false, code: 'PR_NOT_FOUND', error: message, status: result.code };
  }
  return {
    ok: false,
    code: 'PR_FAILED',
    error: example(message, `gh ${action} failed`),
    status: result.code,
  };
}

function example(message: string, fallback: string): string {
  const first = message.split('\n').find((line) => line.trim() !== '');
  return first?.trim() || fallback;
}

function ghJson(result: GhResult, action: string): PrOperationResult {
  if (!result.ok) return ghFailure(result, action);
  try {
    return { ok: true, data: JSON.parse(result.stdout), text: result.stdout.trim() };
  } catch {
    return { ok: true, data: undefined, text: result.stdout.trim() };
  }
}

async function restCall(
  backend: PrBackend,
  method: string,
  path: string,
  body?: unknown
): Promise<PrOperationResult> {
  const url = `${backend.identity.apiBase}${path}`;
  let response: Response;
  try {
    response = await backend.fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${backend.token ?? ''}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'human-out-of-the-loop',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'PR_FAILED',
      error: `GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : text.slice(0, 300);
    return {
      ok: false,
      code: response.status === 404 ? 'PR_NOT_FOUND' : 'PR_FAILED',
      status: response.status,
      error: `GitHub API answered ${response.status}: ${message}`,
    };
  }
  return { ok: true, data: parsed, text };
}

// ─── the four operations the tools need ─────────────────────────

export interface PrCreateInput {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

function ghRepoSlug(identity: { host: string; owner: string; name: string }): string {
  return identity.host === 'github.com'
    ? `${identity.owner}/${identity.name}`
    : `${identity.host}/${identity.owner}/${identity.name}`;
}

export async function prCreate(
  backend: PrBackend,
  input: PrCreateInput
): Promise<PrOperationResult> {
  if (backend.kind === 'gh') {
    const args = ['pr', 'create', '--repo', ghRepoSlug(backend.identity), '--title', input.title];
    if (input.body !== undefined) args.push('--body', input.body);
    else args.push('--body', '');
    if (input.base) args.push('--base', input.base);
    if (input.head) args.push('--head', input.head);
    if (input.draft) args.push('--draft');
    const created = await backend.runGh(args, { cwd: backend.cwd, env: backend.env });
    if (!created.ok) return ghFailure(created, 'pr create');
    const url = created.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const number = Number(/\/(\d+)\s*$/.exec(url)?.[1] ?? 0);
    if (number === 0) {
      // gh did not print a URL we can read — report success with what we have
      // rather than pretending the call failed.
      return { ok: true, text: created.stdout.trim(), data: { url } };
    }
    const view = await backend.runGh(
      [
        'pr',
        'view',
        String(number),
        '--json',
        'number,title,state,url,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,body',
      ],
      { cwd: backend.cwd, env: backend.env }
    );
    const viewed = ghJson(view, 'pr view');
    if (viewed.ok && viewed.data && typeof viewed.data === 'object') {
      return { ...viewed, data: normalizePr(viewed.data as Record<string, unknown>) };
    }
    return { ok: true, text: created.stdout.trim(), data: { url, number, title: input.title } };
  }

  const { owner, name } = backend.identity;
  const body: Record<string, unknown> = {
    title: input.title,
    head: input.head ?? undefined,
    base: input.base ?? undefined,
    draft: input.draft ?? undefined,
  };
  if (input.body !== undefined) body.body = input.body;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  const created = await restCall(backend, 'POST', `/repos/${owner}/${name}/pulls`, body);
  if (!created.ok || !created.data || typeof created.data !== 'object') return created;
  return { ...created, data: normalizePr(created.data as Record<string, unknown>) };
}

export interface PrListInput {
  state?: string;
  limit?: number;
  base?: string;
  head?: string;
}

export async function prList(
  backend: PrBackend,
  input: PrListInput = {}
): Promise<PrOperationResult> {
  const limit = input.limit ?? 10;
  if (backend.kind === 'gh') {
    const args = [
      'pr',
      'list',
      '--state',
      input.state ?? 'open',
      '--limit',
      String(limit),
      '--json',
      'number,title,state,url,isDraft,author,headRefName,baseRefName,createdAt,updatedAt',
    ];
    if (input.base) args.push('--base', input.base);
    if (input.head) args.push('--head', input.head);
    const result = ghJson(
      await backend.runGh(args, { cwd: backend.cwd, env: backend.env }),
      'pr list'
    );
    if (!result.ok || !Array.isArray(result.data)) return result;
    // One shape on both backends: the caller never learns which one ran.
    return {
      ...result,
      data: (result.data as unknown[]).map((row) => normalizePr(row as Record<string, unknown>)),
    };
  }

  const { owner, name } = backend.identity;
  const query = new URLSearchParams({ state: input.state ?? 'open', per_page: String(limit) });
  if (input.base) query.set('base', input.base);
  if (input.head) query.set('head', input.head);
  const result = await restCall(
    backend,
    'GET',
    `/repos/${owner}/${name}/pulls?${query.toString()}`
  );
  if (!result.ok) return result;
  const rows = Array.isArray(result.data) ? (result.data as unknown[]) : [];
  return {
    ok: true,
    data: rows.map((row) => normalizePr(row as Record<string, unknown>)),
    text: result.text,
  };
}

export async function prView(backend: PrBackend, number: number): Promise<PrOperationResult> {
  if (backend.kind === 'gh') {
    return ghJson(
      await backend.runGh(
        [
          'pr',
          'view',
          String(number),
          '--json',
          'number,title,state,url,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,body,mergeable,commits,files',
        ],
        { cwd: backend.cwd, env: backend.env }
      ),
      'pr view'
    );
  }
  const { owner, name } = backend.identity;
  const result = await restCall(backend, 'GET', `/repos/${owner}/${name}/pulls/${number}`);
  if (!result.ok) return result;
  return { ...result, data: normalizePr(result.data as Record<string, unknown>) };
}

export async function prComment(
  backend: PrBackend,
  number: number,
  body: string
): Promise<PrOperationResult> {
  if (backend.kind === 'gh') {
    const result = await backend.runGh(['pr', 'comment', String(number), '--body', body], {
      cwd: backend.cwd,
      env: backend.env,
    });
    if (!result.ok) return ghFailure(result, 'pr comment');
    return {
      ok: true,
      text: result.stdout.trim(),
      data: { url: result.stdout.trim(), number },
    };
  }
  const { owner, name } = backend.identity;
  return restCall(backend, 'POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body });
}
