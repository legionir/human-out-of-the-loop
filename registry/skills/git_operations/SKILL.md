# Git Operations Skill

## Purpose
Understand a repository before changing anything in it, then change it safely:
what is modified, what the last commits did, which branch this is and where a
push would go — and, when the work is ready, a feature branch, a commit, a push
and a pull request. The read tools answer as data (parsed entries and counts,
not text a model has to count characters in) and the write tools answer with
the state before and after, so every change is visible.

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

## Making a change
The write tools exist to do the obvious thing in one call, and to stop before
the irreversible thing.

1. **Work on a branch, not on `main`.** `git_create_branch` (it switches to the
   new branch by default) or `git_checkout` with `create: true`. `main` and
   `master` are protected: they cannot be pushed to and cannot be hard-reset,
   so start a feature branch and open a pull request instead.
2. **Stage, then commit.** `git_add` with the paths (or `["."]` for
   everything), then `git_commit` with a real message — or pass `paths` to
   `git_commit` to stage and commit in one call. The message is required, an
   empty index is `NOTHING_TO_COMMIT`, and if the repository has no
   `user.name`/`user.email` the answer is `MISSING_IDENTITY`: ask the user to
   set their identity, because this tool will never write one for them.
   `amend: true` rewrites the previous commit, so it needs
   `confirmDestructive: true` and is refused on a protected branch.
3. **Push the branch.** `git_push` defaults to `origin` and the current branch;
   `setUpstream: true` on the first push of a new branch. There is no force
   option — a rejected push is git's answer, and the fix is to fetch and merge,
   or to ask the user.
4. **Open the pull request.** `git_pr_create` (the branch must be pushed
   first), then `git_pr_list` / `git_pr_view` to check it, and
   `git_pr_comment` to report what happened. The backend is the `gh` CLI when
   it is installed, otherwise the GitHub REST API with `GITHUB_TOKEN`/`GH_TOKEN`;
   with neither, the answer is `PR_UNAVAILABLE` and you should say so instead of
   pretending the PR exists.
5. **Tidy up instead of destroying.** `git_stash` (`action: 'push'`) gets a
   clean tree before switching branches, and `action: 'pop'` brings the work
   back. That is almost always what a hard reset was about to be used for.

## Reading the error codes
- `NOT_A_REPO` — the directory is not inside a git work tree (offer `git init`,
  or ask which directory the user meant).
- `PATH_TRAVERSAL_BLOCKED` — the path is outside the workspace; this is not a
  question to retry, it is a boundary.
- `BAD_ARGUMENT` — a ref, path or filter started with `-`, which git would read
  as an option. Quote the value back to the user.
- `TIMEOUT`, `OUTPUT_TOO_LARGE` — git was cut off. Narrow the question
  (`maxCount`, `path`, `statOnly`) instead of repeating the same call.
- `PROTECTED_BRANCH` — the operation would rewrite `main`/`master` (push, hard
  reset, amend). Do not look for a way around it: make a branch.
- `CONFIRM_REQUIRED` — the call would lose uncommitted work (`reset --hard`,
  `checkout` with `discardChanges`, `stash drop`/`clear`, `commit --amend`).
  The refusal lists the files. Confirm only if losing them is what the user
  asked for; otherwise report the files and ask.
- `NOTHING_TO_COMMIT`, `NOTHING_TO_STASH` — there was nothing to do; check
  `git_status` rather than repeating the call.
- `MISSING_IDENTITY` — the repository has no commit identity; the user must set
  `git config user.name` / `user.email`.
- `PR_UNAVAILABLE`, `NOT_GITHUB_REMOTE`, `PR_NOT_FOUND`, `PR_FAILED` — the
  pull-request backend could not be used; each message says which of the two
  backends is missing or what the API answered.

## Constraints
- Never pass `-`-prefixed values as refs, paths or filters; they are refused by
  design (flag injection), not a bug to work around.
- No command waits for input: prompts, pagers and optional locks are disabled,
  so a call can never hang on a password prompt.
- No tool has a `--force`, `--no-verify` or `--mirror` option, by construction.
  If a push or reset cannot be done without one, that is the moment to ask a
  human, not to look for another tool.
- Every write returns `before` and `after` (HEAD, branch, porcelain). Read them
  before reporting success — `headChanged: false` after a commit means the
  commit did not happen.
