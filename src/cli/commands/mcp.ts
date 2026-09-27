/**
 * Phase 23 (CLI, step 2): MCP server management.
 *
 *   human-out-of-the-loop mcp list [--project-root DIR]
 *   human-out-of-the-loop mcp test <serverId> [--project-root DIR]
 *
 * Servers are configured in `<projectRoot>/registry/mcp-servers/*.json`
 * (step 4: registry/ auto-discovery from projectRoot).
 */
import path from 'node:path';
import { McpConnector } from '../../ai/tools/mcp-connector.js';
import { loadMcpServerConfigs } from '../../ai/tools/mcp-bootstrap.js';
import { registryLayersFor } from '../../ai/registries/layout.js';
import type { McpServerConfig } from '../../ai/schemas/mcp-server.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { resolveAndMaybePersistTrust, untrustedProjectMcpMessage } from '../utils/trust-project.js';
import { color, err, out, renderTable } from '../utils/output.js';
import type { RegistryScope } from '../../ai/registries/layout.js';

export interface McpCommandOptions {
  projectRoot?: string;
  /** A-02: persist trust and allow project-layer MCP servers to spawn. */
  trustProject?: boolean;
  /** Trust for this call only (tests) — does not persist. */
  trusted?: boolean;
}

/**
 * Phase 28: MCP servers come from every active layer (package first,
 * project last); a project server with the same id overrides the
 * packaged one.
 */
function mcpDirsFor(opts: McpCommandOptions): Array<{ dir: string; scope: RegistryScope }> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return registryLayersFor(projectRoot).map((layer) => ({
    dir: path.join(layer.dir, 'mcp-servers'),
    scope: layer.scope,
  }));
}

/** Merge per-layer configs by id — later layers win. Tracks the winning scope. */
function loadLayeredMcpConfigs(dirs: Array<{ dir: string; scope: RegistryScope }>): {
  configs: Array<{ config: McpServerConfig; scope: RegistryScope }>;
  errors: Array<{ file: string; error: string }>;
} {
  const byId = new Map<string, { config: McpServerConfig; scope: RegistryScope }>();
  const errors: Array<{ file: string; error: string }> = [];
  for (const { dir, scope } of dirs) {
    const { configs, errors: layerErrors } = loadMcpServerConfigs(dir);
    for (const cfg of configs) byId.set(cfg.id, { config: cfg, scope });
    errors.push(...layerErrors);
  }
  return { configs: Array.from(byId.values()), errors };
}

export async function mcpListCommand(opts: McpCommandOptions): Promise<number> {
  const { configs, errors } = loadLayeredMcpConfigs(mcpDirsFor(opts));

  if (configs.length === 0) {
    out(color.dim('No MCP servers configured (registry/mcp-servers/*.json).'));
    for (const e of errors) out(color.failed(`  ${e.file}: ${e.error}`));
    return 0;
  }

  const rows = configs.map(({ config: c }) => [
    c.id,
    c.name,
    c.transport,
    c.url ?? (c.command ? `${c.command} ${c.args.join(' ')}`.trim() : '-'),
    c.auth.type === 'none' ? 'none' : `${c.auth.type} (${c.auth.type === 'bearer' ? c.auth.tokenEnvVar : c.auth.keyEnvVar})`,
  ]);

  out(renderTable(['ID', 'NAME', 'TRANSPORT', 'ENDPOINT', 'AUTH'], rows));
  for (const e of errors) out(color.failed(`Invalid config: ${e.file}: ${e.error}`));
  return errors.length > 0 ? 1 : 0;
}

export async function mcpTestCommand(serverId: string, opts: McpCommandOptions): Promise<number> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  const trusted =
    opts.trusted === true || resolveAndMaybePersistTrust(projectRoot, opts.trustProject === true);
  const { configs } = loadLayeredMcpConfigs(mcpDirsFor(opts));
  const found = configs.find((c) => c.config.id === serverId);
  if (!found) {
    err(color.failed(`MCP server "${serverId}" not found in registry/mcp-servers.`));
    return 1;
  }
  if (found.scope === 'project' && !trusted) {
    err(color.failed(untrustedProjectMcpMessage(serverId)));
    return 1;
  }
  const config = found.config;

  out(color.dim(`Connecting to "${config.id}" (${config.transport})...`));
  const connector = new McpConnector({ toolRegistry: new ToolRegistry() });
  let ok = false;
  let state: ReturnType<McpConnector['getServerState']>;
  try {
    ok = await connector.connectServer(config);
    state = connector.getServerState(config.id);
  } finally {
    // Phase 30 (P6): a stdio server is a CHILD PROCESS — leaving the
    // connection open kept the CLI alive forever after a successful test
    // (`mcp test <stdio>` never returned until it was killed).
    await connector.closeAll();
  }

  if (ok) {
    out(color.done(`✔ Connected. ${state?.toolIds.length ?? 0} tool(s) registered.`));
    for (const toolId of state?.toolIds ?? []) {
      out(`   ${color.dim('·')} ${toolId}`);
    }
    return 0;
  }

  err(color.failed(`✖ Connection failed: ${state?.lastError ?? 'unknown error'}`));
  return 1;
}
