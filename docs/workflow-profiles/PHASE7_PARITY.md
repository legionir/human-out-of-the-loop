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
