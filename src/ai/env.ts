/**
 * Phase 27 (CFG-08): injectable environment source.
 *
 * Secrets and host configuration used to be read straight from
 * `process.env` inside the provider factories and the MCP connector —
 * which made an Orchestrator impossible to run against a different
 * environment (tests, multi-tenant servers, sandboxes) without mutating
 * global process state.
 *
 * Everything that needs an environment value now takes an optional
 * `EnvSource`.  When omitted, the live `process.env` object is used, so
 * every existing call site keeps its exact previous behaviour.
 *
 * This module sits at the ai/ root (not in runtime/) so the registry
 * layer can use it without depending on the runtime layer — see the
 * architecture gate in hardening-multi-perspective.test.ts.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the effective environment for a call: the injected source when
 * present, otherwise the live process environment.
 *
 * `process.env` is read through the object reference (not snapshotted at
 * module load), so values assigned later — e.g. by the CLI's
 * `loadConfigIntoEnv` — are still visible.
 */
export function resolveEnv(env?: EnvSource): EnvSource {
  return env ?? process.env;
}

