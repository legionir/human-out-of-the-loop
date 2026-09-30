# Workflow Profiles — Phase 6: durable lifecycle, budgets, and enforcement

Phase 6 Steps 1–4 are implemented and locally verified for the commit that carries this document.
The exact-head CI record is appended in §7 once the run for that commit completes (append-only).

## 1. Scope delivered

- `src/ai/workflow-profiles/profile-budget.ts` — the single per-dimension budget contract
  (`SCHEMA_BUDGET_MAXIMA`, `effectiveWorkflowBudget`, `limitRunStatus`, `WorkflowBudget`).
- `src/ai/workflow-profiles/profile-run-state.ts` — versioned crash-safe run state, the file and
  memory stores, saved-dependency pins, the authority snapshot, the pending-effect marker, and
  `evaluateWorkflowProfileResume`.
- `src/ai/workflow-profiles/profile-access-guard.ts` — `narrowAccessPolicy`,
  `assertToolAccess`, `assertSideEffectAuthorized`, `detectAuthorityIncrease`,
  `assertNoAuthorityIncrease`.
- `src/ai/workflow-profiles/profile-events.ts` — the lifecycle event surface over the existing
  EventBus-shaped sink, scrubbed and best-effort.
- `src/ai/workflow-profiles/profile-kernel.ts` — budget handle/options/result wiring, duration and
  visit accounting, resume seeds (`usage`, `loopCounters`, `visitCount`), and the `limit` field that
  records which `onLimit` policy stopped the run.
- `src/ai/workflow-profiles/node-handlers.ts` — planner and reviewer consume one model call before
  delegating; the executor charges the `usage` it reports.
- `src/ai/workflow-profiles/profile-runner.ts` — the durable run path: the run record is written
  before any work, a stored run is re-verified before continuing, an exhausted `ask-user` limit stays
  resumable, and persistence/event failures are fail-closed or degraded as declared.
- Tests: `workflow-profile-budget.test.ts` (11), `workflow-profile-lifecycle.test.ts` (15),
  `workflow-profile-enforcement.test.ts` (10).

## 2. Durable state and resume (Step 1)

The record carries: `stateVersion`, run/profile identity plus `profileHash` (sha256 over the
canonical profile bytes), `schemaVersion`, `runtimeVersion`, the resolved dependency pins
(`kind`/`id`/`version`/`digest`), `status` (a terminal run status or `interrupted`, plus
`awaitingUser` for an `ask-user` pause), `currentNodeId`, `nodeSequence`, `visits`, `loopCounters`,
`budget`, the declared `authority` snapshot, `approvals`, the linked `planId`/`sessionId`, an optional
`pendingEffect`, and `updatedAtMs`. Writes go through the existing `atomicWriteFileSync`
temp+fsync+rename helper; the file name is a hash of the run id, so a run id can never escape the
store directory.

Before any work resumes, `evaluateWorkflowProfileResume` re-verifies profile id, profile hash, schema
version, runtime version, every dependency pin, and that the authority about to be granted is not
wider than the one recorded at start. Any mismatch returns `refuse-integrity` and **the run stops
before a handler can run or touch an effect**. `refuse-ambiguous-effect` and `already-terminal` are
returned for a pending uncommitted effect and for any terminal status. A resume re-enters the graph
at `currentNodeId` and seeds `usage`/`loopCounters`/`visitCount`, so no counter is ever reset.

**Recorded contract — an `ask-user` limit is a pause, not a terminal status.** The kernel reports
`limit: 'ask-user'`; the durable layer stores that run as `interrupted` with `awaitingUser: true` and
keeps every counter, so a later attempt may resume. Because the budget layers can only narrow, a
resumed attempt whose budget is still exhausted pauses again (idempotent, fail-closed) rather than
silently granting more calls; a caller that offers *wider* authority at resume is refused by the
authority check. `fail` and `handoff` remain terminal (`limitRunStatus`).

## 3. Budgets (Step 2)

`effectiveWorkflowBudget(profileLimits, ...layers)` returns the per-dimension **minimum** across the
profile, runtime, and user/session layers (and the schema maxima: 1000 visits, 86 400 s, 10 000 model
calls, 10 000 tool calls). A missing or non-finite layer value never widens a cap; budgets are never
added and never reset. The kernel enforces all four dimensions on the real path: duration is checked
at every transition through the injected clock, the visit cap blocks the next visit and reports the
Phase 4 code (`max-node-visits`, category `visit-cap`) while its status follows `onLimit`, and the
handler-facing `WorkflowBudgetHandle` (`consumeModelCall`, `consumeToolCall`) throws a terminal
`budget` error that no profile policy may retry or route. Planner and reviewer consume their model
call **before** delegating, and the executor charges the calls it reports after the real call — so an
overspend stops the run instead of being retried.

## 4. Enforcement at the call site (Step 3)

`narrowAccessPolicy` intersects tool sets (an absent layer cannot widen; `'*'` contributes nothing
without an explicit `knownToolUniverse`), folds budgets to the per-dimension minimum (a later wider
layer cannot raise anything), and takes the strictest approval policy, treating an unknown policy as
maximally strict. `assertToolAccess` is the call-site gate: the tool must be in the runtime-permitted
set *and* in the effective set, and an effective set that contains tools the runtime does not permit
is denied outright. `assertSideEffectAuthorized` requires the Runtime's own authorization **and**,
when the profile requires one, an approval whose status is `approved` and whose digest matches the
content the effect would act on — a digest-bound plan approval alone never authorizes a side effect.
`assertNoAuthorityIncrease` refuses any policy change (including a resume) that adds tools, raises a
cap, or weakens the approval policy.

## 5. Events and audit (Step 4)

`createWorkflowProfileEventEmitter` maps every kernel event onto the `workflow.*` lifecycle surface
(`run.start`/`run.end`, `node.start`/`output`/`error`/`retry`, `edge.select`, `loop.iteration`,
`loop.exhausted`, `route.error`) and adds `workflow.run.resume-refused`, `workflow.persistence.degraded`,
`workflow.budget`, and `workflow.approval`. Events carry ids, counters, codes, and categories only —
never goals, prompts, inputs, or profile text. Every string is passed through the existing
`scrubSecretValues` with the caller-declared secrets. A failing sink sets `degraded` and calls
`onDegraded` but never throws into the run; a failing **persistence** write is different on purpose:
it invalidates the durability guarantee, so it emits `workflow.persistence.degraded` and rethrows
(fail-closed) — the caller can never mistake an unwritten record for a committed one.

## 6. Evidence

- `npm run typecheck` and `npm run build` pass on Node v22.22.3.
- `npx vitest run src/ai/__tests__/workflow-profile` passes **14 files / 180 tests**: the 11 Phase
  2–5 suites (144) plus `budget` 11, `lifecycle` 15, `enforcement` 10.
- The full repository suite (`npm test`) reports **1,879 tests, 1,878 passing**; the only failure is the
  pre-existing, out-of-scope `phase-j-checkpoint.test.ts > J-05` mtime-tie finding already recorded in
  the Phase 2 closure (source and test untouched by this phase).
- Coverage of the acceptance criteria: restart-from-disk resume and fail-closed hash/version/dependency
  /authority mismatches (lifecycle), terminal/ambiguous-effect refusals and the `ask-user` pause,
  per-dimension minima, no-reset-on-resume and cap-raise refusal (budget), call-site denials,
  digest-bound side-effect authorization, strictest-policy folding, and pre-delegation charging
  (enforcement).
- This is local evidence for the commit that carries this document; the exact-head CI record for that
  SHA is appended in §7.

## 7. CI record (append-only)

### 2026-09-30 — run 36717190085 @ `2cdbd6a` (Phase 6 code head)

Result: **failure**, 7/10 jobs green: ubuntu 22/24/26, e2e ubuntu, e2e macos, e2e windows, and
**windows / node 24** (the job that failed for the Phase 5 head). Two jobs failed:

| Job | Failing test(s) | Annotation |
| --- | --- | --- |
| `macos-latest / node 22` | `src/cli/__tests__/cli.test.ts` — "Phase 23 — CLI: mcp + logs — logs --follow streams new entries as they are appended (followLog)" | `Error: followLog never emitted` (stream wait) |
| `windows-latest / node 22` | `src/cli/__tests__/phase-g.test.ts` — G-09, G-04, G-02 | `Error: Test timed out in 5000ms` (three tests) |

Both failing files are untouched by Phase 6 (`git diff 0bc9288..2cdbd6a -- src/cli` is empty), and the
failing tests differ from the four already recorded for the Phase 5 heads (`chat-mode.test.ts`
greeting, `server.test.ts` U1 parity, `u2-registry.test.ts` U2, `phase-g.test.ts` G-04) — the same
5000 ms-timeout and stream-wait signature now spans several runs, three jobs, and two operating
systems, with a different subset each time, while `macos-latest / node 24` and `windows-latest /
node 24` pass on this same commit. No Phase 6-caused failure is established from this evidence, and
this record does not claim a Windows/macOS-green run for the Phase 6 head: the Phase 4 exact head
(`506a6ec`) remains the last fully green run (10/10 on attempt 1).

## 8. Boundaries and open gates

- **Enforcement boundary.** The Phase 6 gates are implemented and unit-tested at the profile/adapter
  boundary (the guard functions plus the handler charging path). The live Orchestrator tool call site
  is *not* wired yet: no Orchestrator entry point exists, `HOOTL_WORKFLOW_PROFILE` stays off by
  default, and no profile is activated. Wiring the guards into the live tool/effect path belongs to
  the Runtime integration phase and is **not** claimed here.
- **Unknown / Requires Verification:** the existing stores persist *results*, not an
  intent/effect/commit journal, so a process that dies between an effect and its commit marker cannot
  be proven either way. The durable layer therefore never auto-retries a state that carries a pending
  effect. A real journal remains part of the Runtime compatibility/enforcement contract gate that is
  still open before Runtime integration.
- **Resume input contract.** The kernel deliberately keeps no cross-run handler input state, so a
  resumed attempt supplies the entry input for `currentNodeId` from the host; a missing required port
  still fails closed at the node's contract check.
- Merge remains frozen until all phases are complete (owner instruction, 2026-09-30); PR #9 stays
  Draft. Phases 7–10 are still 🔴.

### 2026-09-30 — run 36717860718 @ `2482b6e` (documentation commit for the record above)

Result: **failure**, `windows-latest` only — `/ node 22` failed on `v2717-chat-mode.test.ts`
("answers a greeting", `Hook timed out`), `u2-registry.test.ts` (U2, `Test timed out in 5000ms`) and
`phase-g.test.ts` (G-04, `Test timed out in 5000ms`); `/ node 24` failed on `phase21.test.ts`
(PERF-04, "writes 1000 events in < 100 ms") and `phase19.test.ts` (Law 16, timeout). All of these
files are untouched by every phase of this work (`git diff ee3fa3f..2482b6e -- src/ai/__tests__/
src/server/__tests__ src/cli/__tests__` only shows the new `workflow-profile-*` suites), and the
combined evidence across the runs recorded here — a different job, operating system, and test each
time, always a 5000 ms test/hook timeout or a wall-clock performance assertion, never the profile
suites — is consistent with runner-performance flakiness rather than a branch defect. No
Windows-green run exists for the Phase 5/6 heads; the Phase 4 exact head (`506a6ec`) remains the last
fully green run.
