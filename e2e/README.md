# Local end-to-end harness

A tiny stand-in for a real provider, so the whole runtime (planning →
execution → acceptance → final review) can be exercised without spending
tokens or needing an API key.

## Run it

```bash
node e2e/fake-llm.mjs            # or: e2e/start-stub.sh   (writes a pid file)
```

It speaks the OpenAI **Responses API** on `http://127.0.0.1:8931/v1`:

- structured requests (`text.format.type === "json_schema"`) answer with a
  payload derived from `schemaName` — `PlannerAssessment`, `ExecutionPlan`,
  `AcceptanceJudgment`, `FinalReview`;
- agent turns answer with one `read_file` call (and then a final message).

## Point a project at it

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
hootl logs  --project-root /tmp/demo
hootl plans list --project-root /tmp/demo
hootl usage --project-root /tmp/demo
```

## Notes

- `FAKE_DELAY_MS=1500` slows every reply (useful for cancel/timeout tests);
  `FAKE_DUMP=/tmp/dump.txt` records each request the stub received.
- This is a development aid only — it is not part of the published package
  and no product code imports it.
