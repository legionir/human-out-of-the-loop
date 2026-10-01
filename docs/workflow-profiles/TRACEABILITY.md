# Workflow Profiles — traceability, decisions and open items

Phase 10 Step 2 asks for one place where every requirement maps to the phase/step that implemented
it, the tests that verify it and the documents that describe it, plus the final decision/unknown
register. This is that place. It is written from the repository as it stands (no ⚪/🟡 invented
states): every test file named here exists, and every document named here is in this directory.

Status of the feature as a whole: **all ten phases implemented and 🟢; nothing activated by
default; the owner authorized merging PR #10 on 2026-10-01 and directed a hold while the stack scope
is decided (PR #10 is part of native stack #11 with PR #9 — see `EXECUTION_PLAN.md`, Phase 10 Step 3);
release and default activation still require the owner's explicit authorisation.**

## 1. Requirement matrix (`WP-R-001` … `WP-R-013`)

| ID | Requirement (short) | Phase(s) / step(s) | Implementation | Verification (tests) | Docs |
| --- | --- | --- | --- | --- | --- |
| WP-R-001 | Versioned JSON contract, bounded size, no code/DSL | 1.3, 2.1–2.2 | `profile-schema-validator.ts`, `profile-registry.ts`, `docs/workflow-profiles/workflow-profile.schema.json` | `workflow-profile-schema.test.ts`, `workflow-profile-registry.test.ts`, `scripts/profile-gates.mjs` | `PHASE2_*`, `PHASE8_AUTHORING.md` §3, §7 |
| WP-R-002 | Semantic graph validation (endpoints, ports, maps, results, cycles, loop bounds) | 2.4 | `profile-semantic-validator.ts` | `workflow-profile-semantic.test.ts` (28), `workflow-profile-predicate.test.ts` | `PHASE2_*`, `PHASE8_AUTHORING.md` §5–§6 |
| WP-R-003 | Dependency resolution with version/digest, no component copying | 3.1 | `profile-resolver.ts`, `profile-digest.ts`, `profile-sources.ts` | `workflow-profile-resolver.test.ts` (16), `workflow-profile-sources.test.ts` | `PHASE3_RESOLUTION.md` |
| WP-R-004 | Toolset/Persona/Runtime authorization only narrows; enforcement at the call site | 3.2, 6.3 | `toolsets.ts`, `profile-access-guard.ts`, `orchestrator-adapters.ts` | `workflow-profile-toolsets.test.ts`, `workflow-profile-enforcement.test.ts`, `workflow-profile-adversarial.test.ts` | `PHASE3_RESOLUTION.md`, `PHASE9_HARDENING.md` |
| WP-R-005 | Deterministic first-match routing, bounded loops, typed error/retry/route | 4.1–4.4 | `profile-kernel.ts`, `profile-predicate.ts`, `profile-routing.ts` | `workflow-profile-kernel.test.ts` (16) | `PHASE4_*`, `PHASE8_AUTHORING.md` §6 |
| WP-R-006 | Feature flag default-off, legacy behaviour preserved | 4.5, 7.2–7.3 | `profile-runner.ts` (`HOOTL_WORKFLOW_PROFILE`, `WORKFLOW_PROFILE_FLAG_ENV_VAR`), `profile-activation.ts` | `workflow-profile-activation.test.ts`, `workflow-profile-parity.test.ts`, `workflow-profile-hardening.test.ts` ("flag off keeps the path unreachable") | `PHASE7_PARITY.md`, `PHASE10_OPERATIONS.md` §1 |
| WP-R-007 | Handlers delegate to existing lifecycle; profile text stays untrusted data | 5.1–5.4 | `node-handlers.ts`, `orchestrator-bridge.ts`, `untrusted-content.ts` | `workflow-profile-handlers.test.ts` (17), `workflow-profile-injection.test.ts`, `workflow-profile-untrusted-content.test.ts`, `workflow-profile-adversarial.test.ts` | `PHASE5_*`, `PHASE8_AUTHORING.md` §9 |
| WP-R-008 | Durable lifecycle, resume/cancel, digest-bound approval, shared budget | 6.1–6.4, 9.1 | `profile-run-state.ts`, `profile-runner.ts`, `orchestrator-bridge.ts`, `orchestrator-adapters.ts` | `workflow-profile-lifecycle.test.ts` (17), `workflow-profile-budget.test.ts` (11), `workflow-profile-hardening.test.ts` (9), `workflow-profile-upgrade.test.ts` (3) | `PHASE6_LIFECYCLE.md`, `PHASE9_HARDENING.md`, `PHASE10_OPERATIONS.md` §3, §7 |
| WP-R-009 | The default profile preserves the current observable flow | 7.1–7.3 | `default-profile.ts` + the Phase 7 bridge | `workflow-profile-parity.test.ts` (9), `workflow-profile-default-profile.test.ts` (11), `workflow-profile-orchestrator.test.ts`, `workflow-profile-bridge.test.ts` | `PHASE7_PARITY.md` (incl. the recorded behaviour differences) |
| WP-R-010 | Authoring/discovery/selection reach the supported interfaces | 8.1–8.3 | `profile-discovery.ts`, `profile-selection.ts`, `src/cli/commands/{run,profiles}.ts`, `src/server/routes/run.ts` | `phase8-profiles.test.ts`, `phase8-profile-selection.test.ts` (8), `workflow-profile-discovery.test.ts` | `PHASE8_AUTHORING.md` §11–§12, `PHASE7_PARITY.md` §10 |
| WP-R-011 | Adversarial trust/tool boundaries and resource ceilings | 5.2, 9.1–9.2 | the guards above + budgets in `profile-budget.ts` | `workflow-profile-adversarial.test.ts` (7), `workflow-profile-hardening.test.ts` (9), `workflow-profile-budget.test.ts`, `scripts/profile-bench.mjs` | `PHASE9_HARDENING.md` (findings H-1…H-3, measurements) |
| WP-R-012 | Migration, rollback, docs, CI and review gates | 10.1–10.3 | `scripts/profile-gates.mjs`, `.github/workflows/ci.yml`, this file | `scripts/profile-gates.mjs` (9 checks, run in CI), `workflow-profile-upgrade.test.ts`, `workflow-profile-examples.test.ts` | `PHASE10_OPERATIONS.md`, `TRACEABILITY.md` |
| WP-R-013 | Explicit v1 exclusions (no inheritance/templates/sub-workflows/recursion/parallelism/fan-out/join) | 1.3, 2–4 | schema `additionalProperties: false` + the seven node kinds in `profile-types.ts`/semantic validator | schema/registry/semantic suites; the gate's negative controls | `PHASE1_BASELINE.md` §4, `PHASE8_AUTHORING.md` §1, §11 |

## 2. Decision register (owner-confirmed)

Recorded in `PHASE1_BASELINE.md` §8–§9 (D-WP-001…009) and `PHASE3_RESOLUTION.md` (D-WP-010/011);
restated here in one line each, with where the implementation honours it.

| ID | Confirmed decision | Honoured by |
| --- | --- | --- |
| D-WP-001 | Ajv + JSON Schema Draft 2020-12 validates structure; semantics stay a separate TypeScript validator with separate diagnostics. | `profile-schema-validator.ts` (`Ajv2020`), `profile-semantic-validator.ts`; both run in the gate |
| D-WP-002 | A pin is a digest of the exact component content; `version` is recorded when it exists but never substitutes for the digest. | `profile-digest.ts`, `profile-resolver.ts` (`dependency.digest-mismatch` fails closed) |
| D-WP-003 | Exactly one active profile per run; selection order explicit > opted-in project > built-in default; no composition; no weakening of runtime policy. | `profile-selection.ts`, `selectWorkflowProfile`, `profile-activation.ts` |
| D-WP-004 | Approval binds the digest of the exact plan shown; approval alone authorises nothing else. | `orchestrator-adapters.ts` (`createApprovalPort` echoes the shown digest), `orchestrator-bridge.ts` (`assertExecutable`), `workflow-profile-hardening.test.ts` |
| D-WP-005 | Effective budget is the strictest per-dimension cap; counters never reset across loops/retries/resume. | `profile-budget.ts`, `profile-runner.ts` (`usage`, `loopCounters`, `visitCount` restored on resume) |
| D-WP-006 | MCP tool ids stay byte-exact (`toolPrefix + raw name`), non-empty, no control characters, ≤256 UTF-8 bytes. | `src/ai/schemas/tool-definition.ts` + `workflow-profile-mcp-ids.test.ts` |
| D-WP-007 | Profiles are capped at 1 MiB (1,048,576 UTF-8 bytes), rejected before parsing. | `profile-registry.ts` (`MAX_WORKFLOW_PROFILE_BYTES`), `workflow-profile-registry.test.ts`, bench row in `PHASE9_HARDENING.md` |
| D-WP-008 | The profile runtime owns only the outer graph; `PlanRuntime` stays the sole inner-DAG scheduler; a narrow internal adapter, no new public facade. | `orchestrator-bridge.ts` (delegates to the Orchestrator's own services), `orchestrator-adapters.ts` |
| D-WP-009 | `x-*` extension metadata: scalars only, ≤16 fields per object, ≤1,024-character strings. | schema + `workflow-profile-schema.test.ts` boundary cases |
| D-WP-010 | v1 rubrics come only from the code-owned built-in catalogue (user-authored rubrics need a separate decision). | `profile-resolver.ts` (built-in catalogue), `workflow-profile-resolver.test.ts` |
| D-WP-011 | Digests are required; versions optional and never a substitute; example digests in fixtures are structural placeholders only. | `profile-digest.ts`, examples carry real pins and are checked by the test suite + gate |

## 3. Open owner items (no blocking unknown is unowned)

| ID | Item | Owner | Required before | Recommendation / current behaviour |
| --- | --- | --- | --- | --- |
| ~~U-1~~ | ~~Runtime version contract~~ — **resolved 2026-09-30**: a run records the **package version** (`packageVersion()` in `registries/layout.ts`, the same helper the CLI banner uses) unless the host declares `runtimeVersion`; a mismatch refuses the resume (`resume.runtime-version-changed`). | Pouya (chose activation) | done | `workflow-profile-upgrade.test.ts` writes its interrupted record with the package version, so the guard is exercised against the real value. |
| ~~U-2~~ | ~~Resume surface~~ — **resolved 2026-09-30 (option A)**: profile runs record themselves under `<runtimeDir>/workflow-profile-runs/` by default, `hootl profiles runs` lists them, and `hootl run --resume <runId>` continues one (re-selecting the recorded profile or file, continuing its session) with a stored approval never treated as authority. The server records under its own run id; resume is not exposed over HTTP. | Pouya (chose A) | done | `workflow-profile-resume-wiring.test.ts` (4), `workflow-profile-upgrade.test.ts` (3), e2e `profiles` scenario 12/12 (`PHASE10_OPERATIONS.md` §7). |
| U-3 | **Built-in default activation.** `BUILT_IN_DEFAULT_APPROVAL.approved` is `false`; the default profile cannot activate until the owner records the approval. | Pouya | Activation | Keep `false`; the record and the gate are in `default-profile.ts` + `workflow-profile-default-profile.test.ts`. |
| ~~U-4~~ | ~~**Phase 7 behaviour differences.**~~ — **resolved 2026-09-30 (case by case)**: G-5 **accepted** (a denial with feedback stays terminal), G-2 **accepted** (the answer branch ends `success`); report wording **aligned** to the legacy `formatReviewForUser` block (implemented); R-3 **changed** — a `rejected` end before execution reports `cancelled`, after execution stays `failure` (implemented). The absent `plan:clarified` entry stays as designed under the same decision. | Pouya (decided) | done | Decision record `PHASE10_OPERATIONS.md` §9; regression `workflow-profile-hardening.test.ts` (R-3, both directions), `workflow-profile-parity.test.ts` (shared report shape), `phase8-profile-selection.test.ts` (API outcome). |
| U-5 | **Host-root stability.** The server takes `projectRoot` only from configuration (never from a request) and every profile open is identity-checked (`O_NOFOLLOW`-style + lstat/fstat comparison), but nothing proves the operator's directory contents are not writable by another local user. | Pouya (operator property) | Activation on a shared host | **Documented 2026-09-30** in `PHASE10_OPERATIONS.md` §4 (`Host requirements`): the guarantee, its limit, where the run-state records live, and the operator rule ("run HOOTL in a directory only the operator can write"). Owner acknowledgement remains part of the activation checklist — the item is documentation, not code. |
| U-7 | **Profile-native `handoff`/`ask-user` outcomes in the legacy vocabulary.** A run that stops at a limit with `onLimit: handoff`/`ask-user` (or an end node with `outcome: "handoff"`) finishes with run status `handoff`; the Orchestrator maps it onto the legacy review/interaction outcome `failure` (the legacy union has no `handoff`). The durable record keeps the pause correctly (`awaitingUser: true`, non-terminal, `resumable`), and the report line shows `Workflow profile "handoff"` — only the session interaction is labelled `failure`. Opened by the 2026-09-30 self-review. | Pouya | Activation | Recommendation: map `handoff` → `partial-success` (work produced, not finished here) and leave an `ask-user` pause's interaction `pending` (the run is resumable), keeping the profile status in the report line; exit codes unchanged. Until decided the behaviour fails closed and is visible; the built-in default uses `onLimit: fail` and no `fail`-free flow ships (the schema fixture exercises a handoff end). |
| U-6 | **Pre-existing `J-05` checkpoint test is environment-sensitive.** On this sandbox it fails deterministically (`keeps only the newest snapshots of a plan and prunes old plans`, keeping `s1`,`s2` instead of `s2`,`s3`): consecutive writes land on the **same mtime** here (probe: three files, one distinct `mtimeMs`), so the "newest two" tie-break falls to name order. It passes on GitHub runners (all 10 jobs green on the phase heads) and the file plus `checkpoint.ts` are unchanged since the session base (`git diff f1d403f` empty). | Repository maintainers | Next checkpoint change | Not a regression from this work and not hidden: keep CI as the authority, and make pruning deterministic (order by a recorded sequence/`snapshotId`, not by equal mtimes) the next time `checkpoint.ts` is touched. |

## 3b. Independent-review fix backlog (2026-09-30; closed 2026-10-01)

**Status: all ten findings are fixed** — F-1/F-2/F-3/F-6/F-8 in `220af0b`, F-9 in `8ca5fe0`,
F-4/F-5/F-7 in `85cf218`, F-10 in `987e197`. The section below keeps the ledger and the evidence;
Phases 6, 7 and 9 are 🟢 again.

An independent static review of head `57c9761` found ten issues; all ten were re-verified as real
(`PHASE10_REVIEW.md` §9). Phases 6 and 9 are 🟡 again until F-1…F-4 and F-5…F-8 are fixed and tested
through the real adapters; F-9 is fixed in this stretch. No owner decision blocks the fixes except the
mechanism for F-4 (lock vs compare-and-swap).

| # | Issue | Status | Required before |
| --- | --- | --- | --- |
| F-1 | Declared tool surface not enforced at the execution call site | **Fixed** (`220af0b`) — the declared surface (pinned/bound toolset − toolset/profile deny lists) is narrowed onto every plan step before the runtime sees it; wildcard steps become exactly that surface | Phase 6 🟢 (F-4/F-7 remain) |
| F-2 | Profile counters not charged for delegated plan execution | **Fixed** (`220af0b`) — `createEventBusExecutionUsage` counts the plan's own `agent:*` events; the port returns the usage and the handler charges it, after refusing to start a plan the remaining budget cannot fund | Phase 6/9 🟢 (F-4/F-5/F-7 remain) |
| F-3 | Effect markers never called; resume can repeat a side effect | **Fixed** (`220af0b`) — `recordEffectStart` is persisted before the delegated call and committed only once it reports back; a kill or throw leaves `pendingEffect` and the resume gate refuses (`resume.ambiguous-effect`) | Phase 6 🟢 (F-4/F-7 remain) |
| F-4 | No lease/CAS: two runners can resume one run | **Fixed** (`85cf218`) — a resume takes an O_EXCL run lease (self-healing by pid, `resume.locked` for a live second process) and releases it when the attempt settles | Phase 6 🟢 |
| F-5 | An approval that binds content need not have shown it | **Fixed** (`85cf218`) — `bindsTo ∉ show` is refused at load (`approval.bound-content-not-shown`) and again at the runtime boundary before any interaction | Phase 9 🟢 |
| F-6 | Manual server confirmation cannot resolve (no plan id on the profile confirm callback) | **Fixed** (`220af0b`) — the confirm callback receives the captured plan, so the server sets `run.planId` and the CLI sets `currentPlanId` on the profile path too | Phase 8/10 acceptance |
| F-7 | Resume restores no inputs for a mid-graph pause | **Fixed** (`85cf218`) — the kernel reports the stopping node's inputs, an `ask-user` pause stores them, a resume hands them back; a legacy record without them refuses (`resume.inputs-missing`) | Phase 6 🟢 |
| F-8 | Cancellation not forwarded to the delegated runtime | **Fixed** (`220af0b`) — the run's abort signal reaches `PlanRuntime.cancel()`, which stops dispatching new steps | Phase 9 🟢 (F-5 remains) |
| F-9 | Auto-escalation re-ran the prepared run (crash) | **Fixed** — fresh attempt + parity regression | done |
| F-10 | Session history not given to the profile planner | **Fixed** (`987e197`) — the profile run installs the same per-run session-history scope as the legacy path; pinned by the parity suite | Phase 7 parity claim |

**Fix evidence (2026-10-01):** F-1, F-2, F-3, F-6 and F-8 are fixed in `220af0b` (CI `36810452453` @ `220af0b` **success 10/10** (ubuntu/macos/windows × Node 22/24/26, three e2e legs, type check, build, profile gates, CLI smoke));
F-4, F-5 and F-7 are fixed in `85cf218`; F-10 is fixed in `987e197` — all ten review findings are
closed, every one pinned by `workflow-profile-review-fixes.test.ts` (20 tests) or the parity suite.
Final evidence at the exact head CI `36812950278` @ `987e197` **success 10/10** (ubuntu/macos/windows × Node 22/24/26, the three e2e legs, type check, build, profile gates, CLI smoke); locally the profile + CLI + server suites pass
52 files / 598 tests, the CI-equivalent sweep reports 2,006/2,007 with only the pre-existing `J-05`,
profile gates 9/9, e2e `profiles` 12/12, `tsc --noEmit` and `npm run build` clean. Phases 6, 7 and 9
are 🟢 again; Phase 10 Step 3 closed with the owner's merge authorization (2026-10-01); the merge is
on hold at the owner's direction. **Merge authorized but on hold (owner direction, 2026-10-01):** the owner authorized the merge and then directed a hold, because PR #10 is part of GitHub's native stack #11 (base `main` @ `ee3fa3f`): its lower PR #9 (`feat/workflow-profile-phase2-contract-20260929`, draft, Phase 2) and PR #10 would be merged together by GitHub's stack-aware API, and a plain merge (or a base retarget of a stacked PR) is refused. The owner is deciding between unstacking #10 from the stack and merging the whole stack; until then no merge has been performed.

**Resolved unknowns (kept for the record, no owner needed):**

- *Duplicate profile IDs across scopes* — fail closed globally (`registry.duplicate-id`); selection
  precedence is not an override rule (D-WP-003, delegated disposition recorded in
  `PHASE1_BASELINE.md` §10 and `PHASE2_ACCEPTANCE_REVIEW.md`).
- *`result.kind` → end-port type* — closed by the Phase 2 contract: `RESULT_KIND_PORT_TYPES` +
  `result.kind-type-mismatch` in the semantic validator.
- *No intent/effect/commit journal* — resolved conservatively: `pendingEffect` is written before an
  effect and cleared after it, and a recorded marker refuses an automatic retry
  (`resume.ambiguous-effect`). A completed-but-uncommitted effect is reported ambiguous instead of
  being repeated, which is the safe direction; see `PHASE6_LIFECYCLE.md`.
- *Project-profile trust for the server* — `POST /api/run` resolves the selection per request with
  the same rules as `hootl run --profile` (both 400 with `selection.*` diagnostics when the project
  is not trusted); proved by `phase8-profile-selection.test.ts` and the live smoke recorded in
  `PHASE7_PARITY.md` §10/`CHANGELOG.md`.

## 4. CI gates and how a green result is read

| Gate | Where | What it proves |
| --- | --- | --- |
| Type check | `ci.yml` → `npx tsc --noEmit` | the tree compiles under the repository's tsconfig |
| Unit + integration suite | `ci.yml` → `node scripts/ci-test.mjs` | 148 files / 1,974 tests on this sandbox, GitHub runners green; failures are re-published as check-run annotations |
| Workflow Profile gates | `ci.yml` → `node scripts/profile-gates.mjs` (`npm run profile-gates`) | the built-in default and the three shipped examples pass schema + semantics + dependency resolution; the shipped schema file equals `WORKFLOW_PROFILE_SCHEMA`; four negative controls prove the validators still refuse unknown keys, non-v1 node kinds, unbounded loops and dangling error routes |
| Build + global install + CLI smoke | `ci.yml` | `dist/` builds and the installed binary answers |
| End-to-end scenarios | `ci.yml` → `node e2e/scenarios/run.mjs` | the whole runtime still drives the local stub (plan → execute → review → logs) |

There is **no linter in this repository** (no ESLint/Prettier config, no `lint` script); the static
gate is the type check. That is recorded here rather than invented: the plan's "lint" item has no
tool to run, and adding a linter is a repository-wide decision outside this feature.

Baseline separation: the only local red test is `J-05` (U-6), which is unrelated to this feature,
unchanged since the session base and green on CI; no Workflow Profile test is red anywhere.

## 5. Evidence index

- Phase heads and CI: `CHANGELOG.md` and the PR history; CI runs are green on every phase head
  (`gh run list --json headSha,conclusion`).
- Findings: `PHASE9_HARDENING.md` (H-1 gate, H-2 request text, H-3 toolset wiring, R-3 mapping).
- Measurements: `PHASE9_HARDENING.md` §Step 2, reproducible via `node scripts/profile-bench.mjs`.
- Operations, rollout/rollback, upgrade: `PHASE10_OPERATIONS.md`.
- Authoring: `PHASE8_AUTHORING.md`; contract details: `PHASE2_*`…`PHASE7_PARITY.md`.

## 3c. Second independent-review backlog (2026-10-01; closed)

The owner attached a **second independent static review** (against `d48c4cc`; no local test run) with
five findings — four P1, one P2. All five were re-verified here as real and fixed in `6b36348`:

| # | Issue | Status | Required before |
| --- | --- | --- | --- |
| F-11 | Declared surface could be bypassed by the skill fallback and by re-planned steps | **Fixed** (`6b36348`) — the runtime narrows every dispatch, filters every built agent's tools and narrows re-planned steps; the bridge hands the surface to the runtime (`toolSurfaceFor`) | Phase 6/9 🟢 |
| F-12 | Budget undercount: one charge per agent run, and exhaustion discovered after the work ran | **Fixed** (`6b36348`) — `modelCalls` (SDK steps) reported and charged; a per-dispatch budget guard stops before the next dispatch and still charges the calls already made | Phase 6/9 🟢 |
| F-13 | Effect marker cleared before the settled progress was persisted | **Fixed** (`6b36348`) — the marker is dropped in the same write that persists the progress (`effectOutcomeKnown`) | Phase 6 🟢 |
| F-14 | Only resumes leased; stale leases broken with a racy check-then-unlink | **Fixed** (`6b36348`) — every store-backed run leases (`run.locked`/`resume.locked`), stale breaks are an atomic rename + inode/content identity CAS | Phase 6 🟢 |
| F-15 | A pause before a node paired that node's inputs with the previous node's id | **Fixed** (`6b36348`) — `resumeNodeId` pairs inputs with the stopping node; the durable layer stores the pair | Phase 6 🟢 |

**Evidence:** CI `36843874529` @ `6b36348` **success 10/10** (ubuntu/macos/windows × Node 22/24/26,
three e2e legs, type check, build, profile gates, CLI smoke); locally `scripts/ci-test.mjs`
2,017/2,017, the full `src/ai` suite 127 files / 1,707 tests, profile gates 9/9, e2e `profiles` 12/12,
`tsc --noEmit` and `npm run build` clean. Regression coverage:
`workflow-profile-runtime-guards.test.ts` + `workflow-profile-review-fixes.test.ts` +
`workflow-profile-lifecycle.test.ts`.

**Merge status (supersedes the hold recorded in §3b):** the owner's 2026-10-01 directive ("PR #9
ready — mergeable as a stack, tests green; before merge verify everything is correct, and review the
attached report") closes the wait; the report is reviewed and its five findings are fixed above, so
the verified stack merge proceeds. The merge event is recorded in the PR timeline.

**Merge performed (2026-10-01):** the verified stack was merged with GitHub's stack-aware endpoint
(`PUT /repos/legionir/human-out-of-the-loop/pulls/10/merge-async`, `merge_method: merge`, expected
head `f6b8e5b`): merge commit `8e2036ce107544f47f3620abf36989596b440a29` ("Merge pull request #10 …")
is the head of `main`, PR #9 and PR #10 are both `MERGED`, and native stack #11 is closed. CI
`36845511269` @ `8e2036c` on `main` is **success 10/10**. Nothing beyond this stack was merged, no
release was published, and the built-in default stays unapproved (`BUILT_IN_DEFAULT_APPROVAL`
`approved: false`) and off.