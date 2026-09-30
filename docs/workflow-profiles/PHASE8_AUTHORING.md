# Phase 8 — authoring, validating and selecting a Workflow Profile

This guide is the self-contained reference for writing a Workflow Profile by hand. It describes
exactly what the runtime in this repository accepts: **JSON only** (the schema shipped next to this
file), no DSL, no expression language, no editor, no `eval`. Everything a profile can do is a
declaration; every decision that matters (authorization, approvals, budgets) is *narrowed* by a
profile, never widened.

Authoring is opt-in end to end. `HOOTL_WORKFLOW_PROFILE` stays off unless a run selects a profile
explicitly, so an existing project that adds profile files changes nothing until somebody runs
`hootl run --profile …`.

Contents: [1 Files and scopes](#1-where-profiles-live) · [2 Skeleton](#2-document-skeleton) ·
[3 Nodes](#3-node-kinds) · [4 Ports and mapping](#4-ports-and-mapping) ·
[5 Routing](#5-routing-predicates-and-defaults) · [6 Loops](#6-bounded-loops) ·
[7 Approvals](#7-approvals-and-the-human-gate) · [8 Budgets](#8-budgets) ·
[9 Errors](#9-error-policy) · [10 Dependencies](#10-dependencies-and-pins) ·
[11 Extensions](#11-x--extensions) · [12 Validate and select](#12-validate-and-select) ·
[13 Examples](#13-examples) · [14 Troubleshooting](#14-troubleshooting) ·
[15 Versions](#15-version-compatibility)

## 1. Where profiles live

| Source | Path / variable | Scope | Precedence |
| --- | --- | --- | --- |
| Project | `<projectRoot>/.hootl/workflow-profiles/*.json` | `project` | read **only** with the trust opt-in (`--trust-project` / the trust record) |
| Operator | `HOOTL_WORKFLOW_PROFILES_DIR` or `--profiles-dir <dir>` | `user-selected` | after project |
| One file | `--profile-file <path>` (or `hootl profiles validate <path>`) | `user-selected` | explicit |

Rules that follow from that table:

- A project profile is **untrusted data**. It cannot override a user selection, cannot widen tools
  or approvals, and is never executed while the project is untrusted: without the opt-in the file
  is not even read, and `hootl profiles list` says so.
- Selection precedence is fixed: **explicit selection** (`--profile`/`--profile-file`) → the
  opted-in **project default** (the project's single project-scoped profile, and only when the
  project is trusted and no profile was named) → the **built-in default**. The built-in default is
  shipped with an approval record that is not yet approved, so today it refuses to activate; see
  `PHASE7_PARITY.md` §9 for the recorded differences and the owner gate.
- Broken files never take a project down: discovery collects diagnostics. Selection, however, is
  fail-closed — a profile that failed to load is simply not selectable.

## 2. Document skeleton

```jsonc
{
  "$schema": "./workflow-profile.schema.json", // optional, informational
  "schemaVersion": "1.0.0",                    // required; major must be 1
  "profile": { "id": "…", "name": "…", "version": "1.0.0", "author": "…", "description": "…" },
  "dependencies": [ /* see §10 — required, may be an empty list */ ],
  "workflow": { "startNode": "request", "nodes": [ /* ≤100 */ ], "edges": [ /* ≤300 */ ] },
  "policies": { "execution": { /* §8 */ }, "tools": { /* §10 */ }, "approvals": { /* §7 */ } },
  "result": [ /* one entry per end node, §4 */ ]
}
```

Hard limits enforced by the loader before anything else happens:

- **1 MiB per file** (`1,048,576` bytes, `MAX_WORKFLOW_PROFILE_BYTES`), checked *before* parsing —
  a file at the cap is rejected, not truncated.
- UTF-8 only; a file that is not a regular file, changes while being read, or is unreadable fails
  closed.
- Validation runs in stages — read → UTF-8 → parse → schema (`schemaVersion` first) → semantics →
  dependency resolution — and **all** diagnostics are reported, not just the first.

## 3. Node kinds

Exactly seven kinds exist in v1. Adding an eighth is a runtime change (a handler plus kernel and
runtime tests), not an authoring change — there is no plug-in mechanism.

| Kind | Purpose | Required bindings | Notable config |
| --- | --- | --- | --- |
| `intake` | Carries the run request into the workflow. | — | `classification` |
| `planner` | Decides plan / answer / clarify. | `personaRef` | `mode: decompose \| direct`, `maxPlanItems` |
| `execute` | Performs the confirmed plan inside the granted capabilities. | exactly one of `personaRef` / `personaSource: "plan-step"` | `mode`, `requireApprovalForSideEffects` |
| `review` | Judges the result against a pinned rubric. | `personaRef` + `rubricRef` | `allowedDecisions` must match the rubric's decision domain |
| `condition` | Data-only branch: evaluates its `predicate` against its **inputs**, emits `matched`. | — | `predicate` |
| `approval` | The only human interaction node. | — | `prompt`, `approvalType`, `responseKind`, optional `bindsTo`, `show`, `timeoutSeconds` |
| `end` | Terminates the run with an outcome and an explicit `emit` map. | — | `outcome`, `emit` |

`condition` nodes pass their inputs through unchanged (declare them as outputs as well) and are
routing only: they never call a model or a tool. The workflow must start at an `intake` node, must
contain at least one `end`, and every declared node must be reachable — unreachable nodes and
unmapped end nodes are validation errors, not warnings.

## 4. Ports and mapping

- Port types: `string`, `number`, `integer`, `boolean`, `object`, `array`, `file`, `artifact`,
  `any`. A port may declare a closed `enum` of scalars (1–50 values).
- `required` is a contract: a mapping may only leave a required input unfilled when no edge can
  reach that node without the value; the validator reports `mapping.required-input-missing`.
- Every edge declares `map`, an object of `targetInputPort → "/sourceOutputPort"`. Pointers address
  **exactly one top-level declared port** (`/request`, not `/request/goal`); deeper pointers are
  rejected with `*.pointer-depth` and undeclared names with `*.port-missing`.
- Types must be compatible end to end (`mapping.type-mismatch`), including `end.emit`: an `end`
  node's `emit` maps each of its *output* ports to one of its *inputs*, and the two must have the
  same type.
- `result` entries (`fromNode`, `port`, `kind`, `outcome`) describe what the run reports. Every end
  node needs an entry, the outcome must match the node's configured outcome, and the port must
  exist (`result.end-unmapped`, `result.outcome-mismatch`, `result.port-missing`).

## 5. Routing, predicates and defaults

Outgoing edges are evaluated by **ascending `priority`** (default 100), then by declaration order;
the first predicate that is true wins. One `default: true` edge per source node covers the case
where no conditional edge matched — and it may not also carry a `when`.

- Operators: `exists`, `not-exists`, `equals`, `not-equals`, `in`, `not-in`, `greater-than`,
  `greater-or-equal`, `less-than`, `less-or-equal`, `contains`.
- Predicates address one top-level scalar port of the **source node's output**, e.g.
  `{ "path": "/kind", "operator": "equals", "value": "plan" }`.
- **No route matched ⇒ the run fails closed.** There is no implicit fallback and no "do nothing"
  branch; `route.implicit-fallback` is an error.
- A predicate that can never be true (`predicate.type-mismatch`), a route into an `end` node that
  has outgoing edges (`edge.from-end`), or a route back into the start node (`edge.to-start`) are
  validation errors.
- Overlap is allowed and deterministic: two predicates may both be true, and priority + declaration
  order decide. It is not an ambiguity error.
- Every decision a `review` node can return must be routable (`review.decisions-unrouted`), and a
  route domain that is not exhaustive needs a default (`route.domain-not-exhaustive`).

## 6. Bounded loops

A loop is declared on the edge that is traversed repeatedly:

```json
{
  "from": "review", "to": "plan",
  "when": { "path": "/decision", "operator": "equals", "value": "revise" },
  "map": { "context": "/reason" },
  "label": "review-fix",
  "loop": { "maxIterations": 1, "counterId": "review-fix-rounds", "onExhausted": { "strategy": "fail" } }
}
```

- `maxIterations` is 1–20 and required; one iteration is one successful traversal of that edge.
- `counterId` must be unique across the profile (`loop.counter-duplicate`).
- `onExhausted.strategy` is `fail` (terminate the run) or `route` (continue to `to` with its own
  `map`). Exhaustion is a control transition and is included in cycle analysis.
- Every cycle must contain a bounded loop edge; `workflow.unbounded-cycle` rejects the rest.
- The static check `budget.static-node-visits` compares a conservative visit bound
  (`|nodes| × (1 + maxIterations)`, summed over loops) with `policies.execution.maxNodeVisits`.
  Raise the budget or shorten the loop — never the other way round: the runtime cap can only be
  tightened by outer layers, never raised by the profile.

## 7. Approvals and the human gate

An `approval` node is the only place a profile can ask a human for something.

- `approvalType`: `continue` (informational), `side-effect` (must gate a side effect),
  `custom`.
- `responseKind`: `decision` (produces the `decision` object port) or `text` (produces the `answer`
  string port). A `side-effect` approval **must** bind to an input port with `bindsTo`, and the
  runtime re-verifies that port's content digest before the effect proceeds.
- `show` lists the input ports rendered to the user; `prompt` is static, non-interpolated text
  (≤1000 chars); `timeoutSeconds` bounds the wait.
- A denial, a timeout or a cancellation **fails the node terminally**: the kernel never routes or
  retries a denied approval, and no profile can configure that away.
- An approval can only tighten what the runtime already requires. That is also why
  `bindsTo` requires `responseKind: "decision"` (a decision can carry the digest that was
  displayed); a text answer has no such binding and therefore cannot gate an effect.
- Known v1 limitation (G-5, recorded in `PHASE7_PARITY.md` §9): a plan confirmation *denied with
  feedback* cannot re-plan. Predicates address one scalar port, and a decision is an object, so no
  route can branch on its content; feedback ends the run fail-closed instead.

## 8. Budgets

```json
"execution": {
  "maxNodeVisits": 80, "maxDurationSeconds": 3600,
  "maxModelCalls": 100, "maxToolCalls": 200, "onLimit": "fail"
}
```

- Counters are consumed **before** the call they bound; the effective cap of each dimension is the
  strictest of runtime, session/user and profile values. Nothing can reset a counter mid-run, and
  no layer below the profile can raise it.
- `onLimit`: `fail` (default), `ask-user`, `handoff`. `ask-user` pauses in a resumable
  waiting-for-user state and does not grant approval or bypass policy.
- `policies.tools.allowedToolsets` lists the toolsets this profile may bind; `deniedTools` removes
  specific tool ids. The effective tool surface is
  `intersection(Runtime, Persona.allowedTools, Toolset) \ deniedTools` — a profile that names no
  toolset adds no narrowing (the built-in default uses `[]` for exactly that reason), and a
  `toolsetRef` that is not listed in `allowedToolsets` is an error (`toolset.not-allowed`).
- `policies.approvals.policy` is `runtime-default`, `side-effects` or `every-tool-call`, with an
  optional `requireUserConfirmationFor` list of effect classes. Again: strictest wins.

## 9. Error policy

Any node may declare an error policy:

```json
"onError": {
  "strategy": "route", "routeTo": "review",
  "routeMap": { "summary": "/failure/code", "status": "/failure/category" }
}
```

- `strategy`: `fail` (default), `retry` (bounded, with `retryOn: ["technical", "timeout",
  "rate-limit"]`) or `route`.
- `route` sends the failure to another node through a **sanitized envelope** (`/failure/code`,
  `/failure/category`, `retryable`) — never a raw exception, provider message or secret.
- Authorization denial, approval denial and cancellation are terminal: they are never retried and
  never routed, whatever `onError` says.

## 10. Dependencies and pins

Every component a profile mentions must be declared and pinned:

```json
{ "kind": "persona", "id": "planner", "version": "1.0.0", "digest": "sha256:<64 hex>" }
```

- `kind` ∈ `persona`, `skill`, `toolset`, `rubric`, `model-profile`.
- The **digest is required**. It is the SHA-256 of a canonical envelope over the exact resolved
  component content (`profile-digest.ts`), so any change to the component — including one unknown
  field — breaks the pin. `version` is metadata for humans; it never substitutes for the digest.
- Every reference in the document (`personaRef`, `skillRefs`, `toolsetRef`, `modelProfileRef`,
  `rubricRef`) must have a matching dependency entry (`dependency.reference-missing`), and no
  `(kind, id)` may be declared twice (`dependency.duplicate`).
- Resolution fails closed with aggregated diagnostics: a missing component, an ambiguous id, a
  disabled component, a stale digest, or a skill without resolved instructions all prevent
  activation. Nothing runs "partially".
- Getting the digest: run `hootl profiles validate <file>` — a `dependency.digest-mismatch`
  diagnostic prints the digest of the content that was found, which is what you paste back.

## 11. `x-` extensions

Keys matching `x-[a-z0-9][a-z0-9._-]{0,63}` may appear on the document, nodes and edges for
tooling notes. Values must be **non-executable scalars** (string ≤1024 chars, number, boolean or
null), at most 16 per object. Extensions are never interpreted by the runtime and never influence
routing, policy or authorization.

## 12. Validate and select

```bash
hootl profiles list [--project-root DIR] [--trust-project] [--profiles-dir DIR] [--json]
hootl profiles validate <id|path/to/profile.json> [--project-root DIR] [--trust-project] [--json]

hootl run --profile <id> "…"            # explicit selection for one run
hootl run --profile-file <path> "…"     # explicit selection by file
hootl run "…"                           # no selection: the legacy path, unchanged
```

- `list` shows id, scope, name, version, graph size and file, plus every diagnostic it found, and
  never fails on a broken project file.
- `validate` exits 1 when there is any diagnostic — use it in CI; a profile that does not resolve
  is not selected.
- Selection is **the** opt-in: `--profile`/`--profile-file` turns `HOOTL_WORKFLOW_PROFILE` on for
  that run through the gated activation path, and nothing else does. A run without a selection
  never resolves a profile at all.
- Both selection flags are mutually exclusive. Unknown ids, broken/unreadable files, a missing
  `--profile-file`, an untrusted project profile, and every validation or resolution error all fail
  **before** a session or a plan is created.

## 13. Examples

Two examples are shipped, and both are validated by the test suite
(`src/ai/__tests__/workflow-profile-examples.test.ts`) through the same loader, resolver and CLI
path described above. They carry **real pins** of the content in `registry/`, so a change to a
pinned component fails that test until the example is re-pinned — which is exactly the feedback an
author gets.

| Example | What it demonstrates |
| --- | --- |
| [`examples/answer-only.example.json`](examples/answer-only.example.json) | The smallest useful profile: intake → planner → answer/clarify. It has no `execute` and no `review` node, so it *cannot* perform a side effect; the clarification loop is bounded at 3 rounds. |
| [`examples/bounded-review-fix.example.json`](examples/bounded-review-fix.example.json) | The full work profile: digest-bound plan confirmation, execution with the `plan-step` persona source, error routing into review, and exactly one bounded re-plan loop (`review` → `plan`, `maxIterations: 1`, fail when exhausted). |

Validate either one straight from the repository:

```bash
hootl profiles validate docs/workflow-profiles/examples/bounded-review-fix.example.json
# ✓ Workflow profile "example.bounded-review-fix" is valid and all dependencies resolve.
```

The `*.example.json` files directly in this directory are different: they are schema/semantic
**fixtures** with deliberate placeholder digests, used by the schema and semantic suites. They are
not resolvable and not meant to be selected.

## 14. Troubleshooting

| Diagnostic | Cause | Fix |
| --- | --- | --- |
| `schema-version.unsupported` | `schemaVersion` is not `1.x.y` or uses a minor this runtime does not know | write the version this repository documents, or upgrade the runtime |
| `file.too-large` | file above 1 MiB | split the profile; the cap is checked before parsing |
| `dependency.digest-mismatch` | pinned content changed (or the pin was copied from another registry) | re-pin with the digest from `hootl profiles validate` |
| `dependency.missing` / `dependency.disabled` | the component is not in the resolved registries | add/rename it in the registry, or drop the reference |
| `bindings.persona-binding-missing` | `planner`/`review` without `personaRef`, or `execute` with neither of the two allowed forms | add `personaRef`, or `personaSource: "plan-step"` for `execute` |
| `toolset.not-allowed` | `toolsetRef` not listed in `policies.tools.allowedToolsets` | list it — the profile can only narrow, never add |
| `mapping.type-mismatch` / `end.emit-type-mismatch` | a value of a different type is routed into a port | align port types, or route through a `condition` node |
| `route.implicit-fallback` / `route.domain-not-exhaustive` | a decision can fall through with no matching edge | add the missing predicate edge or one `default: true` edge |
| `workflow.unbounded-cycle` | a cycle without a loop edge | add `loop` with `maxIterations` and a unique `counterId` |
| `budget.static-node-visits` | the conservative visit bound exceeds `maxNodeVisits` | raise the budget or shorten the loop |
| `project-profile.opt-in-required` | a project-scoped profile was selected without trust | run with `--trust-project`, or move the file to the operator scope |
| `selection.profile-missing` | the id was not discovered (typo, wrong scope, untrusted project, or the file failed to load) | run `hootl profiles list` and read the diagnostics |

## 15. Version compatibility

- `schemaVersion` is `1.x.y`: the major must match the runtime's contract. The loader checks it
  *before* the full schema, so an old runtime refuses a newer document with a dedicated diagnostic
  instead of a confusing field error.
- Pins are content-addressed. Updating any pinned component is a deliberate re-pin in the same
  change; nothing re-pins itself.
- A run's profile id, version, canonical digest and resolved dependency digests are recorded in the
  lifecycle state; a resume verifies them and refuses to continue if the profile, its content or its
  dependencies changed (`PHASE6_LIFECYCLE.md`).
- Nothing in a profile can enable a feature: activation still requires the flag plus a selection,
  and the built-in default additionally requires a recorded owner approval.
