# Workflow Profiles — Phase 1 Baseline & Decision Register

**Status:** 🟡 Phase 1 in progress; implementation is intentionally stopped before Phase 2 until the owner decisions below are resolved.
**Baseline:** `main` at `ff7c030afaa20b8a343cdb090b3b2db16384279e` (2026-09-29).
**Scope:** discovery, design traceability, and a reversible architecture spike only. No Runtime code or existing behavior changed in this phase.

## 1. Branch, PR, and CI baseline

| Item | Verified state |
|---|---|
| Default branch | `main`, HEAD `ff7c030afaa20b8a343cdb090b3b2db16384279e` |
| PR #5 | merged; prompt-construction refactor, merge commit `b9a80176fc849ba84be03743c86cceaf03dbca2f` |
| PR #6 | merged; Persona/Skill library and registry importer, merge commit `f36d513c2a2ff3213d71641beb218cd4ec7da27b` |
| PR #7 | merged; profile schema/examples/plan and importer docs, merge commit `ff7c030afaa20b8a343cdb090b3b2db16384279e` |
| Open PRs | none observed at baseline check |
| Dependency conclusion | #5/#6 are already in the base. No rebase or PR merge is needed for Workflow Profiles. Their prompt and registry contracts must be consumed as-is; this work does not revise them. |
| Phase delivery | separate branch and reviewable PR per phase; Phase 2 must base on the Phase 1 merge commit. No direct `main` edits; no phase-skipping or multi-phase mega-PR. |

**CI evidence (not a local test claim):** GitHub Actions CI run `36577591299` on this exact `main` SHA completed with failure. Ubuntu Node 22/24/26, macOS Node 22/24, and all three E2E jobs passed. Windows Node 24 and Node 22 unit/integration jobs failed. The logs include PERF-04 timing assertions (about 834 ms / 736 ms against a 500 ms threshold), Windows Node 24 G-04/G-18 timeouts, and Windows Node 22 failures/timeouts in `phase27`, `cli`, `phase30-p10`, `phase-h`, and `u3-run-options` tests. Attribution (regression vs platform/timing flake) has not been established; do not call these baseline failures fixed or unrelated. Typecheck and install completed before the unit-test failures; later steps were skipped in those jobs.

Commands declared by `package.json`: `npm test` (`vitest run`), `npm run typecheck`, `npm run build`, `npm run e2e`; no lint script is defined. CI uses `npm ci`, `npx tsc --noEmit`, `node scripts/ci-test.mjs`, build/install/CLI smoke, and `node e2e/scenarios/run.mjs`. The evidence above is from the actual CI run on main; no local full-repository test run is claimed.

## 2. Existing architecture and trust boundaries

- **Entry points:** CLI `src/cli/commands/run.ts`; server `src/server/routes/preview.ts` and `src/server/routes/run.ts`. Preview plans without side effects; run starts `Orchestrator.run`. The server supports clarification/confirmation callbacks and cancellation; interactive waiting uses in-memory resolvers plus a TTL.
- **Planning:** `src/ai/planning/planner.ts` produces the existing `Plan` contract from `src/ai/schemas/plan.ts`; `feasibility-gate.ts` and `cycle-detector.ts` validate it; `plan-confirmation.ts` formats the explicit plan confirmation required by Law 17.
- **Execution:** `src/ai/runtime/plan-runtime.ts` accepts a confirmed `Plan`, schedules ready `PlanStep`s according to `dependsOn`, delegates tasks to `TaskRuntime`/`AgentRuntime`, and owns acceptance checks, bounded re-planning, cancellation, and resume. This DAG is the inner execution graph and must remain intact.
- **Lifecycle/storage:** `Orchestrator` owns intake through plan creation, feasibility, confirmation, execution, review/report and session lifecycle. `PlanStore`/`SessionStore` have memory and file-backed implementations; PlanRuntime exposes execute/resume/cancel. Existing cancellation and resume semantics are runtime-owned.
- **Registries:** `registryLayersFor()` loads package then project registries; project entries override matching package IDs. Existing JSON entries are validated with Zod. Persona and Skill IDs are lowercase alphanumeric/underscore/hyphen; ToolDefinition has the same ID pattern. `Persona.allowedTools` is an execution policy. Tool metadata and executable implementations are separate in `ToolRegistry`.
- **Trust:** current project trust is persisted in global config or process scope and gates project MCP/command configuration. It does not yet define Workflow Profile discovery, default-profile override, or approval/budget-policy precedence.
- **Versions:** Skill entries have a `version`; Persona and ToolDefinition schemas do not. The current registry entry shape therefore cannot uniformly satisfy the Profile contract's exact-version/digest references without a deliberate version/integrity design.

## 3. Read-only architecture spike: outer workflow vs inner Plan DAG

**Finding:** the intended two-graph model is sound only if the outer workflow delegates into the current lifecycle. The existing `Orchestrator.run()` is a composite call; it does not expose stable public `intake → plan → review` stage handlers. `PlanRuntime.execute(plan)` is not an outer workflow API: it runs the inner Plan DAG after confirmation and owns its existing task scheduling/replan/cancel/resume behavior. The server's current waiting resolvers are in-memory and not a durable general approval/resume contract.

**Safe boundary:** Workflow Profile may select/sequence coarse lifecycle stages; each `execute` stage must hand one confirmed Plan to the existing PlanRuntime, which alone schedules its DAG. Preserve Orchestrator ownership of Law 17 confirmation, review, cancellation, persistence, resource locks, and existing status semantics. A Profile kernel that calls whole `Orchestrator.run()` as several node handlers cannot reliably separate those stages; a parallel task scheduler or flattened Plan DAG is rejected.

**Required architecture choice before Phase 4/5:** expose a narrow staged facade from Orchestrator that delegates to existing services, with PlanRuntime still the sole inner DAG scheduler, or stop and revise the Profile contract. The facade does not exist on baseline main. No Workflow Profile runtime/feature flag exists in the reviewed code; `HOTL_NO_PACKAGE_REGISTRY` is a registry-layer switch, not a profile execution gate. The plan's future Profile flag must be newly added and default-off.

## 4. Version-1 contract carried forward

The merged schema and execution plan define a JSON-only declarative profile, seven node kinds, no inheritance/templates/sub-workflows/parallelism, top-level port references only, first-match routing (priority ascending then declaration order; default only as fallback; otherwise fail-closed), bounded loops, typed fail/retry/route policies, explicit end emits, and monotonic Runtime authorization/approval/budget constraints. The schema is a design artifact only: no loader, semantic validator, handler, or Runtime execution path exists yet. Schema validation must remain distinct from semantic graph validation and tool-call authorization.

## 5. Decision / Unknown Register

Owner for product/security choices: **Pouya Rahimi**. Until approved, each item is 🟡 and the dependent step is blocked; recommendations below are proposals, not decisions.

| ID | Decision / unknown; evidence | Recommendation to decide | Owner / required before |
|---|---|---|---|
| D-WP-001 | Schema/validator integration: package uses Zod; canonical artifact is JSON Schema Draft 2020-12; no JSON Schema validator dependency is present. | Keep JSON Schema authoritative; consume Draft 2020-12 in a dedicated validator (e.g. Ajv) and keep semantic checks separate in TypeScript. Approve dependency/diagnostic approach. | Pouya / Phase 2 Steps 1–2 |
| D-WP-002 | Registry versioning: Skill has a version, Persona/ToolDefinition do not; current registries have no uniform digest contract. | Approve immutable per-entry version+digest (or another explicit pinning format) before resolving exact dependencies; do not invent version values from mutable files. | Pouya / Phase 2 Step 3 and Phase 3 Step 1 |
| D-WP-003 | Project profiles and precedence: project registry overrides package entries; existing trust gates only selected executable project config. | Package default remains non-overridable implicitly; a project profile is untrusted and only usable through explicit selection plus trust/opt-in; effective policies can only tighten. Approve discovery/opt-in semantics. | Pouya / Phase 2 Step 3 |
| D-WP-004 | Approval node vs Law 17: current behavior confirms the full plan before execution and then runs without further human messages; server confirmation wait is in-memory. | Decide whether v1 approval is only the existing pre-execution confirmation (and remove/defer mid-run approval semantics) or whether durable pause/resume changes the product contract. Do not silently create a second approval model. | Pouya / Phase 2 Step 1 and Phase 5 Step 3 |
| D-WP-005 | Budget composition: `BudgetTracker` tracks token/USD limits and PlanRuntime/AgentRuntime also have independent limits, rate limits and call limits. | Define an immutable run-level effective cap as the strictest applicable limit, with counters shared across loops/retries; no profile reset or increase. Confirm dimensions and ownership. | Pouya / Phase 2 Step 1 and Phase 6 Step 2 |
| D-WP-006 | MCP tool IDs: local ToolDefinition validates `^[a-z0-9_-]+$`; MCP IDs are `toolPrefix + raw server tool name`, then validated by the same schema. Raw MCP names/prefixes are not normalized here. | Audit real MCP names and define a compatibility-safe canonical ID/alias rule before freezing Profile `toolId`. | Agent verification with Pouya sign-off / Phase 2 Step 1 and Phase 3 Step 2 |
| D-WP-007 | Profile byte cap: current generic registry loader reads each file fully before parsing and exposes no byte limit. | Measure representative registry/profile sizes and parsing cost; set an explicit, tested Profile byte cap before adding a loader. No guessed cap. | Agent verification / Phase 2 Step 1 |
| D-WP-008 | Outer/inner graph seam: no staged Orchestrator facade exists; PlanRuntime owns the inner DAG. | Approve the narrow Orchestrator-stage facade described in §3, or stop and revise the architecture. Never duplicate the Plan scheduler. | Pouya / before Phase 4 Step 1 and Phase 5 Step 1 |

## 6. Initial requirement traceability (tests are targets, not implemented)

| Requirement | Scope | Plan location | Verification target |
|---|---|---|---|
| WP-R-001 Canonical, versioned JSON contract; bounded size; no executable fields | v1 contract | Phase 2 Steps 1–2 | `workflow-profile.schema.test.ts`; schema/loader parity tests |
| WP-R-002 Semantic graph correctness (IDs, ports, maps, endpoints, cycles, loops, results) | v1 contract | Phase 2 Step 4 | `workflow-profile-semantic.test.ts` positive/negative fixtures |
| WP-R-003 Resolve and pin Persona/Skill/Toolset/Rubric/Model dependencies | v1 contract | Phase 3 Step 1 | resolver tests for missing/duplicate/version/digest/trust |
| WP-R-004 Tool access is an intersection and can only narrow Runtime/Persona policy | security | Phase 3 Step 2; Phase 6 Step 3 | denied-tool call-site integration tests |
| WP-R-005 Deterministic first-match, bounded loops, exhaustion, typed error/retry/route | control flow | Phase 4 Steps 1–4 | graph-engine tests including overlap/tie/nested-loop/retry exhaustion |
| WP-R-006 Default-off, invalid/untrusted profiles rejected before dispatch; legacy behavior unchanged | rollout/parity | Phase 4 Step 5; Phase 7 Steps 2–3 | default-off/opt-in and golden parity tests |
| WP-R-007 Node handlers delegate to existing Orchestrator/PlanRuntime and treat profile text as untrusted | integration/security | Phase 5 Steps 1–4 | handler integration and adversarial prompt-boundary tests |
| WP-R-008 Durable workflow lifecycle, digest-bound approval, cancellation/resume, shared budgets | lifecycle | Phase 6 Steps 1–4 | restart/recovery, approval-digest, cancel/resume and budget tests |
| WP-R-009 Default profile preserves current observable HOOTL flow | compatibility | Phase 7 Steps 1–3 | characterization/golden tests for clarify/confirm/execute/replan/review/cancel |
| WP-R-010 Authoring/discovery/selection diagnostics in supported interfaces | user-facing | Phase 8 Steps 1–3 | CLI/API contract and invalid-profile diagnostics tests |
| WP-R-011 Adversarial policy/tool trust boundary and safe resource ceilings | security/performance | Phase 5 Step 2; Phase 9 Steps 1–2 | injection, trust, limit and resource-bound tests |
| WP-R-012 Migration, rollback, docs, CI and independent review gates | delivery | Phase 10 Steps 1–3 | migration/rollback checks, CI gates, final traceability review |
| WP-R-013 Explicit v1 exclusions: no inheritance, templates, sub-workflows, recursion, parallelism/fan-out/join | scope | Phase 1 Step 3; Phases 2–4 | schema/semantic rejection tests and docs scope assertions |

## 7. Phase 1 gate

Completed evidence: current base/PR state, repository entrypoints, existing Plan/Task and registry boundaries, declared test commands, current CI outcomes, and the lack of a public outer-workflow seam are recorded above. Outstanding owner decisions D-WP-001…005 and D-WP-008 affect contract or architecture and therefore block dependent implementation. D-WP-006/007 require bounded verification before schema/loader work. Phase 1 remains 🟡 until these are approved/resolved and this addendum is merged into the canonical project plan; Phase 2 must not start before that gate. No code or existing file was removed or rewritten by this baseline report.


## 8. Owner decisions and verification update (2026-09-29 19:38 GMT+3:30; append-only)

This addendum records Pouya Rahimi's confirmed decisions after the initial baseline. It supersedes the open/proposed status of D-WP-001…008 in §§5 and 7 as of this timestamp; the initial findings and history above are retained unchanged.

| ID | Confirmed decision / evidence | Implementation constraint and next gate |
|---|---|---|
| D-WP-001 | Ajv with JSON Schema Draft 2020-12 validates structure; a separate semantic validator validates references and graph/type consistency. | Keep structural and semantic errors separate; Phase 2 Steps 1–2. |
| D-WP-002 | A dependency pin requires a digest of the exact component content. Record a registry version when one exists, but a version never substitutes for the digest. The Phase 1 schema update makes `digest` required and `version` optional. | Missing or mismatched digest fails closed before activation. Phase 2/3 must define and test the deterministic digest input for each dependency kind before resolution is implemented. Example digests are explicitly structural placeholders, not activation-ready pins. |
| D-WP-003 | Exactly one profile is active per run. Selection order: explicit user selection, then project profile only after explicit opt-in, then built-in default. Profiles are not composed; a profile cannot weaken Runtime safety policy. | Discovery/selection and opt-in checks are Phase 2/8; policy enforcement remains Runtime-owned. |
| D-WP-004 | Approval is bound to the digest of the exact plan shown to the user; approval alone does not authorize tools or side effects. | Runtime authorization remains separate and must be checked at the real call site. |
| D-WP-005 | The effective budget is the strictest applicable cap, per dimension, across Runtime, user/session, and profile. Budgets are not added and a profile cannot raise them. | Counters cannot reset across profile loops/retries/resume; enforcement is Phase 6. |
| D-WP-006 | Keep actual MCP tool IDs byte-for-byte/string-exact: `toolPrefix + raw tool name`, with no lowercase, normalization, or lossy aliasing. Local tool IDs keep their current restricted convention. MCP IDs must be nonempty, contain no control characters, and be at most 256 UTF-8 bytes; collisions and profile references use exact comparison. The Phase 1 Profile Schema now permits the bounded opaque shape; the runtime registry still needs source-aware validation. | Phase 2/3 must enforce the UTF-8 byte cap and exact registry match, while preserving the local-ID rule; test names with case, punctuation, Unicode, boundary length, control characters, and collisions. Real remote MCP names are not configured in this repository, so no live-server sample is claimed. Evidence: `src/ai/tools/mcp-connector.ts` builds the prefixed ID without normalization; `src/ai/schemas/tool-definition.ts` currently rejects IDs outside `^[a-z0-9_-]+$`; existing tests cover only lowercase names. |
| D-WP-007 | Profile JSON has a hard cap of 1 MiB (1,048,576 UTF-8 bytes), rejected before parsing. | Existing profile design artifacts are below the cap: schema 35,763 bytes; default example 10,107; bounded-review example 7,461; error-route example 4,002. Loader tests must cover exactly-at-cap and cap+1. No deployed user-authored profile exists to measure yet. |
| D-WP-008 | The outer Workflow Runtime controls only the profile graph and its counters; `PlanRuntime` remains the sole scheduler for every inner Plan DAG. No parallel scheduler and no new public/generic Orchestrator facade. | Pouya approved a narrow internal adapter that delegates to existing lifecycle services and `PlanRuntime`. It must preserve Orchestrator ownership of confirmation, review, persistence, cancellation, resource locks, and status. Adapter implementation/integration proof belongs to later runtime phases; this Phase 1 spike does not claim it is implemented. |

### Bounded architecture spike and current gate

Read-only source evidence at baseline `main` (`ff7c030afaa20b8a343cdb090b3b2db16384279e`): `Orchestrator.run()` enters private `runInSession()` and owns intake/planning/clarification/confirmation before delegating a confirmed plan to `PlanRuntime.execute()`. Public `PlanRuntime` lifecycle is `execute(plan)`, `resume(planId)`, and `cancel()`; it schedules the inner DAG. No public staged Orchestrator API or Profile Runtime exists. This rules out composing existing public calls alone, but does not require another scheduler: the owner-approved solution is an internal, narrow adapter to existing services, with PlanRuntime unchanged as the inner scheduler. This is a design/read-only spike, not executable integration evidence.

The Phase 1 owner-decision blockers are resolved. **Step 3 is 🟢**: owner decisions are recorded, the Schema now requires dependency digests and allows an exact bounded MCP ID shape, and all three structural examples carry clearly labelled placeholder digests. **Step 4 is 🟢 for its read-only design spike**: the architecture boundary and narrow internal adapter are owner-approved; no implementation/integration success is claimed. **Step 5 was 🟡** pending PR #8 review/merge at the time of this baseline. The completion and post-merge CI evidence are recorded in the append-only update below; no historical evidence is removed.

## Phase 1 completion and Phase 2 handoff (2026-09-29 20:38 GMT+3:30; append-only)

PR #8 merged to `main` at `ee3fa3f67d695a251974d5bb94ce53ab6e605b5a`. Post-merge CI run `36601818036` is completed with conclusion `success`. Phase 1 Step 5 and the Phase 1 Gate are now 🟢. The source branch `feat/workflow-profile-phase1-baseline-20260929` is preserved. Phase 2 may proceed on a new branch from this merge commit; it does not authorize Runtime activation or any later phase.

## 9. D-WP-009 — owner-confirmed extension metadata policy (2026-09-29 21:33 GMT+3:30; append-only)

Pouya confirmed that `x-*` extension metadata is limited to JSON scalar values only; each extension-enabled object may contain at most 16 such fields; extension strings are limited to 1,024 characters; the overall Profile file remains capped at 1 MiB (1,048,576 UTF-8 bytes). Arrays, objects, executable content, and extension keys outside the existing bounded key pattern are rejected. This resolves the remaining owner-policy question for Phase 2. Contract tests cover the 16/17-field boundary at each extension-enabled object, non-scalar values, string length, and the file-size boundary. This approval does not authorize workflow execution or later phases.

## 10. D-WP-003 Profile-ID collision clarification (2026-09-29; append-only)

The earlier baseline observation that `registryLayersFor()` lets project registry entries override matching package registry IDs describes the pre-existing Persona/Skill-style registries; it is not itself the Workflow Profile ID collision contract. The owner-confirmed Profile selection order is explicit user selection, then an explicitly opted-in project Profile, then built-in default, with exactly one active Profile and no composition. The decision does not specify same-ID collision/override semantics across Profile scopes. Phase 2 currently rejects duplicate Profile IDs across scopes and tests that fail-closed behavior. Do not transfer the old package→project override rule to Profiles. Whether fail-closed duplicate handling is the final Profile contract, or an explicit scoped-ID/override rule is desired, remains an owner decision before Phase 2 acceptance; no override is inferred.



## 11. Superseding Profile ID collision decision (2026-09-30; append-only)

Section 10 retains the historical state before Pouya's later delegation. Under Pouya's instruction to apply the agent's conservative recommendations, the current Workflow Profile rule is **global fail-closed for duplicate IDs across all scopes**. Selection order (explicit user selection, opted-in project Profile, then built-in default) does not authorize same-ID override or disambiguation. The Phase 2 registry and tests implement this rule. This supersedes only the unresolved-decision sentence in §10; no historical evidence is removed.
