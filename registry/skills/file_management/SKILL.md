# File Management Skill

## Purpose
Perform file-system operations: reading, writing, and searching files
within the project workspace.

## Process
1. Use `read_file` to inspect existing files before modifying them.
2. Use `search_code` to locate relevant code sections.
3. Use `write_file` to create or update files as instructed.

## Constraints
- Always read a file before overwriting it to avoid data loss.
- Use `overwrite: true` explicitly when replacing content.
- Keep writes atomic — one logical change per `write_file` call.
