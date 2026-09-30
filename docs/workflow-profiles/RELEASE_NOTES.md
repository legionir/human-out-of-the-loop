# Release notes — Workflow Profiles (unreleased, opt-in)

This is the owner-facing summary of the Workflow Profiles work: what is in the tree, what a user
sees, what is still gated, and what must be accepted before anything is activated. It is written to
match the implementation and the suites named in `TRACEABILITY.md`; nothing here is activated by
merging the branch.

**Activation state: off by default.** `HOOTL_WORKFLOW_PROFILE` is unset, the built-in default has
`BUILT_IN_DEFAULT_APPROVAL.approved === false`, and no CLI or server code path selects a profile
unless the user asks for one.

## 1. What ships

- **A declarative, JSON-only flow document.** Exactly seven node kinds (`intake`, `planner`,
  `execute`, `review`, `condition`, `approval`, `end`) with typed ports, first-match routing by
  ascending priority then declaration order, bounded loops, and typed `fail`/`retry`/route error
  policies. No DSL, no `eval`, no executable conditionals, no inheritance, templates, sub-workflows,
  recursion or parallelism.
- **Everything is pinned.** Every component a profile names (persona, skill, toolset, model config,
  rubric) is resolved by content digest before the run starts; a missing, changed or disabled
  component fails closed with `dependency.*` diagnostics.
- **Authorization can only narrow.** The effective tool surface is
  `runtime ∩ persona ∩ toolset − denied`, enforced again at the real call site; approval is bound to
  the digest of the plan the user was shown, and a resumed run re-asks (a stored approval is never
  authority). Budgets are the strictest per-dimension cap and counters never reset across loops,
  retries or resumes.
- **Untrusted content stays data.** Profile text, project-layer personas and clarification answers
  are confined when they enter a prompt; they cannot change system policy or the tool surface.
- **Durable, resumable runs.** Every profile run records itself under
  `<projectRoot>/.ai-runtime/workflow-profile-runs/`; `hootl profiles runs` lists them (status, node,
  counters, whether it can be resumed) and `hootl run --resume <runId> "…"` continues an interrupted
  one — re-selecting the same profile content (by id, or from the recorded file) and continuing its
  session. Nothing is auto-retried: a pending effect refuses continuation, and a run that already
  finished is refused as history.
- **Authoring and operations surfaces.** `hootl profiles list|validate|runs`, `hootl run --profile
  <id>|--profile-file <path>|--resume <runId>`, `POST /api/run { profile }`, operator
  (`HOOTL_WORKFLOW_PROFILES_DIR`) and project (`.hootl/workflow-profiles`, trust-gated) discovery,
  plus three shipped examples (`answer-only`, `bounded-review-fix`, `error-route`) that pass the
  schema, the semantic validator and dependency resolution in CI.
- **The default profile reproduces today's flow** — plan → digest-bound confirmation → execution by
  `PlanRuntime` (still the only inner-DAG scheduler) → review — with the parity suite comparing both
  paths on the same scripted model.

## 2. How to turn it on (all opt-in, all reversible)

```bash
# One run, explicit selection (nothing changes for anyone who does not pass this):
hootl run --profile <id> "…"            # a discovered id (operator dir or trusted project)
hootl run --profile-file ./flow.json "…"  # an explicit file, CLI/operator only

# Validate before running anything:
hootl profiles validate <id|file>        # exit 1 with stage/code/file on any diagnostic
hootl profiles list --trust-project      # shows scope, file, graph size; never throws on a bad file
```

Server: `POST /api/run { "message": "…", "profile": "<id>" }` behaves exactly like
`hootl run --profile`; `profileFile` is refused over HTTP by design (a client-supplied host path would
be a file-reading primitive). A refused selection answers HTTP 400 with the diagnostic list and
creates nothing.

Trust: project-scoped profiles are read only with the existing project trust opt-in; the operator
directory is the operator's own choice. Digest verification then happens per component regardless of
scope.

## 3. Behaviour differences to accept before activation

These are deliberate, measured differences between a profile run and the legacy path; all are
recorded with evidence in `PHASE7_PARITY.md` §9–§10. **Owner acceptance (U-4) was decided on
2026-09-30** — the acceptance and the two changes it asked for are recorded here and implemented;
the decision record itself is in `PHASE10_OPERATIONS.md` §8.

| # | Difference | Owner decision (2026-09-30) | Why it is there |
| --- | --- | --- | --- |
| G-5 | A confirmation denial with feedback cannot re-plan; the run ends | **Accepted as designed** — the denial with feedback stays terminal and fail-closed | The v1 kernel routes denials to a terminal outcome instead of re-entering the planner with the feedback; introducing a re-plan would be a new approval model |
| G-2 | The answer branch ends `success` (the legacy path reports the answer through its own outcome) | **Accepted as designed** | A profile's `end` declares the outcome; the answer-only shape has no failure to report |
| — | ~~The run report wording differs for the profile path (profile id and node-path phrasing)~~ | **Changed (implemented):** the profile path now reports through the legacy `formatReviewForUser` block, with one trailing line naming the profile status and whether it executed | The owner asked for one report shape; the profile's own status stays visible in that trailing line |
| — | No `plan:clarified` observability entry on the profile path | Accepted with the suite (not raised as a separate item) | The clarification round is an `approval` node with a bounded loop, not the legacy in-planner clarification |
| U-7 | A `handoff`/`ask-user` end maps to the legacy `failure` review/interaction outcome | **Open — owner decision (U-7):** recommended `handoff` → `partial-success` and an `ask-user` pause's interaction stays `pending`; until then the mapping fails closed and the report line keeps the profile status | The legacy review union has no `handoff`; the durable record still marks the pause resumable |
| R-3 | ~~A `rejected` end maps to a `failure` review outcome~~ | **Changed (implemented):** a `rejected` end reached before execution is reported as `cancelled` (a refusal, exactly like a declined confirmation on the legacy path); a `rejected` end **after** execution stays `failure`. The profile's own status is always in the report line | The review union has no `rejected` member; refusing to map it straight onto `failure` was the owner's call |

Nothing else about the legacy path changes, and the parity suite fails if the plan, session, step
agents, execution result or review summary diverge (the differences above are the documented
exceptions).

**Host requirements (U-5, documented 2026-09-30):** the server never accepts `projectRoot` from a
request, every profile/component file is identity-checked and digest-verified, but nothing in code can
prove the operator's directory is unwritable by another local user — run HOOTL in a directory only the
operator can write, and treat the run-state records under `.ai-runtime/workflow-profile-runs/` as
private as the plans and sessions beside them. Details and the exact guarantee/limit split:
`PHASE10_OPERATIONS.md` §4.

## 4. Upgrade, rollback, migration

- **No persistent-state migration is required**: profile runs reuse `PlanStore`/`SessionStore`
  unchanged, and the new run-state record is additive, opt-in and ignored by builds that do not know
  it. The evidence (including the parity read/write proof and the resume guards) is in
  `PHASE10_OPERATIONS.md` §3.
- **Rollback**: stop selecting a profile / unset the flag; there is no legacy path to restore
  because none was removed. A revert to an older build reads the same plans and sessions. Side
  effects already performed by tool calls are the tool layer's own concern (existing rollback
  tooling).
- **Downgrade safety**: nothing is auto-retried, and a resume that finds a pending effect refuses to
  continue (`resume.ambiguous-effect`); a resume whose policy became wider is refused
  (`resume.authority-increase`).

## 5. Known limitations at this release

| ID | Limitation | Where it is recorded |
| --- | --- | --- |
| ~~U-1~~ | ~~No authoritative runtime-version source~~ — resolved: a run records the package version | `PHASE10_OPERATIONS.md` §7 |
| ~~U-2~~ | ~~Resume is embedder-level~~ — resolved: runs record themselves, `hootl profiles runs` lists them, `hootl run --resume` continues one | `PHASE10_OPERATIONS.md` §7 |
| U-3 | The built-in default cannot activate until the owner records the approval | `EXECUTION_PLAN.md`, `default-profile.ts` |
| U-5 | Host-root stability is an operator property (the server never takes a root from a request) | `TRACEABILITY.md` §3 |
| U-6 | A pre-existing checkpoint test (`J-05`) is mtime-resolution sensitive on this sandbox; unchanged by this work, green on CI | `TRACEABILITY.md` §3 |

## 6. Before activation (owner checklist)

- [ ] Accept or defer the behaviour differences in §3 (U-4).
- [ ] Decide the resume surface (U-2) and the Runtime version source (U-1).
- [ ] Record `BUILT_IN_DEFAULT_APPROVAL` (U-3) if the default is to be activated.
- [ ] Confirm the deployment's host-root expectation (U-5).
- [ ] CI green on the exact head SHA being handed over.
- [ ] Merge/release authorisation (standing instruction: merges stay frozen until all phases are
      complete and the owner authorises).
