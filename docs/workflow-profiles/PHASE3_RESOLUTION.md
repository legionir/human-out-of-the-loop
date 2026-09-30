# Workflow Profiles — Phase 3: dependency resolution and named toolsets

**Status:** 🟢 implemented and locally verified (2026-09-30). Phase 3 adds static, pre-activation resolution only: no workflow is activated, no model or tool is executed, and no Runtime authorization decision is made here.

## 1. Scope delivered

| Phase 3 step | Implementation | Tests |
|---|---|---|
| Step 1 — resolver for profile dependencies | `src/ai/workflow-profiles/profile-resolver.ts`, `src/ai/workflow-profiles/profile-digest.ts` | `src/ai/__tests__/workflow-profile-resolver.test.ts` |
| Step 2 — named, versioned toolsets | `src/ai/workflow-profiles/toolsets.ts` | same file (toolset describe block) |

## 2. Sources of truth (no parallel registry)

| Dependency kind | Source of truth | Notes |
|---|---|---|
| `persona` | existing `PersonaRegistry` entry (validated `Persona`) | consumed as-is; profile text is never copied |
| `skill` | existing `SkillRegistry` resolved entry (`ResolvedSkill`) | digest covers the resolved SKILL.md text |
| `model-profile` | existing `ModelRegistry` `ModelConfig` entry (`getConfig`) | registry exposes no version; version metadata is omitted, never invented |
| `toolset` | `ToolsetRegistry` added in Step 2 | named + versioned; tools must exist in the live `ToolRegistry` |
| `rubric` | built-in rubric catalogue (D-WP-010) | see below |

### D-WP-010 — rubric source of truth (recorded 2026-09-30, owner-delegated conservative decision)

The repository has no rubric registry, and the plan forbids creating a parallel registry without a decision. v1 therefore resolves `rubric` references against a **built-in, code-owned catalogue** that mirrors the existing acceptance/final-review decision contract (`pass | revise | reject`), keyed by `id` and `version`, with the exact criteria text included in the digest. Consequences:

- a profile can only reference a rubric that exists in the catalogue and whose content digest it pins;
- user-authored rubrics are **out of scope for v1** and require a separate owner decision plus a schema/registry design before Phase 8 authoring work;
- no rubric text is ever executed; it is data used for the decision-domain comparison.

### D-WP-011 — digest contract (recorded 2026-09-30, owner-delegated conservative decision)

A pin is `sha256:<64 hex>` over a typed envelope:

```
hootl.workflow-profile.dependency.v1
<kind>
<id>
<canonical JSON of the resolved content projection>
```

- canonical JSON: object keys sorted, `undefined` members omitted, array order preserved, `JSON.stringify` scalar forms; cycles, aliases, accessors, non-finite numbers, and non-plain objects are rejected (`DigestInputError`).
- the content projection is every own enumerable field of the validated source record, so unknown/extra fields also break the pin (fail-closed).
- for `skill`, the on-disk `instructions` reference is replaced by the resolved SKILL.md text (and the derived `resolvedInstructions`/`resolvedTools` fields are dropped) so the pin covers the content actually handed to a workflow.
- kind and id are part of the envelope, so identical content under a different kind or id can never satisfy the same pin.
- `version` is optional metadata; when both the pin and the source expose a version they must match exactly. A version never substitutes for the digest.

## 3. Resolution behaviour (fail-closed, aggregated)

`resolveWorkflowProfileDependencies(profile, sources)` returns frozen, pinned dependencies only when every pin matched. Otherwise it throws `WorkflowProfileLoadError` with all diagnostics collected. Diagnostic codes:

| Code | Meaning |
|---|---|
| `dependency.source-missing` | no source of truth wired for that kind |
| `dependency.digest-invalid` | pin is not `sha256:<64 hex>` |
| `dependency.version-invalid` / `dependency.version-mismatch` | malformed pinned version, or source version differs |
| `dependency.missing` | component absent from the registry |
| `dependency.ambiguous` | the id matches more than one entry |
| `dependency.disabled` | component present but disabled by the host |
| `dependency.content-invalid` | non-object record, or a skill without resolved instructions |
| `dependency.digest-mismatch` | content digest differs from the pin |
| `dependency.tool-unavailable` | resolved toolset names a tool the runtime catalog lacks |
| `dependency.rubric-unresolved` / `dependency.rubric-invalid` | review node rubric missing or without a decision domain |
| `dependency.rubric-decision-mismatch` | declared `allowedDecisions` or the `decision` port enum differs from the resolved rubric domain |

Review nodes that declare `allowedDecisions` are compared, as an exact value set, with the digest-pinned rubric's real decisions; when the node also exposes a `decision` output port, its `enum` must match the same set. This closes the Phase 2 gate that deferred rubric-domain equality to resolution.

## 4. Named toolsets (Step 2)

- `ToolsetSchema`: `id` (`^[a-z][a-z0-9._-]{1,127}$`), `version`, 1–200 `tools`, optional `deniedTools`, optional `name`/`description`.
- Registration rejects an unknown tool (`toolset.tool-unavailable`), a duplicate id (`toolset.duplicate-id`), an invalid id/definition (`toolset.invalid`), and unbounded/control-character tool ids.
- `effectiveToolIds()` computes `(Runtime-permitted ∩ Persona.allowedTools ∩ Toolset.tools) − deniedTools − Toolset.deniedTools` and always returns a sorted subset of the runtime-permitted set. A wildcard runtime permission requires an explicit `knownToolIds` universe; otherwise it fails closed.
- Recorded boundary: this is a **static** narrowing computation. Schema/registry validation is not an execution authorization; Phase 6 re-checks the effective set at the real tool call site.

## 5. Evidence

Commands (repo root, Node v22.22.3, `npm ci` from the committed lockfile):

- `npm run typecheck` → pass; `npm run build` → pass.
- `npx vitest run src/ai/__tests__/workflow-profile-*.test.ts` → **5 files, 79 tests passed** (resolver 16, semantic 27, registry 21, schema 11, MCP-ID 4).

Resolver coverage: canonical-JSON determinism and rejection of non-JSON values; kind/id-bound digests; resolution of all five kinds against real repository components (`registry/personas/coder.json`, `registry/models/claude-sonnet.json`, `registry/tools/*.json`, the built-in rubric); digest/version/missing/ambiguous/disabled/malformed failures; skill pins covering resolved SKILL.md text rather than the on-disk reference; toolset re-verification against the live catalog; review-domain equality and mismatch; and rejection of the shipped example pins because their placeholder digests do not match real content.

## 6. Boundaries and open gates

- No Runtime execution, feature flag, handler, Orchestrator adapter, or profile activation is part of Phase 3.
- `inheritance`, `Node Templates`, `Sub-workflows`, `recursion`, and `parallelism/fan-out/join` remain excluded from v1 and are not implemented anywhere in this phase; adding them requires a separate owner decision and version.
- Trusted-host obligations from Phase 2 are unchanged: only trusted host code derives scope and supplies registry roots, and stable, non-attacker-writable roots must be demonstrated before Runtime integration.
- The authoritative Workflow Runtime compatibility/enforcement contract is still undefined and remains a pre-integration gate; `profile.runtime` stays syntax-only metadata.
- User-authored rubrics, digest computation tooling for authors, and profile authoring/discovery UX belong to Phase 8 and are not claimed here.
