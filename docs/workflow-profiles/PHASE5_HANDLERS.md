# Workflow Profiles — Phase 5: node handlers and delegation to existing services

**Status:** 🟢 implemented and locally verified (2026-09-30). Phase 5 adds adapters only: it connects the Phase 4 kernel to capabilities HOOTL already has and does not re-implement control flow, loop bounds, or base security. No Orchestrator entry point executes a profile yet (the feature flag from Phase 4 stays off, and wiring the flag into the Orchestrator/default profile is Phase 7), and no runtime authorization decision is made here.

## 1. Scope delivered

| Phase 5 step | Implementation | Tests |
|---|---|---|
| Step 1 — intake, condition, end | `src/ai/workflow-profiles/node-handlers.ts` (intake adapter); `condition` and `end` stay inside the Phase 4 kernel | `workflow-profile-handlers.test.ts` |
| Step 2 — planner, execute, review with a day-one trust boundary | `node-handlers.ts` + `src/ai/workflow-profiles/untrusted-content.ts` + `src/ai/workflow-profiles/orchestrator-adapters.ts` | `workflow-profile-injection.test.ts`, `workflow-profile-adapters.test.ts` |
| Step 3 — approval and error behaviour | `node-handlers.ts` approval adapter + `createApprovalPort` | `workflow-profile-handlers.test.ts`, `workflow-profile-adapters.test.ts` |
| Step 4 — seven-kind integration and security boundary | the full-profile fixture in `workflow-profile-injection.test.ts` (semantically validated, all seven kinds in one run) | same file |

## 2. Handler contract

`createWorkflowProfileHandlers(services)` returns handlers for `intake`, `planner`, `execute`, `review`, and `approval`. It deliberately returns **no** `condition` or `end` handler: those stay computed by the kernel from the validated contract, so no second implementation can drift. A service that is not wired fails closed (`planner.service-missing`, `executor.service-missing`, `reviewer.service-missing`, `approval.service-missing`) instead of silently degrading.

- **intake** maps the run's entry payload (`goal`/`request`/`description`/`task`, plus `context`) onto the node's declared output ports. It never invents a value; a required port with no value is caught by the kernel's single output-contract check.
- **planner** confines the goal and optional context, calls the planner port, and maps the outcome onto the declared ports: `kind`, `plan`, `planText`, `planDigest` (digest of the rendered plan text — the text a user is shown), `answer`, `needsClarification`, `clarification`. Clarification output keeps the existing entry-point shape (`needsClarification: string[]`).
- **execute** confines the goal, forwards `plan`/`planDigest`, the node's `mode`, `requireApprovalForSideEffects`, and the persona/skill/toolset/model bindings, and maps the outcome onto `status`, `summary`, `taskId`, `artifacts`. A declared failure classification is re-thrown as a typed `WorkflowNodeError`, so Phase 4 retry/route semantics apply unchanged.
- **review** confines the content under review and also passes the raw typed values for delegation; the returned decision must be inside the node's allowed domain, otherwise the node fails closed with `review.decision-invalid` (validation, never routed).
- **approval** returns the structured `decision` object (or `answer` for text responses) on approval, and fails closed on denial, expiry, or cancellation.

## 3. Trust boundary (from the first dispatch)

`untrusted-content.ts` is the single confinement implementation:

- every goal/description/persona/skill/fetched answer handed to a service is first wrapped in `<untrusted-data kind=… source=… digest=… bytes=…>` blocks with an explicit policy line (`UNTRUSTED_CONTENT_POLICY`) for prompt builders;
- delimiter-like sequences inside the payload are neutralized with a zero-width space, so content cannot close the block early — a break-out attempt leaves exactly one wrapper pair;
- payloads are capped (default 32 KiB) with the truncation stated inside the block, and the digest always covers the **raw, untruncated** content;
- the digest is `sha256` over a string's exact bytes or the canonical JSON of any other JSON-compatible value, so identical content always pins to the same digest and any change breaks it.

The handler never forwards raw untrusted text: the adapter tests assert that, with all untrusted blocks removed, no request to a service still contains the injected sentence. Injected instructions cannot change `mode`, `requireApprovalForSideEffects`, persona/toolset bindings, the allowed decision domain, or routing, because those are read from the validated profile and the kernel's first-match rules — never from content. An injected claim that "approval already happened" does not skip the gate: the run still asks and a denial is terminal.

## 4. Adapters to existing services (no parallel machinery)

| Port | Existing service | Mapping |
|---|---|---|
| planner | `Planner.plan()` | `plan` → `{ kind: 'plan', plan, planText }` rendered exactly as the caller renders it (`formatPlanForUser` by default, injectable); `answer`/`clarify` pass through |
| execute | `PlanRuntime.execute()` (sole inner DAG scheduler, D-WP-008) | `PlanExecutionResult` → `completed` / `partial` / `failed`; a cancelled run raises the terminal `cancelled` category |
| review | `FinalReviewer.review()` or `AcceptanceChecker.checkStep()` | `success → pass`, `partial-success → revise`, `failure → reject`; a cancelled run is terminal, never a verdict; an acceptance-check infrastructure error fails closed instead of producing a verdict |
| approval | the existing confirm/interaction callback | `confirmed → approved`, `!confirmed → denied`, timeout → `expired`, callback failure → `cancelled` |

### D-WP-012 — approval pass-through (recorded 2026-09-30, owner-delegated conservative decision)

An `approval` node emits its response port (`decision` or `answer`) and passes through any input port it also declares as an output — the same rule a `condition` node already follows. Without this rule a plan could not be gated by an approval and then executed, because edge mappings may only reference the current node's declared outputs. The rule never widens the contract: only ports the profile already declares can be produced.

### D-WP-013 — digest-bound approval over a text confirm callback (recorded 2026-09-30, owner-delegated conservative decision)

For `approvalType: side-effect` with `bindsTo`, the handler computes the digest of the bound input port, shows it inside the same interaction, and requires the port to return the digest it approved; any mismatch aborts with `approval.digest-mismatch` (`approval-denied`, terminal). The text-confirm adapter echoes the digest it displayed in that same interaction. A host whose approval can arrive out of band (web UI, resume) must supply its own port that returns the digest it actually approved; the check itself is unconditional.

An approval decision remains data: it is not a tool or side-effect authorization, and Phase 6 re-checks Runtime policy at the real call site before any effect. `timeoutSeconds` produces `expired` (terminal); durable pause/resume of a pending approval across restarts is Phase 6 work.

## 5. Evidence

Commands (repo root, Node v22.22.3):

- `npm run typecheck` → pass; `npm run build` → pass.
- `npx vitest run src/ai/__tests__/workflow-profile-*.test.ts` → **11 files, 144 tests passed** (kernel 16, handlers 17, injection 8, adapters 10, predicate 8, untrusted-content 6, semantic 27, resolver 16, registry 21, schema 11, MCP-ID 4).
- `npm test` (full repository) → 132 files / 1,843 tests: **1,842 passed, 1 failed**; the single failure is the pre-existing, out-of-scope `phase-j-checkpoint.test.ts > J-05` mtime-tie finding recorded in the Phase 2 closure.

Coverage highlights: all seven kinds in one semantically validated profile (`start → plan → ask → work → judge → check → ok`); intake mapping and missing-port failure; planner plan/answer/clarify mapping and digest binding to the rendered text; executor delegation, retryable failure classification, security denial terminal; review domain enforcement and out-of-domain rejection; approval approval/denial/expiry/cancellation, digest match and mismatch, binding to a missing port, text responses; adapter mapping for `PlanExecutionResult`, `Review`, `AcceptanceChecker`, and the confirm callback; and the adversarial matrix (goal injection, delimiter break-out, persona/skill text kept as identifiers, injected content unable to change the review decision or the route, injected "approval already happened", toolset-widening attempt).

## 6. Boundaries and open gates

- No Orchestrator/CLI entry point, feature-flag activation, persistence, resume, budget enforcement at the real call site, EventBus observability, node templates, or sub-workflows are included; those are Phases 6–7.
- Handlers add no policy of their own: they are adapters, and every authorization decision stays with the Runtime (Phase 6).
- Existing services are consumed through narrow structural interfaces, so a future change to `Planner`/`PlanRuntime`/`FinalReviewer` signatures surfaces as a type error at wiring time instead of silent drift.
- The trusted-host stable-root guarantee and the authoritative Runtime compatibility/enforcement contract remain open pre-integration gates.
- Per the owner instruction of 2026-09-30 no merge happens until every phase is complete; this phase is its own commit so per-phase review remains reconstructable at handoff.

## 7. CI record (append-only)

**Run `36713201379` on `c9ba62d` — attempt 1, 9/10 jobs, failure on `windows-latest / node 22` only.** The other nine jobs passed (ubuntu 22/24/26, macos 22/24, windows 24, and the three e2e jobs). The failing job's logs are not retrievable from this environment (the job-log API returns 0 bytes and the log archive request ends in `EOF`, the same limitation recorded for earlier runs), and both rerun routes are rejected (`run cannot be rerun`; `rerun-failed-jobs` → HTTP 403 `Resource not accessible by integration`), so **no cause is asserted** for this failure.

Context that bears on interpretation, not a conclusion: the same `windows-latest / node 22` or `node 24` job failed on two of the four most recent pushes to this branch and passed on rerun or on the next push without any change to that job's inputs (PR #9 attempt 1 → attempt 2 all green; PR #10 `2ccaaa0` failed `windows / node 24`; Phase 4 run `36710870531` passed all ten). A fresh exact-head run on the next commit is the discriminating evidence; until it is green, Phase 5's local evidence above stands on its own and the Windows result is recorded as unexplained rather than resolved.

**Resolution of the Windows failure (append-only, 2026-09-30).** The fresh run `36713820279` on `b7870cf` — whose diff against `c9ba62d` is documentation only — failed the same two Windows unit jobs, and this run's check-run annotations name the failing tests:

| Job (run 36713820279) | Failing test | Annotation |
|---|---|---|
| `windows-latest / node 22` | `src/ai/__tests__/chat-mode.test.ts` — "v27.17.0 — a greeting is answered, not planned" | `Error: Test timed out in 5000ms.` |
| `windows-latest / node 24` | `src/server/__tests__/server.test.ts` — "U1 — server config parity (.env + global config) model precedence" | `Error: Test timed out in 5000ms.` |

Both files are byte-identical to `main` on this branch (`git diff main --stat` for them is empty), both are pre-existing suites unrelated to Workflow Profiles, and the failure mode is the 5-second Vitest timeout on Windows runners — a different test per job and a different job set than the previous run on identical code. The nine/eight other jobs, including all three e2e jobs and every workflow-profile suite on Linux and macOS, pass. The Windows unit jobs on this repository therefore fail for an environment/timeout reason outside this phase's scope; the earlier unexplained `windows-latest / node 24` failure at `2ccaaa0` (run 36707929806) and the failed-then-passed Windows jobs at PR #9 are the same symptom. This is recorded as an environment finding for the owner, not resolved here and not attributed to Phase 5.

### 2026-09-30 — owner-authorized CI timeout adjustment (append-only)

Across the Phase 5/6 heads the Windows legs failed with a rotating set of **5000 ms test/hook
timeouts in pre-existing tests this branch never touched** (`chat-mode.test.ts` greeting,
`server.test.ts` U1 parity, `u2-registry.test.ts` U2, `u2717-chat-mode.test.ts` greeting,
`phase19.test.ts` Law 16, `phase-g.test.ts` G-02/G-04/G-09, `phase21.test.ts` PERF-04,
`cli.test.ts` followLog), never with a Workflow Profile assertion. The check-run annotations are the
evidence: each failure is a Vitest timeout or a wall-clock budget, the failing test differs per run
and per job, and the same commit can be green on one runner and red on another.

Owner instruction (2026-09-30): stop chasing the flake and raise the ceilings. Applied in
`vitest.config.ts` — on CI only, `testTimeout`/`hookTimeout` 30 s and `maxWorkers` 2, so the 2-core
runners are not starved; local runs keep Vitest's defaults. `phase21.test.ts` PERF-04's Windows
budget was raised from 500 ms to 2000 ms (the assertion still catches a regression to one
open/close per event, which costs seconds on that platform). No assertion was removed and no test
semantics changed; the flake itself is recorded, not hidden.
