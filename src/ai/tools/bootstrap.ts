import type { Tool } from 'ai';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import { ToolDefinitionSchema } from '../schemas/tool-definition.js';

// Import all implementations (Law 12: this is the ONLY place that
// directly imports tool implementations — Agents never do).
// Phase 18: filesystem tools are factories bound to projectRoot.
import { createReadFileTool } from './implementations/read-file.js';
import { createSearchCodeTool } from './implementations/search-code.js';
import { createWriteFileTool } from './implementations/write-file.js';
import { createGitStatusTool } from './implementations/git-status.js';

/**
 * Full bootstrap: loads metadata JSON from `registry/tools/`,
 * then binds each to its live implementation.
 *
 * Phase 18: `projectRoot` is now a required parameter — the
 * filesystem tools are created bound to it (workspace isolation).
 *
 * @param toolsDir     Absolute path to `registry/tools/`
 * @param registry     The ToolRegistry instance to populate
 * @param projectRoot  The workspace root the tools must stay inside
 */
export function bootstrapTools(toolsDir: string, registry: ToolRegistry, projectRoot: string): void {
  // Bind implementations (created per-Orchestrator, bound to projectRoot)
  const implementations: Record<string, Tool> = {
    read_file: createReadFileTool(projectRoot),
    search_code: createSearchCodeTool(projectRoot),
    write_file: createWriteFileTool(projectRoot),
    git_status: createGitStatusTool(projectRoot),
  };

  // 1. Load metadata into the underlying registry
  const metaRegistry = registry.getMetadataRegistry();
  const result = loadRegistryFromDirectory({
    directory: toolsDir,
    registry: metaRegistry,
    schema: ToolDefinitionSchema,
    strict: true,
  });

  if (result.errors.length > 0) {
    throw new Error(
      `[bootstrapTools] Failed to load tool definitions: ${result.errors.map((e) => `${e.file}: ${e.error}`).join('; ')}`
    );
  }

  // 2. Bind implementations
  for (const def of registry.listDefinitions()) {
    const impl = implementations[def.id];
    if (!impl) {
      // For MCP tools, implementation already registered by connector; skip
      if (def.source === 'mcp') continue;
      throw new Error(
        `[bootstrapTools] Tool "${def.id}" has metadata but no implementation in IMPLEMENTATIONS map.`
      );
    }
    // Avoid double-registering if already present (e.g. from MCP)
    if (!registry.getImplementation(def.id)) {
      registry.registerImplementation(def.id, impl);
    }
  }
}
