import {
  isFailure,
  runGit,
  type GitFailure,
  type GitResult,
  type ResolvedRepo,
} from './git-runner.js';
import { parseStatusV1 } from './parse.js';

/**
 * Phase 42 — the shared safety model for the tools that *change* a repository.
 *
 * Phase 41 could be permissive because reading cannot cost anything. Writing
 * can, in three different ways, and each gets its own mechanism:
 *
 *   1. **Irreversible loss of work.** `git reset --hard`, checking out with
 *      `discardChanges`, dropping a stash, amending a commit: each of these
 *      throws away something that exists nowhere else. They are refused unless
 *      the caller passes `confirmDestructive: true`, and the refusal *lists the
 *      exact files* that would be lost — so a model that is about to destroy an
 *      afternoon of someone's work sees that work named before it does.
 *   2. **Damaging a shared branch.** `main`/`master` (configurable) may not be
 *      pushed to or hard-reset — `PROTECTED_BRANCH`. A push is how an agent
 *      breaks something somebody else depends on; that is a human's decision,
 *      not a tool call's.
 *   3. **Silent surprise.** Every write reports the repository's HEAD and
 *      porcelain status **before and after**, so "what did that call actually
 *      change?" is answered by the result itself (and by the Journal, which
 *      records the same result).
 *
 * There is deliberately no way to ask for a force push, `--no-verify`, or an
 * identity change: those options do not exist in any schema, so no prompt,
 * context or file can conjure them.
 */

/** Branches that must never be pushed to or hard-reset by an agent. */
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'];

/** Overridable with a comma-separated list; empty string disables protection. */
export const PROTECTED_BRANCHES_ENV = 'HOTL_PROTECTED_BRANCHES';

export function protectedBranches(
  env: NodeJS.ProcessEnv = process.env,
  override?: readonly string[]
): string[] {
  if (override !== undefined) return [...override];
  const raw = env[PROTECTED_BRANCHES_ENV];
  if (raw === undefined) return [...DEFAULT_PROTECTED_BRANCHES];
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/** The protected name a branch refers to, or undefined when it is free. */
export function protectedMatch(branch: string, list: readonly string[]): string | undefined {
  const cleaned = branch.replace(/^refs\/heads\//, '');
  return list.find((name) => name === cleaned);
}

export function protectedBranchFailure(
  branch: string,
  action: string,
  list: readonly string[]
): GitFailure {
  return {
    ok: false,
    code: 'PROTECTED_BRANCH',
    error:
      `Refusing to ${action} "${branch}": it is a protected branch (${list.join(', ')}). ` +
      `Protected branches are changed by a human, not by a tool call — work on a feature branch ` +
      `and open a pull request instead. (Configurable: ${PROTECTED_BRANCHES_ENV}.)`,
  };
}

// ─── what a destructive call would throw away ────────────────────

export interface DirtyWork {
  /** `git status --porcelain` lines, verbatim. */
  lines: string[];
  /** One entry per affected path, for the confirmation message. */
  paths: string[];
}

/** Read the porcelain status once; both the snapshot and the warning use it. */
export async function readDirty(repo: ResolvedRepo): Promise<DirtyWork> {
  const result = await runGit(repo.directory, ['status', '--porcelain']);
  if (!result.ok) return { lines: [], paths: [] };
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  const paths = parseStatusV1(result.stdout).entries.map((entry) =>
    entry.from ? `${entry.from} → ${entry.path}` : entry.path
  );
  return { lines, paths };
}

/**
 * The refusal a destructive call gets when it did not ask to be destructive.
 *
 * The plan requires the error to name what would be lost; a file list is more
 * useful than "dirty working tree", and it is the same list the model would
 * have had to read before choosing to proceed.
 */
export function confirmRequired(action: string, dirty: DirtyWork, extra?: string): GitFailure {
  const detail =
    dirty.paths.length > 0
      ? `Uncommitted changes that would be lost:\n${dirty.paths.map((p) => `  - ${p}`).join('\n')}`
      : 'The working tree is clean, so nothing tracked would be lost (untracked or ignored files may still be removed).';
  return {
    ok: false,
    code: 'CONFIRM_REQUIRED',
    error:
      `Refusing to ${action} without confirmation. ${extra ?? ''}${detail}\n` +
      `Call again with confirmDestructive: true if losing those changes is intended ` +
      `(they cannot be recovered by the tool afterwards).`,
  };
}

// ─── before/after snapshots ──────────────────────────────────────

export interface RepoSnapshot {
  /** Full commit id, or '' in a repository with no commits yet. */
  head: string;
  /** Short branch name, or 'HEAD' when detached. */
  branch: string;
  /** `git status --porcelain` lines. */
  status: string[];
  clean: boolean;
}

export async function snapshot(repo: ResolvedRepo): Promise<RepoSnapshot> {
  const [head, branch, status] = await Promise.all([
    runGit(repo.directory, ['rev-parse', 'HEAD'], { allowFailure: true }),
    runGit(repo.directory, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }),
    runGit(repo.directory, ['status', '--porcelain'], { allowFailure: true }),
  ]);
  const lines = status.ok ? status.stdout.split('\n').filter((line) => line.trim() !== '') : [];
  return {
    head: head.ok ? head.stdout.trim() : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    status: lines,
    clean: lines.length === 0,
  };
}

export interface WriteResultExtras {
  before: RepoSnapshot;
  after: RepoSnapshot;
  /** HEAD moved (a commit, a reset, a checkout of a different commit). */
  headChanged: boolean;
  /** The working tree/index state changed at all. */
  changed: boolean;
  /** Branch changed (a checkout, a new branch). */
  branchChanged: boolean;
}

/**
 * Snapshot around a write, so the result says what actually changed.
 *
 * `changed` is deliberately coarse (HEAD, branch or any status line differs) —
 * the point is that a caller (or a test) can tell "this call did something"
 * from "this call was a no-op", not to diff the trees.
 */
export async function withSnapshot(
  repo: ResolvedRepo,
  action: () => Promise<GitResult>
): Promise<{ result: GitResult } & WriteResultExtras> {
  const before = await snapshot(repo);
  const result = await action();
  const after = await snapshot(repo);
  return {
    result,
    before,
    after,
    headChanged: before.head !== after.head,
    branchChanged: before.branch !== after.branch,
    changed:
      before.head !== after.head ||
      before.branch !== after.branch ||
      before.status.join('\n') !== after.status.join('\n'),
  };
}

/**
 * The three booleans every write result carries, straight from `withSnapshot`.
 * A caller — model or human — reads `headChanged: true` to know the commit
 * really moved HEAD, and `changed: false` to know a "successful" call was a
 * no-op. Spreading one helper keeps the six write tools saying the same thing.
 */
export function changeReport(extras: {
  changed: boolean;
  headChanged: boolean;
  branchChanged: boolean;
}): { changed: boolean; headChanged: boolean; branchChanged: boolean } {
  return {
    changed: extras.changed,
    headChanged: extras.headChanged,
    branchChanged: extras.branchChanged,
  };
}

/** Trim a snapshot for a tool result (full status text is noisy). */
export function snapshotSummary(snap: RepoSnapshot): {
  head: string;
  shortHead: string;
  branch: string;
  clean: boolean;
  files: number;
} {
  return {
    head: snap.head,
    shortHead: snap.head.slice(0, 7),
    branch: snap.branch,
    clean: snap.clean,
    files: snap.status.length,
  };
}

export { isFailure };
