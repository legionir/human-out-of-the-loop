# human-out-of-the-loop — AI Multi-Agent Orchestration Runtime

> **Human-Out-Of-Loop (Law 17):** All configuration decisions (task decomposition, persona/skill/tool selection, ambiguity resolution) are finalized **before execution** and confirmed by the user. After confirmation, the system runs to completion **without human messages like "continue"**. Only explicit cancellation and progress streaming are allowed.

## Quick Start

```bash
npm install
export OPENAI_API_KEY="sk-..."
npm run build
npx vitest run
```

```typescript
import { Orchestrator, createCliConfirmCallback } from './src/ai/orchestrator.js';

const orchestrator = new Orchestrator({
  projectRoot: process.cwd(),
  persistent: true,
  maxConcurrentTasks: 5,
  maxReplanningAttempts: 3,
});

await orchestrator.initialize();

const result = await orchestrator.run('Build a login page with validation', {
  confirmCallback: createCliConfirmCallback(),
});

console.log(result.report);
await orchestrator.shutdown();
```

## CLI

A full command-line front-end (Claude Code–style): plan, confirm once, then go out of the loop.

### Install the `hootl` command

Three ways to get a `hootl` command, depending on how you want to work. All of
them keep the current working directory as the project root, so in every case
you can just `cd` into the project you are working on and run `hootl` there
(`--project-root <dir>` overrides it for a single invocation).

#### a) Global install of the binary (recommended for real use)

```bash
npm install                # dependencies
npm run build              # compile to dist/
npm install -g .           # or: npm link  (same effect, no copy)
```

`hootl` works from ANY directory — no `registry/` needed in the project, because
the built-in (package) registry is always available and the project's own
`registry/` is layered on top when present:

```bash
cd ~/work/my-project       # no registry/ needed here
hootl models               # the built-in catalog is used
hootl run "fix the failing tests" --persistent
```

Notes:

- `package.json` publishes **two** binaries for the same entry point:
  `human-out-of-the-loop` and `hootl`.  The one-line alias is already in place,
  so no extra edit is required; the help text follows the name you typed
  (`hootl --help` prints `Usage: hootl …`).
- `"private": true` only blocks `npm publish` — it does **not** prevent a local
  or global install (`npm install -g .`, `npm link`) or a `npx <path>` run.
- **Re-run `npm run build` after every source change** — the installed binary is
  the compiled `dist/src/cli.js`, not the TypeScript sources.
- Requires Node.js >= 22.

#### b) Shell alias / function — no build, live source

A function (not just an alias) is the safest form: it passes arguments through
untouched and, because it never `cd`s into the repository, the CLI still treats
your current directory as the project root.

Add to `~/.zshrc` (zsh) or `~/.bashrc` (bash) — replace the path with your
checkout and run `npm install` in it once:

```sh
# zsh / bash — live source, no build required
hootl() { "/path/to/human-out-of-the-loop/node_modules/.bin/tsx" \
          "/path/to/human-out-of-the-loop/src/cli.ts" "$@"; }
```

`npx --prefix` works the same way if you prefer not to reference `node_modules`
directly:

```sh
hootl() { npx --prefix "/path/to/human-out-of-the-loop" tsx \
          "/path/to/human-out-of-the-loop/src/cli.ts" "$@"; }
```

Trade-offs: the code of this repository is used **live** (no rebuild after
edits), at the cost of roughly half a second to a second of `tsx` startup and a
dependency on the repository path staying where it is.

#### c) Wrapper script in `~/bin` or `~/.local/bin`

Same live-source approach without touching your shell profile — useful when the
shell config is shared or managed. Create the file, make it executable, and make
sure the directory is on `PATH`:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/hootl <<'EOF'
#!/bin/sh
exec "/path/to/human-out-of-the-loop/node_modules/.bin/tsx" \
     "/path/to/human-out-of-the-loop/src/cli.ts" "$@"
EOF
chmod +x ~/.local/bin/hootl
# add once, if not already there:
export PATH="$HOME/.local/bin:$PATH"
```

Because the script uses the repository as-is, there is nothing to rebuild; the
same `tsx` startup cost as option (b) applies. Option (a) remains the fastest
startup because it runs plain JavaScript from `dist/`.

#### Development runs (no installation at all)

```bash
npx tsx src/cli.ts models        # same commands, from inside the repository
```

### Help

The CLI documents itself — every command and subcommand carries a full
how-to appendix (behaviour, states, configuration, exit codes):

```bash
hootl --help                 # command groups, config precedence, registry layers, exit codes
hootl help run               # same as `hootl run --help`
hootl plans help resume      # help for one subcommand
hootl --version
```

### Registry layers (global + local)

Registries (personas, tools, skills, models, MCP servers, `agents.json`) are
merged from two layers, lowest precedence first:

| Layer | Location | Purpose |
|---|---|---|
| **package** (global) | `registry/` inside the installation | the built-in catalog — makes every command work from any directory |
| **project** (local) | `<project-root>/registry` | overrides and extensions; loaded LAST |

An entry whose `id` already exists in the package layer **replaces** it; new ids
are added. So a project can tweak `gpt-4o` or `coder` and still keep every other
built-in entry. `HOTL_NO_PACKAGE_REGISTRY=1` disables the global layer
(strictly local registries — handy for hermetic runs). Registry introspection
commands print which layers were used, e.g.
`registry: package (built-in) + project (.)`.

The project root defaults to the current working directory and can be overridden
per invocation with `--project-root <dir>`.

```bash
# Plan + confirm + execute, persisting state in .ai-runtime
human-out-of-the-loop run "Build a login page" --persistent --model gpt-4o

# CI / Human-Out-Of-Loop: never prompt, confirm automatically
human-out-of-the-loop run "Build a login page" --yes --max-replans 2

# Preview the plan without executing anything
human-out-of-the-loop run "Build a login page" --dry-run
```

### Command reference

| Command | Purpose | Key options |
|---|---|---|
| `run <goal>` | Plan, confirm (once), execute to completion | `--project-root`, `--persistent`, `--model <id>`, `--session <id>`, `--yes`, `--verbose`, `--dry-run`, `--timeout-ms <ms>`, `--max-steps <n>`, `--max-replans <0-10>`, `--max-delegation-depth <0-5>`, `--label <text>` |
| `sessions list` | List persisted sessions | `--project-root` |
| `sessions show <id>` | Session detail (interactions, plan ids, summaries) | `--project-root` |
| `sessions label <id> <label>` | Rename a session (empty string clears the label) | `--project-root` |
| `sessions delete <id>` | Delete a session | `--project-root` |
| `plans list` | List persisted plans (status, step progress) | `--project-root` |
| `plans show <id>` | Plan detail (goal, steps, dependencies) | `--project-root` |
| `plans cancel <id>` | Mark a plan cancelled (no execution state touched) | `--project-root` |
| `plans resume <id>` | Re-execute a plan that is not in a terminal state | `--project-root`, `--model`, `--timeout-ms` |
| `mcp list` | MCP servers from `registry/mcp-servers` | `--json` |
| `mcp test <serverId>` | Connect to one MCP server, list its tools | `--json` |
| `models` / `personas` / `skills` / `tools` | List registry entries | `--json` |
| `usage` | Token usage per plan (prompt/completion/total + task count) | `--plan <planId>`, `--json` |
| `tasks list` | Tasks from the observability log (derived status, tokens) | `--plan <planId>`, `--json` |
| `tasks show <taskId>` | Every log entry for one task (incl. payloads) | `--project-root` |
| `logs` | Read the observability log (`.ai-runtime/observability.jsonl`) | `--plan <planId>`, `--tail <n>`, `--follow` |

Registry introspection commands (`models`, `personas`, `skills`, `tools`) exit
**0** when listed (even with the built-in layer only), **1** when a registry file
fails validation (the valid entries are still printed) and **2** when no registry
layer exists at all.

`run` exits **0** on success/partial-success, **1** on failure (plan rejected,
clarification unanswered, agent failure), **2** on usage errors (unknown model,
bad flag values). With `--yes` or in a non-TTY environment the CLI never
prompts: an unclear request fails with the planner's questions instead of
hanging. In an interactive terminal the CLI asks clarification questions
before planning and shows the plan summary before executing.

### Examples

```bash
# Inspect one plan and its spend
human-out-of-the-loop plans show plan_8f3a… --project-root ./app
human-out-of-the-loop usage --plan plan_8f3a… --project-root ./app --json

# Watch the observability log while a run is in flight
human-out-of-the-loop logs --follow --project-root ./app

# Rename a session for easier reference
human-out-of-the-loop sessions label session_5c1d… "Login page v2"
```

## Web UI

The same runtime behind a browser front-end (Express + vanilla JS, no build step). Every UI action maps to a runtime capability — nothing is simulated:

```bash
npm run server                       # http://localhost:3000  (project root = cwd)
HOTL_PROJECT_ROOT=./app npm run server
HOTL_PORT=4000 HOTL_MODEL=claude-sonnet npx tsx src/server.ts
```

| Env var | Effect |
|---|---|
| `HOTL_PROJECT_ROOT` | Workspace root (registry/, `.ai-runtime/`) — also read from `~/.human-out-of-the-loop/config.json` (`projectRoot`) |
| `HOTL_PORT` | HTTP port (default `3000`) |
| `HOTL_MODEL` | Server default model, overridable per run from the UI (see U3 below) |
| `HOTL_REDACT_KEYS` | Extra comma-separated keys to redact from the observability log |
| `.env` (project root or cwd) + `~/.human-out-of-the-loop/config.json` | Same sources as the CLI (`defaultModel`, `projectRoot`) |

### UI flows

1. **Run** — type a goal → `Run`: the plan modal appears (with the selected model in the header), you confirm **once**, then execution streams live and ends with the final report.
2. **Plan only (preview)** — plans without saving anything: no session, no plan id, no execution. Feasibility and dependency-cycle checks are shown, and the modal has no Confirm button.
3. **Clarification** — when the planner needs more information it asks in a modal (one textarea per question); answers are fed back, the plan is regenerated, and nothing runs until you confirm it. "Don't answer" cancels the run.
4. **Per-run options** — a model selector populated from `/api/models` (default = server model) plus a collapsed *Advanced* group: `timeoutMs`, `maxSteps` (1–100), `maxReplans` (0–10). Invalid values are rejected with `400` before the run starts.
5. **Live tasks & usage** — the Tasks panel shows each task's status with a per-task **Cancel** (real cancellation in this process) and the run's token usage; the sidebar footer shows this server's aggregate.
6. **Sessions** — list/rename (✎)/open/delete; labels use the same store as `sessions label`.
7. **Observability** — the *Observability log* panel follows `.ai-runtime/observability.jsonl` live (SSE), optionally filtered to the active run's plan.

### API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | `{ok, projectRoot, model, persistent, redactKeysCount}` |
| `POST /api/run` | `{message, sessionId?, confirm?, model?, timeoutMs?, maxSteps?, maxReplans?}` → `202 {runId}` |
| `GET /api/runs/:runId` | Live run state (`planning` → `awaiting-clarification` → `awaiting-confirmation` → `running` → `done`/`error`) |
| `POST /api/runs/:runId/clarification` | `{answers:{question:answer}}` or `{decline:true}` (400 on incomplete answers, 409 when not awaiting) |
| `GET /api/runs/:runId/tasks` | Tasks of the run's plan + counts |
| `POST /api/runs/:runId/tasks/:taskId/cancel` | Cancel one pending/running task |
| `POST /api/preview` | Plan without side effects → `{ok, planId:null, plan, planText, feasibility, cycles}` (400 + `questions` when unclear) |
| `POST /api/plans/:id/confirm` | `{confirmed, feedback?}` — the single human decision |
| `GET /api/plans`, `GET /api/plans/:id`, `POST /api/plans/:id/cancel` | Plans list/detail/cancel |
| `PATCH /api/sessions/:id` · `DELETE /api/sessions/:id` | Rename (`{label}`; `""` clears) / delete |
| `GET /api/usage` · `GET /api/usage?planId=` | In-memory aggregate for this server / one plan's tokens |
| `GET /api/stream/:planId` · `GET /api/stream/:runId` | SSE: plan progress / clarification events |
| `GET /api/observability` · `GET /api/observability/stream?planId=` | Log entries / live follow |
| `GET /api/models` · `/api/personas` · `/api/skills` · `/api/tools` · `/api/mcp` · `POST /api/mcp/:id/test` | Registry introspection (same data as the CLI commands) |

```bash
# Run e2e without a browser (auto-confirm)
curl -s localhost:3000/api/run -H 'Content-Type: application/json' \
  -d '{"message":"Build a login page","confirm":true,"model":"local-llama","maxSteps":10}'

# Preview: nothing is persisted
curl -s localhost:3000/api/preview -H 'Content-Type: application/json' \
  -d '{"message":"Build a login page"}'

# Per-plan usage, live tasks, rename a session
curl -s 'localhost:3000/api/usage?planId=plan_abc'
curl -s localhost:3000/api/runs/<runId>/tasks
curl -s -X PATCH localhost:3000/api/sessions/session_5c1d -H 'Content-Type: application/json' \
  -d '{"label":"Login page v2"}'
```

> **In-memory vs persisted:** `/api/usage` and `/api/runs/:runId/tasks` reflect *this server process* (restart resets them). The durable per-plan totals live in `plan.json` (`review.usage`, exposed via `GET /api/plans/:id`), and sessions/plans/logs persist in `.ai-runtime/`.

## Architecture

See [src/ai/README.md](./src/ai/README.md) for full architecture diagram, layers, data flow, Persona/Skill/Tool differences, authorization model, MCP integration, and Human-Out-Of-Loop principle.

## Adding New Components

See [src/ai/CONTRIBUTING.md](./src/ai/CONTRIBUTING.md) for step-by-step guides to add Tool / Skill / Persona / Agent / MCP Server.

## Configuration

See [src/ai/CONFIGURATION.md](./src/ai/CONFIGURATION.md) for env vars, configurable ceilings, file structures, runtime directory, and scope audit.

## Project Status

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Base Registry & Schemas | 🟢 |
| 2 | Tool Registry (local + MCP) | 🟢 |
| 3 | Skill Registry | 🟢 |
| 4 | Persona (policy) + Model Registry | 🟢 |
| 5 | Agent Registry + Factory + Context Budget | 🟢 |
| 6 | Dynamic Catalog + Agent Composition | 🟢 |
| 7 | Agent Runtime + EventBus | 🟢 |
| 8 | Task Runtime + Resource Lock + Concurrency | 🟢 |
| 9 | Planning Layer | 🟢 |
| 10 | PlanRuntime (Human-Out-Of-Loop) | 🟢 |
| 11 | Per-Step Acceptance Check | 🟢 |
| 12 | Final Review + Report | 🟢 |
| 13 | Streaming/Cancellation/Rate-limit/Usage | 🟢 |
| 14 | Session + Observability | 🟢 |
| 15 | End-to-End Integration | 🟢 |
| 16 | Hardening + 15 Fixes | 🟢 |
| 17 | Documentation & Delivery | 🟢 |
| 18–26 | Runtime hardening, CLI parity, server-side controls, registry introspection, clarification, usage/tasks | 🟢 |
| C1–C5 | CLI completion plan (`CLI_COMPLETION_PLAN.md`) | 🟢 |
| U1–U7 | UI completion plan (`UI_COMPLETION_PLAN.md`) | 🟢 |

**527 tests green (36 files), 0 tsc errors** (phases 18–26 complete — see `EXECUTION_PLAN_V2.md`; CLI + UI completion plans: `CLI_COMPLETION_PLAN.md`, `UI_COMPLETION_PLAN.md`)

## Law Compliance

- **Law 12:** Persona=behavior+policy, Skill=knowledge, Tool=action. No Agent imports Tool impl directly.
- **Law 13:** Main→Sub via `delegate_task` only.
- **Law 14:** Compact events (tool name only, no args) + `get_task_details` explicit.
- **Law 15:** Structured Output via `Output.object()` + Zod.
- **Law 16:** Data-driven registries — new components without Runtime code changes.
- **Law 17:** Human-Out-Of-Loop — confirmation is ONLY human touchpoint, auto retry/re-plan/backoff.
- **Law 18:** `allowedTools` enforced in Factory (static) + delegate_task (dynamic) + Feasibility Gate.
