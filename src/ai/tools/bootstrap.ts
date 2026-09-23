import type { Tool } from 'ai';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import { ToolDefinitionSchema } from '../schemas/tool-definition.js';

// Import all implementations (Law 12: this is the ONLY place that
// directly imports tool implementations — Agents never do).
import { readFileTool } from './implementations/read-file.js';
import { searchCodeTool } from './implementations/search-code.js';
import { writeFileTool } from './implementations/write-file.js';
import { gitStatusTool } from './implementations/git-status.js';

/**
 * Static mapping from tool id → live AI-SDK Tool instance.
 * In a more dynamic setup this could be driven by `modulePath`
 * and `import()`, but for the baseline four tools a static map
 * is simpler and type-safe.
 */
const IMPLEMENTATIONS: Record<string, Tool> = {
  read_file: readFileTool,
  search_code: searchCodeTool,
  write_file: writeFileTool,
  git_status: gitStatusTool,
};

/**
 * Full bootstrap: loads metadata JSON from `registry/tools/`,
 * then binds each to its live implementation.
 *
 * @param toolsDir  Absolute path to `registry/tools/`
 * @param registry  The ToolRegistry instance to populate
 */
export function bootstrapTools(toolsDir: string, registry: ToolRegistry): void {
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
    const impl = IMPLEMENTATIONS[def.id];
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
