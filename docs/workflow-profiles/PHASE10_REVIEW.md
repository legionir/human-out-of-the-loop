# Phase 10 Step 3 — review record (agent-performed; the independent human review is still required)

The plan asks for an independent architectural, QA, security, operations and compatibility review
before handoff. This document is the **agent's** review of the finished feature: what it checked, what
it found, and what it cannot certify. It is explicitly **not** the independent review the plan means —
a reviewer other than the implementer has to sign that off (`TRACEABILITY.md` §3, U-items).

Every claim below is traceable to a file, a test or a CI run; nothing was re-derived from memory.

## 1. Architecture

| Question | Finding |
| --- | --- |
| Is there exactly one scheduler for the inner DAG? | Yes. The profile kernel schedules the *outer* graph only; every plan is executed by the Orchestrator's own `PlanRuntime` through `orchestrator-adapters.ts` (`createExecutorPort` wraps `services.planRuntime`, D-WP-008). `workflow-profile-bridge.test.ts` and `workflow-profile-orchestrator.test.ts` drive that seam. |
| Does the profile path duplicate lifecycle services? | No. The bridge builds ports over the Orchestrator's own planner, executor, reviewer, acceptance checker and approval callback; a missing service fails closed (`*.service-missing`) instead of substituting a stub. Plan/session persistence happens in the caller via `onPlan` before anything executes. |
| Is the new public surface small? | `hootl profiles list|validate`, `hootl run --profile/--profile-file`, `POST /api/run { profile }`, plus module-level exports under `src/ai/workflow-profiles/`. No new scheduler, no generic façade. |
| Any place where profile content influences policy? | No. Profile text is confined data (`untrusted-content.ts`), authorization is intersected and re-checked at the call site, approvals are digest-bound, and budgets take the strictest cap. |

Residual architectural risk: the resume surface is not wired into the CLI/server (U-2); see §5.

## 2. QA / test evidence

- Per-phase suites (file → tests): resolver 16, toolsets 4, sources 5, kernel 16, predicate 8,
  handlers 17, injection 8, untrusted-content 6, adapters 10, lifecycle 17, budget 11, enforcement 10,
  parity 9, bridge 6, default-profile 11, activation 8, orchestrator 4, discovery 6, schema 10,
  semantic 28, registry 19, mcp-ids 4, examples 9, hardening 9, adversarial 7, upgrade 3, plus the CLI
  (`phase8-profiles`) and server (`phase8-profile-selection`, 8) suites.
- Whole-tree local run: profile + CLI + server **50 files / 571 tests**; CI-equivalent command
  **149 files / 1,980 tests**, the only red test being the pre-existing `J-05` (U-6).
- The suites are written to be able to fail: the hardening suite reddens when the execution gate is
  disabled (recorded during implementation), and the CI gate's negative controls fail if the
  validators stop refusing (unknown key, non-v1 node kind, unbounded loop, dangling error route).
- Parity is asserted against the scripted model on both paths (plan, answer, clarification,
  cancellation, acceptance-failure/re-plan, tool authorization, review summary, load error).

## 3. Security

| Boundary | Evidence |
| --- | --- |
| Untrusted data cannot act | `workflow-profile-injection.test.ts`, `workflow-profile-untrusted-content.test.ts`, and the adversarial suite's injected-persona case (the step agent still receives exactly `['read_file']`) |
| Tools can only narrow | `workflow-profile-toolsets.test.ts`, `workflow-profile-enforcement.test.ts`, adversarial toolset cases (intersection; unknown tool refused pre-execution) |
| Approval is bound to the shown plan | `createApprovalPort` echoes the shown digest; `assertExecutable` requires it; hardening suite includes the "no approval node" and "digest dropped" refusals and a positive control |
| A stale approval is never authority | `workflow-profile-upgrade.test.ts`: the resumed attempt re-runs the approval node and asks again; a stored record is audit data |
| Denial/cancellation is terminal | hardening suite: `security-denied` cannot be routed around by `onError`; a cancelled run never reaches review |
| Secrets do not leak | adversarial suite: a provider error embedding a key leaves the report, the session JSON and `observability.jsonl` clean, and nothing executes |
| Resource ceilings act before consumption | `workflow-profile-budget.test.ts` per dimension; the bench's spent-budget row shows the planner uncalled |
| File handling | 1 MiB cap before parsing, regular files only, identity checks across the open (O_NOFOLLOW where available); `workflow-profile-registry.test.ts` |

Residual security risk (recorded, not mitigated): host-root writability is an operator property (U-5);
project profiles require explicit trust and every component is digest-verified, but a directory
writable by another local user is outside what the loader can prove.

## 4. Operations

- Everything is default-off and per-run; a legacy run pays one flag read (measured p50 0.000 ms).
- Rollback is "stop selecting"; no legacy path was removed and no persisted format changed
  (`PHASE10_OPERATIONS.md` §3, §5).
- Observability reuses the existing event path; the profile path adds node-sequence, loop, budget and
  resume events but no new secret-bearing surface.
- Diagnostics are uniform across CLI and server (`stage`, `code`, `message`, `file`, `profileId`), and
  a bad selection creates nothing.

## 5. Compatibility

- **CLI:** no existing flag, output or exit code changed for runs that do not pass `--profile`.
- **Server:** `POST /api/run` without `profile` behaves as before; the response only gains `profileId`
  when a profile was selected; `profileFile` over HTTP is refused by design.
- **Persistence:** plans and sessions are unchanged in shape and are read/written by both paths
  (parity suite, read and write). The run-state record is new, additive and opt-in.
- **Defaults:** `HOOTL_WORKFLOW_PROFILE` off; the built-in default refuses to activate
  (`BUILT_IN_DEFAULT_APPROVAL.approved === false`).
- **Behaviour differences** that a user of a *selected* profile will see are recorded and need the
  owner's acceptance (U-4): G-5, G-2, report wording, absent `plan:clarified`, and the
  `rejected`-end → `failure` review mapping.

## 6. What this review cannot certify

1. **Independent review.** A reviewer other than the implementer must confirm the above; the plan
   requires it and this file does not substitute for it.
2. **U-1/U-2/U-3/U-4/U-5** decisions in `TRACEABILITY.md` §3 — each needs the owner before activation.
3. **Real-provider behaviour.** Every end-to-end run here uses the scripted/stub model; no provider
   call was made (no key, and the plan forbids claiming provider-verified results without one).
4. **Cross-platform.** Behaviour is verified on Linux (sandbox) and by CI on ubuntu/macos/windows
   (Node 22/24/26 for unit+integration; 22 for e2e) for the heads listed in the phase records; no
   manual Windows/macOS run was performed by this review.
5. **Load/soak behaviour** beyond the measured micro-benchmarks: no multi-hour run was performed.

## 7. Review verdict

**Ready for handoff, not for activation.** All ten phases are implemented, tested and documented;
the default remains off; the open items above are decisions and environment properties, not
implementation gaps. Recommend: independent review against this document, then the owner's U-item
decisions, then — only with explicit authorisation — activation and merge.
