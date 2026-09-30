# Workflow Profiles Phase 2 — Acceptance Review (2026-09-29)

**Reviewed head:** `e2e7d6fd1c2c0b0a19294d73af6ed40c3711117c` on `feat/workflow-profile-phase2-contract-20260929`  
**PR:** #9, Draft; not approved or merged.  
**Decision:** Phase 2 remains 🟡. This review records evidence and residual trust limitations; it does not authorize Runtime work, Phase 3, or merge.

## Trust and provenance boundary

`projectOptIn` is enforced at direct file load, directory discovery, registry registration, and selection **for the scope value supplied by the caller**. The module does not establish that a path really belongs to that scope. A caller able to choose both path and scope can load a project-controlled JSON file as `builtin` or `user-selected`, avoiding the project-scope opt-in guard. Scope is not part of the profile JSON, so the file itself cannot relabel its scope. Duplicate profile IDs fail closed; project entries cannot override an already registered profile with the same ID.

**Required host contract for this Phase 2 module:** only trusted host code may choose scope and filesystem roots; the host must derive scope from trusted configuration, must not accept an untrusted caller's arbitrary scope/path pair, and must pass `projectOptIn: true` only after an explicit opt-in. The loader currently validates the asserted scope and opt-in but does not authenticate provenance. Do not describe this as loader-verified project/builtin provenance.

This disposition is acceptable only while scope/path selection is a trusted-host responsibility. If the threat model requires the loader itself to authenticate project-vs-builtin provenance or treats its caller as untrusted, this remains a code-level blocker before any Runtime integration; root-bound APIs or equivalent host-authority binding will be needed.

## Profile-ID collision/precedence clarification

The old baseline statement that project entries override matching package entries describes the existing non-Profile registry layering; it is not an approved Workflow Profile override rule. The owner-confirmed Profile selection order is explicit user selection, then an explicitly opted-in project Profile, then built-in default, but it does not define what happens when the same Profile ID exists in multiple scopes. The Phase 2 registry and tests currently reject duplicate IDs across scopes. Keep this fail-closed behavior; do not infer project-over-package override. The same-ID collision rule remains an owner decision for Phase 2 acceptance unless confirmed as final.

## Filesystem race boundary

Profile-file opening rejects non-regular files and uses `O_NOFOLLOW`/`O_NONBLOCK` where supported. It compares pre-open `lstat`, descriptor `fstat`, and post-open path identity (`dev`/`ino`), reads at most the byte cap plus one, and decodes UTF-8 fatally. Tests cover file replacement and POSIX FIFO behavior.

Directory discovery is still path-based: the root is checked with `lstat` and then enumerated with `readdirSync`; it is not pinned to a directory descriptor or revalidated after enumeration. A concurrent replacement of the directory root, or in-place writes to the same regular-file inode, is not prevented by the file identity checks. **No race-free directory enumeration or immutable-content guarantee is claimed.** For this phase, the host-supplied discovery root and its contents must be stable and not writable by an attacker during discovery. If that cannot be guaranteed, hardening is required before Runtime use.

## Validation evidence

- CI run `36618571517` on the reviewed head completed **failure (8/10 jobs succeeded)**. All Linux/macOS jobs and E2E jobs succeeded; the Windows Node 22/24 type checks succeeded. Both Windows unit/integration jobs failed in unrelated existing tests/timeouts; the Workflow Profile suites passed on both Windows jobs: semantic 22, registry 17 (2 skipped), schema 9, MCP ID 4. No Profile-specific CI failure was reported.
- Windows Node 22 failures: `PERF-04` timing assertion and 5-second timeouts in `G-04 deleted session` and `G-18 no custom baseURL in run output`.
- Windows Node 24 failures: `v27.17.0` greeting/chat timeout, CLI `mcp list` hook timeout, `G-04`, `G-18`, server `projectRoot` hook timeout, server `.env` precedence timeout, and MCP registry route timeout.
- Baseline CI on base commit `ee3fa3f67d695a251974d5bb94ce53ab6e605b5a` (run `36601818036`) was green. Therefore the current Windows failures cannot be assumed to be baseline failures or conclusively attributed to the Profile changes; they require rerun/triage. Failed jobs were queued for rerun; no rerun result is claimed yet.
- Prior isolated local harness evidence on this branch: 48/48 targeted tests and `tsc --noEmit` passed. This is not a full-repository local run. Full-repository GitHub CI is the evidence above, and is not fully green.

## Remaining Phase 2 gates

1. Obtain and assess the failed-job rerun; do not call the CI gate green unless the required run is green or the repository's accepted baseline/regression policy explicitly resolves the failures.
2. Decide/record whether the trusted-host scope/path contract is sufficient for Phase 2; otherwise implement a code-level provenance boundary.
3. Keep the directory-root and in-place mutation limitations explicit, and confirm the host can guarantee stable trusted roots before any integration.
4. Resolve the already recorded Runtime version contract, `result.kind`→end-port mapping, duplicate-ID precedence wording, and review-decision route-target ambiguity; do not infer them.
5. Complete independent acceptance review, verify no file/branch deletions, and keep this PR Draft until all gates close.

No files or branches were deleted as part of this review. No workflow execution, dependency resolution, or Runtime authorization behavior is claimed.

## Current status and owner decision (2026-09-30; append-only)

**Current PR head:** `2a3f725d708858ec867a9fb013587f964ffc2899`. The earlier reviewed-head label above remains historical; this addendum records the current evidence and does not replace that review.

**Trusted-host decision:** Pouya selected Option 1. For Phase 2, trusted host code is responsible for deriving scope and supplying trusted roots from trusted configuration; loader-side provenance authentication is not required in this phase. This is not evidence that the current or future host actually guarantees stable roots. Before Runtime integration, the host must be shown to keep the supplied root and contents stable and non-attacker-writable. Directory-root replacement and in-place same-inode mutation limitations remain open and are not claimed as mitigated.

**CI:** run `36621696802` attempt 1 completed with 9/10 jobs successful; the Windows Node 22 unit/integration job failed. Failed-job-only attempt 2 also failed on Windows Node 22: typecheck passed, while unit/integration reported timeouts in `G-04 deleted session`, `G-09 orchestrator cache`, and `Phase 19`, and `PERF-04` measured about 691 ms against a <500 ms assertion. The other nine jobs succeeded. CI is not green; the available evidence does not establish that these failures are unrelated to the PR.

A separate read-only review of this exact head found no deleted or renamed files. It also found that the plan, acceptance report, and PR description had stale status text; the current addenda correct the decision/evidence trail. **Phase 2 remains 🟡.** Remaining gates: triage CI failures against baseline and affected tests; verify host root-stability guarantees before Runtime integration; settle Runtime version contract, `result.kind`→end-port mapping, duplicate-ID behavior, and review-decision route-target semantics; then complete final acceptance. This update does not authorize Runtime work, Phase 3, PR approval, or merge.

## Owner-delegated decision disposition and current validation (2026-09-30; append-only)

Pouya authorized the agent to apply its conservative recommendations to remaining design decisions, based on prior agreement with those recommendations.

- **Cross-scope duplicate Profile IDs:** fail closed globally; selection precedence is not an override rule. Existing registry behavior and test are retained as the v1 contract.
- **Runtime version:** `profile.runtime` is optional, non-operative Phase 2 metadata. Present values are syntax-checked only; no package-version comparison or compatibility/activation claim is made. The authoritative Workflow Runtime contract and enforcement remain a gate before Runtime integration. Schema, type, test, and examples are being aligned accordingly.
- **`result.kind` and end-port type:** no implicit mapping is inferred from examples. A closed mapping plus semantic validation is required before any activation; until then the ambiguity remains an explicit Phase 2 acceptance gate and unresolved profiles must fail closed.
- **Review routing:** every allowed decision must have a selectable outgoing route under priority-then-definition-order first-match; selected route target and input mapping must be valid. A unique per-decision destination is not required in v1. Runtime first-match behavior still requires Phase 4 execution tests.

Run `36636528369` completed 10/10 jobs successfully on the previous documentation head `9d4308589f78d29e1d5a698fdce4725bcfb777e6`. That run predates the schema/type/test/example changes described above; this resulting implementation head requires fresh CI. Phase 2 remains 🟡 pending those checks and closure of the end-result mapping and final acceptance gates. Host verification of stable, trusted roots remains mandatory before Runtime integration. No file or branch deletion, Runtime integration, or merge is claimed.

## CI triage follow-up (2026-09-30; append-only)

Run `36639028334` on head `e3a32cdee16d345e62718f8089b0ea10447451dd` completed with 3/10 jobs successful. All seven OS/Node unit+integration matrix jobs failed at the same Profile-specific assertion in `workflow-profile-schema.test.ts`: the `profile metadata` case expected structural rejection of 17 x-* fields but got no structural error. The optional-runtime change removed one property from the fixture, so the aggregate `maxProperties` limit no longer fired; the semantic validator's explicit x-* cap remains the intended protection for sparse objects. The test helper was corrected to include the optional runtime metadata when it is exercising aggregate-property overflow. Type checks and all three E2E jobs passed; there were no timeout/performance failures in this run. This attribution comes from CI logs; no local test result is claimed.

The corrected test and this addendum are being pushed for a fresh CI run. Phase 2 remains 🟡 until the new head passes and the unresolved result-kind/end-port mapping and final acceptance are closed. Stable trusted roots remain a mandatory pre-Runtime gate. No file/branch deletion, Runtime integration, or merge is claimed.

## Current status refresh — CI rerun and result-kind contract (2026-09-30; append-only)

Run `36642042670`, attempt 2, completed successfully on head `b49cf7eecfe8855c20b5537a4aad02801eb1e8f1`: **10/10 jobs passed**, including Windows Node 24. This closes the corrected x-* fixture CI rerun only; the changes recorded below are newer than that run and require fresh CI.

**Delegated conservative decision — `result.kind` to end-port type:** code and examples did not define a mapping. Under Pouya's standing authorization to apply conservative recommendations, v1 now uses a closed semantic mapping: `response` → `string|number|integer|boolean|object|array`; `artifact` → `artifact|file`; `proposal` and `handoff` → `object`. `any` is rejected for all kinds. This preserves every existing sample (`response/object`, `handoff/object`) and prevents a kind label from blessing an opaque or unrelated output. The JSON Schema remains structural; the separate semantic validator emits `result.kind-type-mismatch` at `/result/{i}/kind` when a declared end-output port falls outside the table. Tests cover accepted/rejected type combinations and verify structural Schema acceptance is separate from semantic rejection. This mapping is a conservative agent disposition under the delegated authority, not evidence of pre-existing Runtime semantics; it does not authorize execution.

**Current implementation status:** the mapping, types, tests and this status clarification are being prepared on top of `b49cf7e`. Fresh CI and final read-only diff review are required on the resulting head. Phase 2 remains 🟡. Before Runtime integration, host-guaranteed stable, trusted, non-attacker-writable roots and the authoritative Runtime compatibility/enforcement contract must still be verified. No file or branch deletion, Runtime integration, Phase 3, approval, or merge is claimed.


## Superseding decision and CI status correction (2026-09-30; append-only)

This addendum supersedes conflicting unresolved/"being prepared" statements in earlier historical sections; their chronology is retained.

Pouya delegated remaining design decisions to the agent's conservative recommendations. The final Phase 2 dispositions are:

- Duplicate Profile IDs fail closed globally; no scope overrides another.
- `profile.runtime` is optional syntax-only, non-operative metadata in Phase 2. No package-version comparison, compatibility claim, or activation authorization is made; the authoritative Runtime compatibility/enforcement contract remains a pre-integration gate.
- `result.kind` is now implemented as a closed semantic mapping: `response` → `string|number|integer|boolean|object|array`; `artifact` → `artifact|file`; `proposal` and `handoff` → `object`; `any` is rejected. Semantic validation emits `result.kind-type-mismatch`; Schema validation remains structural.
- Review routing requires every allowed decision to have a selectable first-match route (priority ascending, then definition order), with a valid selected target and mapping. A unique destination per decision is not required. Runtime execution semantics require Phase 4 tests.
- Trusted-host Option 1 is selected: the trusted host derives scope and supplies the root; the loader does not authenticate provenance. Stable trusted roots not writable by an attacker must be demonstrated before Runtime integration. Directory replacement and same-inode writes are not claimed as prevented.

CI run `36643719995` is on head `316ce64af65b2c3497d56b19cbc97d33f9ca42e1`, attempt 2. Attempt 1 completed 9/10: the sole failure was Windows Node 22 at `G-14 usage API equals CLI jsonl` / `GET /api/usage?planId matches collectProjectUsage`, which timed out after 5 seconds; Profile-specific suites passed. At the latest check, attempt 2 was still `in_progress`; its Windows Node 22 setup/typecheck succeeded and unit/integration was running. The log was not yet available, so no final rerun conclusion is claimed. CI remains a gate.

Phase 2 remains 🟡 pending completion/assessment of that CI attempt, a fresh CI run on any resulting documentation head, and final acceptance. Runtime behavior tests for tie order, retry exhaustion, denial/cancellation routing, nested loops, and hard visit caps belong to Phase 4; Phase 2's acceptance evidence is static validation only. No file or branch deletion, Runtime integration, Phase 3, approval, or merge is claimed.


## Independent review follow-up — malformed registration and rerun cancellation (2026-09-30; append-only)

A final independent read-only review identified a blocking API-boundary defect: `WorkflowProfileRegistry.register()` dereferenced the profile ID before validation, allowing malformed in-memory entries to throw raw `TypeError`. Commit `7ece43dfe19e0345e2388ac1da360c9344aa0f2d` adds fail-closed checks for invalid entries/missing file identifiers, moves profile-ID access after structural validation, and adds malformed-entry tests. Local TypeScript syntax transformation passed; full tests/typecheck are not claimed locally.

CI run `36643719995` attempt 2 on `316ce64` was cancelled when a newer PR run superseded it, so it has no final test conclusion. Run `36644573121` is on older documentation head `271a154` and does not contain the registry fix. Fresh full CI on `7ece43d` is required. The documentation head has no completed CI result that validates the latest code. Phase 2 remains 🟡; PR #9 remains Draft. No deleted or renamed files were found. Stable trusted roots and the authoritative Runtime compatibility/enforcement contract remain pre-Runtime gates; runtime behavior remains Phase 4 evidence.

## Consolidated Phase 2 hardening status (2026-09-30; append-only)

This section supersedes earlier status statements above that describe the current implementation head or say the remaining conservative decisions are still unresolved; historical records are retained.

**Remote baseline and CI before this consolidated batch:** PR #9 was open and Draft at head `f4367deda016deca86aebeaae79729e62bdf2592`. Run `36644922483` completed with 9/10 checks successful; Windows Node 24 failed in Unit + integration. Its log reported 116/125 test files passed and 1,716 tests passed, 22 failed, 16 skipped; the Profile-specific suites passed. The failures were scattered CLI/server/chat/orchestrator timeouts. A prior green Windows Node 24 run on main and a green run on an earlier PR head do not establish whether this failure is a regression or transient. **CI is not green and failure attribution remains open.** No rerun is being used to validate the consolidated batch before it is ready.

**Consolidated local changes:** the public registry constructor, file loader, directory loader, and selection boundary now reject malformed options/IDs and non-registry duck types with `WorkflowProfileLoadError` diagnostics. Structural validation requires plain JSON-compatible own-data values and Ajv validates own properties; inherited required fields, accessors, cycles/aliases, non-JSON classes, and hostile reflection objects are rejected. The exported semantic validator now returns diagnostics rather than leaking raw exceptions on malformed inputs while preserving semantic diagnostics for structurally imperfect test inputs. Duplicate-key scanning runs only after `JSON.parse` confirms valid syntax, so malformed JSON takes precedence while valid duplicate members remain rejected. Tests cover escaped/nested duplicate keys, malformed duplicate-looking JSON, bad boundary values, inherited fields/non-JSON values/aliases/hostile reflection, Approval text/decision outputs, required Condition `matched` and exact pass-through contracts, and required Review decision outputs.

Focused verification in the isolated harness passed **59/59 Profile tests across 4 test files**, and strict TypeScript checking of the changed workflow-profile source/tests passed using ESNext/Bundler settings. This is **not** a full-repository test, build, or typecheck and does not replace GitHub CI. An independent review identified the non-plain/inherited-object boundary weakness; the consolidated code now rejects those values and adds regressions, but the final consolidated diff still needs a fresh independent review. Approval's canonical Schema describes decision as structured approved/denied/expired output; Phase 2 validates the required `decision` object port but does not invent an internal object shape or forbid unrelated pass-through outputs. Condition `matched` is required boolean; pass-through contracts preserve type, requiredness and enum values. No Runtime execution is claimed.

**Current acceptance gate:** push the tested source, tests and both status documents as one consolidated commit, then assess full CI on that exact head. Keep Phase 2 🟡 and PR #9 Draft until CI and final acceptance are closed. The trusted-host Option 1 contract is accepted for this phase, but stable/trusted/non-attacker-writable root guarantees must still be evidenced before Runtime integration. The authoritative Runtime compatibility/enforcement contract remains a pre-integration gate; execution semantics and dependency resolution remain later phases. No file or branch deletion, Runtime integration, approval, or merge is claimed.

## Consolidated-batch verification refresh (2026-09-30; append-only)

The isolated harness was rerun after the latest registry, structural, semantic, and Condition-route hardening: **63/63 Profile tests passed across 4 test files** (registry 21, schema 11, semantic 27, MCP IDs 4). Strict TypeScript checking of the changed Profile sources, supporting types, and focused tests passed with ESNext/Bundler settings. For this focused harness only, the temporary `/tmp` package manifest was given the real package name so canonical Schema lookup could exercise the package-boundary check; dependencies and harness edits stayed outside the repository. This is targeted local evidence, not full repository tests, build, or typecheck.

The latest remote baseline before this consolidated batch was PR #9 head `f4367deda016deca86aebeaae79729e62bdf2592`. Run `36644922483` completed **9/10**: Windows Node 24 passed typecheck but failed Unit + integration; all other jobs passed. Its Profile-specific suites passed, but the broader failures are not proven unrelated to the PR. The consolidated local changes are not yet pushed and have no CI result.

The fresh review identified and prompted fixes for four items: Schema lookup now stops at the nearest package manifest and requires the `human-out-of-the-loop` package name; API boundaries accept only plain records with own data properties and read scope/opt-in/entry/selection fields via own descriptors; `not-exists` is rejected for required output ports; and the broad wire types are documented as untrusted while registry-exposed profiles carry a compile-time validated brand. Regression tests cover inherited opt-in/entry fields, stateful Proxy descriptor failures, and impossible predicates. Package-identity binding was inspected but has no dedicated wrong-package regression test; a compile-time assertion now verifies that raw documents are not assignable to the branded validated type. The final targeted independent review of the Proxy-boundary hardening found no blocker; its local test/type-check evidence is green. Final remote-head comparison and exact-SHA CI after the single consolidated push remain required. Phase 2 stays 🟡 and PR #9 Draft. No file or branch deletion, Runtime integration, Phase 3 work, approval, or merge is claimed.
