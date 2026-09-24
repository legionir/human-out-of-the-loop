import { createRegistry, Registry } from './base-registry.js';
import { loadRegistryFromDirectory } from './loader.js';
import { PersonaSchema, type Persona } from '../schemas/persona.js';

// ─── PersonaRegistry ─────────────────────────────────────────────

/**
 * Thin wrapper around the generic base Registry for Persona entries.
 *
 * Persona = رفتار (system prompt) + policy دسترسی (allowedTools).
 * هیچ ارجاعی به Tool یا Skill ندارد — صرفاً هویت و لحن Agent.
 *
 * Data-driven: personas are loaded from `registry/personas/*.json`
 * at startup.  Adding a new persona requires only a new JSON file.
 */
export class PersonaRegistry {
  private readonly registry: Registry<Persona>;

  constructor() {
    this.registry = createRegistry<Persona>({
      schema: PersonaSchema,
      label: 'PersonaRegistry',
    });
  }

  /** Register a single persona from raw JSON data. */
  register(raw: unknown): Persona {
    return this.registry.register(raw);
  }

  /** Retrieve a persona by id. Returns undefined if not found. */
  get(id: string): Persona | undefined {
    return this.registry.get(id);
  }

  /** Check if a persona exists. */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /** List all registered personas. */
  list(): ReadonlyArray<Persona> {
    return this.registry.list();
  }

  get size(): number {
    return this.registry.size;
  }

  // ── Bulk loading ──────────────────────────────────────────────

  /**
   * Load all persona JSON files from a directory.
   *
   * @param personasDir  Absolute path to `registry/personas/`
   * @param strict       Throw on any error (default: true for startup)
   */
  loadFromDirectory(
    personasDir: string,
    strict = true,
    /** Phase 28: replace same-id entries (project layer overrides package). */
    override = false
  ): { loaded: number; errors: Array<{ file: string; error: string }> } {
    return loadRegistryFromDirectory({
      directory: personasDir,
      registry: this.registry,
      schema: PersonaSchema,
      strict,
      override,
    });
  }
}
