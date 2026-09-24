# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are aligned with the
delivery plans (`EXECUTION_PLAN_V2.md`, `CLI_COMPLETION_PLAN.md`,
`UI_COMPLETION_PLAN.md`, `PLAN.md`).

## [25.0.0] — 2026-09-24 — Final hardening, docs & delivery

The release that closes the hardening programme (phases 18–26) and ships the
CLI (C1–C5) and web UI (U1–U8) plans. **Breaking changes are listed first** —
this project explicitly allowed them (see "Breaking-change policy").

### ⚠️ Breaking changes

| # | Change | Migration |
|---|---|---|
| 1 | **Record ids are UUID-based**: `plan_<randomUUID>`, `session_…`, `interaction_…`, `dynamic_…`, `pending_…` (was `plan_${Date.now()}`, 6-char base36 suffixes). | Nothing to do in code — ids are opaque strings. `.ai-runtime` data written by earlier versions still reads correctly (the stores take the id from the JSON body, and filenames are content-hashed). To start from a clean slate: `rm -rf .ai-runtime`. |
| 2 | **`projectRoot` is mandatory** and must be passed explicitly: every tool factory receives it (`createReadFileTool(projectRoot)`, …) and `validateWorkspacePath` throws when it is missing (was: fallback to `process.cwd()`). | Pass `projectRoot` to the Orchestrator / CLI (`--project-root`) / server (`HOTL_PROJECT_ROOT`). |
| 3 | **No global `EventBus` fallback.** `AgentRuntime`/`TaskRuntime` no longer fall back to a module-level bus — the bus is injected (`new TaskRuntime({ eventBus })`). | Pass the bus explicitly; `Orchestrator` does this for you. |
| 4 | **`OrchestratorConfig` is validated by Zod** and throws `ZodError` for invalid values (was: silently accepted). | Fix the offending field; the error lists the allowed range. |
| 5 | **`OrchestratorConfig.maxSteps` / `--max-steps` are now live** (U3). They previously had no effect; runs may now stop earlier/later than before. | Remove the flag or set it to the previous `AgentRuntime` default (`20`). |
| 6 | **`Review.usage` is required** (`emptyReviewUsage` provides zeros) and every review builder emits it. | Consumers reading `review.usage` no longer need an optional check; writers must include it. |
| 7 | **Terminal plan statuses**: `isPlanTerminal` now returns `true` for `completed`/`failed-partial`/`cancelled` without inspecting steps (a cancelled plan with pending steps is no longer "resumable"). | Use `resumePlan` only for non-terminal plans; `plans resume` on a draft plan returns "not found" (guarded since phase 24). |
| 8 | **Storage filenames are `sha256(id)` based** (was `id.replace(/[^a-zA-Z0-9]/g, '_')`) — ids differing only in punctuation no longer collide. | None; `list()` returns the original ids. |
| 9 | **Server/CLI configuration is unified** (U1): the server reads `~/.human-out-of-the-loop/config.json` and the project `.env`, so a server started without `HOTL_MODEL` may now use your configured `defaultModel` instead of `gpt-4o`. | Set `HOTL_MODEL` (or the `model` server option) to pin the model. |
| 10 | **New commands/flags** (C1–C5, phase 23): `mcp list|test`, `logs [--follow]`, `usage`, `tasks`, `sessions label`, `plans cancel|resume`, `run --dry-run/--timeout-ms/--max-steps/--max-replans/--label`. | n/a (additive). |

### Added

- **CLI (C1–C5)**: full command surface (`run`, `sessions`, `plans`, `mcp`,
  `models`, `personas`, `skills`, `tools`, `usage`, `tasks`, `logs`), interactive
  clarification, `--dry-run` preview, session labels.
- **Web UI (U1–U8)**: Express server + vanilla front-end — run/preview/clarification
  flows, per-run model & execution options, live task list with real per-task
  cancel, usage counters, session rename, observability follow stream, registry
  introspection panel (`/api/models`, `/api/personas`, `/api/skills`,
  `/api/tools`, `/api/mcp`, `POST /api/mcp/:id/test`).
- **Interactive clarification (C4/U5)**: the planner may ask questions; answers
  are fed back, the plan is regenerated, and only then is the single
  confirmation requested (`maxClarificationRounds`, default 3).
- **Per-run overrides (U3)**: `modelId`, `agentTimeoutMs`, `maxSteps`,
  `maxReplanningAttempts` — validated before any side effect
  (`InvalidModelError` carries the valid model ids).
- **Observability follow stream (U7)** and `redactKeys` configuration (U1).
- New docs: migration guide in `src/ai/README.md`, CLI reference + Web UI
  section in `README.md`, full config tables in `src/ai/CONFIGURATION.md`.

### Fixed

- Path security (PATH-01…09): every filesystem tool is bound to `projectRoot`,
  symlinks are resolved (`realpathSync`), Windows-style separators and
  case-insensitive roots no longer escape the workspace, skill instruction
  paths are boundary-checked.
- Config wiring (CFG-01…08): one catalogue bootstrap, `RateLimiter` and
  `DelegationGuard` receive their config, `agentTimeoutMs` actually applies,
  every documented ceiling exists in the schema.
- Persistence (PERS-01…03): atomic writes (`tmp` + `fsync` + `rename`),
  `structuredClone` snapshots, no shared mutable state between store reads.
- Timer leaks (LEAK-01/02): `clearTimeout` in `finally` for MCP connects and
  agent runs; `waitForAll` before `destroy`.
- Correctness (CORR-01…08): Zod issue paths in errors, per-plan usage
  bucketing (`task.planId`), explicit acceptance hooks, `event.planId`
  propagation through the streaming manager.
- Security (SEC-01…06): ReDoS guard for `search_code` patterns (nested
  quantifiers rejected, pattern length capped), MCP success threshold,
  substring-based redaction (`myApiKey` is redacted), relative paths returned
  to the model instead of absolute ones.
- Performance (PERF-01…08): O(1) task counts, memoized transitive-dependent
  counts, reused file descriptors in the observability logger.
- Quality (QUAL-01…07): zero `any` and zero `console.*` in runtime sources
  (enforced by source-scan tests), dead code removed, `abortSignal` plumbed to
  `generateText`, injectable randomness for deterministic backoff tests.

### Verified

- `npx tsc --noEmit` clean; **527 tests across 36 files** green.
- Live smoke: CLI registry/log commands, and the web UI on `:3000` (every
  endpoint, preview, clarification, usage/tasks, observability stream).

## [17.0.0] — previous baseline

17 phases, 334 tests, library-only (no CLI/UI). See `PLAN.md`.
