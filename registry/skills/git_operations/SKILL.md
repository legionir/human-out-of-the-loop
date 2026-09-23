# Git Operations Skill

## Purpose
Inspect the current state of the git repository and report meaningful
information about uncommitted changes, branch status, and recent activity.

## Process
1. Run `git_status` to get the current working tree state.
2. Interpret the output and summarise:
   - Number of modified, added, deleted, and untracked files.
   - Whether the working tree is clean.
3. If the tree is dirty, list the most important changes.

## Constraints
- This skill is read-only — do NOT stage, commit, or push.
- If `git_status` fails (not a repo), report the error clearly.
