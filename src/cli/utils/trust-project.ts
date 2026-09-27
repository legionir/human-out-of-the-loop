/**
 * A-02 — persist and resolve the R0-08 project-trust flag.
 *
 * `Orchestrator` already skips the project `registry/mcp-servers` layer
 * unless `trustedProject:true`. This helper is the CLI/server wiring:
 * `--trust-project` writes the project root into
 * `~/.human-out-of-the-loop/config.json` (`trustedProjects`) so later
 * invocations (and the three introspection paths in A-03) see it.
 */
import { isProjectTrusted, withTrustedProject } from '../../ai/registries/trust.js';
import { loadGlobalConfig, saveGlobalConfig } from './config.js';

/**
 * When `trustNow` is set, persist `projectRoot` as trusted (idempotent)
 * and return true. Otherwise return whether it is already on the list.
 */
export function resolveAndMaybePersistTrust(projectRoot: string, trustNow: boolean): boolean {
  const cfg = loadGlobalConfig();
  if (trustNow) {
    const next = withTrustedProject(projectRoot, cfg);
    if (next.trustedProjects !== cfg.trustedProjects) {
      saveGlobalConfig({ ...cfg, trustedProjects: next.trustedProjects });
    }
    return true;
  }
  return isProjectTrusted(projectRoot, cfg);
}

export function isCurrentProjectTrusted(projectRoot: string): boolean {
  return isProjectTrusted(projectRoot, loadGlobalConfig());
}

/** Message used by every introspection path that would otherwise spawn. */
export function untrustedProjectMcpMessage(serverId?: string): string {
  const target = serverId ? `MCP server "${serverId}"` : "this project's registry/mcp-servers";
  return (
    `Refusing to connect to ${target} in an untrusted project. ` +
    'Pass --trust-project (once) to allow the project-layer MCP servers to spawn.'
  );
}
