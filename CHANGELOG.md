# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are aligned with the
delivery plans (`docs/history/` — `EXECUTION_PLAN_V2.md`, `CLI_COMPLETION_PLAN.md`,
`UI_COMPLETION_PLAN.md`, `PLAN.md`).

## [Unreleased] — Workflow Profiles (opt-in, off by default)

Workflow Profiles let a JSON document describe the run's control flow (intake, planner, bounded
clarification, digest-bound plan approval, delegated execution, review, ends) while `PlanRuntime`
stays the only inner-DAG scheduler. **`HOOTL_WORKFLOW_PROFILE` is off by default: without an explicit
opt-in nothing profile-related is resolved and the existing path runs unchanged.**

**Added**
- Draft 2020-12 schema, semantic validation, dependency resolution with content-digest pins, the
  execution kernel, node handlers/adapters, durable run state with resume guards, budgets,
  authorization guard and events (Phases 2–6).
- The built-in default profile (`src/ai/workflow-profiles/default-profile.ts`), built in code with
  pins computed from resolved component content, and the activation seam plus run bridge that wire it
  to the Orchestrator behind the flag (Phase 7).
- Authoring and selection (Phase 8): discovery on fixed conventions (`.hootl/workflow-profiles/`
  project scope behind the trust opt-in, `HOOTL_WORKFLOW_PROFILES_DIR`, and a single explicit file),
  `hootl profiles list`, `hootl profiles validate <id|file>` (schema, semantics and dependency pins;
  exit 1 on any diagnostic) and `hootl run --profile <id> | --profile-file <path>`. Selecting a
  profile for a run is the opt-in: it enables the flag for that run only, and every failure
  (unknown id, unreadable/broken file, untrusted project profile, stale pin) happens before a session
  or plan exists. A run without a selection never resolves a profile.
- Named toolsets are loadable from the registry layers (`<layer>/toolsets/<id>.json`, project
  overrides package) and are wired into both the run and `profiles validate`, so a profile can pin a
  `toolset` dependency. A toolset still cannot add access: every tool id is re-checked against the
  live catalog and the effective set stays an intersection (Phase 9 finding H-3).
- `docs/workflow-profiles/PHASE8_AUTHORING.md`, the self-contained authoring guide, plus two
  resolvable examples under `docs/workflow-profiles/examples/` (answer-only, bounded review/fix) that
  are validated end to end in the test suite.

**Added**
- Durable, resumable Workflow Profile runs: a selected profile records itself under
  `<projectRoot>/.ai-runtime/workflow-profile-runs/` by default (with the package version as the
  runtime version unless the host declares one), `hootl profiles runs [--json]` lists the recorded
  runs with status, node, counters and whether they can be resumed, and
  `hootl run --resume <runId> "…"` continues an interrupted one — re-selecting the same profile
  content (by id, or from the file it was selected from) and continuing its session. A stored
  approval is never authority: the resumed attempt runs the approval node and asks again. Nothing is
  auto-retried (a pending effect refuses continuation) and a finished run is refused as history.
- `docs/workflow-profiles/PHASE10_OPERATIONS.md` (upgrade, rollout and rollback operations, including
  the evidence that no persistent-state migration is required), `docs/workflow-profiles/TRACEABILITY.md`
  (the `WP-R-001`…`WP-R-013` matrix, the decision register and the open owner items) and
  `docs/workflow-profiles/RELEASE_NOTES.md` (what ships, how to enable it, the behaviour differences
  needing acceptance and the pre-activation checklist).
- A CI gate for the shipped flow documents: `scripts/profile-gates.mjs` (also `npm run profile-gates`,
  wired into `.github/workflows/ci.yml`) validates the built-in default profile and every example
  through the schema, the semantic validator and fail-closed dependency resolution, checks that the
  shipped JSON Schema is the validator's schema, and runs negative controls that prove the validators
  still refuse unknown keys, non-v1 node kinds, unbounded loops and dangling error routes.
- `docs/workflow-profiles/examples/error-route.example.json`: the work path with a typed error route
  (a delegated execution failure becomes a rejected end instead of an abort), validated by the test
  suite and the CI gate like the other examples.
- Profile runs now record every approval decision (node, status, bound digest and port) in the run
  state through the new `recordApproval`/`appendApprovalRecord`; the record is audit data only and a
  resumed attempt re-runs the approval node and asks the user again.

**Security**
- A selected profile could omit the confirmation node and execute its plan without any human
  confirmation (the legacy path always requires one). Execution now requires a granted side-effect
  approval whose bound digest is the plan being executed; the refusal is a terminal
  `security-denied` failure (`execute.approval-required`) that no `onError` policy can route or
  retry. Found by the Phase 9 end-to-end hardening pass (`docs/workflow-profiles/PHASE9_HARDENING.md`).
- The profile path sent the planner its node goal text instead of the user's request (the request
  arrives as the entry payload object). Both paths now hand the planner the request; a regression
  test fails without the fix (finding H-2 in the same document).
- Phase 9 hardening: end-to-end adversarial coverage for component-content injection, toolset
  narrowing, a toolset naming an unavailable tool, an unknown approval policy, error-payload leakage
  into the report/session/log, graph caps and an exhausted bounded loop; findings and the
  reproducible measurements (byte cap before parse, counters before calls, flag-off cost) are
  recorded in `docs/workflow-profiles/PHASE9_HARDENING.md`.

**API**
- `POST /api/run` accepts `profile: "<id>"` and runs that request with the selected Workflow
  Profile, resolved by the same code as `hootl run --profile` and before the run, session or plan
  exists (400 with diagnostics otherwise). Requests without the field are unchanged, and selection
  is per request — the flag is never enabled process-wide. `profileFile` is not accepted over the
  API; selecting by file stays a CLI action.

**Known gaps — independent review of 2026-09-30 (fixes in progress):**
- **Fixed (`220af0b`, `36810452453` 10/10):** the declared tool surface now narrows every plan step
  before the delegated runtime sees it (F-1); the delegated execution is charged from the usage the
  run's own events report, and a plan the remaining budget cannot fund is refused before it starts
  (F-2); the delegated call is a persisted `pendingEffect` until the runtime reports back, so a kill
  mid-effect refuses an automatic retry (F-3); the confirm callback receives the captured plan, so
  `POST /api/plans/:id/confirm` and Ctrl-C `cancelPlan` work on the profile path (F-6); the run's
  abort signal reaches the delegated runtime (F-8).
- **Fixed earlier:** auto-mode escalation on the profile path re-ran the prepared run and crashed with
  `resume.already-terminal`; the escalated attempt is now its own run (fresh id), with a parity
  regression (F-9).
- **Fixed (`85cf218`, `987e197`):** resuming a stored run now takes an exclusive run lease
  (`resume.locked` for a live second process, self-healing when the holder died) — F-4; an approval
  that binds content must show it, refused at load time and at the runtime boundary — F-5; a resume
  hands a mid-graph pause the inputs it was waiting on, and a legacy record without them refuses
  instead of failing inside the node — F-7; the profile planner receives the session history exactly
  like the legacy planner — F-10.
- **Closed:** every finding of the independent review is fixed (F-1…F-10). Phases 6, 7 and 9 are 🟢
  again and Phase 10 Step 3 closed with the owner's merge authorization (2026-10-01); the merge is on
  hold at the owner's direction while the stack scope is decided (PR #10 is part of native stack #11
  with PR #9 — `EXECUTION_PLAN.md`, Phase 10 Step 3). The built-in default stays unapproved and off.
  `TRACEABILITY.md` §3b holds the fix ledger.

**Behaviour differences — decided by the owner on 2026-09-30 (U-4)** (recorded in
`docs/workflow-profiles/PHASE7_PARITY.md`, the decision record in `PHASE10_OPERATIONS.md` §9; the
built-in default stays gated until the approval is recorded):
- **Accepted:** a plan-confirmation denial with feedback cannot re-plan in v1 (the digest-bound
  decision port is an object and v1 predicates address one top-level scalar port): the run ends
  fail-closed, like a cancellation.
- **Accepted:** the answer branch ends with the run status `success`; the interaction status
  `answered` stays the entry point's job, and an answer outcome without text ends with no response
  value.
- **Changed — report aligned:** the profile path now renders the legacy `FINAL REPORT` block and
  appends one line naming the profile status and whether the run executed.
- **Changed — `rejected` ends (R-3):** a `rejected` end reached before anything executed is reported
  as `cancelled` (a refusal, like a declined confirmation on the legacy path); a `rejected` end
  **after** execution stays `failure`. Both directions are pinned by a regression test.
- A failed plan execution is routed to the review (the current flow reviews failures instead of
  aborting), so the run is reported rather than terminated at the execution node.

## [27.17.17] — 2026-09-27 — Real provider runs and a green CI matrix

Found by running the CLI against a real OpenAI-compatible gateway (`real-provider.yml`) and by the first real Actions runs of the CI matrix. Suite: **vitest 1693/1693** (also with `TMPDIR` behind a symlink), **e2e 209/209**; CI green on ubuntu/macos/windows × node 22/24/26.

**Security**
- Checkpoints copied the project's `.env` into `.ai-runtime/checkpoints` — the provider key ended up in run artifacts. Credential files (`.env`, `.env.*` except `.env.example`) are never snapshotted.

**Fixed**
- File tools refused every path when the project root was reached through a symlink (macOS `/var`, Windows 8.3 `RUNNER~1`): allowed roots now include their real paths, and a checked path is returned under the root as the caller spelled it (relative paths and `.git`/`.ai-runtime` protection stay right). git's `--show-toplevel` is expressed the same way.
- A gateway answering HTTP 200 with a body that is not a response (`upstream_error: temporarily unavailable`) ended the run at planning. Structured calls retry it up to 3 times with backoff (`HOTL_UNREADABLE_RETRY_MS`), and the error names the status and the start of the body.
- Auto mode: a request whose chat answer only points at `@plan` (a Persian "create a file" request did this) is now planned instead of asking the user to retype it.
- Checkpoint rollback decided "new file" by mtime (a file written in the capture's millisecond survived); the manifest lists the files present at capture.
- `hootl usage --json` printed prose on an empty project; it prints `{ plans: [], totals }`.
- Windows: a rename onto a file briefly held open (EPERM/EACCES/EBUSY) is retried.
- `real-provider.yml`: reads `HOTL_MODEL`/`HOTL_API_STYLE` from secrets too; accepts model names with dots; the leak check matches keys literally and names the file.

**Tests**
- A CLI command matrix runs every read-only command on a fresh project, plus the unknown-id paths.
- The suite is portable to Windows (POSIX-path assumptions removed).

## [27.17.16] — 2026-09-27 — Code review of phases A–K: fixes

A review of the A–K fixes (tracked as phase **R** in `docs/UNIFIED_EXECUTION_PLAN.md`) found defects the fixes introduced or left open. All are fixed with regression tests (`src/ai/__tests__/review-fixes.test.ts` plus the phase test files named below). Suite: tsc clean, **vitest 1670/1670** (also under three shuffled orders), **e2e 209/209**.

**Security**
- **E-03** `ANTHROPIC_API_KEY` is never sent to a custom `baseURL`, and neither provider accepts an `apiKeyEnv` that names the real key for a custom endpoint (R0-07 regression).
- **J-01/J-02** `run_command`/`run_tests`: `.ai-runtime/commands.json` is honoured only for a trusted project; argv[0] must equal an allowlist entry exactly (no `./scripts/npm`); an empty allowlist no longer admits any test binary; children run without credential variables.
- **J-04** plan files scrub every string (a step `handoff` carried an echoed key into the plan file — found once the e2e credential trap really ran).
- **A-01** the web UI sends the token (fetch header; `?access_token=` for the two GET SSE routes only).
- **A-08** sessions, their plans, both SSE streams and the plan/session lists are bound to the owning token.

**Correctness**
- **F-04** trimmed tool results keep the SDK `ToolResultOutput` shape (providers sent tool messages without content from the 4th tool call on).
- **C-01** an agent timeout returns even when the call ignores its abort; the task keeps its lock/slot until the work settles (max 30 s).
- **B-07/G-07** Ctrl-C, shutdown and operator cancel end the run; only real feedback text re-plans.
- **B-15/J-03** session history and the budget are per run (concurrent web runs shared them).
- **B-06** reconciliation never closes an interaction a live process (this one or another) is working on.
- **B-08** resuming a plan with an unjudged `done` step no longer crashes the acceptance check.
- **C-07** a parent waiting in `delegate_task` lends its concurrency slot to the child (no deadlock).
- **B-01** plan ownership is claimed atomically; **C-10** breaking a stale lock never steals a fresh one.
- **B-18/B-19** tools of an unavailable or untrusted-skipped MCP server warn instead of failing start-up.
- **J-05** checkpoints: no rollback over a concurrent writable step, stored under `runtimeDir`, restore removes only files created after the snapshot, bounded size and retention.
- **E-07** chat answers get the detected language; **E-08** Persian requests quoting code stay Persian.
- **E-01** the planner catalog lists every tool a persona may use (was cut at 16).
- **D-07** git/command runners read output to the end; **D-03** mixed CRLF/LF files keep each line's ending.
- **Usage** a chat turn is counted once; chat/clarification reviews report their own run only.
- **C-02 / v27.17.2** a stream that fails before any output is re-asked without streaming; after output it fails.
- **G-02** the no-TTY check runs after the free pre-flight and not in chat mode.

**Performance / housekeeping**
- **F-03** the tool-result cap trims to the budget instead of to 2 000 chars.
- **C-11** one `stat` per log write; the newest 5 rotated logs kept; `HOTL_RETENTION_DAYS` (default 365) for plans/sessions; unique rotated names.
- TaskRuntime waits are event-driven (no 10–15 ms polling).

**Audit items**
- **ARCH-003** one layered MCP-server loader (`loadLayeredMcpServers`) for CLI, server and runtime.
- **OPS-001** the suite passes in shuffled order (phase11 mock queue reset; phase42 is an ordered scenario by design).
- **Appendix B-1** `.env.example`.
- `registry/models/local-llama.json` restored (a personal config had replaced it); e2e runs with an isolated `HOME`.

## [27.17.15] — 2026-09-27 — Phase K (partial): XSS encoder, R0 re-verify, baseline

Does **not** close K-01 (real provider), K-02 (Windows Actions), K-03 (full-green suite), K-05 (deploy bind), or K-07 (live SIGKILL).

- **K-08 — XSS.** `escapeHtml` / `renderMarkdown` live only in `public/ui-logic.js`; `app.js` interpolations must go through them. Tests in `phase-k-xss.test.ts`.
- **K-09 — R0-07/09/10.** Re-run via `phase-k-r0-reverify.test.ts` plus the original hardening files.
- **K-04 / K-06.** SSE connection/ring-buffer caps and MCP `bodyTimeout: 0` locked in `phase-k-sse-scale.test.ts` (idle-stream crash still covered by `phase30-p10-fetch.test.ts`).
- **K-07 (partial).** Cancel unblocks `waitForAll` (`phase-k-shutdown.test.ts`).
- **K-03.** Baseline recorded in `audit/baseline/k03-SUMMARY.md` (tsc clean; vitest 1607/19; e2e 144/194).
- Owner checklists: `audit/baseline/K01_OWNER_CHECKLIST.md`, `K02_CI_WINDOWS.md`, `K05_BIND_OWNER.md`.
- **Tracker.** `docs/UNIFIED_EXECUTION_PLAN.md` §1–§7 refreshed after `b2a8acb` / v27.17.15; Phase K test inventory registered. Open rows remain K-01/K-02/K-03/K-05/K-07.

## [27.17.14] — 2026-09-27 — Phase J: new capabilities

Closes every open row of **Phase J** in `docs/UNIFIED_EXECUTION_PLAN.md` (J-01…J-09). Independent tests live in `src/ai/__tests__/phase-j-*.test.ts`.

- **J-01 — `run_command` / `run_tests`.** Allowlist (`.ai-runtime/commands.json`, `HOTL_ALLOWED_COMMANDS`); argv spawn (no shell); timeout kills the process group; output cap + `truncated`; journalled; not read-only.
- **J-02 — self-verify.** After a coder step, if `testCommand` / `HOTL_TEST_COMMAND` is set, tests run automatically. Failure is technical and re-plan sees the output.
- **J-03 — `--budget`.** Token count or `$1.50`. Exceeding cancels with `budget exceeded` and blocks further model calls. Model registry `pricing`.
- **J-04 — step handoff.** `{changedFiles,keyResult,notes}` in dependent prompts (`DEPENDENCY HANDOFF`), not the full transcript.
- **J-05 — checkpoint / rollback.** File-copy snapshot before a writable step; restore on failure; `hootl plans rollback <id>`.
- **J-06 — model routes.** Cheap classify/judge/review vs plan/code; usage `byModel`.
- **J-07 — `--estimate`.** Plan only; print steps, tokens, and USD; nothing executes.
- **J-08 — plan examples.** Successful plans in `.ai-runtime/plan-examples.jsonl`; `HOTL_PLAN_EXAMPLES=0` disables; size cap; overlap selection.
- **J-09 — extras.** `delete_file` (sandbox + journal); `read_graph` `offset`; `GET /api/runs`.

## [27.17.13] — 2026-09-27 — Phase I: tests, CI, docs

Closes every open row of **Phase I** in `docs/UNIFIED_EXECUTION_PLAN.md` (I-01…I-08).

- **I-01 — catalog-aware stub.** `e2e/fake-llm.mjs` parses `AVAILABLE CATALOG` and assigns only listed personas; missing catalog or `PERSONA:ghost` errors. Scenario `catalog` covers E-01/E-02.
- **I-02 — coverage map.** One directed `it` per closed A–H UNIFIED row pointing at the regression file.
- **I-03 — no fixed sleeps.** `waitUntil` poll with a cap in followLog, stdio MCP, and EPIPE tests.
- **I-04 — CI once per PR.** `push` only `main`; concurrency `workflow-PR|sha`; npm cache kept.
- **I-05 — annotations.** Cap 40 GitHub `::error` lines, each with `line=`.
- **I-06 — real-provider.** Anthropic leak grep; model from `vars.HOTL_MODEL`; `HOTL_API_STYLE`; cron without a secret skips.
- **I-07 — docs.** `HOTL_*` ↔ `CONFIGURATION.md`; `HOTL_NO_SPLASH`; planner `skillIds: ["task_decomposition"]`; README/`CHANGELOG` suite notes.
- **I-08 — comments.** Semantic comments on files touched this phase.

## [27.17.12] — 2026-09-27 — Project index for agent context

Adds `hootl index` and `docs/PROJECT_INDEX.md`: a static `structure.json` (directories + direct file counts) separate from on-demand `files.json` (`size` + `lines`). Traversal is parallel `readdir({ withFileTypes })`; metadata is one `readFile` per file (no extra `stat`). Tools: `list_tree`, `list_files`, `find_files`, `search`, `read_file_range`.

## [27.17.11] — 2026-09-27 — Phase H: web UI ↔ server

Closes every open row of **Phase H** in `docs/UNIFIED_EXECUTION_PLAN.md` (H-01…H-14).

- **H-01 — plan modal.** Open once per `planId`; a preview stays up while a run is executing; feedback is not wiped by the poller.
- **H-02 — SSE replay.** Ring buffer with `id:` frames, `Last-Event-ID` / `lastEventId`, and dual-emit onto the runId channel so auto-confirm still sees `plan:started`.
- **H-03 — `plan:cancelled`.** Streaming manager translates it once and does not emit `plan:failed` for a cancelled plan.
- **H-04 — event names / `agentLevel`.** UI listens for `task:tool-error`, `plan:replanned`, `plan:error`; SSE forwards `agentLevel` so agent lines are not a second step row.
- **H-05 — session continuity.** `finishRun` keeps `result.sessionId`; two goals in one session.
- **H-06 — run errors.** Failures render in the assistant bubble (`error: …`), not only a toast.
- **H-07 — preview chat vs errors.** Preview shows `answer`; provider failures are errors, not clarification questions.
- **H-08 — previewId.** `POST /api/preview` returns an in-memory `previewId`; `POST /api/run { previewId }` executes those steps without planning again.
- **H-09 — mode.** `@plan` / `@chat` prefixes, `HOTL_MODE` / `defaultMode`, and a Mode control; preview accepts `mode`.
- **H-10 — follow without a log file.** `followLog` stays open and shows the first write.
- **H-11 — unknown session.** `POST /api/run { sessionId: "nope" }` → 404, no model call.
- **H-12 — task table.** `finishRunUi` loads tasks before dropping the run.
- **H-13 — truncated chat.** Clipped session text carries `… [truncated]`.
- **H-14 — clarification rounds.** Submitted rounds are not reopened by the poller.

## [27.17.10] — 2026-09-27 — Phase G: CLI, REPL, and server

Closes every open row of **Phase G** in `docs/UNIFIED_EXECUTION_PLAN.md` (G-01…G-18).

- **G-01 — Ctrl-C while planning.** REPL aborts only the current goal; `hootl run` still exits 130.
- **G-02 — non-TTY without `--yes`.** Fail before any LLM call.
- **G-03 — `/cd`.** Drop the previous project's `.env` keys, load the next, recompute the model.
- **G-04 — deleted session.** Clear `sessionId` after "Session not found".
- **G-05 — bracketed paste.** A multi-line paste is one goal.
- **G-06 — grapheme cursor.** Emoji width 2; ZWNJ / Persian diacritics 0; backspace deletes a cluster.
- **G-07 — confirm Ctrl-C.** `ExitPromptError` → `{confirmed:false}`.
- **G-08 — resume.** Shared `evaluatePlanResume`; the server builds a `RunState`.
- **G-09 — Orchestrator cache.** One instance per `(cwd, model, persistent)` in the REPL.
- **G-10 — `/run`.** Inherits the REPL model, persistent, yes, and session.
- **G-11 — JSON-RPC.** Batches return arrays; object `id` is `-32600`.
- **G-12 — validation.** `plans resume --timeout-ms abc` exits 2; `/config set defaultMode` uses `parseRunMode`.
- **G-13 — splash.** Any key dismisses it; registry files are cached in the REPL.
- **G-14 — `/api/usage`.** Numbers come from `observability.jsonl`, same as `hootl usage`.
- **G-15 — session files.** Compact JSON, per-interaction caps, shared 64-char label limit.
- **G-16 — `.env`.** `export`, inline comments, quotes, `\n`.
- **G-17 — config resolve.** One helper for run/REPL/plans/server; `--no-persistent`.
- **G-18 — baseURL.** Run output prints the provider name, never a custom URL.

## [27.17.9] — 2026-09-27 — Phase F: efficiency and token use

Closes every open row of **Phase F** in `docs/UNIFIED_EXECUTION_PLAN.md` (F-01…F-10).

- **F-01 — prompt cache.** Environment clock is the date (not seconds); every SDK call stamps Anthropic `cacheControl`; `TokenUsage` / `hootl usage` record cache read/write tokens.
- **F-02 — step tools.** Non-empty `toolIds` are the requested set (then ∩ persona `allowedTools`); four long tool descriptions are shortened; coder-step catalog ≤3500 tokens.
- **F-03 — tool output caps.** `directory_tree` skips build dirs, stops at 500 entries, drops `formatted`; `read_file` pages with offset/maxBytes; git diff/show drop the absolute `repository` and truncate huge patches; runtime wrapper caps ~30k.
- **F-04 — conversation budget.** `prepareStep` replaces older tool results so 20 steps fit `contextBudgetChars`.
- **F-05 — event-driven dispatch.** After each completion the loop re-evaluates readiness so C (depends on A) starts while B is still running.
- **F-06 — concurrent acceptance.** Judgments run with a concurrency cap; the judge sees a clipped result.
- **F-07 — slim review / re-plan.** `ReviewModelSchema` is findings+summary; re-plan calls `generatePlan` (no assess round-trip).
- **F-08 — cheaper writes.** Journal redacts then stringifies once; plan files are compact JSON.
- **F-09 — followLog.** Byte-offset reads, directory watch, resume after rotate (CLI and `/api/observability/stream`).
- **F-10 — SSE cap.** Per-process connection limit (`HOTL_MAX_SSE_CONNECTIONS`, default 32).

## [27.17.8] — 2026-09-27 — Phase E: context, prompts, and models

Closes every open row of **Phase E** in `docs/UNIFIED_EXECUTION_PLAN.md` (E-01…E-12).

- **E-01 — catalog in the planner.** Assess/plan prompts list registered persona, skill and tool ids; `task_decomposition` no longer calls `list_personas`.
- **E-02 — step context.** Each step gets the plan goal, its acceptance criteria, and clipped dependency `resultSummary`s; re-plan uses done-step summaries.
- **E-03 — generation settings.** `temperature` / `maxOutputTokens` reach every SDK call; Anthropic honours `baseURL` and `apiKeyEnv`.
- **E-04 — coder persona.** Verification no longer claims a test run the persona has no tool for.
- **E-05 — judge.** Neutral `judge` persona (no tools) scores acceptance; `code_analysis` no longer forbids a coder from editing.
- **E-06 — skill filter.** SKILL.md sections that name disallowed tools are dropped (researcher no longer sees `git_push`).
- **E-07 — one ENVIRONMENT, one Language.** Planner system prompt skips the env block already in PROJECT CONTEXT; user prompts drop the duplicate Language section.
- **E-08 — dominant script.** Language detection ignores digits, requires the script to beat Latin, maps Urdu markers and any kana to Japanese.
- **E-09 — reasoning clock.** The skill uses the ENVIRONMENT date; `get_current_time` is only for other zones.
- **E-10 — model Plan schema.** `PlanModelSchema` omits runtime fields; `finalizePlan` fills them; steps are asked to summarise in ≤8 sentences.
- **E-11 — `DEFAULT_MODEL_ID`.** Production fallbacks use the constant; catalog `maxContextTokens` wins; `claude-sonnet` ships as `claude-sonnet-5`.
- **E-12 — clarification.** The nested Persian `if` in `fallbackClarificationQuestion` is gone.

## [27.17.7] — 2026-09-27 — Phase D: tools and journal

Closes every open row of **Phase D** in `docs/UNIFIED_EXECUTION_PLAN.md` (D-01…D-18).

- **D-01 — ambiguous edit.** More than one `oldText` match is `AMBIGUOUS_MATCH` with a count; the file is left untouched.
- **D-02 — tabs.** Whitespace-tolerant edits keep the original indent characters (Makefile recipes stay tab-indented).
- **D-03 — CRLF.** Unedited lines are rewritten with the file's original EOL.
- **D-04 — empty `oldText`.** Schema and `applyFileEdits` reject empty search text (`EMPTY_OLD_TEXT`).
- **D-05 — encoding.** Non-UTF-8 files are `ENCODING_UNSUPPORTED`; `write_file` accepts `encoding: "base64"`.
- **D-06 — MCP connect.** `client.tools()` is inside the connect timeout race; timeout closes the client and transport.
- **D-07 — git process group.** `runGit` spawns a detached group, kills it on timeout, and settles on `exit`. Commits allow 120s.
- **D-08 — `gitEnv` allowlist.** SSH, proxy, `XDG_CONFIG_HOME`, `GIT_AUTHOR_*`/`COMMITTER_*`, and `USERPROFILE` pass through; secrets do not.
- **D-09 — detached HEAD / no-op push.** Commits on a detached HEAD are `DETACHED_HEAD`; an up-to-date push reports `pushed: false`.
- **D-10 — PR head/base.** `git_pr_create` sends current head, default base, and `gh --repo`; unpushed branches are `BRANCH_NOT_PUSHED`.
- **D-11 — sequentialthinking.** Default session is per plan/task; TTL prunes old files; thoughts are secret-scrubbed.
- **D-12 — fetch.** Truncation is `truncated`/`nextStartIndex` only; non-text is `UNSUPPORTED_CONTENT_TYPE`.
- **D-13 — commit body.** Multiline messages go to `git commit -F -`.
- **D-14 — calendar dates.** Impossible days such as `2026-02-31` are `INVALID_DATE`.
- **D-15 — create_task.** A bare TaskRuntime handle returns `USE_DELEGATE_TASK` instead of a fake success.
- **D-16 — read-only PRs.** `git_pr_list` and `git_pr_view` are in `readOnlyToolIds()`.
- **D-17 — previous plan summary.** `get_previous_plan_summary` is registered with the session store.
- **D-18 — journal summary.** Default `summary` omits full tool results; key redaction is substring-based; secret values redact from length 6.

## [27.17.6] — 2026-09-27 — Phase C: runtime, task, agent

Closes every open row of **Phase C** in `docs/UNIFIED_EXECUTION_PLAN.md` (C-01…C-14).

- **C-01 — lock until settle.** Timeout/cancel abort the run but hold resource locks until `executionPromise` finishes; `abortSignal` is forwarded to fs/git/fetch tools.
- **C-02 — stream errors fail.** `pipeThoughts` treats `error` parts as failure; `finishReason === 'error'` fails the run.
- **C-03 — cancel running work.** `cancelPlan` aborts running tasks and children; acceptance is skipped after cancel.
- **C-04 — model-call retry.** `wrapModelForRetry` + status-code 429/5xx/network retry with per-provider concurrency; backoff releases the slot. Whole-agent `RetryableAgentRuntime` is no longer on the TaskRuntime path.
- **C-05 — delegation depth.** Child agents are created at `depth+1`; `delegate_task` checks the **caller** persona via async run context.
- **C-06 — partial usage.** `onStepFinish` accumulates tokens; failed/timed-out runs still report usage.
- **C-07 — delegated results.** Children inherit `planId`/`parentTaskId`; `delegate_task` waits and returns status/result/usage.
- **C-08 — waitFor.** `waitFor(planId)` is plan-scoped; a throwing `run()` cannot hot-loop `waitForAll`.
- **C-09 — map pruning.** Agents/overrides are dropped on completion; task records cap at `maxTaskRecords`.
- **C-10 — file-lock CAS.** Stale locks are renamed atomically; a live pid is never stolen; `withFileLock` is the async server path.
- **C-11 — journal/log hygiene.** `journal.close()` on shutdown; size-based observability rotation; stale temp/lock cleanup and store retention on initialize.
- **C-12 — live `agent:tool_call`.** Events fire when a tool starts (with a post-run fallback for mocks).
- **C-13 — chat task ids.** Answer turns use `chat:${interactionId}`; abandoned chat interactions reconcile on initialize.
- **C-14 — review.usage.** Clarification/answer paths use aggregator totals; `withStructuredRetry` reports the failed first attempt.

## [27.17.5] — 2026-09-27 — Phase B: orchestration, stores, registry

Closes every open row of **Phase B** in `docs/UNIFIED_EXECUTION_PLAN.md` (B-01…B-22).

- **B-01 — resume vs live owner.** In-process live-plan set plus a pid/heartbeat owner file. A second `resume` (API 409, CLI error) is refused until the owner dies or the heartbeat goes stale.
- **B-02 — resume closes the right interaction.** Match `planIds.includes(planId)` first; never close another plan's open turn.
- **B-03 — store load validates.** `PlanSchema`/`SessionSchema.safeParse`; corrupt files skipped with warnings; API list stays 200.
- **B-04 — duplicate step ids.** Feasibility gate already rejected them; regression test kept.
- **B-05 — re-plan `replacesStepId`.** Dependants are rewired onto the replacement; a failed step with no replacement rejects the merge.
- **B-06 — reconcile.** `initialize` and `plans resume` close pending interactions whose plans are already terminal/draft.
- **B-07 — failed plan paths update the session.** Feasibility, cycles, and reject all complete the interaction; textual confirmation feedback triggers a re-plan up to the clarification ceiling.
- **B-08 / B-14 — persist per completion, judge before the next write.** `waitForAny` drains a wave one task at a time; resume judges `done` steps that never got an `[Acceptance:` mark.
- **B-09 — `PlanStore.update(id, fn)`** locked read-modify-write (File + Memory + scrubbing wrapper).
- **B-10 — persist failures.** Logged via `logSystemError`; `persistenceDegraded` on the review after consecutive failures.
- **B-11 — pre-hash filenames.** `list()`/`load()`/`delete()` migrate `plan_foo.json` onto the sha256 name.
- **B-12 — web server shutdown.** HTTP `server.close()`, cancel live plans, resolve waits as cancelled; a second signal hard-exits.
- **B-13 — CLI SIGTERM/SIGHUP.** `hootl run` and the REPL treat them like the first Ctrl-C.
- **B-15 — session history.** Last 5 completed turns injected into planner prompts.
- **B-16 — corrupt registry JSON fails `initialize`.** Missing default-model keys are reported, not swallowed.
- **B-17 — duplicate ids inside one layer** error even with `override`.
- **B-18 — persona `allowedTools`** must name a real tool (`*` / `mcp:` allowed).
- **B-19 — MCP down does not fail skill load.** Missing tools are dropped with a warning when MCP servers are configured.
- **B-20 — CLI/runtime loader parity.** Registry commands call `prepareCliEnvironment`; `/api/mcp` uses the same layer merge as the CLI.
- **B-21 — model slug collisions** get a hash suffix; empty specs stay `InvalidModelError`.
- **B-22 — `HOTL_BASE_URL` alone** no longer displaces global `defaultModel`.

## [27.17.4] — 2026-09-27 — Phase A: web-server auth, project trust, cancel-during-planning

Closes every open row of **Phase A** in `docs/UNIFIED_EXECUTION_PLAN.md` (A-01…A-08).

- **A-01 — web server bind + auth.** Default listen address is `127.0.0.1` (was `0.0.0.0`). A non-loopback bind without `--token` / `HOTL_SERVER_TOKEN` is refused at startup. When a token is configured, every `/api/*` route requires `Authorization: Bearer <token>` (401 otherwise). `HOTL_HOST` selects the bind address.
- **A-02 — `--trust-project`.** The R0-08 gate is now wired on `run`, the REPL, `serve`, `mcp test` and `tools --mcp`. The flag persists the project root in `~/.human-out-of-the-loop/config.json` (`trustedProjects`) so later invocations see it.
- **A-03 — no trust-gate bypass.** `tools --mcp`, `mcp test <id>` and `POST /api/mcp/:id/test` refuse to spawn a project-layer MCP server until the project is trusted.
- **A-04 — cancel during planning.** `POST /api/runs/:runId/cancel` aborts the planner's in-flight LLM call (`AbortSignal`); no further `generateObject` runs.
- **A-05 — idle TTL.** Clarification and confirmation waits time out after 30 minutes (`HOTL_RUN_TTL_MS`, `0` disables). The run ends `cancelled` and the session interaction is closed.
- **A-06 — MCP `env`.** `McpServerConfigSchema.env` is a `Record<string,string>` passed through to the stdio child (on top of the R0-04 allowlist).
- **A-07 — MCP URL / env-var names.** `http`/`sse` URLs must be `http:` or `https:` (`file://` is rejected). `tokenEnvVar` / `keyEnvVar` must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- **A-08 — ownership.** A run is bound to the presenting bearer token. A second valid token gets 403 on that run (and on confirm/cancel of its plan).

## [27.17.3] — 2026-09-25 — every tool call on one line, and the records behind it

Asked for in the CLI: each AI tool call logged with the tool's type, its name,
the input it was given and how it ended — and the capability placed at the
runtime, not in the CLI, so a UI (or anything else) can consume the same
records.

    🔧 tool: write_file  type: filesystem  input: {"filePath":"notes/a.txt","content":"…"}  status: ✅ success
    🔧 tool: read_file  type: filesystem  input: {"filePath":"notes/missing.txt","encoding":"utf-8"}  status: ❌ failed — ENOENT: no such file or directory
    🔧 tool: git_push  type: git  input: {"directory":".","branch":"main","setUpstream":false}  status: ❌ failed — PROTECTED_BRANCH: Refusing to push "main" …

- **The record is a runtime type, not a CLI string.**  `ToolCallSink` in
  `src/ai/runtime/tool-call-log.ts` receives
  `{ phase: 'start' | 'end', status: 'running' | 'success' | 'failure',
  toolType, toolName, input, taskId?, agentId?, planId?, planStepId?, callId?,
  durationMs?, error?, code? }`, wired where tools actually execute — the same
  place the Journal hooks in, one wrapper outside it, so a call that fails
  before or inside the Journal is still reported.  `withToolCallLog` returns
  the tools untouched when no sink is configured, and the orchestrator passes
  the sink down through `TaskRuntime` (including the chat path); a UI, a JSON
  consumer or a test can register one and get the same objects the CLI renders.
- **The type comes from the registry, not from guessing.**  A tool's type is
  its registry `category` (git, filesystem, memory, time, web, reasoning;
  `mcp` for MCP-sourced tools), with a static map and a name-prefix fallback
  for tools built outside the registry; unknown names are `other`.
- **The input is the real arguments, with secrets taken out.**  Credential-ish
  keys are redacted (`DEFAULT_REDACT_KEYS`, now shared with the Journal) and
  every process secret value is scrubbed from the serialized text; the result
  is capped at 400 characters.  Successful and failed calls both carry it, so
  a refusal can be read without digging through logs.
- **Failure is the runtime's own verdict.**  The status uses the same contract
  the Journal uses (`success: false`, an SDK error output, an MCP `isError`),
  and an exception thrown by a tool is re-thrown after the `end` record — the
  call is logged *and* the error still reaches the runtime's error handling.
- **The CLI line, and how to turn it off.**  `--tool-log <auto|on|off>`
  (`HOTL_TOOL_LOG=0`/`off` also works, and `auto` defers to it) prints one line
  per finished call, after the status line is cleared; `on` also prints when a
  call starts.  Failures carry the error message and its code (never the code
  twice).  Default: on.

Verification: `src/ai/__tests__/v27173-tool-call-log.test.ts` (18 tests — type
resolution, input redaction and capping, the success/failure contract, the
identity path without a sink, a throwing sink that must not break a call, the
runtime wiring, and the options the Orchestrator hands to it — complete, secrets
included, from the moment of the hand-over) and `src/cli/__tests__/v27173-tool-log.test.ts` (13 tests —
the line and its status, the renderer's start/end/off behaviour, and the
flag/environment matrix), plus 5 e2e checks: `success` renders a line and
`HOTL_TOOL_LOG=0` silences it while the run still happens, and `gitwrite`
shows all seven calls — the two documented refusals included — in the four
requested fields.  1218 tests, 194 e2e checks.

## [27.17.2] — 2026-09-25 — the thinking text, and the prompt that was sent twice

Two more findings from the same Windows gateway as 27.17.1, both visible in one
session's logs:

    HOOTL test-projects › @chat الان توی چه مسیری هستی؟
    Mode: chat (prefix)
    💭
    💬 Answer

The `💭` opened and never filled.  That gateway streams reasoning as
`response.reasoning_text.delta` and inside the finished reasoning item — and the
AI SDK maps **only** `response.reasoning_summary_text.delta` to a reasoning
part, so the text was dropped before any callback could see it.

- **The wire shapes the SDK does not map are read from the raw chunk.**
  `response.reasoning_text.delta`/`.done` and the `reasoning` item's
  `content[]`/`summary[]` (from `output_item.added`/`.done`) now reach the
  terminal.  The SDK-mapped `reasoning_summary_text.*` events are deliberately
  NOT read there — the provider sends the raw chunk *before* the part it maps,
  and reading both printed every summary delta twice (which the e2e caught:
  `checkingchecking the project files`).  If a turn streams no reasoning at all
  but the SDK collected some, it is shown once at the end rather than lost.
- **A recoverable answer is no longer asked for twice.**  The reporter's
  provider omits `isClear` on *every* assessment; 27.17.1 learned to read the
  answer anyway, but only after the retry had already sent the identical prompt
  again.  Recovery now happens inside the retry: the JSON is used as it is, and
  a call that CAN be read is never repeated.  Unreadable answers are still
  retried once, exactly as before.
- **A provider that cannot stream is asked once more, without streaming.**  The
  gateway answers a `stream: true` Responses request with a non-streamed body
  (`{"choices":[{"message":{"role":"assistant","content":""}}]}`), which the SDK
  turns into an empty turn — the run then showed the *assessment's draft* as if
  it were the answer, with nothing to indicate it.  When the streaming attempt
  yields nothing (or fails outright), the same prompt goes out once more with
  `generateText`; cancellation and timeouts never trigger it, and the run
  summary records `The provider streamed no answer; the turn was repeated
  without streaming.`  A stream that produced an answer is never repeated.
- `streamText`'s result is awaited before its fields are read, so a provider
  shim that returns a promise is handled like the SDK's own result object.

Verification: `src/ai/__tests__/v27172-provider-wire.test.ts` (8 tests — the raw
wire shapes, the block that used to stay empty, no double printing, the
non-streaming re-ask on an empty stream and on a failed stream, and no re-ask
when the stream worked) plus 3 e2e checks in the `thinking` scenario whose stub
streams reasoning exactly the way the reported gateway does
(`RAWTEXTWIRE`).  1187 tests, 189 e2e checks.

## [27.17.1] — 2026-09-25 — a nearly-correct answer is no longer a failed run

Reported from a real run (same Windows machine as 27.16.1):

    HOOTL test-projects › @chat سلام
    Mode: chat (prefix)
    🛑 Planning failed: The planner was unable to process the request:
       No object generated: response did not match schema.

The provider *had* answered — the run's own log shows the reply arriving with
`kind: "clarify"` and the user's language, five questions and all.  It just left
out `isClear`, which the response schema marks required and that provider does
not enforce.  The SDK refused the object, the planner rethrew, and a greeting
became a crash — with the answer sitting in the response text the whole time.

- **Recover instead of refusing.**  When a structured call fails because the
  object did not match the schema (`NoObjectGeneratedError`), the raw text is
  re-read: the first complete JSON object is extracted (a brace scan that
  respects strings and escapes, so `}` inside a string does not end it early),
  validated against the same schema with every field optional, and handed to
  the normalizer — which already derives what the model left implicit (the kind
  from the fields it filled, `isClear` from the kind).  Errors that carry no
  text (a timeout, a 401, a socket that died) are re-thrown untouched, so a real
  failure is still a failure.  The plan-generation call recovers the same way.
- **Questions without a verdict are a clarification.**  A provider that drops
  `isClear` *and* `kind` used to read as "clear" — and its question list was
  silently ignored on the way to a plan.  Now the questions decide.
- **Chat cannot be killed by its classifier.**  In chat mode the user asked for
  a conversation, so if the assessment call fails outright the run answers
  anyway (the answer call does the work; if that fails too, the report says so).
  Auto mode is unchanged: a broken provider is still reported as a failure.
- **A greeting is never a clarification.**  The auto-mode prompt now names
  greetings and small talk (`hello`, `سلام`) as `answer`, and chat mode says
  explicitly that a conversation is never answered with `kind: "clarify"` — the
  reported model had reasoned its way to "this is a greeting, therefore
  unclear".

Verification: `src/ai/__tests__/v27171-assessment-recovery.test.ts` (13 tests:
the JSON extractor, the reported payload recovered field-by-field, the chat and
auto-mode outcomes, and the plan recovery) plus four new e2e checks in the
`faults` scenario whose stub omits `isClear` exactly as the provider did.
1178 tests, 186 e2e checks.

## [27.17.0] — 2026-09-25 — it answers when talking, plans when working

Until now *every* request became a plan — `hootl run "hello"` planned, confirmed
and "executed" a greeting.  A run now decides what the request actually needs:

    auto (default)   a question, a greeting or a conversation is ANSWERED
                     (read-only tools, nothing executed, exit 0);
                     real work becomes a plan, exactly as before;
                     "this is too vague" still asks first.
    chat             never plan — answer, even if the request sounds like work.
    plan             never answer — plan, even a greeting.

- **Choose it where you think of it:** `@chat <message>` / `@plan <task>`
  inside the request (the prefix is stripped before anything else sees it), or
  `--mode auto|chat|plan`, or `HOTL_MODE`, or `defaultMode` in the config.
  Precedence: prefix > flag > env > config > auto.  A bad value is a usage
  error (exit 2) naming its source, never a silent fallback.  `@aur/auto …`
  and every other `@word` are left alone — only the three mode words followed
  by a space count.  In the REPL: `/mode [auto|chat|plan]` and `/chat <msg>`.
  The run says `Mode: chat (prefix)` when the choice did not come from the
  default.
- **Chat reads, but cannot write:** the answer runs through the same
  AgentRuntime a plan step uses, with the `chat` persona and exactly the
  read-only tool set `hootl serve --mcp --read-only` exposes — so "what does
  this project do?" can actually look at the files.  A tool call in a chat
  turn lands in the Journal like any other (`agentId: "chat-runtime"`), and a
  chat run writes no plan id, no plan file, no step.
- **The answer is in the user's language.**  A script detector names the
  request's language; when it can (Persian, Russian, Greek, Hebrew, Hindi,
  Bengali, Thai, Japanese, Korean, Chinese) the prompt says so in those words,
  and when the Arabic script cannot distinguish Persian from Arabic the
  instruction names the script and tells the model to match the request rather
  than guessing.  Latin requests get the generic rule.  The rule travels with
  the assessment prompt, the plan prompt, every agent's system prompt, the
  acceptance judgment and the review — and the one question the runtime writes
  itself (the fallback clarification) has a Persian template too.
- **Over HTTP:** `POST /api/run { mode }` (validated, 400 on a bad value);
  a chat run ends `done`, `outcome: "success"`, the answer as its report and
  **no plan id**; `POST /api/preview` returns `{ ok, answer }` instead of a
  plan, still touching nothing.
- **`--dry-run` follows the mode:** in chat mode it prints the answer and
  executes nothing (there is nothing to preview).
- Verification: `src/ai/__tests__/chat-mode.test.ts` (25 tests: modes,
  prefixes, precedence, prompt content, language detection, the read-only
  catalog, and the orchestrator's chat/plan/clarify branches),
  `src/server/__tests__/v2717-chat-mode.test.ts` (4 tests), the CLI suite
  (+10 tests) and the e2e scenario `chat` (13 checks) — a chat turn that reads
  the README, is journalled, answers in Persian, and the same request planned
  again under `@plan`. 1165 tests, 182 e2e checks.

## [27.16.1] — 2026-09-25 — an unclear verdict can no longer arrive empty

A real run (reported from a Windows machine, `I:\structured-ai\last\test-projects`)
ended like this:

```
⚠️ Clarification needed:

```

Nothing under the heading — even though the model *had* answered with three
questions. It had used the key `clarificationQuestions`; the response schema
only declared `needsClarification`, and zod drops what a schema does not
declare, so the questions were gone by the time the orchestrator looked at
them. With an empty list the clarification loop breaks out immediately, so the
refusal printed with no body (and nothing to answer). The end-to-end stub always
answered `isClear: true`, which is why no test caught it.

- **The schema now keeps the answers the model actually sends:** the
  (`clarificationQuestions`, `questions`) spellings are optional, additive
  fields, and the planner merges all three, trims them and drops duplicates
  (case-insensitively) before anything else looks at them.
- **"Unclear" always carries at least one question.** If a provider omits them
  entirely, the planner asks a question built from what the runtime already
  knows — the project root and the entries it can see — instead of asking for
  the project location (`PROJECT CONTEXT` already supplies it). A clear verdict
  is passed through untouched, so nothing extra is ever asked for a plan.
- **The prompt names the field:** "put 1-5 specific, answerable questions in the
  `needsClarification` array — never an empty list".
- Verification: `src/ai/__tests__/clarification-fidelity.test.ts` (13 tests, the
  aliased payload from the reported run included) and a new `clarify` e2e
  scenario that answers the assessment the way the provider did and asserts the
  questions reach the terminal, that the heading is never followed by a blank
  line, that no plan is written, and that the session record keeps the
  questions. The U5 server test now expects the fallback question to open a
  round (previously it asserted the empty refusal) — 1125 tests, 169 e2e checks.

## [27.16.0] — 2026-09-25 — this runtime *as* an MCP server

`hootl serve --mcp`: the reverse of `hootl mcp list`. Until now the runtime was
always an MCP *client* — `McpConnector` pulls other servers' tools in; now any
MCP client (Claude Desktop, Cursor, an IDE agent) can list and call the same 45
local tools the agent uses. That closes the tools-expansion plan
(`docs/history/TOOLS_EXPANSION_PLAN.md`, phases 37–43).

**One execution path, not a second API** (`src/mcp/server.ts`)
- A `tools/call` reaches the *same* tool object the runtime uses: the workspace
  sandbox, the zod `inputSchema` (so a bad argument is `-32602` with the field
  named), the same structured `{ success: false, code }` results. A tool refusal
  is returned **in-band** as `isError` with its code — a client shows it to the
  model instead of losing the connection.
- **Audited from outside.** Calls are wrapped by phase 37's `withJournal`, so an
  MCP client's edit lands in `.ai-runtime/journal/` exactly like the agent's own
  (`agentId: "mcp"`) — successes *and* refusals, codes included.

**Least privilege is a flag, not a hope**
- `--read-only` exposes only tools that cannot change anything: `read_*`,
  `list_*`, `search_*`, `get_*`, the five git reads, `fetch`, the time tools and
  the memory reads — an **allowlist**, so a future write tool is private until
  someone decides otherwise. (`sequentialthinking` is deliberately out: it
  persists a session file.)
- `--allow-tools a,b` narrows further, `--prefix m` renames tools to `m_<id>`
  for clients that merge servers. Both filters apply to `tools/list` **and**
  `tools/call`.
- Read-only tools carry `readOnlyHint` in their annotations, which is what lets
  a client auto-approve them without trusting the rest.

**Protocol and transports** (`src/mcp/protocol.ts`, `src/mcp/transports.ts`)
- JSON-RPC 2.0: `initialize` (2025-06-18, falling back to 2025-03-26 /
  2024-11-05 — an unknown version is answered with ours and said once, as the
  spec requires), `ping`, `tools/list`, `tools/call`, `resources/list`,
  `resources/read`, `prompts/list` (empty), plus `notifications/initialized`
  (which, being a notification, is answered with silence).
- Codes that mean something: `-32700` (unparseable frame — even for a malformed
  HTTP body), `-32600`, `-32601` (unknown method *or* tool, listing what is
  visible), `-32602` (invalid params), `-32002` (unknown resource).
- **stdio** is the default and the transport clients spawn; stdout carries
  protocol only, the banner goes to stderr, frames are answered in order, and a
  parse failure is answered in-band rather than dropped.
- **HTTP** binds 127.0.0.1, requires a bearer token (`--token`/`HOTL_MCP_TOKEN`)
  and refuses to start without one; `GET /health` is the only unauthenticated
  route and says nothing but "alive". A notification gets `202`.
- Tool schemas come from the tools' own zod definitions (`z.toJSONSchema`,
  draft 2020-12, `io: input`) — one source of truth; `describe()` text survives
  the conversion, so a client's model sees the same help the agent does.
- Resources are read-only and shape-validated before lookup: `plan://{id}` (via
  the real plan store — ids, not filenames), `journal://{YYYY-MM-DD}` and
  `memory://graph`.

**CLI**: `hootl serve --mcp [--project-root DIR] [--http [--port 3300] --token
<t>] [--read-only] [--allow-tools a,b] [--prefix m]`, listed in `--help` next to
`mcp`, and warned about where the client is configured
(`registry/mcp-servers/README.md`): this endpoint reads and writes project files,
so `--read-only` is the recommendation for a client you do not fully trust.

**Tests**: 1078 → **1112** (66 files; 34 new). Framing (`-32700`/`-32600`),
negotiation (supported, unsupported, missing), `tools/list` equal to
`LOCAL_TOOL_IDS` with real JSON Schemas and annotations, `tools/call` success /
`-32602` / `-32601` / in-band sandbox refusal, both filters (including that a
filtered tool cannot be *called*), the Journal line for an external call, the
three resources plus six path-traversal attempts on resource uris, stdio framing
(order, silence on notifications, banner on stderr) and HTTP (401 without a
token, 202 for a notification, `-32700` for a malformed body, refusal to start
tokenless) — and, the acceptance's real interop test: **`@ai-sdk/mcp`'s own
client** connecting to the real CLI over stdio, listing 45 tools and calling one.
e2e **153 → 161**: the new `mcpserve` scenario points our own client at our own
server through a project registry entry, then speaks raw stdio to prove what a
call does — the file comes back through the sandbox, a path outside the project
is refused in-band, and both outcomes are in the Journal.

## [27.15.0] — 2026-09-25 — git, writing (and pull requests)

Eleven new tools, so the same agent that could *read* a repository can now do
the work — on a branch, with the destructive half fenced off. The reference
server's `git_add` / `git_commit` / `git_create_branch` / `git_checkout` /
`git_reset` / `git_push` / `git_stash` are here, plus the pull-request set the
plan asked for (`git_pr_create` / `git_pr_list` / `git_pr_view` /
`git_pr_comment`).

**The safety model (`src/ai/tools/git/git-safe.ts`)**
- **Protected branches** (`main`, `master`, or `HOTL_PROTECTED_BRANCHES`): no
  push, no `reset --hard`, no `commit --amend` — `PROTECTED_BRANCH`, with the
  alternative in the message ("work on a feature branch and open a pull
  request"). Creating a branch *from* `main` and standing on `main` are
  deliberately allowed; the guards are on rewriting.
- **Nothing irreversible happens without `confirmDestructive: true`**, and the
  refusal *names every file that would be lost* — `reset --hard`, a checkout
  with `discardChanges`, `stash drop`/`clear`, `commit --amend`.
- **No force, anywhere**: `--force`, `--force-with-lease`, `--mirror` and
  `--no-verify` do not exist in any schema, so no prompt, context or file can
  conjure one. A rejected push is git's answer.
- **Every write reports `before`/`after`** — HEAD, short sha, branch and
  porcelain — plus `changed` / `headChanged` / `branchChanged`, so "what did
  that call actually do?" is in the result itself (and in the Journal).
- `gitExitOk` was added to the runner: `allowFailure` means "git ran", not "git
  worked", so every caller that wants a *value* now checks the exit code too.

**The local writes**
- `git_add` — paths resolved inside the workspace (the phase-33 check), `--`
  before them, repo-relative, `["."]` for everything.
- `git_commit` — staged only, or `paths` to stage-and-commit; message required;
  an empty index is `NOTHING_TO_COMMIT`; the author identity is **read** from
  `git config` and never written (`MISSING_IDENTITY` tells the user to set it).
- `git_create_branch` — validated by git itself (`check-ref-format --branch`),
  switches to the new branch by default, needs no confirmation: it is the safe
  thing to do.
- `git_checkout` — `create` for `-b`; uncommitted work makes it fail the way git
  intends unless `discardChanges: true` is confirmed.
- `git_reset` — the reference's behaviour is the default (unstage everything,
  safe); `soft` moves HEAD; `hard` is gated and refused on a protected branch.
- `git_push` — `origin` + current branch by default, `setUpstream` for the first
  push, a local bare remote in the tests; protected branches refused before git
  runs.
- `git_stash` — push (`-u` for untracked), list, pop, apply, and a gated
  drop/clear: the tidy-up that is *not* a hard reset.

**Pull requests — both backends the plan locked in (`src/ai/tools/git/pr-backend.ts`)**
- `gh` first (probed with `gh --version`, `GH_PROMPT_DISABLED=1`, 30 s, 4 MB),
  then the GitHub REST API with `GITHUB_TOKEN`/`GH_TOKEN`, else
  `PR_UNAVAILABLE` with both fixes named. A non-GitHub remote is
  `NOT_GITHUB_REMOTE`, a missing PR is `PR_NOT_FOUND`, an unauthenticated `gh`
  is `PR_UNAVAILABLE` — not a stack trace.
- Owner/name come from the remote URL git actually has (`https`, `git@host:`,
  `ssh://`), so a PR always targets the repository the branch is connected to,
  and GitHub Enterprise gets `https://<host>/api/v3`.
- One shape from both backends (`normalizePr`), and the token is read per call,
  used, and never echoed into a result — the phase-37 Journal check still
  asserts it.

**Wiring**: local catalog 34 → **45 tools**; the `git_operations` skill is
v1.2.0 (17 tools, priority 55) with a "Making a change" workflow and the new
error codes; personas coder 45 / architect 29 / reviewer 27 (the reviewers may
read and comment on PRs, never push or commit).

**Tests**: 1034 → **1078** (65 files; 44 new) against a real repository with a
**bare remote in the same temp directory** — the SHA changes and the message
lands, `reset --hard` without the flag is refused with *zero* disk change and
with it succeeds, `--hard` on `main` is `PROTECTED_BRANCH`, the push reaches the
bare repo and a rewritten history is rejected with no way to force it, the force
option is asserted **absent from the schema**, `drop` keeps the stash until
confirmed. The PR tools run against an injected `gh` runner and an injected
`fetch` — so no test can reach GitHub — including the logged-out, no-gh-no-token
and 404 paths, plus a stub `gh` **on `PATH`** for the real runner. e2e **140 → 153**: a new `gitwrite` scenario commits a real change
on a branch, pushes it to a bare remote, and then proves both guards by their
side effects (the remote's only ref is the feature branch; the refused hard
reset leaves HEAD and the tree untouched).

## [27.14.0] — 2026-09-25 — git, read-only

Five new tools and a new `git_status`, so an agent can understand a repository
before it is allowed to change one (the write half is 27.15.0).

**A shared core, not six copies of `execFile`** (`src/ai/tools/git/`)
- **No shell, ever**: `spawn('git', argv)` with an argument list, and any
  caller-supplied ref, path or filter that starts with `-` is refused
  (`BAD_ARGUMENT`) — a branch named `--upload-pack=…` stays a name, never an
  option. Paths are passed after `--`.
- **No prompts**: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `SSH_ASKPASS=echo`,
  `GIT_PAGER=cat`, `GIT_OPTIONAL_LOCKS=0` — a call can never hang on a password
  prompt or a pager, and a read never takes a lock out from under the user's
  editor.
- **Bounded output**: 256 KB per command, and the cap *kills the child*
  (`OUTPUT_TOO_LARGE`), so a 40 MB `git show` costs 256 KB.
- Codes a model can act on: `NOT_A_REPO`, `GIT_MISSING`, `TIMEOUT`,
  `PATH_TRAVERSAL_BLOCKED`, `BAD_ARGUMENT`, `OUTPUT_TOO_LARGE`, `GIT_FAILED`.

**`git_status` grew up (backward compatible)**
- Still `directory` + `short` + `output`; new: `porcelain: 'v1' | 'v2'` parsed
  into `entries` (index/worktree characters, renames with their `from`,
  untracked, unmerged) and `counts`; `branch: true` for `{ name, upstream,
  ahead, behind, detached }`; `path` to focus on one file.
- The error code is the plan's `NOT_A_REPO` (phase 18's `NOT_A_GIT_REPO` is
  gone) and `PATH_TRAVERSAL_BLOCKED` still comes from the ported phase-33 path
  check.

**The five reads**
- `git_diff` — one tool for the reference's three: the working tree by default
  (`git_diff_unstaged`), `staged: true` for the index (`git_diff_staged`), or
  `target: 'HEAD~1'` (`git_diff`). `statOnly`/`nameOnly`, `path`,
  `contextLines`, and a parsed file list with per-file `+`/`-` counts.
- `git_log` — parsed entries (sha, short sha, author, ISO date, parents, refs,
  subject, body) with `path`/`author`/`since`/`until` filters and
  `oneline`/`short`/`json` rendering. A repository with no commits is an empty
  log, not an error.
- `git_show` — the commit object plus its patch, `path` to narrow it,
  `statOnly` to keep a merge from flooding the context. (Two git subtleties are
  encoded here: options must precede the revision, and `--unified=N` implies
  `--patch` — so a stat-only run passes `--stat` and no `--unified`.)
- `git_branch_list` — `for-each-ref` with an explicit field list, so the answer
  is data (current flag, sha, upstream, ahead/behind, last commit), with the
  reference's `contains`/`notContains`, and a detached HEAD reported as
  detached *with its sha*.
- `git_remote_list` — name, fetch URL and push URL (they differ more often than
  people expect); configuration only, no network. Checked before anything is
  pushed in 27.15.0.

**Wiring**: local catalog 29 → **34 tools**; the `git_operations` skill now
teaches the read set (priority 30, extended, not replaced); personas coder 34 /
architect 26 / reviewer 25.

**Tests**: 1034 (64 files; 46 new). The suite builds a real repository in a temp
directory — two commits, a second branch, a staged file, an unstaged change,
an untracked file, two remotes with differing push URLs — and asserts parsed
fields, not substrings: porcelain v1 and v2, the branch block, flag-injection
refusals, `PATH_TRAVERSAL_BLOCKED` outside the workspace, `NOT_A_REPO` inside a
plain directory, the byte ceiling with its SIGKILL, the neutral environment, the
detached-HEAD report and the empty-repository cases. e2e **127 → 140**: a new
`gitread` scenario runs all six tools against a repository the scenario itself
initialises, and asserts the repository is byte-for-byte unchanged afterwards.

## [27.13.0] — 2026-09-25 — the web, read as Markdown

`fetch`, the reference `fetch` server's tool, ported natively — with the
question the reference does not ask: *which URLs may an agent reach on its own?*

**One tool, the reference's contract**
- `url`, `maxLength` (default 5000, max 100 000), `startIndex` (paging), `raw`
  (HTML instead of Markdown) — and the reference's truncation affordance, spelled
  out: a paged result carries `nextStartIndex`, `remainingChars` and a
  `<error>Content truncated. Call fetch with startIndex N…</error>` tail.
- HTML → Markdown in-tree (no dependency): headings, paragraphs, **absolute**
  links, lists, fenced code, tables, quotes, emphasis, images; `script`,
  `style`, `nav`, `footer`, `form` … are dropped *with their contents*, so a
  page's noise never becomes prompt tokens. Non-HTML text (JSON, plain text,
  XML) passes through untouched; a binary content type comes back as metadata
  only, body not downloaded.

**What it will not do**
- **SSRF defence (the deliberate difference).** Loopback, private, link-local,
  CGNAT, multicast and reserved addresses are refused **by default**
  (`BLOCKED_PRIVATE_ADDRESS` with the reason and the address), because a URL
  reaches the agent from the model's context — a fetched page or a README — not
  from a human at a keyboard. The check runs on what the host *resolves to* (so
  `localhost`, alternative IPv4 spellings, IPv4-mapped IPv6 and a public name
  with a private A record are all caught) and again on **every redirect hop**.
  `allowPrivate: true` is the documented override, and its use is reported back
  as `privateAllowed`.
- **Bounded everything**: 10 s per request, ≤ 5 redirects, ≤ 2 MB read from the
  wire (the stream is *cancelled* at the cap — a 2 GB download costs 2 MB), and
  a 2 MB body that was cut is an error, not silent truncation.
- **No credentials, ever**: one header set for every request — our own
  User-Agent (`human-out-of-the-loop/<version>`) and a plain `Accept`. Nothing
  from the environment is forwarded.
- **robots.txt is honoured** (default `respectRobots: true`), per host with a
  10-minute cache; the longest matching rule wins with Allow taking ties, an
  exact product-token group beats `*`. 401/403 is a refusal, an unreadable
  robots.txt (5xx, network error) is a refusal too — *"we could not find out
  whether we are welcome" is not permission* — and the rule is reported so the
  model can explain why. `respectRobots: false` is the override.

**Wiring**: local catalog 28 → **29 tools**; new `web_research` skill (priority
65); personas coder 29 / architect 21 / reviewer 20 (not the planner — planning
is not research). Every fetch is journalled like any other tool call.

**Tests**: 988 (63 files; 51 new for phase 40 — the address classes, the
redirect-hop re-check, the paging window, the byte cap, the timeout, robots
modes 200/403/404/5xx, the cache, the HTML→Markdown rules, and the header set a
request actually carries). e2e **116 → 127** checks: a new `fetch` scenario runs
four fetches against a throwaway loopback server — Markdown with absolute links,
`raw: true`, a robots refusal with its rule, and the SSRF refusal — and asserts
the raw page's junk never reached the model.

## [27.12.0] — 2026-09-25 — project memory

The nine tools of the reference `memory` server, ported natively: what a run
learns is still there in the next one. The Journal (27.10.0) is the history of
what happened; this is the current state of what the project knows.

**Nine tools, the reference's semantics**
- `create_entities` · `create_relations` · `add_observations` ·
  `delete_entities` · `delete_observations` · `delete_relations` ·
  `read_graph` · `search_nodes` · `open_nodes`.
- An existing entity is **left alone** (no silent merge, no error), duplicate
  observations are skipped, and a relation whose endpoint does not exist is
  refused with `ENTITY_NOT_FOUND` — nobody invents the other end of an edge.
- Deleting an entity cascades its relations and reports both what went and what
  was not there (`deleted` / `notFound`); `open_nodes` reports `notFound` for
  the names it does not have instead of returning a short list.

**Per project, locked, atomic — and honest about the file**
- One graph per project: `<project>/.ai-runtime/memory.json`; every write goes
  through the phase-27 file lock and a temp file + `rename`, so parallel agents
  cannot lose an update, and no `.lock`/`.tmp` file outlives the call.
- A corrupt file is reported as `GRAPH_CORRUPT` and is **never overwritten** —
  losing months of accumulated context to one bad byte would be worse than
  failing the call. Every result names the file it used (`memoryFile`).
- Reads are paged (`read_graph` 200 entities, `search_nodes` 100) with `total`,
  `truncated` and the names of neighbours that fell outside the page, so a graph
  that grew for months cannot blow up a prompt.

**Wiring**
- Local catalog 19 → **28 tools**; `project_memory` skill (priority 75);
  personas: `coder` 28 (the full set, deletes included), `architect` 20 and
  `reviewer` 19 (read + capture, no deletes). Every write is journalled
  automatically — memory has an audit trail for free.
- Tests 921 → **937** (62 files); e2e **103 → 116** checks, with a new `memory`
  scenario that walks all nine tools in one run and then proves persistence: a
  *second process* searches the graph the first one wrote, and a relation to a
  ghost entity comes back `ENTITY_NOT_FOUND` with the file unchanged.

## [27.11.0] — 2026-09-25 — the clock, time zones, and persisted reasoning

Three tools ported from the reference `time` and `sequentialthinking` servers.

**`get_current_time` — the reference's four fields, plus the ones a prompt uses**
- timezone, datetime (ISO with offset), day_of_week, is_dst — and additionally
  the wall-clock `formatted`, the `utcOffset` in both forms, the epoch and the
  **machine's** zone (so "the user's time" is never confused with UTC).
- `date: 'YYYY-MM-DD'` asks about another day; an offset is date-dependent, and
  a January question about Berlin is not the same as a July one.
- An unknown zone is refused with close matches
  (`INVALID_TIMEZONE`: *did you mean Asia/Tehran?*) — the reference answers with
  a protocol error, and a model that typed `Asia/Tehrn` deserves better than a
  silent UTC.

**`convert_time` — one call, several zones**
- `sourceTimeZone`, `time` (HH:MM), and either `targetTimeZone` or
  `targetTimeZones` (the reference's list), each target carrying its own
  `utcOffset`, `isDST` and `timeDifference` (`+5.5h`, `-1.5h`).
- The wall clock → instant conversion resolves the zone offset **for the target
  day**, which is what makes it correct across a DST switch; `date` makes that
  day explicit instead of "today, silently".

**`sequentialthinking` — reasoning that survives the turn**
- Every field of the reference tool (`thought`, `nextThoughtNeeded`,
  `thoughtNumber`, `totalThoughts`, `isRevision`/`revisesThought`,
  `branchFromThought`/`branchId`, `needsMoreThoughts`), the same
  `thoughtNumber > totalThoughts` adjustment, branch bookkeeping and bordered
  rendering.
- The chain is **persisted** in `<project>/.ai-runtime/thinking/<sessionId>.json`
  (atomic write), so a resumed plan or a fresh process continues the same
  session — that is the difference between a reasoning trace and a paragraph.
- 50 steps / 256 KB per session (`THINKING_LIMIT`), session ids sanitised so one
  can never name a path outside the directory, a corrupt session file starts a
  fresh chain instead of failing the step, and warnings for a dangling
  `revisesThought` or a branch without an id.
- Because it is a normal tool, every step also lands in the Journal (phase 37)
  with its arguments — the reasoning trail is auditable for free.

**The clock in the environment block (phase 36 follow-up):** `PROJECT CONTEXT`
and every agent system prompt now carry `current time: 2026-09-25 04:12:33
(Asia/Tehran, GMT+03:30)`, so a plan that says "the release from last week"
starts from a real date instead of a guess.

**Verification:** 28 new unit tests (fixed instants, so DST is deterministic in
both hemispheres; fractional offsets like Kathmandu's +05:45; midnight and
day-boundary crossings; typo suggestions; session persistence across instances,
isolation between sessions, the step ceiling, corrupt-file recovery and id
sanitisation) and a new `time` e2e scenario. Also: `local-tools` catalog 19,
persona allow-lists and a new `reasoning` skill.

## [27.10.0] — 2026-09-25 — the Journal: what the AI did, recorded automatically

`<project>/.ai-runtime/journal/YYYY-MM-DD.jsonl` — one append-only line per
action, written where the runtime hands its tools to the model.

**The hook** (`AgentRuntime`)
- `withJournal(tools, context, writer)` wraps every tool's `execute` **once**,
  just before the tool set is passed to `generateText`/`streamText`: local
  tools, MCP tools, `delegate_task` and anything added later are covered with
  no change to their implementations, and the live-thinking (`streamText`)
  branch is covered by the same wiring as `generateText` — not by a second
  code path that can quietly drift.
- The wrapper is transparent: return values and thrown errors pass through
  untouched (the SDK and `describeToolFailure` see exactly what they saw
  before), and `callId` comes from the SDK's own `toolCallId`, so a journal
  line and the `agent:tool_call` event can be joined.

**What a line carries**
- tool name, input, summary, duration, `ok`, error + code, and the
  `taskId`/`agentId`/`planId`/`planStepId` of the run;
- `artifacts` for written files: path, byte count and a **sha256 of the content
  the model asked to write** — the line proves *what* was written, not merely
  that something was;
- plan and step transitions (`kind: 'plan' | 'step'`), so a tool call is
  traceable to the step that caused it.

**Safety and hygiene**
- credentials are redacted twice: by key name (`apiKey`, `token`, …) and by the
  literal secret **values** this process holds (`secret-scrub`);
- `maxEntryBytes` (8 KB) keeps metadata and a preview instead of flooding the
  file; `includeResults: 'none' | 'summary' | 'full'`;
- daily rotation, `retentionDays` pruning (30 days), descriptor reuse with
  inode detection (the phase-21 lesson: `rm -rf .ai-runtime` under a running
  process must not lose the journal), and a write failure is a warning, never a
  broken run;
- `HOTL_JOURNAL=0` / `HOTL_JOURNAL_RESULTS=…` override per process.

**Reading it**
- `hootl journal [--day] [--tool] [--plan] [--failed] [--since 24h] [--limit]`
  `[--stats] [--json] [--paths]` — filters, a per-tool summary, and raw JSONL
  for machines.

**Verification:** 27 new unit tests (writer semantics, redaction of keys and
values, size capping, retention, re-creation after deletion, the wrapper for
success/failure/throw/artifacts/batch, and both SDK branches of the runtime
hook: `generateText` and `streamText`), a new `journal` e2e scenario, and the
`credential` scenario now also asserts that a second credential shape never
reaches any runtime artifact — the Journal included.

## [27.9.0] — 2026-09-25 — the glob scan at editor level, and the machine the model writes for

Two answers to "the tool works, but the model still has to guess": `search_files`
was thinner than `search_code`, and nothing told a model *which* machine its
commands would run on.

**`search_files` — level with `search_code`**
- **A bare name matches at any depth**: `*.ts` finds `src/lib/util.ts` and
  `top.test.ts`, the way an editor's file finder and `search_code`'s defaults do,
  instead of matching only what sits directly under the search root (the
  reference's rule, kept behind `matchBaseName: false`).
- **Build/vendor directories are skipped by default** — the same list
  `search_code` uses (`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`,
  `.next`, `target`, `vendor`, `.ai-runtime`, …), now shared from `fs/lib.ts`
  instead of living in two places; `skipBuildDirs: false` searches them on
  purpose, and `ignoredDirectories` says what was skipped.
- **`!` re-includes in `excludePatterns`** (`['**/*.js', '!**/keep.js']`), read
  the way a glob list is read; the first entry that governs a path wins.
- **Type filters and real metadata**: `includeFiles` / `includeDirectories`,
  per-entry `type`, `size` and `modified` (via `lstat` — a symlink is reported as
  itself, never followed), and `counts`, `filesScanned`, `directoriesScanned`,
  `skippedExcluded`, `skippedSymlinks` so an empty result can say *why* it is
  empty.
- **A Windows bug in the port is fixed**: the relative path was matched with
  native separators, and `minimatch` treats `\` as an escape character, so a
  path pattern like `src/**` + `/*.ts` matched nothing on Windows. Matching now
  happens on POSIX separators on every host (asserted by a test that runs the
  same patterns everywhere).

**The environment block — the machine, not just its name**
- New `src/ai/environment-context.ts` turns `node:os` and the process
  environment into a short bullet list: operating system **and version**, arch,
  node version, the shell a command will actually run in, the path separator,
  the line ending, and whether the filesystem is case-sensitive.
- `PROJECT CONTEXT` (planner assessment + plan prompts) now carries it — the
  planner writes the commands, so it is the first place a wrong shell shows up —
  and the **agent system prompt** does too (persona + skills stay budgeted; the
  block is appended untrimmed and small).
- Platform-specific guidance is generated per host, not hard-coded: POSIX
  userland vs `dir`/`type`/`findstr`, **GNU vs BSD** (`sed -i ''`, no `grep -P`
  on macOS), Windows reserved names, macOS NFD + case-insensitive lookups, WSL
  (`/mnt/c`) — so "format the disk" style instruction sets stop being a coin
  flip.
- Facts are collected through an injectable `collectEnvironmentFacts(env,
  platform)`, so the Windows/PowerShell/macOS/WSL branches are all tested from a
  Linux CI runner.

**Verification:** 21 new unit tests (glob semantics, excludes with re-include,
type filters, truncation vs `totalMatches`, symlink refusal, POSIX matching, and
the environment facts for every platform) and a new `search` end-to-end scenario
plus an extended `context` one.

## [27.8.0] — 2026-09-25 — the filesystem set is complete

The last two tools of the MCP reference filesystem server
(`servers-main/src/filesystem/`) now exist natively, so **every tool that server
registers has a counterpart here**. Nothing about the port's safety properties
changed: both go through the same path validation as the rest of the set.

**`read_media_file` — the read that is not text**
- Images (png, jpg/jpeg, gif, webp, bmp, svg) and audio (mp3, wav, ogg, flac)
  come back as base64 with their MIME type, and are **attached to the model
  call** as a real content part (`toModelOutput`: `input_text` + `input_image`
  on the Responses API), so a vision model can actually look at the file. Every
  other extension is `application/octet-stream`.
- Two deliberate deviations from the reference, both about not flooding a run:
  `maxBytes` (default 10 MiB) refuses an oversized file with `FILE_TOO_LARGE`
  rather than pushing tens of megabytes into every following model call, and a
  non-media binary is reported with its metadata but **not attached**
  (`attachedToModel: false`) — the model sees the type, the size and the path,
  not the payload.
- Failures keep the project's contract: `{ success: false, error, code }` on the
  runtime side (so `describeToolFailure` still sees them) and the same JSON for
  the model.

**`list_directory_with_sizes` — where the bytes are**
- Per-entry size and mtime, `sortBy: 'name' | 'size'` (size orders largest
  first), and the reference's footer: `Total: N files, M directories` plus
  `Combined size: …`, with a `[DIR]`/`[FILE]` padded rendering in `formatted`.
- Still `lstat`: a symlink is reported as `[LINK]` and never followed, an
  unreadable entry carries `unreadable: true` instead of failing the listing —
  and only regular files carry a size, so the totals and the ordering talk about
  bytes on disk rather than directory inode sizes.

**Also**
- `read_file` now refuses `head` together with `tail`
  (`Cannot specify both head and tail parameters simultaneously.`), matching the
  reference's `read_text_file` instead of silently returning the head.
- 17 new unit tests (a parity map asserting every tool the reference registers
  has a local counterpart, and the reverse — no dead entries) and a new `media`
  end-to-end scenario that asserts on the wire body the stub received.

## [27.7.0] — 2026-09-25 — batch writing and VS Code-style search

Two tools the filesystem set was still missing: writing a *set* of files in one
call (scaffolding) and searching content the way an editor does — a pattern for
the content, a pattern for the paths, every hit on every line.

**`write_multiple_files` — one call, a whole scaffold**
- `files: [{ path, content }]` (up to 200), parent directories created, every
  file written through the ported atomic core.
- **Path problems abort the batch** — if any path escapes the workspace or is
  listed twice, *nothing* is written and each problem is reported. A
  half-applied scaffold is worse than none.
- **Content problems do not** — a file that exists with different content is
  reported as a `conflict` (with its line of the summary) while the rest of the
  batch is still written, the way `read_multiple_files` returns what it could
  read. `overwrite: true` replaces instead.
- **Identical content is `unchanged`, never a conflict**, so re-running a
  scaffold is a clean no-op (mtime included). `dryRun: true` previews the same
  statuses without touching the disk, and the result lists every directory the
  batch created.

**`search_code` — VS Code "find in files", not a single-pattern grep**
- A **content** pattern and a **path** pattern: `pathPattern` (regex over the
  workspace-relative path) plus glob `excludePatterns` answer VS Code's *files
  to include / exclude*. Both patterns go through the same ReDoS guard
  (`UNSAFE_REGEX`, `PATTERN_TOO_LONG`, `INVALID_REGEX`).
- The three toggles: `caseSensitive` (default **false** — the search now ignores
  case unless asked), `wholeWord` (lookarounds, so a punctuation-led pattern
  like `\(foo\)` still works — a `\b` guard would silently fail on it) and
  `literal` (pattern as plain text).
- **Every occurrence, with its column.** `call(fooBar, fooBar)` is two matches
  on one line, and the result reports both — a per-line grep reports one.
- `contextLines` adds the surrounding lines; `maxMatchesPerFile` (default 20)
  stops one generated file from consuming the budget; the result carries the
  matched `files` list, a `formatted` `file:line:column: text` rendering (what
  models read best) and `filesScanned`.
- Safety unchanged: paths are validated by the ported core, **symlinks are never
  followed** (counted in `skippedSymlinks`), binary files (`skippedBinary`) and
  files over `maxFileSizeBytes` (`skippedTooLarge`) are counted instead of
  polluting the phase-27 `skipped` contract, build/vendor directories are
  skipped by default, and the engine lives in `src/ai/tools/fs/content-search.ts`
  next to the other filesystem primitives. `directory_tree`'s excludes now use
  the same `isExcludedPath` helper, so "exclude node_modules" means one thing.

Authorisation: `write_multiple_files` is in `coder` and `file_management`; the
new `search_code` surface is available to every persona that already had the
tool, and the read-only personas still cannot write.

**Tests & docs:** 828 tests green (57 files), 0 tsc errors, and a new `batch` e2e
scenario (74 committed checks) that scaffolds two files with one call and then
finds their marker with the path-filtered, context-carrying search — asserting
the result really reached the next model turn.

## [27.6.0] — 2026-09-25 — the filesystem toolset, ported from the MCP reference server

The runtime could read a file, rewrite it whole, grep it and ask git about it.
That is not enough to work on a real project: renaming a file, fixing one line
without re-emitting the file, seeing what a directory contains, or reading five
files to compare them each had no tool. The **filesystem** capabilities of the
vendored MCP reference server (`servers-main/src/filesystem/`) are now native
tools — not a registered MCP server — and the existing three filesystem tools
were rewritten on the same core, because the point of using that code was its
path safety.

**Nine new tools** (`registry/tools/*.json`, bound to `--project-root`)

- `edit_file` — line-based edits (`oldText`/`newText`), returning a git-style
  diff. Exact match first, then a whitespace-tolerant match that shifts the
  whole replacement by the indentation difference; a non-matching edit is an
  error, never a silent no-op. `dryRun: true` previews without writing.
- `read_multiple_files` — one call, per-file results: what could be read is
  returned, what could not carries its error (a failed file no longer fails the
  batch).
- `list_directory` — `[DIR]`/`[FILE]` entries; a symlink is reported as
  `symlink`, never silently followed.
- `directory_tree` — recursive JSON tree with glob `excludePatterns` and a
  `maxDepth` (a `node_modules`-sized tree cannot flood the context).
- `move_file` — move/rename; both ends validated before anything moves and an
  existing destination is refused instead of overwritten.
- `get_file_info`, `create_directory` (idempotent), `search_files` (glob
  counterpart of `search_code`), `list_allowed_directories`.
- `read_file` gained `head`/`tail`; every path is now checked by the ported
  implementation and every tool answers `{ success: false, code }` on refusal.

**The path safety is the reason this port exists** (`src/ai/tools/fs/`)

- Every existing component of a path is resolved through its symlinks and
  re-checked, so `<root>/link-to-outside/new.txt` is refused *before* anything is
  created — the previous lexical check plus a best-effort realpath let that
  through.
- A Windows drive path on a POSIX host is refused instead of being written as a
  literal `C:\Users\...` file inside the workspace, and Unicode-equivalent
  (NFC/NFD) names resolve to the file that exists (ambiguous matches refused).
- New files are created with `O_EXCL` (a pre-existing symlink is never written
  through); existing files are replaced through a temp file + `rename` with the
  original permission bits restored; `move_file` uses `lstat` so an existing
  symlink at the destination counts as occupied.
- Allowed directories are a parameter, not module state — two Orchestrators in
  one process still cannot share a sandbox.

**Authorisation stays explicit:** `coder` gets all 13 tools, `architect` and
`reviewer` get the read-only subset, and the `file_management`/`code_analysis`
skills were extended to match — a write tool that a persona does not allow is
filtered by the Factory and logged as a warning, as before.

**Tests & docs:** 801 tests green (56 files), 0 tsc errors, and a new `files`
e2e scenario (68 committed checks) that drives `edit_file`, `directory_tree` and
`move_file` through the real CLI — the edit is asserted to leave the rest of the
file byte-identical and the tree's JSON result is asserted to reach the next
model request.

## [27.5.0] — 2026-09-24 — the run says it is working, and the model thinks out loud

Two complaints from a real session, both about **not being able to see what is
happening**: a long planning call printed nothing at all (three model requests
went out and the terminal stayed empty — "is it hung?"), and the planner did
not know where it was running, so it asked *"Which project should be scanned?"*
until the run gave up with "No plan could be produced after 2 clarification
round(s)".

**The terminal is never blank while a result is pending**
- One self-overwriting status line shows a spinner and a message that changes
  every **3 seconds**, picked at random from the twelve requested texts
  (*dreaming…*, *Crunching the numbers…*, *Analyzing the data…*,
  *Generating insights…*, *Processing your request…*, *Thinking deeply…*,
  *Working on it…*, *Hold tight, almost there…*, *Just a moment, please…*,
  *Loading the magic…*, *Preparing the response…*, *Hang tight, we're on it…*),
  never the same one twice in a row. It covers the whole run: planning,
  clarification, agent turns, acceptance, final review.
- Every line of real output erases the status line first (one capture point:
  `out()`), and it pauses for prompts — nothing is ever mangled or duplicated.
- Terminal-only: without a TTY (pipes, CI, tests, `--json`) nothing is written.
  `HOTL_NO_ACTIVITY=1` / `HOTL_ACTIVITY=off` turn it off, and
  `HOTL_ACTIVITY_INTERVAL_MS` changes the rotation (minimum 250 ms).

**The model's thinking, streamed**
- When thinking is shown, an agent turn is executed with `streamText` and every
  reasoning part the provider emits is rendered live: italic, violet
  (`#a78bfa`), prefixed with 💭, indented on the model's own line breaks, and
  capped at 4000 characters per block so a chatty model cannot flood the
  terminal. Blocks close on the first answer token, tool call, or step
  boundary — and always close at the end of the run, so the spinner is never
  left paused.
- Providers that answer reasoning in `choices[0].delta.reasoning_content`
  (OpenAI-compatible gateways; the SDK's chat schema drops the field) are
  covered through `includeRawChunks`, and native reasoning parts win when both
  exist, so nothing is printed twice. A failing renderer can never fail a run.
- `--thinking <auto|on|off>` (default `auto` = only in a terminal),
  `HOTL_THINKING` / `HOTL_SHOW_THINKING`, and **nothing is persisted** —
  thinking text never reaches a plan, the observability log or a report, and
  without a sink the runtime keeps its non-streaming `generateText` path
  byte-for-byte.

**The planner knows the project it is planning for**
- Both planning prompts (`assess` and `generatePlan`) now carry a
  `PROJECT CONTEXT` block: the absolute project root, the platform, that paths
  are relative to that root and stay inside it, the top-level entries (directories
  first, heavy ones like `node_modules`/`dist`/`.git` skipped, max 40) and
  whether a `package.json` is present. A request that only lacks the project,
  its location or its stack is now explicitly *clear*, so the model no longer
  spends a clarification round asking for what the CLI already knows.

The e2e stub answers streaming requests with real SSE now (Responses:
`response.reasoning_summary_text.delta`; Chat Completions:
`delta.reasoning_content`), and a `THINK:<text>` marker makes it think out loud.
Two new scenarios: `thinking` proves the reasoning reaches the terminal, is
styled, is never persisted, stays off outside a terminal, and that a stream
killed mid-flight still ends the run; `context` reads the planner request the
stub actually received and proves the PROJECT CONTEXT block is in it.
758 tests (55 files), e2e 60/60.

## [27.4.0] — 2026-09-24 — start screen, the `/` menu, and models chosen at runtime

**Interactive mode**
- The screen is cleared and **HOOTL** is drawn in block letters (yellow,
  orange shadow, centered) for 3 seconds, then the console opens.
  `--no-splash` or `HOTL_NO_SPLASH=1` skips it.
- A new line editor: typing `/` opens the command menu under the prompt,
  filtered as you type; ↑/↓ select, Tab completes, Enter runs, Esc closes.
  Arguments get menus too: `/model ` lists models, `/cd ` directories,
  `/persistent ` on/off, `/plans ` its subcommands.  ↑/↓ walk the history
  when the menu is closed.
- The prompt and banner say **HOOTL** (`HOOTL my-project ›`); with the long
  binary name a project with the same name read
  `human-out-of-the-loop human-out-of-the-loop ›`.
- **`hootl --project-root=<dir>` (and `--model`, `--persistent`, `--yes`)
  without a subcommand opens interactive mode** in that directory.  Before,
  it failed with "unknown option": those flags only existed on subcommands.

**Models are not limited to the registry**
- `--model`, `/model`, `defaultModel` and the web UI accept a registered id,
  **any model name the provider serves**, or `<provider>:<name>`
  (`anthropic:…`, `openai:…`, `local:…`).  An unregistered name is
  registered at runtime (e.g. `@aur/auto` → id `aur-auto`) on the HOTL
  endpoint when one is set, else OpenAI; the run says so before starting.
- The providers are asked what they serve: `hootl models --remote`, the
  `/model` menu, and `GET /api/models/remote` (the UI's model picker now has
  a "From <provider>" group and a ↻ reload button).
- The per-run model now drives **every** call of the run — planning,
  re-planning, acceptance and the final review — not only the agents (the
  web UI's per-run model used to reach the agents only).

Contract changes: an unknown `--model` is no longer exit 2, and an unknown
model in `POST /api/run` is no longer a 400 — both run it as a provider
model name (an empty model is still a 400).  The tests that pinned the old
contract were updated.  723 tests, e2e 46/46; the interactive flow was
checked in a real PTY rendered through a terminal emulator.

## [27.3.1] — 2026-09-24 — an endpoint from the environment

`HOTL_BASE_URL`, `HOTL_API_KEY` and `HOTL_MODEL` were only read by the CI
workflow; the CLI ignored them and failed with "OPENAI_API_KEY environment
variable is not set".  They now configure the CLI, the interactive mode, the
web server and `plans resume` directly:

- `HOTL_MODEL` is a registered id (`gpt-4o`) or any provider model name
  (`@aur/auto`, `llama3:8b`); a name that is not an id is registered as
  **`custom`** and becomes the default model.  Precedence: `--model` >
  `HOTL_MODEL` > the global config.
- `HOTL_BASE_URL` points that model at an OpenAI-compatible endpoint, over
  **Chat Completions** by default (what gateways implement;
  `HOTL_API_STYLE=responses` keeps the Responses API).
- `HOTL_API_KEY` is the key (`OPENAI_API_KEY` still works; an empty one no
  longer hides the other).
- The interactive banner shows the model (`custom (@aur/auto)`), the URL and
  which keys are present.

Found on the way: **the acceptance judge ignored the selected model** — it
always ran on the built-in `gpt-4o`, so with `--model` (or an env endpoint)
every step failed its quality check against a provider it was never meant to
call.  It now uses the run's model like the planner and the reviewer.

The e2e stub speaks Chat Completions too; a new `envendpoint` scenario runs
the real CLI from the three variables alone.  705 tests, e2e 46/46.

## [27.3.0] — 2026-09-24 — interactive mode

`hootl` with no arguments in a terminal now opens a prompt, like Claude Code,
instead of printing the help:

- a banner with the version, the **active directory** (the project root), the
  model, persistence and which API keys are present; the prompt shows the
  directory too;
- a plain line is a goal (plan → confirm once → execute), and with
  `/persistent on` the goals of one interactive session share a session;
- slash commands for configuration: `/config` (show; `set`/`unset` of
  `defaultModel`, `persistent`, `projectRoot` in the global config), `/model`,
  `/persistent`, `/yes`, `/verbose`, `/cd`, `/pwd`, `/status`, `/new`,
  `/clear`, `/help`, `/exit`;
- every regular subcommand as `/<command>` in the active directory
  (`/plans list`, `/usage`, `/logs --tail 20`, …), including `--help`;
- history, Tab completion of commands, Ctrl-C clears the line / cancels a
  running plan and returns to the prompt, Ctrl-C twice or Ctrl-D leaves.

Pipes, CI and scripts are unchanged: without a TTY, no arguments still prints
the help.  Verified in a real PTY (goals with and without auto-confirm, the
inquirer confirmation, session reuse, `/cd`, Ctrl-C cancel); 15 new tests.

## [27.2.14] — 2026-09-24 — provider faults (P1 without a key)

The e2e stub can now misbehave like a real provider — `FAULT:<429|500|401|CUT|HANG|EMPTY>x<n>`
on agent turns and `BADJSON:<Schema>x<n>` on structured calls — and a new
`faults` scenario drives the real CLI through them.  Transient 5xx/429,
dropped connections and timeouts were already handled.  Four things were not:

- **Token usage was half the bill.** Only agent turns reached the usage
  aggregator; every planning, acceptance and final-review call
  (`generateObject`) was billed by the provider but missing from the final
  report and from `hootl usage` (a two-step plan: 160 reported, 320 used).
  Structured calls now report through an `onUsage` callback, are logged as
  `llm:usage`, count toward all totals (not toward `taskCount`), and are
  billed to their plan — including re-planning, which bills the plan being
  revised.
- **The final report summed every run the orchestrator had made.** On the
  long-lived web server the "Usage" of each new run included all previous
  runs.  The report (and `plans resume`, which reported zero) now shows the
  plan's own usage.
- **One malformed structured answer ended the run.** An unparsable planner
  answer stopped the run as "Clarification needed … please provide more
  details"; an unparsable acceptance verdict failed a finished step and
  forced a re-plan.  Structured calls now retry once on
  `NoObjectGeneratedError`, and a planner that still fails is reported as
  `Planning failed: <reason>` (exit 1) instead of as a question.
- **An empty model answer counted as a completed step.** A turn with no text
  and no tool call now fails the task (`EMPTY_RESPONSE`).

679 tests in 50 files, `tsc` clean; `npm run e2e` → 42/42.

## [27.2.13] — 2026-09-24 — the Windows list, closed (annotations paid off)

The annotations from the CI run listed exactly what the (undownloadable) job
log hid.  Five more platform truths, four of them in tests — and one in the
product:

- **`mkdirSync` could mask the real error.** When a store's directory is
  replaced by a *file*, `withFileLockSync`/`atomicWriteFileSync` try to heal
  by recreating the parent.  On Windows that `mkdir` fails with `EEXIST`
  (POSIX says `ENOTDIR`), and the mkdir error was thrown instead of the
  original one — the caller saw a different code per platform.  Both paths
  now rethrow the original error when the heal fails.
- **Absolute-path expectations are platform-specific.** Two assertions in
  `hardening-security.test.ts` hard-coded `/home/user/project/src/main.ts`;
  `path.resolve` legitimately answers `D:\home\user\project\src\main.ts`
  on Windows.  They now compute the expectation with `path.resolve`.
- **EPIPE is a POSIX signal.** A child that closes its own stdin makes the
  next write fail with EPIPE on Linux/macOS; Windows anonymous pipes do not
  report it, so no `'error'` event fires.  The portable guarantee — the write
  rejects instead of becoming an unhandled event — is asserted everywhere;
  the `onerror` assertion is POSIX-only now.

The suite stays green (670 tests, 49 files, `tsc` clean).

## [27.2.12] — 2026-09-24 — the suite is honest on Windows (the new matrix found it)

The first CI matrix run made four legs green (Ubuntu 22/24/26, macOS 22/24)
and three red: **windows-latest / node 22 and 24**, while the e2e job passed
on Windows.  The failures were not in the product — they were tests that
silently assumed POSIX:

- **`os.homedir()` is not `HOME` on Windows.** Two suites isolated "the
  user's home" by setting `process.env.HOME` only; Windows reads
  `USERPROFILE`, so they kept using the runner's real home.  New
  `src/test-utils/isolated-home.ts` sets and restores `HOME`, `USERPROFILE`,
  `HOMEDRIVE` and `HOMEPATH` together.
- **Windows has no signals.** `child.kill('SIGTERM')` is `TerminateProcess`:
  the child's JavaScript handler never runs, so the marker file those tests
  waited for could never appear.  The transport still terminates the child;
  the tests now assert the marker *absent* on Windows and say why, instead of
  failing for a platform fact.
- **Creating a symlink needs a privilege Windows does not grant by default**
  (`SeCreateSymbolicLinkPrivilege` → `EPERM`).  The symlink escape tests in
  `phase20` now probe the capability once and skip with a reason; the lexical
  path checks still run everywhere, and the symlink defense still runs on
  POSIX and macOS.

Also added: `scripts/ci-test.mjs` — the suite now runs through it in CI so
every failing test is published as a check-run **annotation** (file, test
name, first line of the assertion).  The Windows job log was not downloadable
when this was investigated, which is exactly the situation annotations fix.

## [27.2.11] — 2026-09-24 — CI: the real provider from secrets, and a real Windows/macOS matrix

### Added

- **`.github/workflows/real-provider.yml` — the P1 test, run by GitHub.**
  It reads the endpoint and the key from repository secrets (`HOTL_API_KEY`,
  `HOTL_BASE_URL`, `HOTL_MODEL`, optional `HOTL_ANTHROPIC_API_KEY`), never
  from the workflow file, and refuses to start when `HOTL_API_KEY` is unset
  instead of "passing" without a model. It runs `hootl run` against the real
  provider in a scratch project and only accepts the run if (a) a plan was
  persisted, (b) the provider reported non-zero tokens — a plan with zero
  tokens means the model was never really called, and (c) the key appears
  nowhere under `.ai-runtime`. Runs weekly and on demand.
- **`.github/workflows/ci.yml` — the P8 matrix in real operating systems.**
  Ubuntu + Windows + macOS × Node 22/24 (plus Node 26 on Linux): type check,
  the whole vitest suite, a clean build, `npm install -g .`, a CLI smoke and
  the committed e2e scenarios. This is what closes the two axes the sandbox
  could not reach (Node > 22, non-Linux).
- **`e2e/scenarios/` — the end-to-end scenarios, committed and repeatable**
  (`npm run e2e`, ~25 s, seven scenarios, 32 checks): success path, resume,
  sandbox escape, hostile-note credential leak, MCP discovery, `plans cancel`
  mid-run and Ctrl-C. They drive the real CLI against `e2e/fake-llm.mjs`,
  create a throwaway project each, and assert on the artifacts a run wrote
  (plans, log, usage). `e2e/scenarios/fixtures/stdio-server.mjs` is a real
  MCP stdio server for the MCP scenario. The stub now understands the goal
  markers (`READ:`/`WRITE:`/`OVERWRITE:`/`SEARCH:`/`GITSTATUS`, `SLOW:`,
  `SLOWALL:`), carries the goal into the step description, and echoes a
  credential it reads, so the redaction path is exercised, not assumed.

### Fixed

- **`hootl plans resume` re-ran a finished plan.** A plan whose status was
  already `completed` was re-opened (and, with a `pending` step left behind by
  contradictory data, re-dispatched); a plan abandoned in `cancelling` (the
  process was killed after the cancel request) was treated as resumable. Now:
  `completed` is returned as-is, `cancelling` is finalised as `cancelled`, and
  `plans resume` says why it refuses (`exit 1` for a cancelled plan, a notice
  for a completed one) instead of silently running work again.
- **Ctrl-C left the plan stuck in `cancelling`.** The first interrupt cancels
  the plan and lets the step in flight finish; if the second interrupt leaves
  the process immediately, the plan file was never updated and `plans list`
  showed a state no process owned. The exit path now writes the terminal
  state synchronously. (Found by a real PTY test, not by reasoning.)
- **`--yes` runs could not be cancelled gracefully.** The plan id was recorded
  in the interactive confirmation callback, which `--yes` never calls, so the
  first Ctrl-C had no plan to address and exited immediately.
- **`hootl tasks list` reported dead tasks as `running` forever.** A task
  whose plan is already `completed`/`cancelled`/`failed-partial` was killed
  with the process that owned it; the view now derives that from the plan
  store instead of waiting for a `task:*` event that will never come.
- **`hootl tools --mcp --json` was not parseable** — the human-readable
  per-server notes were printed to stdout. They now go to stderr when `--json`
  is requested.

### Note

- The P1 run needs a secret, so it cannot be part of the default test job:
  `real-provider.yml` fails loudly when the secret is missing rather than
  reporting a green run that proved nothing.

## [27.2.10] — 2026-09-24 — a plan always has an identity, and the log records its steps

### Fixed

- **A plan produced inside the planner's assessment had no id.** `assess()`
  returns a plan when the model already answered `isClear: true`, and
  `Planner.plan()` handed that object to the runtime untouched — unlike
  `generatePlan()`, which assigns `plan_<uuid>`. Everything keyed by plan id
  then degraded: `hootl plans show/cancel/resume` could not address the plan,
  every log entry carried `"planId":""`, `hootl usage` listed the run as
  `(unattributed)`, and the final report printed `Plan: unknown`. Worst of
  all, `FilePlanStore` writes `sha256(plan.id ?? "unknown")`, so **every**
  id-less plan was saved to the same file and silently overwrote the last
  one. Both paths now go through one `finalizePlan()` (id, `draft` status,
  `createdAt`, all steps `pending`), and `FilePlanStore.save` refuses an
  id-less plan instead of colliding.
- **The log never recorded the step lifecycle.** The runtime emits
  `step:<id>:running|done|failed` and the logger has had
  `logStepStarted`/`logStepCompleted`/`logStepFailed` all along, but nothing
  called them: `hootl logs` showed tasks and quality failures, never a step.
  The new `step-events.ts` parses those events and writes them (with the
  already-scrubbed step summary).

### Added

- **`e2e/` — a local stub provider** (Responses API on `127.0.0.1:8931`) plus
  `e2e/README.md`: plan, execute, review and inspect a run end to end without
  a provider key. Development aid only; no product code imports it.

### Verified

- A real CLI run against the stub now shows `Plan: plan_<uuid>` in the report,
  the plan in `hootl plans list`/`show`, `160 tokens` attributed to it in
  `hootl usage`, and `step:started`/`step:completed` interleaved with
  `task:*` in `hootl logs`.
- The same flow through the server API: `POST /api/run` → `state=done` with a
  real `planId`, `/api/usage?planId=P` = 160 tokens, `GET /api/plans/:id` =
  200, UI served.
- 6 new tests (`phase30-p10.test.ts`); suite is 651 tests in 46 files.

## [27.2.9] — 2026-09-24 — hostile content: values, not just names (Phase 30 / P10)

### Fixed

- **A credential the model echoed could land in runtime artifacts.**
  Redaction matched field NAMES (`apiKey`, `token`, …); it did not touch the
  value itself. A model that reads `.env` (or a trap file) and prints the key
  puts it into its final text, which becomes the step summary and is written
  into the plan record. The new `src/ai/runtime/secret-scrub.ts` collects the
  actual secret values visible to the process (`OPENAI_API_KEY`,
  `*_TOKEN`, …), scrubs them out of every log message and (nested) payload,
  and a `ScrubbingPlanStore` scrubs step summaries before they are persisted.

### Verified (no code change needed)

- **Sandbox, end to end:** a symlink to `/etc/passwd`, a directory symlink
  used to write outside, an absolute path, `../../../../etc/passwd` and an
  encoded `..%2f` path are all rejected with `PATH_TRAVERSAL_BLOCKED`; nothing
  is created outside the workspace and no `/etc/passwd` content appears in any
  output. Unicode and 180-character file names work without a crash.
- **Prompt injection with a fully jailbroken model:** the trap file was read
  and the model *did* follow it (it tried to read `/etc/passwd`, write outside
  the workspace and echo the key). The sandbox blocked every attempt, and the
  echoed credential is recorded as `***REDACTED***` — the key appears nowhere
  under `.ai-runtime` (log, plans, sessions) nor in `hootl logs`.
- 8 real CLI runs; 9 new tests in `phase30-p10.test.ts`; suite is 645 tests in
  46 files.

## [27.2.8] — 2026-09-24 — the web UI/API path, end to end (Phase 30 / P9)

### Fixed

- **A store whose directory had been removed failed every write with a bare
  ENOENT.** `FileSessionStore`/`FilePlanStore` created `.ai-runtime/<store>/`
  only in their constructor, and both write primitives assumed it still
  existed (`withFileLockSync` opened the lock with `'wx'`;
  `atomicWriteFileSync` wrote its temp file next to the target). After
  `rm -rf .ai-runtime` under a running server every `/api/run` answered
  `{"state":"error","error":"ENOENT: … .json.lock"}`. Both now recreate the
  missing parent directory once and retry.
- **The observability log wrote into a deleted inode.** The logger keeps one
  fd open (PERF-04); when the file was removed or replaced, later entries
  went to the unlinked file, so `hootl logs`/`hootl usage` — which open the
  path — saw nothing while the server's in-memory counters kept counting.
  The fd is now reopened whenever the path no longer points at the same
  inode (one `stat` per entry; still one `open` per file).
- **One unhandled background rejection could kill the server.** A real server
  log contained `TypeError: terminated` (`UND_ERR_BODY_TIMEOUT`) from an MCP
  client's stalled stream fetch; nothing owned the rejection, so it reached
  the top level and took the process down — a dead dashboard instead of one
  failed probe. The server entry point now installs
  `installCrashGuards()`: `unhandledRejection` is reported and the server
  keeps serving (an uncaught exception still terminates).

### Verified

- The whole UI/API flow against the real server (`node dist/src/server.js`):
  preview → interactive run (pauses at `awaiting-confirmation`) → confirm via
  the API → the SSE stream from `plan:started` to `run:done` →
  `/api/usage` + `/api/runs/:id/tasks` → cancel mid-run → a re-planning run
  whose `plan:replanning`/`plan:replanned` events reach the browser stream.
  15/15 checks, twice, each run preceded by `rm -rf .ai-runtime` while the
  server was live.
- All nine MCP probe endpoints answer HTTP 200 with a correct `ok:false`
  (dead URL, missing env var, missing `url`/`command`, hanging stdio) — no 500s.
- `GET /api/usage?planId=P` and `hootl usage --plan P --json` agree
  (330 tokens / 1 task) for the same plan.
- 9 new tests in `phase30-p9.test.ts`; suite is 636 tests in 45 files.

## [27.2.7] — 2026-09-24 — environment matrix, and stdio MCP on Windows (Phase 30 / P8)

### Fixed

- **Standard stdio MCP servers could not start on Windows.** `npx` and `npm`
  are `.cmd` shims there, and `CreateProcess` cannot execute them directly:
  `spawn('npx', …)` fails with ENOENT, so the most common MCP config
  (`"command": "npx"`) never worked on Windows. The spawn options now come
  from a pure, unit-tested `stdioSpawnOptions(platform, env)` — `shell: true`
  on `win32` only, so POSIX behaviour (no shell, no quoting surprises) is
  unchanged.
- **Killing a shell-wrapped stdio server left it running.** With
  `shell: true` the real MCP server is a grandchild, and `child.kill()` only
  signals the shell; on Windows the whole tree is now killed with
  `taskkill /PID <pid> /T /F` (POSIX keeps SIGTERM → SIGKILL).

### Verified (no code change needed)

- **Clean-room install**: `git archive HEAD` → `npm ci` → `npm run build` →
  **627 tests / 44 files** green, and the freshly built CLI runs a plan
  (`Outcome: SUCCESS`, exit 0) and `mcp test` succeeds.
- **No TTY / CI**: 26 key commands with stdin closed and stdout redirected —
  no hangs; read-only commands exit 0; `run` without `--yes` exits 1 with the
  "requires a TTY" hint; `logs --follow` exits as soon as the consumer closes
  the pipe and keeps `tail -f` semantics on a redirect.
- **Static platform audit** (macOS/Windows/WSL): win32 case-insensitive path
  comparison and symlink-escape checks already present, no `chmod`/`symlink`
  in shipped code, no POSIX-only paths, no EOL assumptions, only `git`
  (execFile) and MCP spawn shell out, `engines: node >=22` declared, and no
  deprecated/removed Node APIs.

**Not verified here (honest):** Node 24/26 and real Windows/macOS execution —
this sandbox cannot reach nodejs.org (or GitHub release assets) and has only
Node 22.  Recipe: `nvm install 24 && nvm use 24 && npm ci && npm test`.

## [27.2.6] — 2026-09-24 — large plans and honest re-planning (Phase 30 / P7 of READINESS_AUDIT.md)

A 12-step chained plan with a deliberately failing middle step showed that
re-planning worked but was **invisible**, and that the step it threw away
**disappeared** — the plan then reported `11/11 steps completed`, `SUCCESS`
and exit 0 although the goal had 12 parts.

### Fixed

- **Re-planning was invisible.** `PlanRuntime` emits
  `plan:replanning-attempt-N` and `plan:replanned`; the streaming manager
  only matched the exact string `plan:replanning` and nothing logged either
  event, so neither the terminal nor the JSONL log showed that the plan was
  being rewritten. Both events are translated and logged now (the CLI prints
  `↻ Re-planning attempt 1 — revising the plan...` and
  `↻ Plan revised — N step(s) after re-planning.`).
- **An abandoned step vanished from the plan.** The merge of a revised plan
  kept only completed steps, so a failed step and its reason were dropped:
  the store, `plans show` and the final report kept no record, and the plan
  was reported as `completed` / `SUCCESS`. The new `replan-merge.ts` keeps
  every terminal step (`done` **and** `failed`), which also makes the plan
  status honest (`failed-partial`).
  - A replacement that reuses the failed step's id is no longer swallowed:
    it is recorded as `<id>~replan<n>` and dependants are rewired to it.
  - Dependencies on a kept failed step are dropped — that edge can never be
    satisfied, so keeping it deadlocked the plan (the case re-planning
    exists to handle).
- **`logPlanCompleted` no longer logs a `failed-partial` plan as
  `plan:completed`** ("Plan completed. 11/12 steps done." told the log
  reader the opposite of the truth): the event type and level follow the
  real plan status now.

Tests: `src/ai/__tests__/phase30-p7.test.ts` — 10 tests (merge semantics,
replan event translation, truthful logging).  626 tests / 44 files green,
`tsc` clean.

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

**Second review (2026-10-01) — all five findings fixed (`6b36348`):**
- **F-11:** the declared surface could be bypassed (a step naming no tools got its skill's tools from
  `createAgent`, and a re-planned step brought its own). The runtime now narrows every dispatch,
  filters every built agent's tools and narrows re-planned steps, and the bridge hands the surface to
  the runtime (`toolSurfaceFor`).
- **F-12:** one model call was charged per agent run whatever the SDK step count, and an exhausted
  budget was noticed only after the work ran. The agent runtime reports `modelCalls` (SDK steps), the
  usage recorder charges it, and the executor port stops before the next dispatch once a budget
  dimension is exhausted — reported as a terminal `budget.*` limit, with the calls already made
  charged.
- **F-13:** the durable `pendingEffect` was cleared before the settled progress was persisted; the
  marker is now dropped in the same write that persists the progress.
- **F-14:** every store-backed run leases (fresh: `run.locked`; resume: `resume.locked`), and a stale
  lease is broken by an atomic rename with an inode+content identity CAS instead of a racy unlink.
- **F-15:** a limit checked before a node ran paired that node's inputs with the previous node's id;
  `WorkflowRunResult.resumeNodeId` now pairs them, so a resume cannot hand a node someone else's
  inputs.

**Evidence:** CI `36843874529` @ `6b36348` **success 10/10**; `scripts/ci-test.mjs` 2,017/2,017; the
full `src/ai` suite 127 files / 1,707 tests; profile gates 9/9; e2e `profiles` 12/12; `tsc --noEmit`
and `npm run build` clean. `TRACEABILITY.md` §3c holds the ledger. Per the owner's 2026-10-01
directive the verified stack merge proceeds; the merge event is recorded in the PR timeline.
