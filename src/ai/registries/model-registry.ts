import { createRegistry, Registry } from './base-registry.js';
import { loadRegistryFromDirectory } from './loader.js';
import { ModelConfigSchema, type ModelConfig } from '../schemas/model-config.js';
import type { EnvSource } from '../env.js';
import { resolveEnv } from '../env.js';
import type { LanguageModel } from 'ai';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A provider factory knows how to create a LanguageModel instance
 * from a ModelConfig.  Each supported provider (openai, anthropic,
 * local, …) implements this interface.
 *
 * This indirection means ModelRegistry never hard-codes provider
 * imports — new providers are added by calling `registerProvider()`.
 */
export interface ProviderFactory {
  /** Unique provider name matching `ModelConfig.provider` (e.g. "openai") */
  name: string;
  /**
   * Create a LanguageModel instance from the given config.
   * The factory is responsible for reading API keys from env vars
   * and applying provider-specific options.
   *
   * Phase 27 (CFG-08): `env` is the optional injected environment
   * source.  When omitted, the factory falls back to `process.env`
   * (unchanged default behaviour).
   */
  create(config: ModelConfig, env?: EnvSource): LanguageModel;
}

/** Phase 27 (CFG-08): options accepted by the registry. */
export interface ModelRegistryOptions {
  /**
   * Environment used when instantiating provider factories.
   * Default: the live `process.env`.
   */
  env?: EnvSource;
}

/**
 * A resolved model entry: the original config plus the live
 * LanguageModel instance ready for use by Agent Factory.
 */
export interface ResolvedModel {
  config: ModelConfig;
  model: LanguageModel;
}

// ─── ModelRegistry ───────────────────────────────────────────────

/**
 * Two-layer registry:
 *   1. **Config layer** — generic base Registry holding ModelConfig
 *      metadata loaded from JSON files.
 *   2. **Provider layer** — a map of `ProviderFactory` instances
 *      that know how to instantiate real LanguageModel objects.
 *
 * When `resolve(id)` is called, the registry looks up the config,
 * finds the matching provider factory, and creates the model.
 * Results are cached so each model is instantiated at most once.
 *
 * Law 11 compliance: AI SDK is used only as the model execution
 * layer.  Provider instantiation is delegated to pluggable factories.
 */
export class ModelRegistry {
  private readonly configs: Registry<ModelConfig>;
  private readonly providers = new Map<string, ProviderFactory>();
  private readonly cache = new Map<string, ResolvedModel>();
  /**
   * Phase 27 (CFG-08): environment source threaded to every provider
   * factory.  Defaults to `process.env` (previous behaviour).
   */
  private readonly env: EnvSource;

  constructor(options: ModelRegistryOptions = {}) {
    this.configs = createRegistry<ModelConfig>({
      schema: ModelConfigSchema,
      label: 'ModelRegistry',
    });
    this.env = resolveEnv(options.env);
  }

  /** The environment this registry resolves credentials from. */
  get envSource(): EnvSource {
    return this.env;
  }

  // ── Provider management ───────────────────────────────────────

  /**
   * Register a provider factory.  Throws if a factory with the
   * same name is already registered (prevents silent overrides).
   */
  registerProvider(factory: ProviderFactory): void {
    if (this.providers.has(factory.name)) {
      throw new Error(`[ModelRegistry] Provider "${factory.name}" is already registered.`);
    }
    this.providers.set(factory.name, factory);
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  // ── Config management ─────────────────────────────────────────

  registerConfig(raw: unknown): ModelConfig {
    return this.configs.register(raw);
  }

  getConfig(id: string): ModelConfig | undefined {
    return this.configs.get(id);
  }

  hasConfig(id: string): boolean {
    return this.configs.has(id);
  }

  listConfigs(): ReadonlyArray<ModelConfig> {
    return this.configs.list();
  }

  // ── Resolution ────────────────────────────────────────────────

  /**
   * Resolve a model id to a live `LanguageModel` instance.
   *
   * 1. Looks up the ModelConfig by id.
   * 2. Finds the ProviderFactory matching `config.provider`.
   * 3. Calls `factory.create(config)` to instantiate the model.
   * 4. Caches the result for subsequent calls.
   *
   * @throws if the config or provider is not found.
   */
  resolve(id: string): ResolvedModel {
    // Return cached instance if available
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Look up config
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(
        `[ModelRegistry] Model config "${id}" not found. ` +
          `Available: [${this.configs.list().map((c) => c.id).join(', ')}]`
      );
    }

    // Look up provider
    const factory = this.providers.get(config.provider);
    if (!factory) {
      throw new Error(
        `[ModelRegistry] No provider factory registered for "${config.provider}". ` +
          `Available providers: [${this.listProviders().join(', ')}]`
      );
    }

    // Create and cache
    const model = factory.create(config, this.env);
    const resolved: ResolvedModel = { config, model };
    this.cache.set(id, resolved);
    return resolved;
  }

  /**
   * Convenience: get just the LanguageModel instance.
   */
  get(id: string): LanguageModel {
    return this.resolve(id).model;
  }

  /** Number of resolved (instantiated) models. */
  get resolvedCount(): number {
    return this.cache.size;
  }

  /** Number of registered configs. */
  get configCount(): number {
    return this.configs.size;
  }

  // ── Bulk loading ──────────────────────────────────────────────

  loadConfigsFromDirectory(
    modelsDir: string,
    strict = true,
    /** Phase 28: replace same-id configs (project layer overrides package). */
    override = false
  ): { loaded: number; errors: Array<{ file: string; error: string }> } {
    return loadRegistryFromDirectory({
      directory: modelsDir,
      registry: this.configs,
      schema: ModelConfigSchema,
      strict,
      override,
    });
  }

  /**
   * Pre-resolve all registered configs.  Useful at startup to
   * catch missing API keys or invalid provider configs early.
   *
   * @returns Number of models successfully resolved.
   * @throws on first failure if `strict` is true.
   */
  resolveAll(strict = true): number {
    let count = 0;

    for (const config of this.configs.list()) {
      try {
        this.resolve(config.id);
        count++;
      } catch (err) {
        if (strict) throw err;
      }
    }

    return count;
  }
}
