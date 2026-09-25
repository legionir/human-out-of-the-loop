# End-to-end harness

Two things live here:

1. **`fake-llm.mjs`** — a stand-in for a real provider, so the whole runtime
   (planning → execution → acceptance → final review) can be exercised without
   spending tokens or needing an API key.
2. **`scenarios/`** — the scenarios themselves, committed and repeatable.

## Run the scenarios

```bash
npm run build          # the scenarios drive the real CLI
npm run e2e            # all of them  (~25 s)
npm run e2e -- resume  # one by them by name
```

The runner starts the stub itself, builds a throwaway project per scenario,
runs `node dist/src/cli.js`, and asserts on the artifacts the run wrote
(plans, `observability.jsonl`, usage) — never on the printed prose alone.
`e2e/.artifacts/summary.txt` keeps the last result, and
`e2e/.artifacts/requests.jsonl` every request the stub received (full bodies,
so a scenario can assert on the prompt a model was actually given).

Exit code is 0 only when every check passed. `E2E_SCENARIO_TIMEOUT_MS`
(default 240000) bounds each scenario; `E2E_PORT` moves the stub off 8931.

| scenario | what it proves |
| --- | --- |
| `success` | a goal reaches a persisted plan with an id, the step's tool wrote the file, step lifecycle events are logged, tokens are attributed |
| `files` | phase 33: one run calls `edit_file` (line-based, the rest of the file byte-identical), `directory_tree` (its JSON result reaches the next model turn) and `move_file` (source gone, destination present), all recorded in the log |
| `batch` | phase 34: one run scaffolds two files with a single `write_multiple_files` call, then finds their marker with `search_code` — asserting the path filter, the context lines and the `file:line:column` rendering all reached the next model turn |
| `media` | phase 35: `read_media_file` on a real PNG reaches the model as an `input_image` data URL, the same tool on a `.bin` layers its summary without the payload, and `list_directory_with_sizes` (sorted by size) carries its `[FILE]`/`Combined size` footer back |
| `search` | phase 36: `search_files` twice in one run — a bare `*.ts` name matching two levels down while `node_modules` stays out, then a directories-only scan — with `matchMode`/`counts`/`ignoredDirectories` reaching the model, and the agent system prompt carrying the environment facts |
| `journal` | phase 37: an ordinary run leaves a journal line for its `write_file` (arguments, artifact path/size/sha256, plan+step ids) — and `hootl journal --json/--stats` reads the same file back |
| `time` | phase 38: one run asks the clock twice (local + `Asia/Tehran`), converts 09:30 Tehran to Berlin (08:00, −1.5h) and writes a reasoning step into a named session — asserting the results in the model's request, the persisted session file, and that the Journal recorded all three calls without extra code |
| `memory` | phase 39: one run walks all nine memory tools (two entities, a relation, an observation, both read paths, then the deletes), leaving one entity in `.ai-runtime/memory.json`; a *second process* finds it again, and a relation to a ghost entity is refused with `ENTITY_NOT_FOUND` — with the Journal recording every call and no temp/lock file left behind |
| `fetch` | phase 40: four fetches against a throwaway server on loopback — the page as Markdown (absolute links, tables, `script`/`nav` dropped), the same page with `raw: true`, a robots.txt refusal carrying its rule, and the SSRF refusal for a loopback URL without `allowPrivate` |
| `gitread` | phase 41: the scratch project is `git init`-ed by the scenario, and all six read tools run against it — status (porcelain entries + branch), the three diff modes, log, show, branches and remotes — asserting the parsed fields reached the model and that the repository was left untouched |
| `gitwrite` | phase 42: the scratch project is a real repository with a **bare remote in `/tmp`**, so the scenario asserts what actually arrived — a feature branch created by `git_create_branch`, a commit from `git_add`/`git_commit`, and the push that put shas on the remote. Two guards are expected failures: a push to `main` (`PROTECTED_BRANCH` — the remote's only ref is the feature branch) and an unconfirmed `reset --hard` (`CONFIRM_REQUIRED` — HEAD and the tree are unchanged afterwards). The Journal must carry every write call, the commit message and the branch |
| `mcpserve` | phase 43: our own client (`hootl tools --mcp`) connects to our own server (`hootl serve --mcp`) through a project registry entry and lists its 45 tools; then the scenario speaks raw stdio itself — `initialize` answers with the server identity, `tools/call` returns a file through the same sandbox the agent uses, a path outside the project is refused **in-band** (`PATH_TRAVERSAL_BLOCKED`, not a crash), stdout carried protocol only — and both the success and the refusal are asserted in the Journal (`agentId: "mcp"`, refusal with its code) |
| `resume` | `plans resume` dispatches only the unfinished steps and a second resume is a no-op |
| `sandbox` | `read_file`/`write_file` cannot escape the project root |
| `credential` | a hostile note makes the model echo an API key; it never reaches any artifact, and the redaction marker proves the trap fired |
| `mcp` | `hootl tools --mcp` starts a real stdio server, lists its tool, reports a dead server, and stays valid under `--json` |
| `cancel` | `hootl plans cancel` mid-run ends the plan as `cancelled` and the run exits on its own |
| `faults` | provider faults: retried 5xx, a clear 401, a retried and a persistently unparsable planner answer, an empty answer, and usage that includes the structured calls |
| `envendpoint` | `HOTL_BASE_URL`/`HOTL_API_KEY`/`HOTL_MODEL` alone (no registry edit, no `OPENAI_API_KEY`) drive a full run over Chat Completions, the acceptance judge included |
| `context` | the planner request really carries the `PROJECT CONTEXT` block (absolute root, top-level entries, "never ask the user") — the prompt is read from the stub's request dump |
| `thinking` | `--thinking on` streams the model's reasoning (SSE, both wire formats) in italic, the run still completes, the text is never persisted, a cut stream still ends the run, and thinking stays off outside a terminal |
| `ctrlc` | one Ctrl-C cancels gracefully (skipped on Windows — no POSIX signals) |

## The provider stub

```bash
node e2e/fake-llm.mjs            # or: e2e/start-stub.sh   (writes a pid file)
```

It speaks the OpenAI **Responses API** on `http://127.0.0.1:8931/v1`, and
**Chat Completions** on any path ending in `/chat/completions`:

- structured requests (`text.format.type === "json_schema"`) answer with a
  payload derived from `schemaName` — `PlannerAssessment`, `ExecutionPlan`,
  `AcceptanceJudgment`, `FinalReview`.  The plan follows the goal: the goal's
  wording becomes the step description, and the tools the goal implies
  (`WRITE:` → `write_file`, …) are assigned to the steps;
- agent turns act on the **goal markers** below, one marker per turn, then
  stop.

| marker | effect |
| --- | --- |
| `READ:<path>` | `read_file` that path |
| `WRITE:<path>` | `write_file` that path |
| `OVERWRITE:<path>` | `write_file` with `overwrite: true` |
| `SEARCH:<pattern>` | `search_code` |
| `GITSTATUS` | `git_status` |
| `SLOW:<ms>` | delay the agent turns (a window to cancel) |
| `SLOWALL:<ms>` | delay every reply |
| `FAULT:<kind>x<n>` | the first `<n>` agent turns fail (no `x<n>` = all); kind = `429`, `500`, `401`, `CUT` (drop the socket), `HANG` (never answer), `EMPTY` (empty output) |
| `BADJSON:<Schema>x<n>` | the first `<n>` structured calls for `<Schema>` (`PlannerAssessment`, `ExecutionPlan`, `AcceptanceJudgment`, `FinalReview`) get unparsable text |
| `THINK:<text>` | the stub thinks out loud before answering — reasoning deltas on the stream (`reasoning_summary_text.delta` on Responses, `delta.reasoning_content` on Chat Completions); `-`/`_` become spaces |

Fault counters are keyed by the marker text and live as long as the stub, so
give each scenario its own tag: `FAULT:500x2#my-scenario`.

A goal that reads `OPENAI_API_KEY=…` is echoed back verbatim — that is the
worst case the credential scenario needs: a model under the control of a
hostile file.

## Point a project at it by hand

```bash
mkdir -p /tmp/demo && cp -r registry /tmp/demo/
python3 - <<'PY'
import json
p = '/tmp/demo/registry/models/gpt-4o.json'
d = json.load(open(p)); d.setdefault('config', {})['baseURL'] = 'http://127.0.0.1:8931/v1'
json.dump(d, open(p, 'w'), indent=2)
PY

OPENAI_API_KEY=stub-key hootl run 'summarise the project README' --yes --persistent \
  --project-root /tmp/demo
```

Then inspect the run the way a user would:

```bash
hootl logs   --project-root /tmp/demo
hootl plans  list --project-root /tmp/demo
hootl usage  --project-root /tmp/demo
```

## Notes

- Streaming requests (`stream: true`) are answered as real SSE on both
  endpoints — a streaming client never sees a single JSON body.  The
  `THINK:` marker's text is split into small deltas, so a scenario can tell
  "the reasoning was streamed" from "it arrived in the final payload".
  `FAKE_STREAM_MS` (default 5) delays each delta.
- `FAKE_DELAY_MS=1500` slows every reply (the process-wide default);
  `FAKE_DUMP=/tmp/dump.txt` records each request the stub received (the
  scenario runner points this at `e2e/.artifacts/requests.jsonl`).
- This is a development aid only — it is not part of the published package
  and no product code imports it.  The same scenarios run in CI
  (`.github/workflows/ci.yml`) on Ubuntu, Windows and macOS.
