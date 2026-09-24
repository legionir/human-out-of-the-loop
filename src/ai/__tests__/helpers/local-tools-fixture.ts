import type { ToolRegistry } from '../../registries/tool-registry.js';
import { LOCAL_TOOL_FACTORIES } from '../../tools/local-tools.js';

/**
 * Phase 33: several fixtures hand-build a *partial* tool registry (the four
 * original filesystem/git tools, plus fake catalog tools) and then load the real
 * `registry/skills/`.  The skills now reference the reference filesystem
 * toolset, so a fixture that skipped them would fail strict cross-validation with
 * "references unknown tool(s)".
 *
 * Registering whatever `LOCAL_TOOL_FACTORIES` declares keeps every fixture
 * consistent with what `bootstrapTools` does in production, without duplicating
 * the id list in a dozen test files.  Already-registered ids are left untouched,
 * so a fixture can still substitute its own fake implementation.
 */
export function registerLocalToolFixtures(
  toolRegistry: ToolRegistry,
  projectRoot: string = process.cwd()
): void {
  for (const [id, factory] of Object.entries(LOCAL_TOOL_FACTORIES)) {
    if (toolRegistry.hasDefinition(id)) continue;
    toolRegistry.registerDefinition({
      id,
      name: id,
      description: `${id} (test fixture)`,
      source: 'local',
      modulePath: `./${id}`,
      category: 'filesystem',
    });
    toolRegistry.registerImplementation(id, factory(projectRoot));
  }
}
