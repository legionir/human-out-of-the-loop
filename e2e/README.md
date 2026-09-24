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
`e2e/.artifacts/summary.txt` keeps the last result.

Exit code is 0 only when every check passed. `E2E_SCENARIO_TIMEOUT_MS`
(default 240000) bounds each scenario; `E2E_PORT` moves the stub off 8931.

| scenario | what it proves |
| --- | --- |
| `success` | a goal reaches a persisted plan with an id, the step's tool wrote the file, step lifecycle events are logged, tokens are attributed |
| `resume` | `plans resume` dispatches only the unfinished steps and a second resume is a no-op |
| `sandbox` | `read_file`/`write_file` cannot escape the project root |
| `credential` | a hostile note makes the model echo an API key; it never reaches any artifact, and the redaction marker proves the trap fired |
| `mcp` | `hootl tools --mcp` starts a real stdio server, lists its tool, reports a dead server, and stays valid under `--json` |
| `cancel` | `hootl plans cancel` mid-run ends the plan as `cancelled` and the run exits on its own |
| `faults` | provider faults: retried 5xx, a clear 401, a retried and a persistently unparsable planner answer, an empty answer, and usage that includes the structured calls |
| `envendpoint` | `HOTL_BASE_URL`/`HOTL_API_KEY`/`HOTL_MODEL` alone (no registry edit, no `OPENAI_API_KEY`) drive a full run over Chat Completions, the acceptance judge included |
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

- `FAKE_DELAY_MS=1500` slows every reply (the process-wide default);
  `FAKE_DUMP=/tmp/dump.txt` records each request the stub received.
- This is a development aid only — it is not part of the published package
  and no product code imports it.  The same scenarios run in CI
  (`.github/workflows/ci.yml`) on Ubuntu, Windows and macOS.
