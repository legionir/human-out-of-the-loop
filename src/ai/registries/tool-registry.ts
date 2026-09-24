import type { Tool } from 'ai';
import { createRegistry, Registry } from './base-registry.js';
import { ToolDefinitionSchema, type ToolDefinition } from '../schemas/tool-definition.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A registered tool pairs its metadata (ToolDefinition) with the
 * live AI-SDK `Tool` instance produced by `tool()`.
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  implementation: Tool;
}

export interface ToolRegistryOptions {
  /** Pre-existing base registry (optional — one is created internally if omitted) */
  baseRegistry?: Registry<ToolDefinition>;
}

// ─── ToolRegistry ────────────────────────────────────────────────

/**
 * Wraps the generic `createRegistry<ToolDefinition>` and adds a
 * parallel map from tool-id → live AI-SDK `Tool` instance so that
 * `getToolsByIds()` can return the `Record<string, Tool>` shape
 * expected by `generateText({ tools })`.
 *
 * Separation rationale (Law 12):
 *   - metadata (id, description, modulePath) lives in the base registry
 *   - executable implementation lives in the `implementations` map
 *   - no Agent ever imports a tool implementation directly
 */
export class ToolRegistry {
  private readonly metadata: Registry<ToolDefinition>;
  private readonly implementations = new Map<string, Tool>();

  // Phase 21 (PERF-07): LRU cache for getToolsByIds — the same tool
  // set is requested repeatedly (every createAgent call), and building
  // a fresh Record each time is pure waste.  Map preserves insertion
  // order, so delete+re-set implements MRU ordering.
  private readonly toolsCache = new Map<string, Record<string, Tool>>();
  private static readonly MAX_CACHED_COMBOS = 64;

  constructor(options?: ToolRegistryOptions) {
    this.metadata =
      options?.baseRegistry ??
      createRegistry<ToolDefinition>({
        schema: ToolDefinitionSchema,
        label: 'ToolRegistry',
      });
  }

  // ── Metadata layer (delegates to base registry) ──────────────

  /** Register metadata only (from JSON loader). */
  registerDefinition(raw: unknown): ToolDefinition {
    return this.metadata.register(raw);
  }

  getDefinition(id: string): ToolDefinition | undefined {
    return this.metadata.get(id);
  }

  hasDefinition(id: string): boolean {
    return this.metadata.has(id);
  }

  listDefinitions(): ReadonlyArray<ToolDefinition> {
    return this.metadata.list();
  }

  // ── Implementation layer ─────────────────────────────────────

  /**
   * Bind a live AI-SDK `Tool` instance to an already-registered
   * metadata id.  Throws if the id has no matching definition.
   */
  registerImplementation(id: string, implementation: Tool): void {
    if (!this.metadata.has(id)) {
      throw new Error(
        `[ToolRegistry] Cannot register implementation for unknown tool id "${id}". ` +
          `Register its metadata definition first.`
      );
    }
    this.implementations.set(id, implementation);
    // Phase 21 (PERF-07): every cached combo containing this id is stale
    this.toolsCache.clear();
  }

  getImplementation(id: string): Tool | undefined {
    return this.implementations.get(id);
  }

  // ── Convenience for AI SDK ───────────────────────────────────

  /**
   * Convert a list of tool ids into the `Record<string, Tool>`
   * shape expected by `generateText({ tools })` / `ToolLoopAgent`.
   *
   * @throws if any id lacks a registered implementation.
   */
  getToolsByIds(ids: string[]): Record<string, Tool> {
    // Phase 21 (PERF-07): LRU hit check — same ids array → same object
    const key = ids.join(',');
    const cached = this.toolsCache.get(key);
    if (cached) {
      this.toolsCache.delete(key); // touch → MRU
      this.toolsCache.set(key, cached);
      return cached;
    }

    const result: Record<string, Tool> = {};

    for (const id of ids) {
      const impl = this.implementations.get(id);
      if (!impl) {
        throw new Error(
          `[ToolRegistry] Tool "${id}" has no registered implementation. ` +
            `Available: [${Array.from(this.implementations.keys()).join(', ')}]`
        );
      }
      result[id] = impl;
    }

    this.toolsCache.set(key, result);
    while (this.toolsCache.size > ToolRegistry.MAX_CACHED_COMBOS) {
      const oldest = this.toolsCache.keys().next().value; // insertion order = LRU
      if (oldest === undefined) break;
      this.toolsCache.delete(oldest);
    }

    return result;
  }

  /** Number of tools that have BOTH metadata and implementation. */
  get size(): number {
    return this.implementations.size;
  }

  /** Expose underlying metadata registry for bootstrap helpers (internal use). */
  _getMetadataRegistry(): Registry<ToolDefinition> {
    return this.metadata;
  }

  /** Public getter for metadata registry (type-safe replacement for _getMetadataRegistry). */
  getMetadataRegistry(): Registry<ToolDefinition> {
    return this.metadata;
  }
}
