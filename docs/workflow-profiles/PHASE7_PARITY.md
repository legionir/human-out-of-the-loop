# Workflow Profiles — Phase 7: default profile and current-behaviour parity

Phase 7 models the current HOOTL flow as a default profile, wires it behind the existing flag, and
proves parity. This document is the **Step 1 extraction record**: the flow is derived from the code
and the test suites, not from prose. It also records the two gaps that Step 1 cannot close without an
owner decision; Step 2 (Orchestrator wiring) is blocked on the first of them.

Status: Phase 7 is 🟡 — extraction complete, profile artifact blocked on D-WP-014.

## 1. Extracted current flow (work path)

Source: `src/ai/orchestrator.ts` (`run` at 1031, `runInSession` at 1078), `src/ai/planning/*`,
`src/ai/runtime/*`, and the characterization suites `c4-clarification`, `clarification-fidelity`,
`r1-01-answer-after-clarify`, `r1-10-resume-model-and-state`, `phase-b-orchestration`, `phase15`,
`phase18`–`phase22`, `phase27`, `phase31-faults`.

| # | Stage | Implementation | Observable behaviour (test-anchored) |
| --- | --- | --- | --- |
| 0 | Entry | `run()` 1031–1074 | session created or resumed (404 for unknown), interaction recorded, session history attached to the planner, run context (budget/usage) opened, interaction marked live, `finally` closes it |
| 1 | Planning assessment | `planner.plan` | outcomes are `plan`, `answer`, or unclear + questions (`clarification-fidelity`: declared field, aliases kept, dedupe, never empty when unclear) |
| 1a | Answer branch | `answerRun` | a conversational request is answered with read-only tools, the interaction is `answered`, **no plan and no confirmation** |
| 1b | Escalation | `[[NEEDS_PLAN: true]]` | an answer that asks to be planned becomes a plan; the answer text is the fallback if the plan turns out infeasible |
| 2 | Clarification loop | 1092–1290 | with a callback: answers folded into the request, `plan:clarified` logged, re-plan; `null`/decline ⇒ run cancellation; rounds exhausted ⇒ failure stating how many rounds ran; default `maxClarificationRounds` = 3; without a callback: legacy failure carrying the questions (planner hit once) |
| 3 | Feasibility / cycle gate | `planning/feasibility-gate.ts`, `cycle-detector.ts` | duplicate ids, dependency cycles and unusable plans are rejected **before** execution; on an escalated answer the fallback answer is shown instead of the raw gate error |
| 4 | Plan persistence + link | 1389–1420 | plan and session link written **before** execution; plan stored as `draft` so the pending confirmation is visible; the run's model is remembered for a later resume (`r1-10`) |
| 5 | Plan confirmation (the single human interaction) | `confirmCallback` 233–240, 1569 | the user sees the plan text and answers confirmed / cancelled / feedback; **only feedback re-plans** (bounded by `maxReplanningAttempts`); a cancel or empty-feedback rejection ends the run |
| 6 | Execution | `PlanRuntime.execute` | per-step agents from `step.assignedPersona`/`assignedSkills`/`assignedTools` (`plan-runtime.ts` 395–410), acceptance checker per step (`acceptance-checker.ts`, persona `judge` when present else `reviewer`), automatic re-planning on failure, step/plan events translated into the log and journal, rate limiter applied |
| 7 | Cancellation | `CancellationManager` | Ctrl-C/shutdown/TTL/operator cancel reaches the active runtime, the plan is closed, the run terminates without further work |
| 8 | Review + report | `final-reviewer.ts` (persona `reviewer`, 183) | final review over the plan's accepted/rejected steps, `success`/`rejected`/`failed-partial` outcome, review summary + final summary + report text, interaction completed |

Prompts: planning uses persona `planner` (`planner.ts` 743, `plan-generator.ts` 31), review uses
persona `reviewer` (`final-reviewer.ts` 183) and `judge` if the registry has it
(`acceptance-checker.ts` 155). Execution has **no single executor persona**: every plan step carries
its own `assignedPersona`.

## 2. Mapping to profile constructs

| Flow stage | Profile construct | Notes |
| --- | --- | --- |
| 0 Entry | outside the profile | session/interaction/observability stay the entry point's job; the profile runs inside a session |
| 1 Planning assessment | `planner` node | outcomes `plan` / `answer` / `clarification` map to output ports; the answer branch is a route to an `end` node (see gap G-2) |
| 2 Clarification | `approval` node with `responseKind: text` + edge back to `planner` with a bounded `loop` | the sample already models this; the round limit maps to `loop.maxIterations` |
| 3 Feasibility / cycle gate | inside the `planner` delegation | `PlanRuntime` remains the sole inner-DAG scheduler and validator; the profile must not re-implement it (Phase 1 D-WP-009) |
| 4 Plan persistence + link | outside the profile | `PlanStore`/`SessionStore` keep owning their formats; nothing new is persisted by the profile |
| 5 Plan confirmation | `approval` node with `approvalType: side-effect`, `bindsTo: plan`, digest check | D-WP-004/D-WP-013 already implemented: the digest of the displayed plan is bound and re-checked before continuing |
| 6 Execution | `execute` node | delegated as one call to `PlanRuntime.execute`; per-step retry/re-plan, acceptance, rate limit and tool policy stay inside the runtime |
| 7 Cancellation | kernel `signal` + `cancelled` terminal category | already implemented (Phase 4/6); cancellation is never routed or retried |
| 8 Review + report | `review` node + two `end` nodes (`success`/`rejected`) | rubric `hootl.default-review` is the built-in rubric; the final report stays the runtime's |

## 3. Gaps

### G-1 (blocking, owner decision D-WP-014): the `execute` binding

v1 requires `bindings.personaRef` on every `planner`/`execute`/`review` node (schema `$defs/node`
`allOf[0]`), and the resolver pins that persona as a dependency. The current flow has:

- `planner` persona — exists in `registry/personas/planner.json` and **is** what the runtime uses;
- `reviewer` persona — exists and **is** what the final review (and acceptance, as fallback) uses;
- executor — **no single persona**: `plan-runtime.ts` builds each step's agent from
  `step.assignedPersona`, and `agent-factory.ts` throws when a persona id is missing, so there is no
  runtime default to point at.

Consequences: a default profile that binds an arbitrary existing persona for `execute` would claim a
behaviour the runtime does not have; authoring a new `hootl.executor` persona duplicates the runtime's
step prompt into registry content; making `personaRef` optional for `execute` is a v1 contract change.
This document does not guess: D-WP-014 asks the owner which of the three is approved before Step 2
wires the default profile.

**Resolved (D-WP-014, owner decision 2026-09-30; append-only):** the owner approved the
standards-conformant contract change: `execute` nodes may declare
`bindings.personaSource: "plan-step"` instead of a pinned `personaRef`, meaning "the runtime assigns
each plan step's persona". The JSON Schema, the type and the semantic validator were extended
(planner/review still require `personaRef`; exactly one of the two is required on `execute`; the
source value is a closed single-value domain, and declaring `personaSource` on any other node kind
is rejected). No registry content was added, so nothing duplicates the runtime's step prompt, and the
binding grants nothing: it only tells the executor where its persona comes from. The default profile
artifact built in Step 1 uses it for the `execute` node.


### G-2 (non-blocking, recorded): the answer/conversation branch

The current flow answers conversational requests without any plan (`answerRun`). A v1 profile can
express this as an `intake`/`planner` route to an `end` node, but the answer path uses read-only tools
and marks the interaction `answered` (not `success`). Phase 7 therefore has to decide whether the
default profile models the answer branch or only the work branch, and record it as an intentional
difference with its parity test. Recorded here; no decision needed until Step 1's artifact is built.

### G-3 (recorded, resolved by design): delegated checks

Feasibility/cycle validation, per-step acceptance, re-planning and rate limiting stay inside the
runtime's delegation; the profile must not re-implement them. This is the Phase 1 seam decision
(D-WP-009) and is not a gap in behaviour — it is a deliberate boundary with a parity assertion.

### G-4 (resolved in this step): tool surface declaration

No named toolsets ship in the repository (`registry/toolsets/` does not exist and `ToolsetRegistry`
has no production registration path), while `policies.tools.allowedToolsets` is required and may be
empty. The runner's authority snapshot now derives the profile's declared tool surface from the
**content** of its pinned personas/toolsets and treats "no toolsets declared" as "no narrowing"
instead of "permit nothing"; `allowedToolsets: []` plus omitting `toolsetRef` is therefore a valid,
non-widening default. Covered by a lifecycle test.

## 4. Parity plan (Step 3 preview)

Characterization/golden tests will drive the same inputs through the legacy path and the profile path
and compare the observable surface: clarification rounds and answers, plan confirmation text and
outcome, execution order (step ids/statuses), retry/re-plan counts, acceptance failures, cancellation
termination, the final report fields, and the tool authorization decision for a denied tool. Plan and
session data compatibility is structural rather than a migration: the profile path reuses
`PlanStore`/`SessionStore` unchanged, and a legacy-created plan/session must load, list, resume and
cancel identically (tests planned in Step 3; no new store format is introduced by this phase).

## 5. Step 1 artifact (append-only, 2026-09-30)

`createDefaultWorkflowProfileDocument(sources)` in `src/ai/workflow-profiles/default-profile.ts` is the
artifact. It is built in code, not shipped as JSON, so every dependency pin is the digest of the
component content the caller actually resolved — a missing persona or rubric throws
`WorkflowProfileLoadError` (`default-profile.component-missing`) instead of yielding a profile with a
placeholder pin. `planner` and `reviewer` are pinned by reference; `execute` uses
`bindings.personaSource: "plan-step"` (D-WP-014).

Graph (nine nodes, nine edges): `request` → `plan`, then three exhaustive routes on the planner's
required `kind` discriminator — `plan` → `confirm`, `answer` → `answered`, `clarify` → `clarify`;
`clarify` → `plan` (loop `clarification-rounds`, `maxIterations: 3`, `onExhausted: fail`, i.e. three
questions, matching `maxClarificationRounds`); `confirm` → `execute` (single explicit `default` edge:
an approval node only produces a decision after the user approved, while a denial, cancellation or
digest mismatch fails the node); `execute` → `review`; `review` routes its decision domain
(`pass` → `finish`, `revise`/`reject` → `rejected`).

Recorded choices and their reasons:

- **The confirmation binds `planText`, not the plan object.** `bindsTo` must name a declared input
  port of the approval node; the port whose digest is bound is the text the interaction displays
  (`show: ["planText"]`), which is what D-WP-004/D-WP-013 make the user's acknowledgement mean.
  The same `planDigest` (computed by the planner handler from that text) is threaded to `execute`, so
  the execution delegation is handed exactly the digest that was approved.
- **`review` must accept the digest-pinned rubric's whole domain.** The Phase 3 resolver gate
  compares `config.allowedDecisions` with the rubric's `decisions` and the built-in
  `hootl.default-review` mirrors the existing review contract (`pass`, `revise`, `reject`), so the
  node declares all three. `revise` and `reject` both end at `rejected`: the current flow does not
  re-execute after the final review, and the kernel has no `failed-partial` status, so a partial
  success is reported rather than re-run. The decision itself stays visible in the review output.
- **Budgets.** `maxNodeVisits: 40` covers the conservative static bound (|nodes| × (1 + 3) = 36) with
  headroom; `maxDurationSeconds: 3600`, `maxModelCalls: 500`, `maxToolCalls: 2000` are deliberately
  generous so the profile never cuts a legitimate current-flow run short. Runtime and session layers
  can only tighten the effective values, and a resume never resets a counter.
- **Tool surface.** `policies.tools.allowedToolsets: []` adds no narrowing (drives the G-4 fix);
  effective tools stay runtime ∩ persona ∩ step.

Intentional differences from the current flow, to be recorded in the plan, the release notes and the
owner's approval before any default activation (Step 3):

- **G-5 — confirmation feedback cannot re-plan in v1.** `bindsTo` is only legal with
  `responseKind: "decision"`, whose required output port is an object, while v1 predicates address
  exactly one top-level port of scalar type; the approval node therefore has no routable scalar, and
  the kernel's error routes are terminal-by-contract for approval denials (they cannot be retried,
  routed, or made into a bounded loop). A denial with feedback ends the run fail-closed exactly like
  a cancellation. The bounded clarification loop still models the re-plan that follows an answered
  question, and the runtime's per-step re-planning inside `execute` is untouched.
- **G-2 — the answer branch ends `success`.** The interaction status `answered` is the entry point's
  job (stage 0 stays outside the profile). A planner that reports `answer` without text ends the run
  with no response value — the same degenerate outcome the current flow has for an empty answer —
  instead of executing work.

Evidence for this step: the new suite `src/ai/__tests__/workflow-profile-default-profile.test.ts`
(11 tests: structure/semantics/resolution, closed-profile failure, plan branch order, answer branch,
clarification round-trip and exhaustion, reject and revise terminals, out-of-domain decision,
cancellation, digest mismatch, denial) passes; all Workflow Profile suites pass 15 files / 194 tests;
`npm run typecheck` and `npm run build` are clean. Step 2 (Orchestrator wiring) and Step 3 (parity
tests, including the tests that pin the two differences above) are next.

## 6. Step 2 activation seam (append-only, 2026-09-30)

`activateWorkflowProfile(options)` in `src/ai/workflow-profiles/profile-activation.ts` is the single
decision point the Orchestrator will call:

- **Flag off** (or `HOOTL_WORKFLOW_PROFILE` set to anything but `1`/`true`) ⇒
  `{ kind: 'legacy' }`, decided *before* any component lookup, schema check or dependency resolution.
  No profile-related module work happens, so the legacy path is byte-for-byte the one that runs today.
- **Flag on** ⇒ never legacy. An explicit selection (`document` or a registered profile, D-WP-003's
  highest precedence) is validated, resolved and prepared, or the caller gets a `WorkflowProfileLoadError`
  carrying the diagnostics. Nothing selected and no opt-in ⇒ `profile-activation.not-selected`.
- **Built-in default** is gated by a recorded approval (`BUILT_IN_DEFAULT_APPROVAL`, currently
  `approved: false` with its reference). While it is unapproved, asking for the default fails closed with
  `profile-activation.not-approved` — and does so *before* touching the registries, so an unreadable
  registry can never be confused with a missing approval. Flipping the constant is a recorded change
  that must land with the Step 3 parity evidence, the release notes and the owner's approval.

Evidence: `src/ai/__tests__/workflow-profile-activation.test.ts` (8 tests) covers the flag values, the
"flag off resolves nothing" proof (a counting registry is never touched), the not-selected and
not-approved refusals (also proven registry-free), explicit selection, approved-default preparation,
the schema-version refusal (no fallback) and a dependency-resolution refusal. The Orchestrator hook
(Step 2's second half) follows in the same step.

## 7. Step 2 run bridge and component sources (append-only, 2026-09-30)

Two more Step 2 pieces landed, both fail-closed and mutation-free:

- **`runWorkflowProfileBridge(prepared, options)`** (`src/ai/workflow-profiles/orchestrator-bridge.ts`)
  runs a prepared profile against the existing services — `Planner` through the Phase 5 planner port,
  `PlanRuntime` as the sole inner-DAG scheduler, the `FinalReviewer` (or `AcceptanceChecker`) for the
  review node, and the existing confirm callback for approvals. Boundaries it enforces: the `onPlan`
  hook fires the moment a plan exists and *before* anything executes, so the caller keeps its existing
  `PlanStore`/session-link writes; usage accounting stays inside the services the Orchestrator built;
  the caller's service objects are never mutated (capture views are new objects); a missing service
  fails closed (`approval.service-missing`, `reviewer.service-missing`) instead of substituting a stub.
  The final review is built from the bridge's captured plan/execution context — the profile hands the
  review node only the execution summary — and `reviewerOutcomeFromReview` maps
  `success`/`partial-success`/`failure` onto `pass`/`revise`/`reject` while keeping a cancelled run a
  terminal cancellation. Because the kernel reports a cancellation *category* on a failed node while
  reserving run status `cancelled` for the abort signal, the bridge normalizes
  `failure` + category `cancelled` to status `cancelled`, so the caller maps exactly one cancellation
  outcome.
- **`createWorkflowProfileComponentSources(registries)`** (`src/ai/workflow-profiles/profile-sources.ts`)
  wires the live persona/skill/model-config/toolset/rubric registries into the resolver's component
  sources, returning defensive copies (a caller cannot change registry state through the profile
  layer, and a pin cannot be invalidated by later mutation) and `undefined` for unknown ids so the
  resolver reports `dependency.missing` instead of substituting content. The rubric source defaults to
  the code-owned built-in catalogue; no toolset registry ships, so toolsets resolve to nothing (G-4).

Evidence: `workflow-profile-bridge.test.ts` (6 tests: plan branch with the persistence-before-execution
order, answer branch, denied confirmation, missing approval service, missing reviewer, cancelled
execution) and `workflow-profile-sources.test.ts` (5 tests: resolution, enumeration, unknown ids,
defensive copies, stable pins, built-in rubrics). All Workflow Profile suites: **18 files / 213 tests**;
typecheck and build clean.

**Still to do in Step 2:** the Orchestrator hook itself (`OrchestratorConfig.workflowProfile`,
activation before any session/interaction side effect, the interaction/`OrchestratorResult` mapping),
which is the next change; the plan keeps Step 2 🔴 until it lands.

