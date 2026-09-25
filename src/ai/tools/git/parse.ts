/**
 * Phase 41 — parsers for git's machine formats.
 *
 * Everything here reads a format git documents as stable — `--porcelain=v1|v2`,
 * `for-each-ref --format`, a `%x1f`-separated `--pretty` — never the human
 * output, and never the terminal-width-dependent one. Two of the parsers
 * (status v2, branches) exist because the structured answer is strictly more
 * useful than the text: a model that gets `{ ahead: 2, behind: 0 }` does not
 * have to count characters, and a test can assert a field instead of a
 * substring.
 */

export interface StatusBranch {
  /** Branch name, or a detached description. */
  name: string;
  /** Upstream ref, when the branch tracks one. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Full commit id, when the format reports one. */
  oid?: string;
  detached?: boolean;
}

export interface StatusEntry {
  /** Workspace-relative path (the *new* path for a rename). */
  path: string;
  /** For a rename/copy: the path it came from. */
  from?: string;
  /** Two characters as in `git status --short`: index then work tree. */
  index: string;
  worktree: string;
  /** `??` (untracked), `!!` (ignored) or `U` (unmerged) shorthand. */
  kind: 'tracked' | 'untracked' | 'ignored' | 'unmerged';
}

export interface StatusSummary {
  branch?: StatusBranch;
  entries: StatusEntry[];
  counts: {
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    untracked: number;
    conflicted: number;
    staged: number;
  };
  clean: boolean;
}

/** Parse `git status --porcelain=v1` output. */
export function parseStatusV1(text: string): { entries: StatusEntry[]; branch?: StatusBranch } {
  const entries: StatusEntry[] = [];
  let branch: StatusBranch | undefined;

  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('## ')) {
      branch = parseBranchLine(raw.slice(3));
      continue;
    }
    if (raw.length < 3) continue;
    const index = raw[0]!;
    const worktree = raw[1]!;
    let rest = raw.slice(3);
    let from: string | undefined;
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) {
      from = unquote(rest.slice(0, arrow));
      rest = rest.slice(arrow + 4);
    }
    entries.push({
      path: unquote(rest),
      ...(from ? { from } : {}),
      index,
      worktree,
      kind: kindOf(index, worktree),
    });
  }
  return branch ? { entries, branch } : { entries };
}

function parseBranchLine(text: string): StatusBranch {
  // `main...origin/main [ahead 2, behind 1]` — or `HEAD (no branch)`.
  if (/^HEAD \(no branch\)/.test(text) || /^\(no branch\)/.test(text)) {
    const oid = /\(no branch\)/.test(text) ? undefined : undefined;
    return { name: 'HEAD', detached: true, ...(oid ? { oid } : {}) };
  }
  const [head, tracking] = text.split(' [');
  const [name, upstream] = (head ?? '').split('...');
  const result: StatusBranch = { name: name ?? '' };
  if (upstream) result.upstream = upstream;
  const ahead = /ahead (\d+)/.exec(tracking ?? '');
  const behind = /behind (\d+)/.exec(tracking ?? '');
  if (ahead) result.ahead = Number(ahead[1]);
  if (behind) result.behind = Number(behind[1]);
  return result;
}

/** Parse `git status --porcelain=v2` (with `--branch`). */
export function parseStatusV2(text: string): { entries: StatusEntry[]; branch?: StatusBranch } {
  const entries: StatusEntry[] = [];
  const branch: StatusBranch = { name: '' };
  let sawBranch = false;

  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('# ')) {
      sawBranch = true;
      const [key, ...rest] = raw.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        if (value === '(initial)') branch.name ||= '';
        else branch.oid = value;
      } else if (key === 'branch.head') {
        if (value === '(detached)') {
          branch.name = 'HEAD';
          branch.detached = true;
        } else branch.name = value;
      } else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(value) ?? [];
        if (ahead) branch.ahead = Number(ahead);
        if (behind) branch.behind = Number(behind);
      }
      continue;
    }
    if (raw.startsWith('1 ')) {
      // `1 XY sub mH mI mW hH hI path`
      const parts = raw.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(8).join(' ');
      entries.push({
        path: unquote(path),
        index: xy[0] ?? ' ',
        worktree: xy[1] ?? ' ',
        kind: kindOf(xy[0] ?? ' ', xy[1] ?? ' '),
      });
      continue;
    }
    if (raw.startsWith('2 ')) {
      // `2 XY sub mH mI mW hH hI Xscore path<TAB>origPath`
      const parts = raw.split(' ');
      const xy = parts[1] ?? '..';
      const [path, from] = parts.slice(9).join(' ').split('\t');
      entries.push({
        path: unquote(path ?? ''),
        ...(from ? { from: unquote(from) } : {}),
        index: xy[0] ?? ' ',
        worktree: xy[1] ?? ' ',
        kind: 'tracked',
      });
      continue;
    }
    if (raw.startsWith('? ')) {
      entries.push({ path: unquote(raw.slice(2)), index: '?', worktree: '?', kind: 'untracked' });
      continue;
    }
    if (raw.startsWith('! ')) {
      entries.push({ path: unquote(raw.slice(2)), index: '!', worktree: '!', kind: 'ignored' });
      continue;
    }
    if (raw.startsWith('u ')) {
      const parts = raw.split(' ');
      entries.push({
        path: unquote(parts.slice(10).join(' ')),
        index: 'U',
        worktree: 'U',
        kind: 'unmerged',
      });
    }
  }

  return sawBranch ? { entries, branch } : { entries };
}

function kindOf(index: string, worktree: string): StatusEntry['kind'] {
  if (index === '?' && worktree === '?') return 'untracked';
  if (index === '!' && worktree === '!') return 'ignored';
  if (
    index === 'U' ||
    worktree === 'U' ||
    (index === 'A' && worktree === 'A') ||
    (index === 'D' && worktree === 'D')
  ) {
    return 'unmerged';
  }
  return 'tracked';
}

/** Counts a summary is expected to carry (one place, so tests can trust them). */
export function summarizeStatus(entries: StatusEntry[]): StatusSummary['counts'] {
  const counts = {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0,
    staged: 0,
  };
  for (const entry of entries) {
    if (entry.kind === 'untracked') {
      counts.untracked += 1;
      continue;
    }
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'unmerged') {
      counts.conflicted += 1;
      continue;
    }
    const index = entry.index;
    const worktree = entry.worktree;
    if (worktree === 'M' || index === 'M') counts.modified += 1;
    if (worktree === 'D' || index === 'D') counts.deleted += 1;
    if (worktree === 'A' || index === 'A') counts.added += 1;
    if (index === 'R' || worktree === 'R' || entry.from) counts.renamed += 1;
    if (index !== ' ' && index !== '?' && index !== '!') counts.staged += 1;
  }
  return counts;
}

// ─── log ─────────────────────────────────────────────────────────

export interface LogEntry {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** Author date, ISO 8601 with the author's offset. */
  date: string;
  subject: string;
  body?: string;
  parents: string[];
  refs?: string[];
}

export const LOG_FIELD_SEPARATOR = '\x1f';
export const LOG_ENTRY_SEPARATOR = '\x1e';

/** The `--pretty` used for machine output; exported so tests can assert it. */
export const LOG_FORMAT =
  ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s', '%b'].join(LOG_FIELD_SEPARATOR) +
  LOG_ENTRY_SEPARATOR;

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const record of text.split(LOG_ENTRY_SEPARATOR)) {
    const trimmed = record.replace(/^\n+/, '');
    if (trimmed === '') continue;
    const [
      sha = '',
      shortSha = '',
      author = '',
      authorEmail = '',
      date = '',
      parents = '',
      refs = '',
      subject = '',
      body = '',
    ] = trimmed.split(LOG_FIELD_SEPARATOR);
    entries.push({
      sha,
      shortSha,
      author,
      authorEmail,
      date,
      parents: parents.split(' ').filter(Boolean),
      subject,
      ...(refs.trim() === '' ? {} : { refs: refs.split(', ').map((ref) => ref.trim()) }),
      ...(body.trim() === '' ? {} : { body: body.replace(/\n+$/, '') }),
    });
  }
  return entries;
}

// ─── branches ────────────────────────────────────────────────────

export interface BranchInfo {
  name: string;
  current: boolean;
  /** Remote-tracking branches are marked so the model can tell them apart. */
  remote: boolean;
  sha: string;
  upstream?: string;
  /** `[ahead 1, behind 2]`, when the branch tracks an upstream. */
  track?: string;
  ahead?: number;
  behind?: number;
  date: string;
  subject: string;
}

export const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:iso-strict)',
  '%(contents:subject)',
].join(LOG_FIELD_SEPARATOR);

export function parseBranches(text: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [head = '', refname = '', sha = '', upstream = '', track = '', date = '', subject = ''] =
      line.split(LOG_FIELD_SEPARATOR);
    const remote = refname.startsWith('refs/remotes/');
    const name = refname.replace(/^refs\/(heads|remotes)\//, '');
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    branches.push({
      name,
      current: head.trim() === '*',
      remote,
      sha,
      ...(upstream === '' ? {} : { upstream }),
      ...(track === '' ? {} : { track }),
      ...(ahead ? { ahead: Number(ahead[1]) } : {}),
      ...(behind ? { behind: Number(behind[1]) } : {}),
      date,
      subject,
    });
  }
  return branches;
}

// ─── remotes ─────────────────────────────────────────────────────

export interface RemoteInfo {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export function parseRemotes(text: string): RemoteInfo[] {
  const byName = new Map<string, RemoteInfo>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [name, rest] = line.split('\t');
    if (!name || !rest) continue;
    const url = rest.replace(/\s+\((fetch|push)\)$/, '');
    const kind = /\((fetch|push)\)$/.exec(rest)?.[1];
    const entry = byName.get(name) ?? { name };
    if (kind === 'push') entry.pushUrl = url;
    else if (kind === 'fetch') entry.fetchUrl = url;
    if (!entry.fetchUrl && !entry.pushUrl) entry.fetchUrl = url;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

// ─── diffs ───────────────────────────────────────────────────────

export interface DiffFile {
  path: string;
  /** The previous path, for a rename/copy. */
  from?: string;
  /** Hunks counted from the diff body. */
  hunks: number;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffSummary {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

/** Read the `diff --git a/… b/…` headers and count the `+`/`-` lines. */
export function parseDiff(text: string): DiffSummary {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let additions = 0;
  let deletions = 0;

  const flush = (): void => {
    if (!current) return;
    files.push(current);
    additions += current.additions;
    deletions += current.deletions;
    current = undefined;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const parsed = parseDiffHeader(line);
      current = {
        path: parsed.path,
        ...(parsed.from ? { from: parsed.from } : {}),
        hunks: 0,
        additions: 0,
        deletions: 0,
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      current.hunks += 1;
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
  }
  flush();
  return { files, additions, deletions };
}

/** `diff --git a/src/x.ts b/src/x.ts` → `{ path, from? }`. */
export function parseDiffHeader(line: string): { path: string; from?: string } {
  const body = line.slice('diff --git '.length);
  const match = /^(?:"?a\/(.*?)"?)\s+(?:"?b\/(.*?)"?)$/.exec(body);
  if (!match) return { path: body.trim() };
  const from = match[1] ?? '';
  const to = match[2] ?? '';
  return from === to ? { path: to } : { path: to, from };
}

/** Parse `--numstat` output (`additions\tdeletions\tpath`). */
export function parseNumstat(
  text: string
): Array<{ path: string; additions: number; deletions: number; binary: boolean }> {
  const rows: Array<{ path: string; additions: number; deletions: number; binary: boolean }> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [added, removed, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (file === '') continue;
    const binary = added === '-' || removed === '-';
    rows.push({
      path: file,
      additions: binary ? 0 : Number(added ?? 0),
      deletions: binary ? 0 : Number(removed ?? 0),
      binary,
    });
  }
  return rows;
}

/** Git quotes unusual paths (`"a\tb"`) — undo that for display. */
export function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const body = trimmed.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|[\\"abfnrtv])/g, (match, escape: string) => {
    if (escape.startsWith('u')) return String.fromCharCode(parseInt(escape.slice(1), 16));
    const table: Record<string, string> = {
      '\\\\': '\\',
      '"': '"',
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
    };
    return table[escape] ?? match;
  });
}
