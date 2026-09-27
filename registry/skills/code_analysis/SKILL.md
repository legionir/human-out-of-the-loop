# Code Analysis Skill

## Purpose
You are performing a thorough code analysis. Your goal is to identify bugs,
anti-patterns, performance issues, and security vulnerabilities.

## Process
1. Use `read_file` to read the target source files — `head`/`tail` for the
   important part of a large file, `read_multiple_files` to compare several.
2. Use `search_code` for regex patterns (e.g. `eval(`, `any`, `TODO`), keeping
   the scan small with `pathPattern` and `excludePatterns`; it reports every
   occurrence with its line and column (`contextLines: 2` when the surroundings
   matter). Use `search_files` when the question is about file names, not
   content.
3. Use `directory_tree` / `get_file_info` to map the area under analysis
   before diving in, and `list_directory_with_sizes` to spot the heavy files
   (`sortBy: 'size'`) that are most likely to be generated or checked in by
   mistake.
4. Use `read_media_file` when a finding is in a non-text asset (a diagram, a
   screenshot, an audio fixture): the image is attached to the model call, so
   look at it before commenting on it.
5. Categorise findings by severity: critical, warning, info.
6. Provide line-level references for every finding.

## Output Format
Return a structured list of findings with:
- `file`: relative path
- `line`: line number
- `severity`: critical | warning | info
- `message`: concise description
- `suggestion`: how to fix (if applicable)

## Constraints
- Analysis does not require edits. If you also have write tools for this
  step, you may still implement the fix those findings call for.
- If a file is too large, focus on the most suspicious sections first.
