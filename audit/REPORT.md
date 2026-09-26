# Integration, Workflow & Correctness Audit — REPORT
Project: human-out-of-the-loop (hootl) — TypeScript, Node ≥22, ESM; CLI + Express web UI + MCP server; file-backed persistence (no DB).
Method: 10-phase protocol (P0-P10), evidence-gated, resumable workspace under `audit/`.

## 1. What was inspected
- Entry points: 65/65 classified (61 DONE with resolved handlers, 4 NA = commander subcommand group containers whose children are their own EPs).
- Workflows: 60/60 traced to card level (15 card files; endpoint families as one-row-per-item tables per A9.3), W1-W15 evidence rows, success + failure paths.
- Entities: 5/5 (Plan, Session+Interaction, JournalEntry, Task run-state, web RunState) with transition sets verified against schemas/stores.
- Boundaries: 10/10 (HTTP, JSON-RPC stdio+http, tool schema, config/env, store↔disk, provider HTTP, child process, UI).
- Files: 525 tracked; T1 core (28 files) read fully at L2/L3 across this + prior forensic sessions; T3/T4 classified per tier rules (tests/docs/generated).
- Baseline: typecheck/tests BLOCKED (no node_modules; read-only scope). Compensating static checks: 599 relative imports resolved → 0 unresolved; package scripts validated.

## 2. Verdict (computed from gates)
**SUBSTANTIALLY VERIFIED WITH OPEN ITEMS**
- Gates passed: P0-P9 all PASSED; discovery-repeat gate PASS; findings refuted/verified in P8.
- Open items: 4 UNKNOWNs (unknowns.md), baseline run BLOCKED (static compensation done), F-0007/F-0011 POSSIBLE pending measurement.

## 3. Confirmed integration findings (post-refutation)
| ID | Sev | Finding | Location |
|---|---|---|---|
| SEC-001 family | CRITICAL | Web server: no auth on ANY route + default bind 0.0.0.0; destructive/spend endpoints exposed (POST /api/run, plans cancel/resume/confirm, DELETE sessions, preview→LLM spend, models/remote). Asymmetric with MCP HTTP transport which refuses tokenless startup (transports.ts:169-174). Per-endpoint table in audit/workflows/WF-0002..0027 cards. | src/server.ts:141-148, 202; routes/*.ts |
| SEC-003 | HIGH | Trust-gate bypass: three probe paths spawn project-layer MCP servers without the R0-08 trustedProject filter that orchestrator.initialize enforces (orchestrator.ts:693-696). | registry.ts:95,110-123; mcp.ts:27-50,80-92; registry.ts:150-203 |
| CONF-001 | HIGH | --trust-project flag referenced in error message but absent from CLI; trust.ts has zero production callers (dead wiring). | orchestrator.ts:696; src/ai/registries/trust.ts |
| F-0002 | MEDIUM | Runs awaiting clarification/confirmation never time out; run object + pending promise leak for process lifetime; ghost 'awaiting' states visible to UI. | src/server/routes/run.ts:127-171 |
| API-001 | LOW | /api/mcp single-layer vs CLI mcp layered listing (contract mismatch between server parity claim and implementation). | registry.ts:95,110 vs mcp.ts:27-50 |
| F-0001 | INFO | Interactive run prints active baseURL to terminal. | run.ts:368-372 |
| F-0010 | INFO | sessions.ts header omits `label` subcommand (doc drift). | sessions.ts:1-9 vs 57-79 |

## 4. POSSIBLE (not confirmed)
- F-0007 LOW/PERF: no cap on concurrent SSE connections (stream.ts:35-45).
- F-0011 MEDIUM/PERF: followLog re-parses whole JSONL per fs.watch event; shared by web stream route (logs.ts:147-169; observability-stream.ts:74-79).
- TEST-001 (prior audit): e2e fake-llm fixes assignedPersona='coder' — persona coverage gap.

## 5. What works (verified, for balance)
- Clarification/confirmation state machine guards (run.ts:206-210; plans.ts:90-105); resolvers never serialized (run.ts:253-255).
- Task-cancel ownership scope check (usage.ts:90-96) — the one true ownership check in the routes.
- Plan lifecycle guards: draft not resumable (orchestrator.ts:1512-1514), terminal-state finalize on SIGINT (run.ts:155-168), orphan task:interrupted reconciliation (orchestrator.ts:1585-1600 + tasks.ts:88-118 — two views converge).
- MCP HTTP transport: mandatory bearer token, loopback default, notifications→202 (R0-05), parse-error JSON-RPC mapping, 2mb body cap.
- Probe isolation everywhere (fresh ToolRegistry + closeAll finally: registry.ts:119-132; mcp.ts:87-99; registry.ts:197-199).
- Provider key isolation (R0-07): keys only to their own API; error scrubbing (list-models.ts:56-60, 121-122).

## 6. Prioritized remediation
1. Immediate: add auth to web server (or loopback default + token, mirroring transports.ts pattern); implement --trust-project or remove the dead gate; gate the three MCP probe paths behind the same trust check.
2. Short term: timeout/janitor for abandoned runs (F-0002); fix /api/mcp layering (API-001); cap SSE connections + incremental log tailing (F-0007/F-0011 after measurement).
3. Medium: unifying run/plan ownership model (replace UUID-knowledge-as-authz).

## 7. Coverage statement (exact)
Files: 525 discovered (files.tsv), 525 with final classification; 28 T1 at required depth DONE; remainder tier-scoped (T3/T4 L0/L1 per A7, T2 read in prior sessions). Workflows 60/60 carded. Entry points 65/65. Entities 5/5. Boundaries 10/10. Findings: 11 candidates → 5 standalone verified/kept, 6 merged into SEC-001 family, 2 downgraded POSSIBLE. Baseline commands: 5 BLOCKED with static compensation. No sampling was used for any coverage claim.
