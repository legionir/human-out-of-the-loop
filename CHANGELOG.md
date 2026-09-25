# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are aligned with the
delivery plans (`docs/history/` — `EXECUTION_PLAN_V2.md`, `CLI_COMPLETION_PLAN.md`,
`UI_COMPLETION_PLAN.md`, `PLAN.md`).

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
