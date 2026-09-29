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
