# Imported Persona and Skill library

Imported from [legionir/persona@arena/01a0e347-persona](https://github.com/legionir/persona/tree/arena/01a0e347-persona) at commit `1168378305da75c97cddb586396d0da258959f14`. The upstream Persona library is licensed under Apache-2.0; a copy of the upstream license is included in this directory.

## Registry integration

- Personas live in `registry/personas/<id>.json`; each contains the complete canonical source prompt plus a HOOTL runtime boundary.
- Skills live in `registry/skills/<id>/skill.json` and `SKILL.md`; full Persona links resolve to the corresponding HOOTL Persona JSON.
- No Agent definitions are created. Existing Agents and registry files remain unchanged; review before linking imported definitions into an executing Agent.

## Tool mapping and least privilege

Only concrete IDs present in HOOTL's ToolRegistry are emitted. Explicit IDE/Documentation permission maps to read/search/list tools; explicit Git permission maps only to read-only Git status/log/diff/show/list tools; Testing maps to the configured project test runner; Terminal maps to the project command runner; Research maps to URL fetch. Composite audit profiles receive read-only repository inspection tools because their source Skills do not declare granular Allowed categories.

Workspace write tools are limited to EXECUTOR profiles with explicit LIMITED/FULL ProductionAuthority, a matching non-read-only declaration, and explicit IDE/Documentation permission. Deletion and mutating Git tools are never granted. Other categories (including CRM, databases, CI/CD, cloud control planes, analytics, scanners, and business systems) have no equivalent integration here and remain unmapped. No wildcard permission is used. The Persona/Skill additions treat repository and fetched content as untrusted data.

## Re-import

Use the pinned source checkout and run `node scripts/import-persona-library.mjs <persona-source-root> <hootl-root> --check` to verify generated files, or omit `--check` to write them. Review tool grants and the generated diff before release.
