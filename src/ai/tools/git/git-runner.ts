import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePathInWorkspace } from '../implementations/path-security.js';
import { getAgentRunContext } from '../../runtime/agent-run-context.js';

/**
 * Phase 41 — the shared git core: one place that runs git, and one place that
 * decides what "a git problem" means.
 *
 * Four properties come from the plan (§۶.۱) and are enforced here rather than
 * repeated in six tools:
 *
 *   1. **No shell, ever.** `spawn('git', argv)` with an argument array — a path
 *      called `; rm -rf ~` is a path, not a command.
 *   2. **No prompts.** `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`,
 *      `SSH_ASKPASS=echo` and `GIT_PAGER=cat`: an agent's git call must never
 *      sit waiting for a password (or a pager) that nobody will type. For the
 *      same reason `GIT_OPTIONAL_LOCKS=0` — a read-only tool must not take a
 *      lock and block a concurrent `git commit` in the user's editor.
 *   3. **Bounded output.** 256 KB by default, and the *cap cancels the child*:
 *      a 40 MB `git show` costs 256 KB and a SIGKILL, not 40 MB of memory.
 *   4. **Flag injection is refused, not escaped.** Any caller-supplied value
 *      that begins with `-` is rejected (`BAD_ARGUMENT`) and paths are passed
 *      after `--`, so `git diff --output=/etc/passwd` cannot be reached by
 *      naming a ref that way.
 *
 * Every failure is a code a model can act on: `NOT_A_REPO`, `GIT_MISSING`,
 * `TIMEOUT`, `PATH_TRAVERSAL_BLOCKED`, `BAD_ARGUMENT`, `OUTPUT_TOO_LARGE`,
 * `GIT_FAILED`.
 */

/** Bytes of stdout/stderr kept per command (the plan's ceiling). */
export const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024;
/** Time allowed for one git command. */
export const GIT_TIMEOUT_MS = 15_000;
/** Commits (and their hooks) get a longer budget than a read. */
export const GIT_COMMIT_TIMEOUT_MS = 120_000;
/** How long to wait for stdout/stderr to drain after the git process exited. */
export const EXIT_DRAIN_GRACE_MS = 250;

/**
 * Parent-env keys a git child is allowed to inherit. Secrets (API keys, tokens)
 * stay out; SSH/proxy/author identity must get through so a push can auth.
 */
export const GIT_ENV_PASSTHROUGH = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'XDG_CONFIG_HOME',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
] as const;

/** Identical environment for every command, whatever the user's shell says. */
export function gitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (!env.PATH) env.PATH = process.env.PATH ?? '';
  // Read the user's own config (aliases, identity) but never write to it and
  // never block on input.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = 'echo';
  env.SSH_ASKPASS = 'echo';
  env.GIT_PAGER = 'cat';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export type GitErrorCode =
  | 'NOT_A_REPO'
  | 'GIT_MISSING'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'PATH_TRAVERSAL_BLOCKED'
  | 'BAD_ARGUMENT'
  | 'OUTPUT_TOO_LARGE'
  | 'GIT_FAILED'
  // Phase 42 — the write half's own refusals.
  | 'PROTECTED_BRANCH'
  | 'CONFIRM_REQUIRED'
  | 'NOTHING_TO_COMMIT'
  | 'MISSING_IDENTITY'
  | 'NOTHING_TO_STASH'
  | 'PR_UNAVAILABLE'
  | 'NOT_GITHUB_REMOTE'
  | 'PR_NOT_FOUND'
  | 'PR_FAILED'
  | 'DETACHED_HEAD'
  | 'BRANCH_NOT_PUSHED';

export interface GitFailure {
  ok: false;
  code: GitErrorCode;
  error: string;
  /** Raw stderr, when git said something useful. */
  stderr?: string;
  status?: number;
}

export interface GitSuccess {
  ok: true;
  stdout: string;
  stderr: string;
  /** stdout was cut at the byte ceiling (the child was killed). */
  truncated: boolean;
  code: number;
}

export type GitResult = GitSuccess | GitFailure;

export interface RunGitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Extra environment (tests: `GIT_AUTHOR_DATE`). */
  env?: NodeJS.ProcessEnv;
  /** Treat a specific stdout shape as a failure (e.g. `git rev-parse` on a bad ref). */
  allowFailure?: boolean;
  /** C-01: kill the child when the agent run is cancelled. */
  abortSignal?: AbortSignal;
  /** Bytes written to the child's stdin (used by `git commit -F -`). */
  stdin?: string;
}

/**
 * Run one git command in `cwd`.
 *
 * The child is killed on the timeout, and again when either stream passes the
 * byte ceiling — so a runaway command costs one kill, never the whole buffer.
 * A non-zero exit is *not* automatically a failure: `git diff --quiet` and
 * `git rev-parse` use the exit code to answer, so callers decide.
 */
function killGitProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (pid && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    });
    return;
  }
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to a direct kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {}
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GIT_OUTPUT_LIMIT_BYTES;
  const abortSignal = options.abortSignal ?? getAgentRunContext()?.abortSignal;

  return new Promise<GitResult>((resolve) => {
    let child;
    try {
      child = spawn('git', [...args], {
        cwd,
        env: gitEnv(options.env),
        stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group so a timeout SIGKILL also reaps hook grandchildren.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ ok: false, code: 'GIT_MISSING', error: describeSpawnError(err) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let failure: GitFailure | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const kill = (reason: GitFailure): void => {
      failure = reason;
      killGitProcessTree(child);
    };

    const onAbort = (): void => {
      kill({ ok: false, code: 'ABORTED', error: 'Aborted' });
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
    }

    const collect = (chunk: Buffer, into: Buffer[], isStdout: boolean): void => {
      const used = isStdout ? stdoutBytes : stderrBytes;
      const room = maxBytes - used;
      if (room <= 0) return;
      if (chunk.byteLength > room) {
        into.push(chunk.subarray(0, room));
        if (isStdout) stdoutBytes = maxBytes;
        else stderrBytes = maxBytes;
        truncated = true;
        kill({
          ok: false,
          code: 'OUTPUT_TOO_LARGE',
          error: `git ${args[0] ?? ''} produced more than ${maxBytes} bytes; output was cut off.`,
        });
        return;
      }
      into.push(chunk);
      if (isStdout) stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, stdout, true));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, stderr, false));
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {
        /* EPIPE after a kill is expected */
      });
      child.stdin?.end(options.stdin, 'utf-8');
    }

    child.on('error', (err) => {
      finish({ ok: false, code: 'GIT_MISSING', error: describeSpawnError(err) });
    });

    // 'exit' can fire before the pipes are drained, which cut stdout short;
    // 'close' waits for them but never comes if a grandchild (a hook that
    // backgrounded something) still holds a pipe.  Settle on 'close', or a
    // short grace period after 'exit'.
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onDone = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      settleExit(exitCode, exitSignal);
    };
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      graceTimer = setTimeout(onDone, EXIT_DRAIN_GRACE_MS);
      graceTimer.unref?.();
    });
    child.on('close', (code, signal) => {
      if (!exited) {
        exitCode = code;
        exitSignal = signal;
      }
      onDone();
    });

    const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const text = Buffer.concat(stdout).toString('utf-8');
      const errText = Buffer.concat(stderr).toString('utf-8');

      if (failure) {
        // The cap was hit: the caller still gets the bytes that were read,
        // marked truncated — plus stderr when git explained itself.
        const withOutput = failure as GitFailure & { stdout?: string };
        withOutput.stdout = text;
        finish({ ...failure, ...(withOutput.stdout ? { stderr: errText } : {}) });
        return;
      }
      if (signal === 'SIGTERM' && code === null) {
        finish({
          ok: false,
          code: 'TIMEOUT',
          error: `git ${args[0] ?? ''} did not finish within ${timeoutMs} ms.`,
          stderr: errText.trim() || undefined,
        });
        return;
      }

      const exit = code ?? 1;
      if (exit !== 0 && !options.allowFailure) {
        finish(failureFromGit(args, exit, errText));
        return;
      }
      finish({ ok: true, stdout: text, stderr: errText, truncated, code: exit });
    };

    timer = setTimeout(() => {
      kill({
        ok: false,
        code: 'TIMEOUT',
        error: `git ${args[0] ?? ''} did not finish within ${timeoutMs} ms.`,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

function describeSpawnError(err: unknown): string {
  const error = err as NodeJS.ErrnoException;
  if (error.code === 'ENOENT') {
    return 'The `git` binary was not found on PATH — install git, or run this from a checkout that has it.';
  }
  return `Could not start git: ${error.message}`;
}

/** Map git's own words onto the codes the tools document. */
/**
 * Did git *work*, as opposed to merely running?
 *
 * `runGit(…, { allowFailure: true })` resolves with `ok: true` and the real
 * exit status in `code` — the flag means "the non-zero exit is mine to
 * interpret". A caller that wants a *value* out of such a run (a config value,
 * a ref, a remote URL) must therefore check both, and this is that check, in
 * one place, so nobody has to remember the subtlety.
 */
export function gitExitOk(result: GitResult): result is GitSuccess & { code: 0 } {
  return result.ok && result.code === 0;
}

export function failureFromGit(args: readonly string[], exit: number, stderr: string): GitFailure {
  const message = stderr.trim();
  if (/not a git repository/i.test(message)) {
    return {
      ok: false,
      code: 'NOT_A_REPO',
      error: `Not a git repository (or any parent up to the filesystem root): ${message}`,
      stderr: message,
      status: exit,
    };
  }
  if (/unknown revision|bad revision|ambiguous argument|did not match any file/i.test(message)) {
    return {
      ok: false,
      code: 'BAD_ARGUMENT',
      error: message,
      stderr: message,
      status: exit,
    };
  }
  return {
    ok: false,
    code: 'GIT_FAILED',
    error: message === '' ? `git ${args[0] ?? ''} exited with status ${exit}.` : message,
    stderr: message,
    status: exit,
  };
}

// ─── caller-supplied values ──────────────────────────────────────

/**
 * Refuse a value that git would read as an option.
 *
 * The reference server does exactly this (`BadName` for anything starting with
 * `-`), and it is the reason a repository can contain a branch called
 * `--upload-pack=…` without that ever becoming an argument.
 */
export function rejectFlagLike(value: string, label: string): GitFailure | undefined {
  if (value.startsWith('-')) {
    return {
      ok: false,
      code: 'BAD_ARGUMENT',
      error: `Invalid ${label} "${value}": it cannot start with "-".`,
    };
  }
  return undefined;
}

/** True when the string has bytes git would choke on (NUL, newline). */
export function isCleanGitName(value: string): boolean {
  return !/[\0\n\r]/.test(value);
}

/** Commit messages may contain newlines; they still cannot contain NUL or other C0. */
export function isCleanGitMessage(value: string): boolean {
  return !/[\0\r\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value);
}

/**
 * Refuse a branch name that could be read as a refspec rather than a plain
 * branch (R0-01).
 *
 * `git push <remote> <branch>` treats `branch` as a refspec, not a literal
 * name: a leading `+` forces the push, and a `:` separates a source from a
 * destination (`feat:main` pushes local `feat` onto remote `main`; `:main`
 * with no source deletes remote `main`). `^`, `~` and `..` are revision
 * syntax that has no place in a branch name either. None of this is caught
 * by `rejectFlagLike`, since none of these values start with `-`.
 */
export function rejectRefspecLike(value: string, label: string): GitFailure | undefined {
  if (
    value.startsWith('+') ||
    value.includes(':') ||
    value.includes('^') ||
    value.includes('~') ||
    value.includes('..')
  ) {
    return {
      ok: false,
      code: 'BAD_ARGUMENT',
      error:
        `Invalid ${label} "${value}": branch names may not contain "+" (as a prefix), ":", "^", "~" or ` +
        `".." — those are refspec/revision syntax, not a literal branch name.`,
    };
  }
  return undefined;
}

/**
 * Validate a ref name the way git itself would (`git check-ref-format
 * --branch`), so anything git's own parser would refuse is caught before it
 * reaches a command line.
 */
export async function isValidBranchName(value: string): Promise<boolean> {
  const result = await runGit('.', ['check-ref-format', '--branch', value], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
  return gitExitOk(result);
}

// ─── workspace + repository resolution ───────────────────────────

export interface ResolvedRepo {
  ok: true;
  /** The directory the caller asked for, resolved and verified in-workspace. */
  directory: string;
  /** Repository root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Bare repositories have no work tree — `git diff` etc. need one. */
  bare: boolean;
  /** What the caller passed, relative to the workspace ('' for the root). */
  display: string;
}

export interface EnsureRepoOptions {
  timeoutMs?: number;
  runGitImpl?: typeof runGit;
}

/**
 * Resolve `directory` inside the workspace and prove it is a git work tree.
 *
 * Two different refusals matter here and they are kept apart on purpose:
 * a path *outside* the workspace is `PATH_TRAVERSAL_BLOCKED` (the agent asked
 * for something it may not touch), a path inside that simply is not in a
 * repository is `NOT_A_REPO` (an answer about the project, not a security
 * event).
 */
export async function ensureRepo(
  directory: string,
  projectRoot: string,
  options: EnsureRepoOptions = {}
): Promise<ResolvedRepo | GitFailure> {
  const run = options.runGitImpl ?? runGit;
  const requested = directory.trim() === '' ? '.' : directory;

  const validation = await resolvePathInWorkspace(requested, [projectRoot]);
  if (!validation.safe) {
    return {
      ok: false,
      code: 'PATH_TRAVERSAL_BLOCKED',
      error: validation.reason ?? `Path "${directory}" is outside the workspace.`,
    };
  }
  const resolved = validation.resolvedPath;

  if (!fs.existsSync(resolved)) {
    return { ok: false, code: 'NOT_A_REPO', error: `Directory "${directory}" does not exist.` };
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, code: 'NOT_A_REPO', error: `"${directory}" is not a directory.` };
    }
  } catch {
    return { ok: false, code: 'NOT_A_REPO', error: `Directory "${directory}" is not readable.` };
  }

  const inside = await run(resolved, ['rev-parse', '--is-inside-work-tree'], {
    timeoutMs: options.timeoutMs,
  });
  if (!inside.ok) {
    // `rev-parse` inside a non-repo answers with the message we already map.
    return inside.code === 'NOT_A_REPO'
      ? {
          ok: false,
          code: 'NOT_A_REPO',
          error:
            `${inside.error} Run \`git init\` first, or point the tool at a directory that is ` +
            `inside a repository.`,
          stderr: inside.stderr,
        }
      : inside;
  }
  if (inside.stdout.trim() !== 'true') {
    return {
      ok: false,
      code: 'NOT_A_REPO',
      error: `"${directory}" is not inside a git work tree (a bare repository has no working tree).`,
    };
  }

  const top = await run(resolved, ['rev-parse', '--show-toplevel'], {
    timeoutMs: options.timeoutMs,
  });
  const root = top.ok ? top.stdout.trim() : resolved;

  // The repository root may sit *above* the workspace (a project directory
  // inside a bigger checkout). That is allowed — the tools still only ever name
  // paths inside the workspace, and the root is reported so the model knows.
  return {
    ok: true,
    directory: resolved,
    root: root === '' ? resolved : root,
    bare: false,
    display: path.relative(projectRoot, resolved) || '.',
  };
}

export function isFailure<T extends { ok: boolean }>(value: T | GitFailure): value is GitFailure {
  return value.ok === false;
}

/** Build the shared `{ success: false, error, code }` shape for a tool result. */
export function failureResult(failure: GitFailure): {
  success: false;
  error: string;
  code: GitErrorCode;
} {
  return { success: false, error: failure.error, code: failure.code };
}
