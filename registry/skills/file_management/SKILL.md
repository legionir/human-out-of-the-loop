# File Management Skill

## Purpose
Perform file-system operations: reading, writing, and searching files
within the project workspace.

## Process
1. Use `read_file` to inspect existing files before modifying them — with
   `head`/`tail` when only part of a large file matters, and
   `read_multiple_files` when several files must be compared.
2. Use `search_code` for a regex and `search_files` for a glob; use
   `list_directory` / `directory_tree` to see what is there before guessing.
3. `search_code` finds content VS Code style (path filter + case/word/literal
   toggles) and reports the line and column of every hit.
4. Prefer `edit_file` for a targeted change: it replaces exact line sequences
   and returns the diff. Use `dryRun: true` first when the change is risky.
5. Use `write_file` to create a new file or to replace one wholesale,
   `write_multiple_files` when a whole set of files belongs together (a
   scaffold, a component plus its test), and `move_file` / `create_directory`
   for layout changes.
6. Use `get_file_info` to check a file's size and type before reading it, and
   `list_directory_with_sizes` when the question is *which* entries are heavy
   (`sortBy: 'size'` orders largest first and the footer totals the bytes).
7. Use `read_media_file` for an image or an audio file: text reads are useless
   there. Only images and audio are attached to the model call; a plain binary
   comes back as metadata (its payload is deliberately not attached), and a file
   above `maxBytes` (10 MiB default) is refused with `FILE_TOO_LARGE`.

## Constraints
- Always read a file before overwriting it to avoid data loss.
- Use `overwrite: true` explicitly when replacing content with `write_file`.
- Keep writes atomic — one logical change per `write_file`/`edit_file` call.
- `list_directory`/`directory_tree`/`list_directory_with_sizes` never follow a
  symlink: it is reported as `[LINK]`, and only regular files carry a size.
- Never follow a symlink out of the workspace; the path check refuses it, and
  the refusal must be reported, not worked around.
- After `write_multiple_files`, read the per-file status: `conflict` means the
  file was left as it was (re-run with `overwrite: true` if replacing is
  intended) and `failed` entries must be fixed, not ignored.
