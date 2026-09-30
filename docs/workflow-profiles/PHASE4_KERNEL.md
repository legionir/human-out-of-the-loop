# Workflow Profiles — Phase 4: workflow graph engine and bounded control-flow

**Status:** 🟢 implemented and locally verified (2026-09-30). Phase 4 delivers the deterministic, handler-agnostic kernel and the opt-in access path only. No model or tool is executed, no plan step is scheduled, no Runtime authorization decision is made, and no user-facing entry point enables profiles: the feature flag defaults to off and handlers arrive in Phase 5.

## 1. Scope delivered

| Phase 4 step | Implementation | Tests |
|---|---|---|
| Step 1 — explicit state machine and first-match edge selection | `src/ai/workflow-profiles/profile-kernel.ts` | `src/ai/__tests__/workflow-profile-kernel.test.ts` |
| Step 2 — data-only predicate evaluation | `src/ai/workflow-profiles/profile-predicate.ts` | `src/ai/__tests__/workflow-profile-predicate.test.ts` |
| Step 3 — bounded loops and the node-visit cap | `profile-kernel.ts` (loop counters, `effectiveMaxNodeVisits`) + semantic validator static bound | kernel suite (overlapping-loop and runaway-cycle cases) and semantic suite (saturating bound, counter collisions) |
| Step 4 — typed error/retry/route contract | `profile-kernel.ts` (`WorkflowNodeError`, `TERMINAL_FAILURE_CATEGORIES`, sanitized envelope) | kernel suite (retry/exhaustion/route/terminal categories) |
| Step 5 — feature flag and safe availability | `src/ai/workflow-profiles/profile-runner.ts` | kernel suite (flag describe block) |

`profile-predicate.ts` is the **single** predicate/port-domain implementation shared by the semantic validator (static) and the kernel (runtime); the validator now imports the same `ABSENT`, `predicateMatches`, `readPort`, `domainFor`, and `routingDomainFor` helpers instead of duplicating them.

## 2. Control-flow contract implemented

- **State machine:** start → dispatch handler (or compute a condition/end node) → validate outputs against declared ports → select exactly one edge → transition. Every transition re-checks cancellation and the visit cap.
- **First-match selection:** conditional edges are ordered by ascending `priority` (default 100), then declaration order; the first true predicate wins even when later predicates also match. A single explicit `default` edge is used only when no conditional edge matched. Duplicate defaults and a missing match/default both fail closed (`route.multiple-defaults`, `route.missing`). Ambiguity is never an error.
- **Typed mapping:** normal-edge and error-route mappings are one-level pointers into the source outputs / sanitized failure envelope. An undeclared target port, a missing value for a required target port, and a value that violates the target port type each fail closed (`route.target-port-missing`, `route.required-input-missing`, `route.input-type-mismatch`).
- **Data-only predicates:** eleven operators over one declared top-level port. Malformed pointers, missing ports, `null`, arrays, objects, non-finite numbers, and type-incompatible values follow the recorded semantics below; no expression string, `eval`, or executable conditional exists anywhere in the kernel.
- **Bounded loops:** each `loop` edge owns one run-scoped counter; one iteration is exactly one successful traversal of that edge. Counters are monotonic and never reset by retries or by other loops. Exhaustion is evaluated when the loop edge is traversed: `fail` terminates with `loop.exhausted`, `route` performs the declared transition through the same typed mapping path. Loops may share nodes (overlapping cycles) and each counter saturates on its own bound.
- **Hard visit cap:** the effective cap is the strictest of the schema maximum (1,000), `policies.execution.maxNodeVisits`, and the runtime-supplied cap. It is enforced on every transition, independently of the semantic validator's conservative static bound (`|nodes| × Π(1 + maxIterations)`, saturating arithmetic), so a nested, overlapping, or mis-analysed cycle cannot run away. The cap counts *allowed* visits: `visits` in the result never exceeds the cap, and blocking the next visit terminates the run with `max-node-visits` (`visit-cap`).

### Recorded execution semantics (consequences of the approved contract; no new owner decision)

1. A successful retry attempt clears the failure recorded by the previous attempt; the node continues with its fresh outputs instead of inheriting the earlier failure.
2. The visit cap blocks the *next* visit and reports the visits actually performed, so `result.visits === effectiveMaxNodeVisits` when a run is stopped by the cap.
3. Exhaustion of a loop is observed on the loop edge itself. Because first-match selection is unchanged, a run may reach the loop's target once more through another already-matching edge before the exhausted edge is traversed; the loop edge then routes or fails without incrementing the counter. The kernel tests assert this behaviour explicitly instead of assuming a shorter sequence.
4. Terminal failure categories are `security-denied`, `approval-denied`, `cancelled`, `visit-cap`, and `budget`. They are never retried and never routed, even when a profile's `onError` policy names them (covered by regression tests).

## 3. Typed error / retry / route contract

- `WorkflowNodeError` classifies handler failures; unknown errors become `handler.error` (`handler` category, not retryable).
- `retry` repeats only categories listed in `retryOn`, only for retryable failures, up to `maxAttempts` (including the first invocation), with a fixed backoff applied through an injectable `sleep` so tests stay deterministic. Exhaustion fails the run with the last failure.
- `route` transfers directly to `routeTo` and maps only the sanitized envelope: `failure.category`, `failure.code`, `failure.retryable`, `node.id`, `node.attempt`, and a snapshot of `inputs.<port>`. Raw exception text is never exposed to a node, an event, or a result (asserted by a regression test that rejects the message string anywhere in the run result).
- Route transitions are independent of normal edges but still participate in reachability, budget, and cycle analysis through the semantic validator.

## 4. Feature flag and availability (Step 5)

- `HOOTL_WORKFLOW_PROFILE` is off unless set to exactly `1` or `true`; while it is off, `isWorkflowProfileExecutionEnabled()` is false, `prepareWorkflowProfileRun()` throws `WorkflowProfileLoadError` with `profile-flag.disabled`, and legacy behaviour is untouched.
- `prepareWorkflowProfileRun()` runs the full pre-execution pipeline — schema-version check → structural validation → semantic validation → dependency resolution — and returns a frozen, registered profile handle plus `run()`. Invalid, unsupported, unknown, or unresolvable profiles are rejected *before* any handler dispatch (`profile.missing`, `schema-version.unsupported`, and pass-through structural/semantic/resolver diagnostics).
- The kernel exposes no public entry point of its own: it takes handlers as arguments, so no code path can reach model/tool execution without an explicit host opt-in in Phase 5/6.

## 5. Evidence

Commands (repo root, Node v22.22.3):

- `npm run typecheck` → pass; `npm run build` → pass.
- `npx vitest run src/ai/__tests__/workflow-profile-*.test.ts` → **7 files, 103 tests passed** (kernel 16, resolver 16, semantic 27, registry 21, schema 11, predicate 8, MCP-ID 4).
- `npm test` (full repository) → 128 files / 1,802 tests: **1,801 passed, 1 failed**. The single failure is the pre-existing, out-of-scope `phase-j-checkpoint.test.ts > J-05` mtime-tie finding recorded in the Phase 2 closure; `src/ai/runtime/checkpoint.ts` and that test are untouched by this phase.

Kernel coverage: linear graph and end-result emission; first-match by priority and declaration order; default fallback; loop bound, exhaustion routing, fail-closed exhaustion, monotonic counters; overlapping/nested loops with two independent counters; a runaway cycle stopped by the runtime hard cap; retry counting and exhaustion; non-matching and non-retryable failures; security/approval denial escaping retry *and* route; sanitized route envelope; output type/required validation; unknown node kind fail-closed; cancellation; the flag's default-off/opt-in behaviour; and pre-dispatch rejection of invalid, unsupported, and unknown profiles. Predicate coverage: pointer shape, missing/absent ports, `null`, strict scalar identity, objects/arrays, membership, ordering, substring matching, unknown operators, and port domain/type helpers.

## 6. Boundaries and open gates

- No node handler, model/tool call, approval interaction, persistence, resume, budget enforcement, observability-to-EventBus wiring, or Orchestrator integration is part of Phase 4; those are Phases 5–7.
- The kernel is not a parallel scheduler: it owns only the outer control graph and never schedules plan steps (PlanRuntime remains the sole inner DAG scheduler, per D-WP-008).
- `inheritance`, `Node Templates`, `Sub-workflows`, `recursion`, `parallelism/fan-out/join` remain excluded from v1 and are not implemented.
- Pre-Runtime-integration gates recorded earlier remain open: trusted host code must guarantee stable, trusted, non-attacker-writable profile roots, and the authoritative Workflow Runtime compatibility/enforcement contract is still undefined (`profile.runtime` stays syntax-only metadata).
- Budget dimensions other than node visits (`maxDurationSeconds`, `maxModelCalls`, `maxToolCalls`) are declared in the schema and checked statically, but their real enforcement, together with cancellation propagation into active handlers, belongs to Phase 6.
- Per the owner instruction of 2026-09-30 no merge happens until every phase is complete; this phase is a separate commit on the working branch so per-phase review remains reconstructable at handoff.
