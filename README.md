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

### Use any OpenAI-compatible endpoint (no registry edits)

```bash
export HOTL_BASE_URL=http://localhost:4414/p/free/v1   # Windows: set HOTL_BASE_URL=...
export HOTL_API_KEY=...
export HOTL_MODEL=@aur/auto        # a provider model name, or a registered id
hootl                               # model: custom (@aur/auto)
```

A model name that is not a registered id is registered as `custom`. The
endpoint is called over Chat Completions; set `HOTL_API_STYLE=responses` for
the Responses API. The three variables can also live in the project's `.env`.
Precedence: `--model` > `HOTL_MODEL` > `defaultModel` in the global config.

### Interactive mode

Run `hootl` with no subcommand in a terminal. The screen is cleared, **HOOTL**
is shown for 3 seconds, and then the console opens. The prompt shows the
active directory, which is the project root:

```text
HOOTL my-project › /mo
 /model   list models  ·  /model <id> to switch for this session
 /models  registered models (--remote: what the providers serve)
 ↑↓ select · Tab complete · Enter run · Esc close
```

```bash
hootl                                   # in the current directory
hootl --project-root=../other-project   # or --model <name>, --persistent, --yes, --no-splash
```

- **A plain line is a goal**: it is planned, shown for confirmation once, then
  executed, the same as `hootl run`. With `/persistent on`, the goals of one
  interactive session are recorded in the same session.
- **`/` opens the command menu**, filtered as you type: ↑/↓ select, Tab
  completes, Enter runs, Esc closes. Arguments have menus too (`/model `,
  `/cd `, `/persistent `, `/plans `). When the menu is closed, ↑/↓ walk the
  history.

| command | effect |
| --- | --- |
| `/help` · `/status` | commands · directory, model, endpoint, session, API keys (present or not) |
| `/model` · `/model <name>` | list registered models and **the models your providers serve** · switch |
| `/config` · `/config set <key> <value>` · `/config unset <key>` | show · save `defaultModel`, `persistent`, `projectRoot` |
| `/persistent on\|off` · `/yes on\|off` · `/verbose on\|off` | write `.ai-runtime` · auto-confirm plans · stream tool calls |
| `/cd <dir>` · `/pwd` | change or print the active directory (loads that directory's `.env`) |
| `/new` · `/clear` · `/exit` | new session · clear the screen · leave (also Ctrl-D, or Ctrl-C twice) |

Every regular subcommand also works with a slash, in the active directory:
`/plans list`, `/plans resume <id>`, `/usage`, `/logs --tail 20`,
`/tools --mcp`, `/mcp test <id>`, and `--help` on any of them.
**Ctrl-C** while a goal is running cancels the plan and returns to the prompt.
Without a terminal (pipes, CI, scripts), `hootl` with no arguments prints the
help, as before.

### Models: registered, or whatever your provider serves

`--model`, `/model`, `defaultModel` and the web UI accept any of these:

- a registered id (`hootl models`), for example `gpt-4o`;
- a model name your provider serves (`hootl models --remote`), for example
  `@aur/auto`. It is called on `HOTL_BASE_URL` when that is set, otherwise
  on OpenAI;
- `<provider>:<name>`, for example `anthropic:claude-3-5-haiku-latest`,
  `openai:gpt-4.1` or `local:llama3:8b`.

The web UI's model picker lists the registered models and, under "From
<provider>", the models the providers serve (↻ reloads them).

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
| `run <goal>` | Plan, confirm (once), execute to completion | `--project-root`, `--persistent`, `--model <id>`, `--session <id>`, `--yes`, `--verbose`, `--dry-run`, `--thinking <auto\|on\|off>`, `--timeout-ms <ms>`, `--max-steps <n>`, `--max-replans <0-10>`, `--max-delegation-depth <0-5>`, `--label <text>` |
| `sessions list` | List persisted sessions | `--project-root` |
| `sessions show <id>` | Session detail (interactions, plan ids, summaries) | `--project-root` |
| `sessions label <id> <label>` | Rename a session (empty string clears the label) | `--project-root` |
| `sessions delete <id>` | Delete a session | `--project-root` |
| `plans list` | List persisted plans (status, step progress) | `--project-root` |
| `plans show <id>` | Plan detail (goal, steps, dependencies) | `--project-root` |
| `plans cancel <id>` | Mark a plan cancelled (no execution state touched) | `--project-root` |
| `plans resume <id>` | Re-execute a plan that is not in a terminal state | `--project-root`, `--model`, `--timeout-ms` |
| `mcp list` | MCP servers from `registry/mcp-servers` | `--json` |
| `mcp test <serverId>` | Connect to one MCP server (`stdio` child process, `http` or `sse`), list its tools | `--json` |
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

### While it works: the terminal is never blank

A model call can take a while — a slow gateway, a reasoning model, a
rate-limited provider. `run` says so while it waits:

- **A rotating status line.** While a result is pending, one self-overwriting
  line shows a spinner and a message that changes every **3 seconds**, picked
  at random from: *dreaming…*, *Crunching the numbers…*, *Analyzing the data…*,
  *Generating insights…*, *Processing your request…*, *Thinking deeply…*,
  *Working on it…*, *Hold tight, almost there…*, *Just a moment, please…*,
  *Loading the magic…*, *Preparing the response…*, *Hang tight, we're on it…*.
  Every real line of output erases it first, so the two never collide.
- **The model's thinking, streamed.** Every reasoning token a provider exposes
  is printed as it arrives — italic, violet, prefixed with 💭 — instead of
  showing up only once the answer is complete. Agent turns switch to a
  streaming call to make that possible. Thinking text is display-only: it is
  never persisted to a plan, the observability log or a report.
- **The planner is told where it works.** Planning prompts carry a
  `PROJECT CONTEXT` block (absolute project root, platform, top-level
  entries), so "which project should be scanned?" is answered before the model
  can ask it.

```bash
hootl run "list every TypeScript file" --yes           # status line + 💭 thinking
hootl run "list every TypeScript file" --thinking off  # plain, non-streaming path
```

| Variable | Default | Meaning |
|---|---|---|
| `HOTL_THINKING` / `HOTL_SHOW_THINKING` | `auto` | `on`/`off`/`1`/`0`; `--thinking <mode>` wins over the environment, and `auto` shows thinking only when stdout is a terminal |
| `HOTL_NO_ACTIVITY=1` / `HOTL_ACTIVITY=off` | — | turn the status line off in a terminal |
| `HOTL_ACTIVITY_INTERVAL_MS` | `3000` | how often the status message changes (minimum 250) |

Both are terminal-only by default, so pipes, CI logs and `--json` output stay
exactly what they were.

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

### Time and structured reasoning

Three tools from the reference `time` and `sequentialthinking` servers:

| Tool | What it answers |
|------|-----------------|
| `get_current_time` | the date and time in any IANA zone, with day of week, UTC offset and DST state — plus the **machine's** zone, so "local" is never ambiguous. `date` asks about another day (offsets are date-dependent). An unknown zone is refused with suggestions (`Asia/Tehrn` → *did you mean Asia/Tehran?*) instead of silently becoming UTC |
| `convert_time` | a wall-clock time (HH:MM) from one zone to **one or many** others, each with its own offset, DST flag and hour difference — resolved for the target day, so it is right across a DST switch |
| `sequentialthinking` | one step of a numbered, estimated, revisable, branchable reasoning chain — kept in `<project>/.ai-runtime/thinking/<sessionId>.json` (atomic write), so a resumed run continues the same chain instead of rebuilding it |

The environment block (below) also carries the current time in the machine's
zone, so ordinary "what is today?" questions cost no tool call. A reasoning
session is capped at 50 steps / 256 KB with a `THINKING_LIMIT` error that asks
for a fresh id — "think forever" is what a stuck model does.

### Reading a git repository

Six read-only tools, so an agent understands a repository before anything is
allowed to change it. They share one core: `git` runs through `spawn` with an
argument array (**no shell**), with `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=echo`
/ `GIT_PAGER=cat` / `GIT_OPTIONAL_LOCKS=0` — a call can never hang on a password
prompt or a pager, and a read never takes a lock out from under your editor.
Any caller-supplied ref, path or filter that starts with `-` is refused outright
(`BAD_ARGUMENT`), paths go after `--`, and output is capped at 256 KB by killing
the child.

| Tool | What it answers |
|------|-----------------|
| `git_status` | the working tree, parsed: porcelain **v1/v2** entries (index/worktree characters, renames with their `from`, untracked, unmerged), counts, and the branch with its upstream and `ahead`/`behind`. `path` focuses on one file |
| `git_diff` | the three reference tools in one: the working tree by default, `staged: true` for the index, `target: 'HEAD~1'` for a ref. `statOnly`, `nameOnly`, `path`, `contextLines`, plus files with per-file `+`/`-` counts |
| `git_log` | parsed history — sha, author, ISO date, parents, refs, subject, body — filtered by `path`, `author`, `since`, `until`, rendered as `oneline`, `short` or `json` |
| `git_show` | one revision: the commit object *and* its patch, `path` to narrow it, `statOnly` to keep a merge out of the context |
| `git_branch_list` | branches as data: current flag, sha, upstream, ahead/behind, last commit — with `contains`/`notContains` ("which branches already have this fix?"). A detached HEAD is reported as detached, with its sha |
| `git_remote_list` | where a push would go: name, fetch URL and push URL (they differ more often than you would think). Config only — no network |

Errors are structured and mean different things on purpose: `NOT_A_REPO` (this
directory is not a work tree), `PATH_TRAVERSAL_BLOCKED` (outside the workspace),
`BAD_ARGUMENT` (a value git would read as an option), `TIMEOUT`,
`OUTPUT_TOO_LARGE`, `GIT_MISSING`, `GIT_FAILED`.

### Reading the web

`fetch` reads one URL and returns it as **Markdown** — headings, links, lists,
code, tables, quotes — with the page's `<title>`, the status, the content type
and the redirect count. `script`, `style`, `nav` and `footer` are removed with
their contents, so a page's markup never becomes prompt tokens; non-HTML text
(JSON, plain text, XML) passes through untouched. Long pages are paged:
`maxLength` (default 5000) plus `startIndex`, and a truncated result carries
`nextStartIndex` and says exactly which call continues it. `raw: true` returns
the markup itself, for the cases where the markup *is* the answer.

```bash
hootl run "read https://vitejs.dev/guide/ and use what fits" --yes
```

Three limits are the point of the port, not afterthoughts:

- **Only public addresses, unless a human says otherwise.** Loopback, private,
  link-local, CGNAT and reserved targets are refused (`BLOCKED_PRIVATE_ADDRESS`,
  with the address and the reason). The check runs on what the host *resolves
  to* — so `localhost`, `127.0.0.1`, `[::1]`, IPv4-mapped IPv6 and a public name
  with a private A record are all caught — and it runs again on **every redirect
  hop**, so a public page cannot bounce the agent into `http://169.254.169.254/`.
  A URL reaches an agent from its context (a fetched page, a README), which is
  exactly the prompt-injection path SSRF travels. `allowPrivate: true` is the
  documented override, reported back as `privateAllowed`.
- **Bounded.** 10 s per request, ≤ 5 redirects, ≤ 2 MB read from the wire (the
  stream is cancelled at the cap), ≤ 100 000 characters returned.
- **No credentials.** One header set for every request: our own User-Agent and a
  plain `Accept`. Nothing from the environment is forwarded, ever.

robots.txt is honoured by default (per host, cached 10 minutes; longest matching
rule wins, Allow takes ties, and an exact token group beats `*`). A 401/403 or an
*unreadable* robots.txt is a refusal — "we could not find out whether we are
welcome" is not permission — and the rule is reported so the model can say why.
`respectRobots: false` is the deliberate override. Failures are structured:
`INVALID_URL`, `BLOCKED_PROTOCOL`, `BLOCKED_PRIVATE_ADDRESS`, `DNS_FAILED`,
`ROBOTS_FORBIDDEN`, `ROBOTS_UNAVAILABLE`, `TIMEOUT`, `TOO_MANY_REDIRECTS`,
`TOO_LARGE`, `HTTP_ERROR`.

### Project memory

Nine tools from the reference `memory` server, so what a run *learns* is still
there tomorrow. The Journal (below) is the history of what happened; memory is
the current state of what the project knows — decisions, constraints, owners,
gotchas that a future run would otherwise rediscover (or contradict).

| Write | Read |
|-------|------|
| `create_entities` (name, type, observations; an existing name is left alone) | `read_graph` (the whole graph, paged) |
| `create_relations` (an active verb, both endpoints must exist) | `search_nodes` (case-insensitive over name, type and observations) |
| `add_observations` (duplicates skipped) | `open_nodes` (named entities, each with its relations) |
| `delete_entities` (cascades its relations) · `delete_observations` · `delete_relations` | |

The graph is **per project** — `<project>/.ai-runtime/memory.json`, written
through a file lock and a temp file + `rename`, so two agents (or two terminals)
cannot lose each other's update. Four rules are visible in the result rather
than guessed at: a relation to a name nobody created is refused with
`ENTITY_NOT_FOUND` (the reference's semantics — no endpoint is invented), a
corrupt file is reported as `GRAPH_CORRUPT` and never overwritten, every result
names the file it used (`memoryFile`), and the read tools page —
`read_graph` at 200 entities, `search_nodes` at 100 — reporting `total` and
`truncated` plus the names of neighbours that fell outside the page, so a graph
that grew for months cannot blow up a prompt. `search_nodes` and `open_nodes`
return the relations touching a hit *even when the other end is not a hit*, with
those names listed, because "what does this depend on?" is usually the question.

Reading and capturing is open to `architect` and `reviewer` as well; the three
`delete_*` tools are granted to `coder` only — erasing history is a deliberate
act. Every write is journalled automatically, like every other tool call.

### Journal — what the AI actually did

Every tool execution and every plan/step transition is appended, automatically,
to `<project-root>/.ai-runtime/journal/YYYY-MM-DD.jsonl` — one line per action,
with the arguments, a summary, the files it touched (path, size, sha256), the
duration, the outcome, and the `taskId`/`agentId`/`planId`/`planStepId` that
connect it to the run. It is written at the one place the runtime hands its
tools to the model (`AgentRuntime`), so local tools, MCP tools and
`delegate_task` are all covered without any tool knowing about it, and the
`streamText` (live-thinking) path is covered by the same wiring.

It is deliberately *not* the observability log: `observability.jsonl` records
what happened to the run and never stores tool arguments or results; the Journal
is the transcript. Credentials are redacted by key **and** by the actual secret
values of the process, entries are capped, files rotate daily and old ones are
pruned (`journal.retentionDays`, default 30).

```bash
human-out-of-the-loop journal --failed --since 24h       # what went wrong today
human-out-of-the-loop journal --tool write_file --json   # machine-readable
human-out-of-the-loop journal --stats                    # per-tool call/failure/time
```

Disable per process with `HOTL_JOURNAL=0`; `HOTL_JOURNAL_RESULTS=full` keeps
complete results instead of summaries. Config:
`journal: { enabled, includeResults, maxEntryBytes, retentionDays }`.

### Filesystem tools

The workspace tools are a native port of the MCP reference *filesystem* server
(`servers-main/src/filesystem/`) — the same path validation, not an MCP server
registration. With phase 35 the reference set is **complete**: every tool that
server registers has a native counterpart here, plus three of our own. Sixteen
tools, all bound to `--project-root` and refusing anything that escapes it
(symlinked parents included):

| Read | Write | Inspect |
|------|-------|---------|
| `read_file` (full, `head`/`tail`, base64) | `write_file` (atomic, `overwrite`) | `list_directory` |
| `read_media_file` (image/audio attached to the model call) | `write_multiple_files` (batch/scaffold, per-file status) | `list_directory_with_sizes` (`sortBy: name\|size`, totals) |
| `read_multiple_files` | `edit_file` (line-based + diff, `dryRun`) | `directory_tree` (globs, `maxDepth`) |
| `search_code` (VS Code style, see below) | `create_directory` | `get_file_info` |
| `search_files` (glob names/paths, sizes, counts) | `move_file` (never overwrites) | `list_allowed_directories` |
| | | `git_status` |

`read_media_file` is the one read that is not text: an image or audio file comes
back as base64 **and is attached to the model call** as a real content part, so a
vision model can look at a screenshot or a diagram. Two deliberate deviations
from the reference keep that from flooding a run: a `maxBytes` ceiling (default
10 MiB) refuses an oversized file with `FILE_TOO_LARGE`, and a non-media binary
is returned with its metadata but *not* attached (`attachedToModel: false`).
`list_directory_with_sizes` adds what a plain listing cannot answer — where the
bytes are: per-file sizes, `sortBy: 'size'`, and the `Total: N files, M
directories` / `Combined size:` footer. It lists with `lstat`, so a symlink is
reported as `[LINK]` (and never followed), and only regular files carry a size.

`search_files` is the glob counterpart, at the same level: a **bare name matches
at any depth** (`*.ts` finds `src/lib/util.ts`, like an editor's file finder —
`matchBaseName: false` restores whole-path matching), `node_modules`, `dist`,
`.git` and friends are **skipped by default** (the same list `search_code` uses,
and `ignoredDirectories` reports what was skipped), `excludePatterns` accept a
leading `!` re-include, `includeFiles`/`includeDirectories` pick the kind of
entry, and every result carries `size` + `modified` (via `lstat` — a symlink is
reported as itself, never followed) with `counts`, `filesScanned` and
`skippedSymlinks`. Matching happens on POSIX separators on **every** host, which
fixes a real Windows bug in the port: a relative path with `\` used to be handed
to `minimatch`, where the backslash is an escape character, so `src/**` + `/*.ts`
matched nothing there.

`search_code` follows the VS Code "search in files" model: a **content** pattern
(regex, or literal text with `literal: true`, case-insensitive unless
`caseSensitive`, `wholeWord` optional) plus a **path** pattern (`pathPattern`,
regex over the workspace-relative path) and glob `excludePatterns` to decide
which files are searched. Every occurrence is reported with its 1-based line
**and column**, optional `contextLines`, the list of matched files, and a
`file:line:column: text` rendering — one call answers "where is this used?"
including *every* hit on a line, which a per-line grep cannot.

Safety properties the port keeps from the reference implementation: every
component of a path is resolved through its symlinks and re-checked (a *new*
file behind a symlinked directory is refused before it is created), a Windows
drive path on a POSIX host is refused instead of being written as a literal
name, Unicode-equivalent (NFC/NFD) names resolve to the file that exists, new
files are created with `O_EXCL`, existing ones are replaced through a temp file
+ `rename` with the original permissions restored, and `edit_file` never
silently skips a non-matching edit. Path-check failures come back as
`{ success: false, code }` — `PATH_TRAVERSAL_BLOCKED`, `EEXIST`, `EDIT_NOT_FOUND`
— so a refused write is visible in the log and can never be judged a success.

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

## CI

Two GitHub Actions workflows ship with the repository.

| Workflow | Trigger | What it does |
|---|---|---|
| [`real-provider.yml`](./.github/workflows/real-provider.yml) | manual (`workflow_dispatch`) + weekly | Runs `hootl run` against a **real** model. The endpoint and the key come from repository secrets — never from the workflow file. |
| [`ci.yml`](./.github/workflows/ci.yml) | every push and pull request | Type check, the full test suite, build, global install and the committed e2e scenarios on **Ubuntu, Windows and macOS** (Node 22/24, plus Node 26 on Linux). No key needed: the e2e scenarios use the local stub. |

### Setting up the real-provider run

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Meaning |
|---|---|---|
| `HOTL_API_KEY` | yes | the provider key (`OPENAI_API_KEY` for the run) |
| `HOTL_BASE_URL` | no | OpenAI-compatible base URL, e.g. `https://api.openai.com/v1` (default: the provider's own endpoint) |
| `HOTL_MODEL` | no | model id, e.g. `gpt-4o-mini` (default: `gpt-4o`) |
| `HOTL_ANTHROPIC_API_KEY` | no | only if the model config needs an Anthropic key |

Optionally set the repository **variable** `HOTL_RUN_GOAL` to change the goal
(default: create `notes/provider-check.txt`). Then run
**Actions → Real provider (P1) → Run workflow**.

The job fails loudly when `HOTL_API_KEY` is missing, and it only reports
success when the run really talked to the model:

- a plan was persisted under `.ai-runtime/plans`,
- the provider reported **non-zero tokens** (a run that never reached the
  model cannot pass),
- the goal's file exists,
- the key appears **nowhere** under `.ai-runtime` — the run log is uploaded as
  an artifact only after that check passes.

## Architecture

See [src/ai/README.md](./src/ai/README.md) for full architecture diagram, layers, data flow, Persona/Skill/Tool differences, authorization model, MCP integration, and Human-Out-Of-Loop principle.

## Adding New Components

See [CONTRIBUTING.md](./CONTRIBUTING.md) for step-by-step guides to add Tool / Skill / Persona / Agent / MCP Server.

## Configuration

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for env vars, configurable ceilings, file structures, runtime directory, and scope audit.

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
| 27–32 | Env-injected endpoints, registry layers, the REPL and `/` menu, runtime models, live run feedback (status line + streamed thinking) & project context for the planner | 🟢 |
| 33 | Native port of the MCP reference filesystem toolset (13 tools, symlink/Unicode-safe paths, atomic writes, line-based edits) | 🟢 |
| 34 | Batch writing (`write_multiple_files`) and VS Code-style `search_code` (path pattern, toggles, columns, context) | 🟢 |
| 35 | `read_media_file` (attached image/audio) and `list_directory_with_sizes` — the reference filesystem toolset is complete | 🟢 |
| 36 | `search_files` at editor level (base-name matching, default excludes, type filters, sizes, counters) and the OS environment block given to the planner *and* the agent (shell, separator, GNU/BSD, line endings) | 🟢 |
| 37 | **Journal** — every tool execution and plan/step transition recorded automatically at the runtime's tool hook, redacted and rotated (`hootl journal`) | 🟢 |
| 38 | `get_current_time`, `convert_time`, `sequentialthinking` (persisted reasoning sessions) + the clock in the environment block | 🟢 |
| 39 | Project memory — the nine reference `memory` tools, per project in `.ai-runtime/memory.json` (locked + atomic, cascading deletes, `ENTITY_NOT_FOUND`, paged reads) | 🟢 |
| 40 | `fetch` — a URL as Markdown (in-tree HTML→Markdown, paging, `raw`), with robots.txt honoured and loopback/private addresses blocked by default | 🟢 |
| 41 | Git, read-only — `git_status` extended (porcelain v1/v2, branch, counts) plus `git_diff`, `git_log`, `git_show`, `git_branch_list`, `git_remote_list`, on a no-shell/bounded-output core | 🟢 |
| 42–43 | Tools expansion plan (`docs/history/TOOLS_EXPANSION_PLAN.md`): git write + PR, and exposing this runtime as an MCP server | 🔵 |
| C1–C5 | CLI completion plan (`docs/history/CLI_COMPLETION_PLAN.md`) | 🟢 |
| U1–U7 | UI completion plan (`docs/history/UI_COMPLETION_PLAN.md`) | 🟢 |

**1034 tests green (64 files), 0 tsc errors — plus 140 committed end-to-end checks (`npm run e2e`)** (phases 18–41 complete — see `docs/history/`)

## Law Compliance

- **Law 12:** Persona=behavior+policy, Skill=knowledge, Tool=action. No Agent imports Tool impl directly.
- **Law 13:** Main→Sub via `delegate_task` only.
- **Law 14:** Compact events (tool name only, no args) + `get_task_details` explicit.
- **Law 15:** Structured Output via `Output.object()` + Zod.
- **Law 16:** Data-driven registries — new components without Runtime code changes.
- **Law 17:** Human-Out-Of-Loop — confirmation is ONLY human touchpoint, auto retry/re-plan/backoff.
- **Law 18:** `allowedTools` enforced in Factory (static) + delegate_task (dynamic) + Feasibility Gate.
