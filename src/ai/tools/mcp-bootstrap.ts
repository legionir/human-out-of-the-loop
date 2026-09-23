import fs from 'node:fs';
import path from 'node:path';
import { McpServerConfigSchema, type McpServerConfig } from '../schemas/mcp-server.js';
import { McpConnector } from './mcp-connector.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

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
  mcpDir: string,
  toolRegistry: ToolRegistry,
  connector?: McpConnector
): Promise<{
  connector: McpConnector;
  configErrors: Array<{ file: string; error: string }>;
  connectionResults: Array<{ id: string; success: boolean; toolCount: number; error?: string }>;
}> {
  const { configs, errors: configErrors } = loadMcpServerConfigs(mcpDir);

  const conn = connector ?? new McpConnector({ toolRegistry });
  const connectionResults = configs.length > 0 ? await conn.connectAll(configs) : [];

  return {
    connector: conn,
    configErrors,
    connectionResults,
  };
}
