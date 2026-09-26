# Unknowns

UNKNOWN-0001
Question: What is the realistic client count / log file size for the SSE endpoints and `logs -f`?
Why it matters: F-0007 (no SSE cap) and F-0011 (full re-parse per fs.watch event) are POSSIBLE — impact depends on scale.
Evidence missing: production telemetry; none in repo.
Attempted: code search for caps/limits (none found); mechanism verified in code.
Blocking factor: runtime measurement impossible in read-only audit (server not started).
Required next evidence: load test or production metrics.

UNKNOWN-0002
Question: Does any deployment bind the web server to a non-loopback interface intentionally (HOTL_PORT/HOST in CI/docker)?
Why it matters: SEC-001 severity (0.0.0.0 default + no auth) depends on deployment exposure.
Evidence missing: no Dockerfile/CI workflow files tracked (verified P1: `.github/` absent from tracked files).
Attempted: file inventory scan for deploy configs; only docs mention `npm run server`.
Blocking factor: deployment artifacts not in repository.
Required next evidence: deployment configuration from the operator.

UNKNOWN-0003
Question: Are there runtime behaviors of real LLM providers (non-fake) that diverge from the fake-llm e2e stub?
Why it matters: test gap — e2e always uses fake-llm (prior audit TEST-001); provider contract drift unprovable statically.
Evidence missing: recorded runs against real providers.
Attempted: static read of list-models/env-endpoint (contracts read); no live calls permitted (A4.3).
Required next evidence: one recorded e2e run per provider.

UNKNOWN-0004
Question: Baseline typecheck/test run — BLOCKED because node_modules is not installed in this workspace and network install is outside read-only scope.
Why it matters: P2 compensating static checks passed (599 imports resolved, scripts valid), but a full tsc/vitest run would strengthen the baseline.
Attempted: static import resolution (scripted, 0 unresolved), package.json script path validation.
Required next evidence: `bun install && bun tsc -b --noEmit && bun test` output.
