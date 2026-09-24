# Code Analysis Skill

## Purpose
You are performing a thorough code analysis. Your goal is to identify bugs,
anti-patterns, performance issues, and security vulnerabilities.

## Process
1. Use `read_file` to read the target source files — `head`/`tail` for the
   important part of a large file, `read_multiple_files` to compare several.
2. Use `search_code` for regex patterns (e.g. `eval(`, `any`, `TODO`) and
   `search_files` when the question is about file names, not content.
3. Use `directory_tree` / `get_file_info` to map the area under analysis
   before diving in.
4. Categorise findings by severity: critical, warning, info.
5. Provide line-level references for every finding.

## Output Format
Return a structured list of findings with:
- `file`: relative path
- `line`: line number
- `severity`: critical | warning | info
- `message`: concise description
- `suggestion`: how to fix (if applicable)

## Constraints
- Do NOT modify any files — this is a read-only skill.
- If a file is too large, focus on the most suspicious sections first.
