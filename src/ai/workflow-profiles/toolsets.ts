/**
 * Phase 3 Step 2 (WP-R-004): named, versioned toolsets.
 *
 * A Toolset is a *named* intersection input, never a grant: the effective tool
 * set for a node is
 *
 *   effective = (Runtime-permitted ∩ Persona.allowedTools ∩ Toolset.tools) − denied
 *
 * so a profile can only narrow what the Runtime already permits. Registering a
 * toolset fails closed when it names a tool that does not exist in the live
 * ToolRegistry: a toolset may never introduce a tool the runtime does not have.
 *
 * Recording boundary: schema/registry validation is *not* an execution
 * authorization. Phase 6 re-checks the effective set at the real tool call site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { WorkflowProfileLoadError } from './profile-registry.js';

const TOOL_ID_MAX_UTF8_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Local tool ids keep the restricted registry convention; MCP ids stay opaque but bounded. */
function validToolId(value: string): boolean {
  if (value.length === 0) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  if (new TextEncoder().encode(value).byteLength > TOOL_ID_MAX_UTF8_BYTES) return false;
  return true;
}

export const ToolsetIdPattern = /^[a-z][a-z0-9._-]{1,127}$/;

export const ToolsetSchema = z.object({
  id: z.string().regex(ToolsetIdPattern, 'Toolset id must match ^[a-z][a-z0-9._-]{1,127}$'),
  name: z.string().min(1).optional(),
  /** Registry version; a version is metadata and never substitutes for the profile's content digest. */
  version: z.string().min(1),
  /** Tool ids this toolset allows. Every id must exist in the live ToolRegistry. */
  tools: z.array(z.string().min(1)).min(1).max(200),
  /** Additional ids removed from this toolset's own allow list. */
  deniedTools: z.array(z.string().min(1)).max(200).optional(),
  description: z.string().optional(),
});

export type Toolset = z.infer<typeof ToolsetSchema>;

/** The subset of ToolRegistry this module needs; keeps the dependency one-way. */
export interface ToolCatalogLike {
  hasDefinition(id: string): boolean;
}

export interface ToolsetRegistryOptions {
  tools: ToolCatalogLike;
}

export class ToolsetRegistry {
  private readonly tools: Map<string, Toolset> = new Map();
  private readonly catalog: ToolCatalogLike;

  constructor(options: ToolsetRegistryOptions) {
    if (!options || typeof options !== 'object' || typeof options.tools?.hasDefinition !== 'function') {
      throw new WorkflowProfileLoadError('ToolsetRegistry requires a tool catalog with hasDefinition()', [
        { stage: 'read', code: 'toolset.catalog-invalid', message: 'ToolsetRegistry requires a tool catalog with hasDefinition()' },
      ]);
    }
    this.catalog = options.tools;
  }

  /** Validate and store a toolset. A tool absent from the runtime catalog is rejected. */
  register(raw: unknown): Toolset {
    const parsed = ToolsetSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
      throw new WorkflowProfileLoadError('Invalid toolset definition', [
        { stage: 'semantic', code: 'toolset.invalid', message: detail },
      ]);
    }
    const toolset = parsed.data;
    for (const toolId of toolset.tools) {
      if (!validToolId(toolId)) {
        throw new WorkflowProfileLoadError(`Toolset "${toolset.id}" declares an invalid tool id`, [
          { stage: 'semantic', code: 'toolset.tool-id-invalid', message: `Tool id "${toolId}" is empty, unbounded, or contains control characters`, path: `/tools`, },
        ]);
      }
      if (!this.catalog.hasDefinition(toolId)) {
        throw new WorkflowProfileLoadError(`Toolset "${toolset.id}" references an unavailable tool`, [
          {
            stage: 'semantic', code: 'toolset.tool-unavailable',
            message: `Tool "${toolId}" is not present in the runtime tool registry; a toolset may never add a tool the runtime does not have`,
            path: '/tools',
          },
        ]);
      }
    }
    if (this.tools.has(toolset.id)) {
      throw new WorkflowProfileLoadError(`Duplicate toolset id "${toolset.id}"`, [
        { stage: 'semantic', code: 'toolset.duplicate-id', message: `Duplicate toolset id "${toolset.id}"`, path: '/id' },
      ]);
    }
    this.tools.set(toolset.id, Object.freeze(toolset));
    return toolset;
  }

  get(id: string): Toolset | undefined {
    return this.tools.get(id);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): ReadonlyArray<Toolset> {
    return Object.freeze(Array.from(this.tools.values()));
  }

  /** Removes a toolset so a higher registry layer can replace it (loader use only). */
  remove(id: string): boolean {
    return this.tools.delete(id);
  }

  get size(): number {
    return this.tools.size;
  }
}

/** One file a loader could not register. `file` is the path or the entry name that failed. */
export interface ToolsetFileError {
  file: string;
  error: string;
}

export interface LoadToolsetsOptions {
  /** Replace a same-id toolset from an earlier layer (project layer overrides package). */
  override?: boolean;
  /**
   * Treat a missing directory as an error. Defaults to false: a registry layer may legitimately
   * ship only some subdirectories, exactly like personas/skills/models.
   */
  required?: boolean;
}

/**
 * Load `<dir>/<id>.json` toolsets into a registry (Phase 9 finding H-3).
 *
 * A profile may pin a `toolset` dependency, but until now nothing in a real run wired the
 * `ToolsetRegistry` into the resolver's sources, so any profile naming a toolset failed with
 * `dependency.source-missing`. The loader follows the same registry-layer convention as the other
 * component kinds: one JSON file per toolset, project layer overrides package, and every tool id is
 * re-checked against the live catalog by `ToolsetRegistry.register` — a toolset can never introduce
 * a tool the runtime does not have. Errors are collected, never thrown, so a validation report can
 * show every broken file.
 */
export function loadToolsetsFromDirectory(
  dir: string,
  registry: ToolsetRegistry,
  options: LoadToolsetsOptions = {},
): { loaded: number; errors: ToolsetFileError[] } {
  const result = { loaded: 0, errors: [] as ToolsetFileError[] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    if (options.required === true) result.errors.push({ file: dir, error: 'Directory does not exist' });
    return result;
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (options.override === true && typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const id = (raw as { id?: unknown }).id;
        if (typeof id === 'string' && registry.has(id)) registry.remove(id);
      }
      registry.register(raw);
      result.loaded += 1;
    } catch (error) {
      result.errors.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export interface EffectiveToolInput {
  /** Tools the Runtime permits. `*` means "everything the runtime exposes" and requires `knownToolIds`. */
  runtimePermitted: ReadonlyArray<string> | '*';
  /** Persona.allowedTools; `["*"]` means every runtime-permitted tool. */
  personaAllowedTools: ReadonlyArray<string>;
  /** Optional named toolset bound to the node. */
  toolset?: Pick<Toolset, 'tools' | 'deniedTools'>;
  /** Runtime/profile deny list; always subtracts. */
  deniedTools?: ReadonlyArray<string>;
  /** Full runtime catalog, required to enumerate when `runtimePermitted` is `*`. */
  knownToolIds?: ReadonlyArray<string>;
}

/**
 * Compute the effective, deterministic tool set. The result is always a subset of
 * the runtime-permitted set: no layer can add access.
 */
export function effectiveToolIds(input: EffectiveToolInput): ReadonlyArray<string> {
  const known = input.knownToolIds ? [...input.knownToolIds] : undefined;
  let runtime: Set<string>;
  if (input.runtimePermitted === '*') {
    if (!known) {
      throw new WorkflowProfileLoadError('Enumerating a wildcard runtime permission requires knownToolIds', [
        { stage: 'semantic', code: 'toolset.runtime-universe-unknown', message: 'knownToolIds is required when runtimePermitted is "*"' },
      ]);
    }
    runtime = new Set(known);
  } else {
    runtime = new Set(input.runtimePermitted);
  }

  const personaAllowsAll = input.personaAllowedTools.includes('*');
  const persona = new Set(input.personaAllowedTools);
  const allowed = new Set<string>();
  for (const id of runtime) {
    if (personaAllowsAll || persona.has(id)) allowed.add(id);
  }

  if (input.toolset) {
    const toolsetAllows = new Set(input.toolset.tools);
    for (const id of [...allowed]) {
      if (!toolsetAllows.has(id)) allowed.delete(id);
    }
    for (const id of input.toolset.deniedTools ?? []) allowed.delete(id);
  }
  for (const id of input.deniedTools ?? []) allowed.delete(id);

  return Object.freeze([...allowed].sort());
}
