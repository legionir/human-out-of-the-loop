import fs from 'node:fs';
import path from 'node:path';
import { McpServerConfigSchema, type McpServerConfig } from '../schemas/mcp-server.js';
import { McpConnector } from './mcp-connector.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { EnvSource } from '../env.js';
import { registryLayersFor, type RegistryScope } from '../registries/layout.js';

// ─── Loading MCP configs from disk ───────────────────────────────

/**
 * Load MCP server configurations from a directory.  Each `.json`
 * file is validated against McpServerConfigSchema.
 *
 * Errors in one file do not prevent others from loading.
 */
export function loadMcpServerConfigs(directory: string): {
  configs: McpServerConfig[];
  errors: Array<{ file: string; error: string }>;
} {
  const result = {
    configs: [] as McpServerConfig[],
    errors: [] as Array<{ file: string; error: string }>,
  };

  if (!fs.existsSync(directory)) {
    // Empty registry is fine — MCP is optional
    return result;
  }

  const files = fs
    .readdirSync(directory)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const filePath = path.join(directory, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const parsed = McpServerConfigSchema.parse(raw);
      result.configs.push(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: filePath, error: message });
    }
  }

  return result;
}

/**
 * Full MCP bootstrap: load configs, connect to every server,
 * populate the ToolRegistry.  Returns a summary suitable for logging.
 *
 * A failure on ANY server does NOT throw — the connector marks
 * that server as `unavailable` and the rest continue.
 */
export async function bootstrapMcpServers(
  /**
   * Phase 28: one directory, or an ordered list of them (package layer
   * first, project layer last).  Servers with the same id are merged so
   * the LAST occurrence wins.
   */
  mcpDir: string | string[],
  toolRegistry: ToolRegistry,
  connector?: McpConnector,
  /**
   * Phase 27 (CFG-08): environment for credential resolution — used
   * only when `connector` is not supplied.  Default: `process.env`.
   */
  env?: EnvSource
): Promise<{
  connector: McpConnector;
  configErrors: Array<{ file: string; error: string }>;
  connectionResults: Array<{ id: string; success: boolean; toolCount: number; error?: string }>;
}> {
  const dirs = Array.isArray(mcpDir) ? mcpDir : [mcpDir];
  const merged = new Map<string, McpServerConfig>();
  const configErrors: Array<{ file: string; error: string }> = [];
  for (const dir of dirs) {
    const { configs: layerConfigs, errors } = loadMcpServerConfigs(dir);
    for (const cfg of layerConfigs) merged.set(cfg.id, cfg); // later layer wins
    configErrors.push(...errors);
  }
  const configs = Array.from(merged.values());

  const conn = connector ?? new McpConnector({ toolRegistry, ...(env ? { env } : {}) });
  const connectionResults = configs.length > 0 ? await conn.connectAll(configs) : [];

  return {
    connector: conn,
    configErrors,
    connectionResults,
  };
}

/** One MCP server as a project sees it, with the layer it came from. */
export interface LayeredMcpServer {
  config: McpServerConfig;
  scope: RegistryScope;
}

/**
 * ARCH-003: the ONE answer to "which MCP servers does project X have" —
 * every registry layer (package first, project last; a project server with
 * the same id overrides the packaged one), each tagged with its layer so a
 * caller can apply the R0-08 trust rule: a `project`-scope server may only be
 * spawned for a trusted project.  The CLI (`mcp list/test`, `tools --mcp`)
 * and the server (`/api/mcp`) all read through here.
 */
export function loadLayeredMcpServers(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): { servers: LayeredMcpServer[]; errors: Array<{ file: string; error: string }> } {
  const byId = new Map<string, LayeredMcpServer>();
  const errors: Array<{ file: string; error: string }> = [];
  for (const layer of registryLayersFor(projectRoot, options.env ? { env: options.env } : {})) {
    const loaded = loadMcpServerConfigs(path.join(layer.dir, 'mcp-servers'));
    for (const config of loaded.configs) byId.set(config.id, { config, scope: layer.scope });
    errors.push(...loaded.errors);
  }
  return { servers: [...byId.values()], errors };
}

/** R0-08: may this server be spawned (connected to) for this project? */
export function mayConnectMcpServer(server: LayeredMcpServer, trustedProject: boolean): boolean {
  return server.scope !== 'project' || trustedProject;
}
