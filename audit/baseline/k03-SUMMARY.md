# K-03 baseline — 2026-09-27 (sandbox Linux, node v22.22.3)

Recorded at `5a4b51e` (then this Phase K commit). `node_modules` was already installed; `npm ci` was skipped.

| Step | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` | 0 | clean |
| `npm run build` | 0 | clean |
| `npx vitest run` | 1 | **1607 passed / 19 failed** (11 files) |
| `npm run e2e` | 1 | **144/194 checks passed** |

## Vitest failures (pre-existing in this workspace, not introduced by Phase K)

- `env-endpoint.test.ts` — error string `HOTL_API_KEY (OPENAI_API_KEY is not sent to a custom baseURL)` vs expected `OPENAI_API_KEY (or HOTL_API_KEY)`
- `phase19.test.ts` / `phase20.test.ts` / `phase30-p5.test.ts` — hanging `generateText` mock did not honour the 5s test timeout (agent timeout path)
- `phase4.test.ts`, `cli.test.ts`, `phase28.test.ts`, `u3-run-options.test.ts` — packaged model id `local-aur` vs tests expecting `local-llama` / `llama3` (do not rewrite `local-llama.json`)
- `v27172-provider-wire.test.ts` — gateway stream fallback
- `phase29.test.ts` / `phase30.test.ts` — CLI TTY / persisted plan id

## e2e (fake-llm)

144/194. Notable fails: `memory` graph file missing, `gitwrite` branch not created, several `gitread`/`mcp`/`chat`/`resume` assertions. Stub scenarios that passed include `success`, `files`, `time`, `thinking`, `context`, `catalog`, `faults` (401 / empty answer).

K-03 stays **🟡** until a clean machine/CI run is fully green.
