# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are aligned with the
delivery plans (`EXECUTION_PLAN_V2.md`, `CLI_COMPLETION_PLAN.md`,
`UI_COMPLETION_PLAN.md`, `PLAN.md`).

## [27.2.5] — 2026-09-24 — real MCP stdio transport (Phase 30 / P6 of READINESS_AUDIT.md)

`transport: "stdio"` was advertised by the registry schema and the CLI help, but
the connector threw `stdio transport is not supported in this version` — every
local MCP server (`npx …`, a python server, …) was unusable. Driving real stdio,
http and sse servers then exposed four bugs at the seams.

### Added

- **`src/ai/tools/mcp-stdio-transport.ts`** — a real stdio transport:
  newline-delimited JSON-RPC 2.0 over the child's stdin/stdout (no extra
  dependency; `@ai-sdk/mcp` ships no stdio transport). stderr is drained but
  never forwarded, `onclose` fires exactly once, and `close()` is
  SIGTERM → SIGKILL after 1 s.

### Fixed

- **`hootl mcp test <stdio server>` never returned.** The connection opened, the
  tools were listed, and then the CLI hung until it was killed (exit 124 at a
  60 s timeout) — the spawned child held the event loop open. `mcp test` now
  closes the connector in a `finally` path, so a failing test closes it too.
- **A failed or timed-out connection leaked its child process.** An attempt that
  never produced a client stored nothing that could be closed, so
  `Connection timeout after 3000ms` was followed by a hang (exit 124 at 30 s).
  The transport of every attempt is now released on failure — including the
  registry probe behind `POST /api/mcp/:id/test`.
- **A child dying mid-session crashed the whole CLI.** The next stdin write
  emitted an unhandled `'error'` event: `Error: write EPIPE` plus a stack trace.
  stdin/stdout errors are handled now (the pending `send()` rejects instead).
- **An MCP tool failure looked like a success.** `@ai-sdk/mcp` returns
  `isError: true` results as ordinary tool results, so `task.errors` stayed
  empty and the acceptance judge never saw the failure — the same invisibility
  bug O fixed for built-in tools. `describeToolFailure` now recognises the MCP
  error shape.

## [27.2.4] — 2026-09-24 — bounded LLM calls (Phase 30 / P5 of READINESS_AUDIT.md)

Driving the real CLI against a deliberately silent stub exposed two ways to
wait forever. Both are fixed; the run now always ends.

### Fixed

- **A timed-out agent run left the process alive.** `--timeout-ms` marked the
  step failed and printed the report, but the abandoned model request kept
  the Node event loop alive: the harness had to `SIGKILL` the CLI after 90 s.
  The run's deadline now aborts the in-flight request (and the losing side of
  the timeout race is swallowed, so no unhandled rejection).
- **Structured calls had no deadline at all.** Planner assessment, plan
  generation, acceptance judgment and the final review were issued without
  any timeout — a provider that accepts the socket and never answers hung the
  CLI forever, with no output.
  - New `withLlmTimeout(label, ms, fn)` (`src/ai/runtime/llm-timeout.ts`):
    hard deadline + `abortSignal` on the SDK call, error message
    `"<call> timed out after <ms>ms"`.
  - `--timeout-ms` (default 120 s) is now plumbed from the orchestrator into
    the planner, the acceptance checker and the final reviewer.
  - The planner no longer hides the real cause behind "request unclear": it
    reports the actual reason (e.g. a timeout).

### Verified behaviour

- Slow model + `--timeout-ms 5000`: `Agent run timed out after 5000ms` →
  step failed, `Outcome: FAILURE`, exit 1, **whole run in 5 s**.
- Infinite tool loop + `--max-steps 3`: exactly 3 tool calls, exit 0 in ~1 s.
- Planner that never answers + `--timeout-ms 5000`: ends in 5 s with a
  truthful message instead of hanging.
- Real `^C` mid-run: immediate exit, no orphan process, no half-written file;
  the plan stays `running` and `plans resume` continues it (the P2 path).

### Tests

- `src/ai/__tests__/phase30-p5.test.ts` — 5 tests (helper resolves/aborts,
  agent run aborts its request, planner answers within the deadline,
  acceptance check fails closed). Direction-checked: disabling the two aborts
  fails exactly those two tests.
- Suite: **605 passed (42 files)**, `tsc` clean.

## [27.2.3] — 2026-09-24 — the crashed task stops pretending to run (Phase 30 / P2 follow-up)

Closing the last open question from P2: a process killed with `SIGKILL`
mid-step can never write its own terminal event, so the task it was running
stayed `running` in `hootl tasks list` forever — even after the plan was
resumed successfully. Verified with a real crash + resume:

```
before:  task_344a1a98  step-2  running
after :  task_344a1a98  step-2  interrupted   ← the killed run
         task_e94d4fe6  step-2  done          ← the resumed run
```

### Fixed

- `plans resume` now captures the steps that were still `running` on disk
  before it re-runs them (the resume overwrites `taskId` on the very same
  step) and logs a `task:interrupted` entry (level `warn`):
  `Task "task_…" was interrupted by a crash; step "step-2" was resumed.`
- `hootl tasks list` maps that event to a distinct `interrupted` status
  (rendered in magenta, never as `running`) and the summary line counts each
  status: `3 task(s): 2 done, 0 failed, 1 interrupted, 0 running`.

### Tests

- `src/cli/__tests__/phase30.test.ts` — new regression test that simulates the
  crash state (including the `task:created` line the killed process managed to
  write), resumes, and asserts both the log entry and the task view.
  Direction-checked: disabling the emission fails the test.
- Suite: **600 passed (41 files)**, `tsc` clean.

## [27.2.2] — 2026-09-24 — real tool side effects + sandbox (Phase 30 / P3 of READINESS_AUDIT.md)

Verified by driving the real CLI against the stub provider with goals that ask
for real tools (`write_file`, `search_code`, `git_status`) and for writes
*outside* the workspace (`../escape.txt`, `/tmp/abs-escape.txt`). The sandbox
held in every case — and that is what exposed the defect: the refusal was
invisible everywhere.

### Fixed

- **A tool that refused to act was reported as success.** Every tool in
  `src/ai/tools/implementations/*` reports failure as a normal result
  (`{ success: false, error, code }`), so the AI SDK sees a successful tool
  call. Nothing recorded it: the observability log said `Tool "write_file"
  called` … `Task "…" completed. 1 tools used.`, the acceptance judge was
  handed `## Task Errors (if any)\nNone`, and the plan printed
  `Outcome: SUCCESS` for a step that wrote nothing.
  - `AgentRuntime` now inspects every raw SDK step content part and reports
    all three failure shapes: a thrown tool (`tool-error` part), the project's
    own `{ success: false, … }` contract, and `execution-denied`.
  - New `agent:tool_error` event → `task:tool-error` (level `warn`) in the
    observability log, and a `task:tool-error` progress event that is printed
    **always** (not only with `--verbose`):
    `✖ tool failed: write_file — Path … is outside workspace … [PATH_TRAVERSAL_BLOCKED]`.
  - Tool errors are appended to the agent summary (`Tool errors: write_file — …`)
    and stored on the task even when the run itself succeeded, so the
    acceptance checker (which reads `task.errors`) can reject the step.
  - Tool arguments and results still never enter events or summaries
    (Law 14: compact events); only the tool's own error message, truncated to
    200 characters, is carried.

### Verified behaviour (no change needed)

- `write_file` inside the workspace really writes: `notes/p3-demo.txt` on disk
  with the expected content, parent directory created, `Outcome: SUCCESS`.
- `search_code` runs on the real tree (hit and miss), `git_status` runs real
  git — in a non-repo it surfaces git's own `fatal: not a git repository …`
  and the plan fails honestly (exit 1).
- Path escapes are refused by `validateWorkspacePath` and **no file** is
  created outside the project root, for both `..` and absolute paths; the
  failure now propagates to the acceptance check, the final report and the
  exit code instead of being swallowed.

### Tests

- `src/ai/__tests__/phase30-p3.test.ts` — 9 tests: refusal result, thrown tool,
  denied execution, no false positives, compact-event check, error truncation,
  tool errors kept on a completed task, `task:tool-error` in the log, and the
  always-visible progress event. Direction-checked: disabling the detection
  fails 5 of them (`expected [] to have a length of 1`).
- Suite: **599 passed (41 files)**, `tsc` clean.

## [27.2.1] — 2026-09-24 — crash recovery (Phase 30 / P2 of READINESS_AUDIT.md)

Verified by really killing a run with `SIGKILL` mid-execution and resuming it
(`READINESS_AUDIT.md` → P2). The crash itself was clean — no leftover lock, no
orphan process, no half-written file, and `plans resume` re-ran only the step
that had not finished. One real defect surfaced in what the crash left behind.

### Fixed

- **A crashed run left the session interaction open forever.** The plan had no
  session reference and the interaction had no plan id, so after a `kill -9`:
  `sessions show` could not tell the user which plan to resume, and even a
  successful `plans resume` never closed the interaction (`outcome: pending`,
  no `completedAt`).
  - `Plan.sessionId` (optional) is now persisted, and both directions of the
    plan ↔ session link are written **before execution starts**.
  - `plans resume` matches the open interaction of the owning session, closes
    it with the real outcome/summary/plan id, and returns the real session id
    instead of the placeholder `'resumed'`.

### Verified behaviour (no change needed)

- `kill -9` mid-step → plan `running`, completed steps kept, no lock left
  behind, no orphan process; `plans resume` continues from the interrupted
  step only (usage 330 of a full 660) and finishes `completed`.
- A never-confirmed plan (`draft`) and an unknown plan id are still refused by
  `plans resume` (exit 1).
- Crash before a plan exists leaves nothing to resume; `sessions show` reports
  the interaction honestly as `pending` (documented limitation — detecting a
  dead run would need a heartbeat).

### Tests

- New `src/cli/__tests__/phase30.test.ts` (5 tests, direction-checked: without
  the fix two of them fail with `expected undefined to be 'session_…'` and
  `expected 'pending' to be 'success'`).

## [27.2.0] — 2026-09-24 — every CLI workflow driven like a real terminal user

Ten bugs were found by driving the CLI inside a real PTY — real prompts, real
keystrokes, real `Ctrl-C`, verified exit codes — instead of trusting the
in-process tests alone.  Highlights: the interactive plan confirmation did not
work at all with the installed inquirer version, plan-declared tools never
reached the agents, and `hootl usage` printed `***REDACTED***` instead of token
counts.

### Fixed

| # | Bug | Detail |
|---|---|---|
| 1 | **Interactive confirmation crashed** | `hootl run "<goal>"` without `--yes` died with `Prompt type "list" is not registered`: inquirer v14 renamed the arrow-key list to `select`. That made the tool's whole interactive path — clarification questions, plan confirmation, rejection feedback — unusable. |
| 2 | **Failed planning printed an empty prompt** | When planning failed without clarification questions the CLI printed `⚠️ Clarification needed:` with nothing under it. It now reports `🛑 Planning failed: <error>` and marks the session interaction as failed. |
| 3 | **Raw `ZodError` dumps** | `--max-steps 0` / `--timeout-ms 500` fell through to config-schema validation; both are now validated up front (`1-100`, `1000-600000`) with exit code 2 and a human sentence. |
| 4 | **Unknown `--model` reached the planner** | `--model ghost-model` now fails before any model call with the list of valid ids and a `hootl models` hint (exit 2). |
| 5 | **Plan-declared tools never reached the agents** | The plan showed `Tools: read_file` but `PlanStep.assignedTools` was read by nobody, so every step ran without tools (`tools` was absent from the model request and the summary said "No tools used"). `AgentDefinitionSchema` gained `toolIds`, `createAgent` merges them (still filtered by `persona.allowedTools`), and `buildAgentForStep` passes `assignedTools`. |
| 6 | **Token counts were redacted in the log** | The `token` redaction pattern also matched the numeric counters `promptTokens` / `completionTokens` / `totalTokens`, so `hootl usage` and the TOKENS column of `hootl tasks` printed `***REDACTED***`. Numeric `*Tokens` values are now kept as metrics while string credentials (`accessToken`, `dbToken`, …) stay redacted. |
| 7 | **Step counter overshot (`[4/2]`)** | `plan:step-completed` is emitted twice per step (plan lifecycle + `agent:completed`). Agent-level events now carry `agentLevel: true` and are shown only with `--verbose`, so the counter reads `[1/2] … [2/2]`. |
| 8 | **`plans show` printed raw JSON** | Its own description promises "steps, personas, tools, dependencies". `plans show` now renders the plan for a human (per-step status, persona, skills, tools, dependencies, acceptance criteria, result) and `--json` keeps the machine-readable dump. |
| 9 | **`sessions label` was write-only** | Labels were set but never listed; `sessions list` gained a `LABEL` column. |
| 10 | **`--session <unknown>` was accepted silently** | The run reported the bogus id as its session and persisted no interaction; it now fails fast (exit 2) with a hint, and the hint explains that sessions require `--persistent`. |
| 11 | **`plans cancel` did not stop a running plan** | `hootl plans cancel <id>` from a second terminal reported success and persisted `cancelled`, but the process that owned the run never re-read the store: it ran to the end and overwrote the cancellation with `completed`. The execution loop now honours the persisted `cancelled` status (before dispatching more work and before deriving the final status) and `persist()` refuses to overwrite a cancellation. The run ends with `❌ Plan cancelled. 1/2 steps completed.`, outcome `CANCELLED`, exit 1, leaving the incomplete steps listed. Running agents are not killed mid-step (the step in flight finishes) — matching the command's documented semantics. |

### Changed

- `hootl run ""` is a usage error (exit 2) instead of a planner round-trip.
- `logs --tail 0` prints no initial lines (`slice(-0)` used to dump the whole log) — handy with `--follow`; a non-numeric/negative `--tail` is a usage error.
- Help text documents the accepted ranges for `--max-steps`, `--timeout-ms` and the meaning of `--tail 0`.
- `logs --follow` was verified to stop cleanly on `Ctrl-C` (exit 0) in a terminal with a controlling tty.

### Tests

- New `src/cli/__tests__/phase29.test.ts` (14 tests): pre-flight usage errors, the surfaced planning failure, the step counter with agent-level events, numeric-token redaction, the human `plans show` view, `--tail` validation, a guard asserting the interactive prompt types exist in the installed inquirer, and cross-process cancellation (fails without the fix).
- Full suite: **585 tests / 39 files**, `tsc` clean.

## [27.1.0] — 2026-09-24 — `hootl` command, layered registries, self-documenting CLI

Makes the CLI usable from ANY directory and documents itself inside the CLI.

### Added

| # | Change | Detail |
|---|---|---|
| 1 | **`hootl` binary alias** | `package.json` now exposes two binaries pointing at the same entry point: `human-out-of-the-loop` and `hootl` (`npm install -g .` / `npm link`). The help text follows the invoked name, so `hootl --help` prints `Usage: hootl …` while dev runs and tests keep the long name. |
| 2 | **Registry layering (global + local)** | `src/ai/registries/layout.ts` resolves, in precedence order, the packaged registry (`registry/` next to `package.json` — found by walking up from the module, so it works from `src/`, `dist/` and a global install) and the project registry (`<project-root>/registry`). Both are loaded everywhere registries are read: `Orchestrator.initialize()` (personas, tools, skills, models, agents.json, MCP bootstrap), the `models`/`personas`/`skills`/`tools` commands and `mcp list`/`mcp test`. A project entry with the same `id` REPLACES the packaged default (new `Registry.replace()`, loader `override` option); other packaged entries stay available. |
| 3 | **`HOTL_NO_PACKAGE_REGISTRY`** | Set to `1`/`true` to ignore the global layer and use strictly local registries. |
| 4 | **Layer provenance in output** | Registry commands print `registry: package (built-in) + project (.)` (and `--json` output stays pure JSON). |
| 5 | **Complete in-CLI help** | Every command and subcommand gained a real description plus a detailed appendix: run lifecycle (clarification → plan → confirm → execute) and interactive vs non-interactive behaviour, plan/session subcommand reference and states, MCP configuration and credential rules, observability-log/tasks/usage semantics, exit codes, configuration precedence, registry layers and project-root/state notes. `hootl --version` prints the package version. |

### Fixed

- **EPIPE crash on early pipe close**: `hootl --help | head`, `hootl models --json | jq '.[0]'` and similar pipelines used to die with an unhandled `Error: write EPIPE` stack trace; the CLI now installs a stdout/stderr guard and exits 0 when the consumer closes the pipe.
- `--help` on any subcommand used to bypass the CLI's exit-code contract (`commander` only honours `exitOverride()` on the command that registered it and therefore called `process.exit` directly); the override is now applied recursively, so all help/version paths return exit code 0 through `main()`.

### Changed

- A project without its own `registry/` is no longer an error: introspection commands used to exit 2 with a hint, now they list the built-in catalog (exit 0) and only report exit 2 when neither layer exists. The Orchestrator likewise tolerates layers that ship only some subdirectories (for example models-only), while malformed entries still fail loudly.

## [27.0.0] — 2026-09-24 — Residual P2 closure

Non-breaking follow-up to [25.0.0]: the five residual findings of
`EXECUTION_PLAN_V2.md` (phase 26/27 work) are closed. Existing call sites keep
their behaviour; the only API additions are optional parameters.

### Added

| # | Change | Detail |
|---|---|---|
| 1 | **Injectable environment (CFG-08)** | `EnvSource` + `resolveEnv` in `src/ai/env.ts`. `OrchestratorConfig.env`, `ModelRegistry({ env })`, `ProviderFactory.create(config, env)`, `McpConnector({ env })` and `bootstrapMcpServers(..., env)` all accept an environment source — omit it and the live `process.env` is used exactly as before. Enables several Orchestrators with different credentials in one process. |
| 2 | **`search_code` skip reporting (SEC-02)** | The tool result now carries `skippedCount` and `skipped[]` (capped at 20 entries, `{ path, kind, error }`) for unreadable files *and directories* — permission errors are no longer silent. |
| 3 | **Store id index (PERF-06)** | `FilePlanStore.list()` / `FileSessionStore.listSessions()` parse each file at most once per instance; the warm path performs a single `readdirSync` and zero reads. |
| 4 | **Cross-process file locking (PERS-04)** | `withFileLockSync` (`src/ai/runtime/file-lock.ts`) guards every store write with an `O_EXCL` lock file: bounded wait → `FileLockTimeoutError` (carries the holder), re-entrant in-process, and self-healing takeover of abandoned locks (stale mtime or dead pid). |

### Changed

| # | Change | Detail |
|---|---|---|
| 1 | `EventBus.emit` no longer allocates (PERF-08) | Type/wildcard subscribers are deduplicated through a reusable per-depth buffer; 1000 emits keep a single buffer. Dedup, ordering and error isolation are unchanged. |

### Fixed

- Lock files use a `.lock` suffix, so store `list()` never mistakes them for data (verified by tests).
- **Provider SDK loaders no longer use a bare `require(...)`** (discovered while smoke-testing CFG-08 in the real runtime): this package is ESM (`"type": "module"`, `module: ESNext`), where `require` is undefined, so `getOpenAISdk()/getAnthropicSdk()/getOpenAISdkLocal()` threw "…is not installed" on every real CLI/server run. Vitest's `require` shim masked the bug in unit tests. The lazy loaders now go through `createRequire(import.meta.url)` (memoized as before), and `phase27.test.ts` spawns `node --import tsx` to cover the real runtime.

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
