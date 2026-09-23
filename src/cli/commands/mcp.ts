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
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface McpCommandOptions {
  projectRoot?: string;
}

function mcpDirFor(opts: McpCommandOptions): string {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return path.join(projectRoot, 'registry', 'mcp-servers');
}

export async function mcpListCommand(opts: McpCommandOptions): Promise<number> {
  const { configs, errors } = loadMcpServerConfigs(mcpDirFor(opts));

  if (configs.length === 0) {
    out(color.dim('No MCP servers configured (registry/mcp-servers/*.json).'));
    for (const e of errors) out(color.failed(`  ${e.file}: ${e.error}`));
    return 0;
  }

  const rows = configs.map((c) => [
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
  const { configs } = loadMcpServerConfigs(mcpDirFor(opts));
  const config = configs.find((c) => c.id === serverId);
  if (!config) {
    err(color.failed(`MCP server "${serverId}" not found in registry/mcp-servers.`));
    return 1;
  }

  out(color.dim(`Connecting to "${config.id}" (${config.transport})...`));
  const connector = new McpConnector({ toolRegistry: new ToolRegistry() });
  const ok = await connector.connectServer(config);
  const state = connector.getServerState(config.id);

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
