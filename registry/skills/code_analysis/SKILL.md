# Code Analysis Skill

## Purpose
You are performing a thorough code analysis. Your goal is to identify bugs,
anti-patterns, performance issues, and security vulnerabilities.

## Process
1. Use `read_file` to read the target source files.
2. Use `search_code` to find specific patterns (e.g. `eval(`, `any`, `TODO`).
3. Categorise findings by severity: critical, warning, info.
4. Provide line-level references for every finding.

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
