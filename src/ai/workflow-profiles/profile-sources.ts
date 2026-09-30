/**
 * Phase 7 Step 2 (WP-R-008): the production bridge from HOOTL's registries to the
 * profile resolver's component sources.
 *
 * Pins are content digests, so this module must hand the resolver *the same content*
 * the built-in default profile was pinned against. It therefore reads through a single
 * `createComponentSource` shape for every kind and returns defensive copies: a caller can
 * neither mutate registry state through the profile layer nor observe an object whose
 * later mutation would silently invalidate a pin.
 *
 * No source invents content: an unknown id resolves to `undefined`, which the resolver
 * reports as `dependency.missing` (fail closed) rather than substituting a default.
 */
import { createBuiltInRubricCatalogue, type ComponentSource, type WorkflowProfileComponentSources } from './profile-resolver.js';
import type { ToolCatalogLike } from './toolsets.js';

/** Structural views of the existing registries (no new registry API is required). */
export interface WorkflowProfileRegistryViews {
  personas?: { get(id: string): unknown; list?(): ReadonlyArray<{ id: string }> };
  skills?: { get(id: string): unknown; list?(): ReadonlyArray<{ id: string }> };
  /** Model *configs* are the pinnable content; a resolved model instance is not. */
  models?: { getConfig(id: string): unknown; listConfigs?(): ReadonlyArray<{ id: string }> };
  toolsets?: { get(id: string): unknown; list?(): ReadonlyArray<{ id: string }> };
  rubrics?: { get(id: string): unknown; list?(): ReadonlyArray<{ id: string }> };
}

export interface WorkflowProfileSourceOptions {
  registries: WorkflowProfileRegistryViews;
  /** Live tool catalog; when present, toolset membership is re-verified at resolve time. */
  toolCatalog?: ToolCatalogLike;
  /** Rubric catalogue override; defaults to the code-owned built-in rubrics. */
  rubricCatalogue?: { get(id: string): unknown; list?(): ReadonlyArray<unknown> };
}

function idsOf(values: ReadonlyArray<unknown> | undefined): string[] {
  const ids: string[] = [];
  for (const value of values ?? []) {
    const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/** One component kind: a read-only lookup plus, when the registry can enumerate, `listIds`. */
function createComponentSource(
  lookup: ((id: string) => unknown) | undefined,
  enumerate: (() => ReadonlyArray<unknown>) | undefined,
): ComponentSource {
  return {
    get(id: string): Record<string, unknown> | undefined {
      const record = lookup?.(id);
      if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
      // Defensive copy: sources are read repeatedly (pin once, resolve later) and must
      // hand out stable content.
      return { ...(record as Record<string, unknown>) };
    },
    ...(enumerate ? { listIds: (): ReadonlyArray<string> => idsOf(enumerate()) } : {}),
  };
}

/** Build the resolver's component sources from the live registries. */
export function createWorkflowProfileComponentSources(
  options: WorkflowProfileSourceOptions,
): WorkflowProfileComponentSources {
  const { registries } = options;
  const rubrics = options.rubricCatalogue ?? createBuiltInRubricCatalogue();
  return {
    personas: createComponentSource(registries.personas ? (id) => registries.personas!.get(id) : undefined, registries.personas?.list ? () => registries.personas!.list!() : undefined),
    skills: createComponentSource(registries.skills ? (id) => registries.skills!.get(id) : undefined, registries.skills?.list ? () => registries.skills!.list!() : undefined),
    models: createComponentSource(registries.models ? (id) => registries.models!.getConfig(id) : undefined, registries.models?.listConfigs ? () => registries.models!.listConfigs!() : undefined),
    toolsets: createComponentSource(registries.toolsets ? (id) => registries.toolsets!.get(id) : undefined, registries.toolsets?.list ? () => registries.toolsets!.list!() : undefined),
    rubrics: createComponentSource((id) => rubrics.get(id), rubrics.list ? () => (rubrics.list as () => ReadonlyArray<unknown>)() : undefined),
    ...(options.toolCatalog ? { toolCatalog: options.toolCatalog } : {}),
  };
}
