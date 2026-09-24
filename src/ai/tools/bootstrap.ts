import type { Tool } from 'ai';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import { ToolDefinitionSchema } from '../schemas/tool-definition.js';

// Import all implementations (Law 12: this is the ONLY place that
// directly imports tool implementations — Agents never do).
// Phase 18: filesystem tools are factories bound to projectRoot.
// Phase 33: the (longer) local toolset lives in ./local-tools.ts so the
// packaged definitions and the in-memory registry cannot drift apart.
import { createLocalTools } from './local-tools.js';

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
export function bootstrapTools(
  toolsDir: string,
  registry: ToolRegistry,
  projectRoot: string,
  /**
   * Phase 28 (registry layering): the packaged layer loads first (missing
   * directory tolerated) and the project layer second with `override`,
   * so a project tool definition replaces the packaged default of the
   * same id while all other packaged tools stay available.
   */
  options: { required?: boolean; override?: boolean } = {}
): void {
  const { required = true, override = false } = options;
  // Bind implementations (created per-Orchestrator, bound to projectRoot)
  const implementations: Record<string, Tool> = createLocalTools(projectRoot);

  // 1. Load metadata into the underlying registry
  const metaRegistry = registry.getMetadataRegistry();
  const result = loadRegistryFromDirectory({
    directory: toolsDir,
    registry: metaRegistry,
    schema: ToolDefinitionSchema,
    strict: required,
    override,
  });

  if (result.errors.length > 0) {
    if (!required) {
      // Optional layer (package): a missing directory is fine; anything
      // else is a real error the caller must see.
      const missingOnly = result.errors.every((e) => e.error.startsWith('Directory does not exist'));
      if (missingOnly) {
        // Still bind implementations for whatever is already registered.
        for (const def of registry.listDefinitions()) {
          const impl = implementations[def.id];
          if (impl && !registry.getImplementation(def.id)) {
            registry.registerImplementation(def.id, impl);
          }
        }
        return;
      }
    }
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
