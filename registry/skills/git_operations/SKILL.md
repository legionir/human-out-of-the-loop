# Git Operations Skill

## Purpose
Understand a repository before changing anything in it: what is modified, what
the last commits did, which branch this is and where a push would go. The read
tools answer those questions as data — parsed entries and counts, not text a
model has to count characters in.

## Process
1. **Orient.** `git_status` first: porcelain entries (index/worktree characters,
   renames with their `from`, untracked, unmerged) and counts, plus the branch
   with its upstream and `ahead`/`behind`. Pass `path` to focus on one file
   instead of reading fifty.
2. **See the change.** `git_diff` — the working tree by default, `staged: true`
   for the index, `target: 'HEAD~1'` (or any ref) to compare against history.
   `statOnly` answers "how much changed", `nameOnly` "which files". The
   reference server's `git_diff_unstaged` / `git_diff_staged` / `git_diff` are
   these three modes.
3. **Read the history.** `git_log` with `path` for a file's own story,
   `author`/`since`/`until` to narrow it, `format: 'oneline'` to scan and
   `'json'` when the fields matter. `git_show` for one revision in full —
   metadata plus the patch, `path` to see only what it did to one file.
4. **Know the branches and remotes.** `git_branch_list` gives ahead/behind and
   the last commit per branch, and `contains` answers "which branches already
   have this fix?". `git_remote_list` says where a push would go — check it
   before writing anything (the fetch and push URLs can differ).
5. Cite what you found: the sha (short form is fine to read, use the full one
   in a report), the path, the branch. "The code changed" is not a finding;
   "`src/app.ts` in `a1b2c3d` replaced the retry loop" is.

## Reading the error codes
- `NOT_A_REPO` — the directory is not inside a git work tree (offer `git init`,
  or ask which directory the user meant).
- `PATH_TRAVERSAL_BLOCKED` — the path is outside the workspace; this is not a
  question to retry, it is a boundary.
- `BAD_ARGUMENT` — a ref, path or filter started with `-`, which git would read
  as an option. Quote the value back to the user.
- `TIMEOUT`, `OUTPUT_TOO_LARGE` — git was cut off. Narrow the question
  (`maxCount`, `path`, `statOnly`) instead of repeating the same call.

## Constraints
- These tools are **read-only**: they never stage, commit, checkout or push.
  Changing history is a separate, deliberate step.
- Never pass `-`-prefixed values as refs, paths or filters; they are refused by
  design (flag injection), not a bug to work around.
- No command waits for input: prompts, pagers and optional locks are disabled,
  so a call can never hang on a password prompt.
