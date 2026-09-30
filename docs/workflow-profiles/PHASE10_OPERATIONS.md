# Phase 10 — migration, rollout and rollback operations

This is the operator/upgrade guide for the Workflow Profiles feature. It states what actually exists
in this repository, what a rollout touches, how to roll back, and the one wiring limitation the owner
still has to decide on. Everything here is written to be checkable against the code and the suites
named in each section.

**Status: 🟡** — the guide, the compatibility evidence and the rollout/rollback procedure are
complete, and the resume surface is wired (§7). The remaining owner items are the activation
checklist in §8.

## 1. What the feature is, and what is off by default

A Workflow Profile is a JSON document that declares a run's control flow (intake, planner, bounded
clarification, digest-bound approval, delegated execution, review, ends). `PlanRuntime` stays the only
inner-DAG scheduler; profiles never gain a new execution engine, a DSL, `eval`, or a route into the
tool layer that bypasses authorization.

| Switch | Default | Effect |
| --- | --- | --- |
| `HOOTL_WORKFLOW_PROFILE` | **off** (unset) | With the flag off, `run()` resolves **nothing** profile-related: no discovery, no schema validation, no digest check, no file read. The legacy path runs exactly as before. |
| `hootl run --profile <id>` / `--profile-file <path>` | not used | Per-run opt-in: the CLI resolves the selection and sets the flag for that run only. |
| `POST /api/run { "profile": "<id>" }` | not used | Per-request opt-in on the server; the flag is set for that run only (never process-wide). |
| `HOOTL_WORKFLOW_PROFILES_DIR` | unset | Operator directory scanned for profiles (no trust needed — it is the operator's own choice). |
| `<project>/.hootl/workflow-profiles/*.json` | not read | Project scope, read only with the trust opt-in (`hootl ... --trust-project`, or the server's trust option/record). |
| `BUILT_IN_DEFAULT_APPROVAL` | `approved: false` | The built-in default profile refuses to activate until the owner records an approval; there is no implicit default. |

Measured cost of "off": the activation decision is one flag read plus an early return — p50 0.000 ms,
against ~0.8 ms to prepare a selected profile (`docs/workflow-profiles/PHASE9_HARDENING.md` §Step 2,
`scripts/profile-bench.mjs`).

## 2. Upgrade guide — schema, runtime and dependencies

### 2.1 Profile / schema versions

- `schemaVersion` is `1.x.y`. The **major** must match the runtime's contract; a document with a
  different major (or an unknown minor) is refused *before* field validation with
  `schema-version.unsupported`, so an old runtime says "this document is newer than me" instead of
  producing confusing field errors.
- Adding a document is additive: copying a profile into a project changes nothing until a run selects
  it (§1). Upgrading HOOTL itself changes nothing for a project that never selects a profile.
- The JSON Schema ships with the runtime at `docs/workflow-profiles/workflow-profile.schema.json` and
  is validated by the same process the runtime uses, so an editor can point at it and get the same
  answers the loader will give.

### 2.2 Runtime version

Every prepared run records the runtime version it started with. A resume whose runtime version
differs is **refused** (`resume.runtime-version-changed`) rather than continued on assumptions about
behaviour that may have changed. To move a run across runtime versions, start a new run: the plan and
session are ordinary PlanStore/SessionStore records and stay readable (§3).

### 2.3 Removed or changed dependencies

Resolution is content-addressed and fail-closed. During an upgrade, the possible outcomes for a
profile are:

| Situation | Diagnostic | What to do |
| --- | --- | --- |
| A pinned component was edited (typo fix, prompt change, new field) | `dependency.digest-mismatch` | Re-pin deliberately: `hootl profiles validate <file>` prints the digest of the content that was found; paste it and review the change. |
| A pinned component was deleted or renamed | `dependency.missing` | Restore it, or remove the reference from the profile and its nodes in the same change. |
| A pinned component is present but disabled | `dependency.disabled` | Re-enable it for the scope that profile resolves in, or drop the pin. |
| A toolset names a tool that no longer exists | `toolset.tool-unavailable` (registration) / `dependency.tool-unavailable` (resolution) | Update the toolset file; a toolset can never be resolved with a missing tool. |
| A skill has no resolved instructions | `dependency.content-invalid` | Fix the skill's files, then re-pin. |
| Duplicate `(kind,id)` or an ambiguous id | `dependency.duplicate` / `dependency.ambiguous` | Keep exactly one entry; ambiguity never activates. |

Nothing is ever "best effort": a single diagnostic stops activation before a session or plan exists.
The rule for upgrades is therefore simple — **run `hootl profiles validate` after any registry change
and re-pin in the same change**; the examples shipped with the feature are covered by a test that
fails when a pin goes stale (`workflow-profile-examples.test.ts`).

## 3. Persistent data: what changes, and why no migration is required

Evidence for "no migration needed" (the plan asks for either a tested migration or recorded evidence
of no need):

1. **Existing stores do not change shape.** Profile runs reuse `PlanStore` and `SessionStore`
   unchanged; the Phase 7 parity suite reads a plan and session written by a legacy run and continues
   in the same session, and asserts the persisted step statuses and the session link are the same
   (`workflow-profile-parity.test.ts`, "reuses legacy plan and session data, and rolls back to the
   legacy path on demand"). There is no new field written into plans or sessions and no format bump.
2. **The new run-state record is additive and opt-in.** `FileWorkflowProfileRunStateStore` writes one
   JSON file per run into a **caller-supplied** directory (hashed file name, `<runId>` based). An
   installation that never passes a state store never has those files; an older build that finds them
   ignores them (nothing scans that directory unless a caller wired the store). See §7 for how a run
   gets one today.
3. **A resume re-verifies everything it depends on** (`evaluateWorkflowProfileResume`), refusing to
   continue when any of these no longer match: profile id, canonical profile hash (the profile
   *bytes*, so a version bump with identical content is caught too), schema version, runtime version,
   every dependency pin (`resume.dependency-missing` / `resume.dependency-changed`), and the
   authority snapshot (`resume.authority-increase`). A pending side-effect marker refuses an
   automatic retry (`resume.ambiguous-effect`). `workflow-profile-lifecycle.test.ts` covers the
   positive and negative cases; `workflow-profile-upgrade.test.ts` (3 tests) drives the crash
   scenario through the real Orchestrator: the interrupted record is written before the first node,
   the resumed attempt re-runs the approval node and asks the user again, a decline stops the run
   with nothing executed, a changed profile is refused before the user is asked, and a stored
   approval record is never read back as authority.
4. **Rollback is data-safe.** Since nothing existing was rewritten, rolling the feature back (flag
   off, no selection) leaves every legacy artifact readable, as the parity suite demonstrates on both
   the read and the write side.

**Verdict: no persistent-state migration is required.** The records this feature adds are new,
additive, and opt-in; the records it reuses are unchanged.

## 4. Rollout procedure (opt-in, staged)

Recommended order for a project or an organisation; each step is reversible on its own.

1. **Author and validate** — write the profile under `<project>/.hootl/workflow-profiles/` (or the
   operator directory) and run `hootl profiles validate <id|file>`. Exit 0 means schema, semantics,
   dependency pins and toolsets all resolve. Nothing has executed.
2. **Inspect the surface** — `hootl profiles list --trust-project` shows every profile the project can
   select, with its scope, file and graph size, and reports broken files without failing.
3. **One run, explicitly** — `hootl run --profile <id> "…"` (interactive confirmation still applies)
   or `POST /api/run { profile }`. Confirm the report and the session record; the run is on the
   profile path only if it was selected.
4. **Check the numbers** — budgets are enforced per dimension with counters charged before each call;
   `hootl usage` and the plan/session records show what actually ran.
5. **Team/org rollout** — put the profile in the operator directory (`HOOTL_WORKFLOW_PROFILES_DIR`) or
   distribute it with the project and require `--trust-project`, then document the id in your own
   runbook. The flag stays per-run; there is no process-wide enablement, and the built-in default
   remains gated by the recorded approval.
6. **Observability** — a profile run reports its node sequence, loop counters, budget counters, tool
   and model usage through the existing event path (Phase 6) and its result through the existing
   report/interaction records; secrets and raw prompt text are not written (asserted end to end by
   `workflow-profile-adversarial.test.ts`).

## 5. Rollback

| Action | Effect | What it does *not* undo |
| --- | --- | --- |
| Stop selecting the profile (`--profile` / API field removed) | Runs take the legacy path | Nothing to undo: the legacy path was never removed |
| Unset `HOOTL_WORKFLOW_PROFILE` | The profile path resolves nothing at all | — |
| Remove/move the profile file | Discovery reports it as missing; selection refuses (`selection.profile-missing`) before any work | Runs already completed keep their plans/sessions |
| Unset `HOOTL_WORKFLOW_PROFILES_DIR` | The operator directory is no longer scanned | — |
| Revert to an earlier build | Reads the same plans/sessions (no format change); ignores run-state files it does not know | — |
| **Not reversible** | Side effects a profile run already performed (files written, git operations, external calls) | Those are ordinary tool actions; use the existing checkpoint/rollback tooling for file effects |

Downgrade safety, explicitly:

- **No repeated side effects.** A downgrade does not re-run anything; and a resume that finds a
  pending-effect marker refuses to continue automatically instead of guessing
  (`resume.ambiguous-effect`).
- **No raised authorization.** Effective tools/approvals/budgets are the strictest of
  runtime ∩ persona ∩ toolset ∩ profile; a resume also compares the authority snapshot and refuses a
  policy that became *wider* (`resume.authority-increase`). Nothing in a downgrade path can expand
  access.

## 6. Operating the feature

- **Files**: 1 MiB per profile (checked before parsing), UTF-8, regular files only; toolsets are one
  JSON file per toolset in `<registry layer>/toolsets/`.
- **Registries**: the packaged registry ships no profile and no toolset; project layers add them
  (`registry/personas`, `registry/skills`, `registry/tools`, `registry/models`, `registry/toolsets`).
- **Diagnostics**: `hootl profiles list` never fails on a broken project file; `hootl profiles
  validate` exits 1 for any diagnostic and prints stage/code/message/file. The server answers a bad
  selection with HTTP 400 and the same diagnostic list.
- **Server**: `profile` is per request; the response carries `profileId` when a profile was selected,
  and `GET /api/runs/:runId` reports it. `profileFile` is not accepted over HTTP by design (a
  client-supplied host path would be a file-reading primitive).
- **Approval records**: every approval decision reaches the run record when a state store is
  configured (`nodeId`, `status`, the digest it bound, and the port that digest came from). The
  records are audit data only — a stored approval is never authority, and a resumed attempt re-runs
  the approval node and asks the user again (proved end to end by `workflow-profile-upgrade.test.ts`).
- **Permissions**: profiles and toolsets are untrusted data. A project profile is only read when the
  project is trusted; every component a profile pins is re-verified by content digest before the run
  starts, and the tool surface is re-checked at the real call site.

## 7. Resume: wired into the CLI and the server (Phase 10, U-2)

The durable run-state store is no longer embedder-only. A profile run records itself by default, and
the operator surface reads it back.

**Where a record lives.** `<projectRoot>/.ai-runtime/workflow-profile-runs/` — one JSON file per run,
named by a hash of the run id (`runtimeDir` follows the Orchestrator config, as every other store
does). A run whose host passes `stateStore: null` keeps its state in memory only; nothing else creates
the directory.

**Runtime version (U-1).** A run records the **package version** (`package.json`, through the same
helper the CLI banner uses) unless the host declares `runtimeVersion`. A resume whose recorded version
differs is refused (`resume.runtime-version-changed`), so a run started on one build is never
continued on another.

**What the record contains.** Profile id/version and the hash of the exact profile bytes, schema and
runtime versions, the resolved dependency pins, the authority snapshot, the node sequence and
counters, the approvals (with the digest each decision bound), the plan/session ids, and — when the
profile was selected from a file — that file path. An interrupted run also carries the
`pendingEffect` marker, which is what refuses an automatic retry.

**Operator workflow.**

```bash
hootl profiles runs                 # what this project recorded (status, node, counters, resumable)
hootl profiles runs --json          # the same, machine-readable
hootl run --resume <runId> "…"      # continue an interrupted run (same request text)
```

- The listing is newest-first, skips a record it cannot parse (one bad file never breaks it) and
  marks each row `yes` / `no (pending effect)` / `no (finished)`.
- `--resume` reads the record first, so a missing or finished run fails with exit 1 and the runner's
  own diagnostics (`resume.profile-missing`, `resume.already-terminal`) before anything is created.
- The request text is supplied again: the kernel keeps no cross-run input state, and an interrupted
  run resumes from the node its record names (for a run interrupted before its first node, that is the
  start node — the request is re-entered normally).
- The profile is re-selected exactly as it was: by id, or from the recorded file when the original
  selection was `--profile-file`. The record cannot substitute different content — the resume guard
  compares the profile hash, every dependency pin and the authority snapshot first, and a mismatch
  refuses the resume.
- The run continues in the session its record names when that session still exists, so the
  conversation and the persisted plan stay in one place; the profile run id stays the same, and the
  record ends `success`/`failure`/`rejected`/`cancelled` like any other run.
- `--resume` cannot be combined with `--profile`/`--profile-file` (exit 2): the record names its
  profile. The one deliberate limit kept: a resumed run is re-confirmed by the profile's own approval
  node (a stored approval is never authority), so continuing a run can never execute work the user has
  not seen.

**Server.** `POST /api/run { profile }` records its run state under the server's own run id, so
`GET /api/runs/:runId` and the durable record name the same attempt. Resume over HTTP is deliberately
*not* exposed: continuing a run is an operator action on a project directory (the CLI), not something
a client asks the server to do with a run id it guessed. The file itself stays inside `.ai-runtime`.

**Evidence.** `workflow-profile-resume-wiring.test.ts` (4 tests: the record is written unasked, run
ids do not collide, `stateStore: null` opts out, and the listing/refusal helpers behave);
`workflow-profile-upgrade.test.ts` (3 tests: a stored approval is re-asked, a decline stops the run, a
changed profile is refused); and the committed end-to-end scenario `node e2e/scenarios/run.mjs
profiles`, which kills a real CLI profile run mid-flight, lists the interrupted record, resumes it
with `hootl run --resume`, and checks that the run executed and turned terminal (12/12 checks).

## 8. Release checklist (before activation is requested)

- [ ] All phase statuses in `EXECUTION_PLAN.md` are 🟢 with evidence (Phases 1–9 are).
- [ ] Owner approval recorded for `BUILT_IN_DEFAULT_APPROVAL` before any default activation.
- [x] Behaviour differences decided by the owner (U-4, 2026-09-30): G-5 **accepted**, G-2
      **accepted**, report wording **aligned to the legacy formatter** (implemented), R-3
      **changed** — a `rejected` end before execution reports `cancelled`, after execution `failure`
      (implemented). The missing `plan:clarified` entry was covered by the same decision and stays as
      designed (`PHASE7_PARITY.md` §9–§10, `CHANGELOG.md`).
- [ ] The §7 decision recorded.
- [ ] CI green on the exact head SHA being handed over (`gh run list --json headSha,conclusion`).
- [ ] Release notes read the `[Unreleased] — Workflow Profiles` section.

## 9. Owner decision record (U-4, 2026-09-30): behaviour differences

Asked case by case because each becomes user-visible the moment the default profile is activated.
The owner's answers, and what was implemented for each:

| Item | Answer | Implementation |
| --- | --- | --- |
| G-5 — a confirmation denial *with feedback* cannot re-plan; the run ends | **Accepted** | Unchanged: the denial stays terminal (fail-closed). Covered by the existing hardening suite |
| G-2 — the answer branch ends `success` | **Accepted** | Unchanged: an `answer` outcome reports `success` and keeps the answer in the report |
| Report wording — the profile path printed its own one-line summary | **Align** | Implemented: `formatReviewForUser` (the legacy FINAL REPORT block) plus one trailing line `Workflow profile "<status>" (profile path[, executed])`; the parity suite asserts the shared shape |
| R-3 — a `rejected` end mapped onto the review `failure` outcome | **Change** | Implemented: `rejected` **before** execution ⇒ `cancelled` (a refusal, like a declined confirmation); `rejected` **after** execution ⇒ `failure`. Both directions pinned by the R-3 regression test; the profile's own status always stays in the report line |

Evidence (this head): `src/ai/__tests__/workflow-profile-hardening.test.ts` (R-3 regression, both
directions), `workflow-profile-parity.test.ts` (shared report shape),
`src/server/__tests__/phase8-profile-selection.test.ts` (the API-visible outcome), plus the full
profile/CLI/server sweep. No profile document gained behaviour it did not have: the mapping only
changed which existing review outcome a given end reports.
