import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── PersonaRegistry ─────────────────────────────────────────────

const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');

describe('PersonaRegistry', () => {
  let registry: PersonaRegistry;

  beforeEach(() => {
    registry = new PersonaRegistry();
  });

  it('registers and retrieves a persona', () => {
    registry.register({
      id: 'test-persona',
      name: 'Test',
      system: 'You are a test persona.',
    });
    const persona = registry.get('test-persona');
    expect(persona).toBeDefined();
    expect(persona!.system).toBe('You are a test persona.');
    expect(persona!.name).toBe('Test');
  });

  it('has() returns correct boolean', () => {
    registry.register({ id: 'p1', name: 'P1', system: 'Sys' });
    expect(registry.has('p1')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('throws on invalid schema (empty system)', () => {
    expect(() => registry.register({ id: 'bad', name: 'Bad', system: '' })).toThrow();
  });

  it('throws on duplicate id', () => {
    registry.register({ id: 'dup', name: 'D1', system: 'S1' });
    expect(() => registry.register({ id: 'dup', name: 'D2', system: 'S2' })).toThrow(/Duplicate/);
  });

  it('loads four personas (architect, coder, reviewer, planner) from registry/personas/', () => {
    const result = registry.loadFromDirectory(PERSONAS_DIR);
    expect(result.loaded).toBeGreaterThanOrEqual(4);
    expect(result.errors).toHaveLength(0);
    expect(registry.has('architect')).toBe(true);
    expect(registry.has('coder')).toBe(true);
    expect(registry.has('reviewer')).toBe(true);
    expect(registry.has('planner')).toBe(true);
  });

  it('every loaded persona has allowedTools defined', () => {
    registry.loadFromDirectory(PERSONAS_DIR);
    for (const persona of registry.list()) {
      expect(persona.allowedTools).toBeDefined();
      expect(Array.isArray(persona.allowedTools)).toBe(true);
    }
  });

  it('planner persona has catalog + control tools in allowedTools', () => {
    registry.loadFromDirectory(PERSONAS_DIR);
    const planner = registry.get('planner')!;
    expect(planner.allowedTools).toContain('list_personas');
    expect(planner.allowedTools).toContain('list_skills');
    expect(planner.allowedTools).toContain('list_tools');
    expect(planner.allowedTools).toContain('create_task');
  });

  it('reviewer persona has read-only tools only', () => {
    registry.loadFromDirectory(PERSONAS_DIR);
    const reviewer = registry.get('reviewer')!;
    expect(reviewer.allowedTools).toContain('read_file');
    expect(reviewer.allowedTools).not.toContain('write_file');
  });

  it('loaded personas have meaningful system prompts', () => {
    registry.loadFromDirectory(PERSONAS_DIR);

    const architect = registry.get('architect')!;
    expect(architect.system).toContain('architect');
    expect(architect.system.length).toBeGreaterThan(50);

    const coder = registry.get('coder')!;
    expect(coder.system).toContain('engineer');

    const reviewer = registry.get('reviewer')!;
    expect(reviewer.system).toContain('review');
  });

  it('list() returns all registered personas', () => {
    registry.loadFromDirectory(PERSONAS_DIR);
    expect(registry.list().length).toBeGreaterThanOrEqual(4);
    expect(registry.size).toBeGreaterThanOrEqual(4);
  });
});

// ─── ModelRegistry ───────────────────────────────────────────────

/**
 * Mock provider factory that returns a fake LanguageModel.
 * No real API calls are made.
 */
function createMockProvider(name: string): ProviderFactory {
  return {
    name,
    create: (config) => {
      // Return a minimal mock that satisfies the LanguageModel interface
      return {
        specificationVersion: 'v1',
        provider: name,
        modelId: config.model,
        defaultObjectGenerationMode: 'json',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      } as unknown as LanguageModel;
    },
  };
}

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
    // Register mock providers
    registry.registerProvider(createMockProvider('openai'));
    registry.registerProvider(createMockProvider('anthropic'));
    registry.registerProvider(createMockProvider('local'));
  });

  it('registers and resolves a model config', () => {
    registry.registerConfig({
      id: 'test-model',
      provider: 'openai',
      model: 'gpt-4o',
    });

    const resolved = registry.resolve('test-model');
    expect(resolved.config.id).toBe('test-model');
    expect(resolved.config.provider).toBe('openai');
    expect(resolved.model).toBeDefined();
  });

  it('get() returns just the LanguageModel', () => {
    registry.registerConfig({
      id: 'm1',
      provider: 'anthropic',
      model: 'claude-sonnet',
    });

    const model = registry.get('m1');
    expect(model).toBeDefined();
    expect((model as unknown as { modelId: string }).modelId).toBe('claude-sonnet');
  });

  it('caches resolved models (same instance on second call)', () => {
    registry.registerConfig({
      id: 'cached',
      provider: 'openai',
      model: 'gpt-4o',
    });

    const first = registry.resolve('cached');
    const second = registry.resolve('cached');
    expect(first).toBe(second); // Same reference
    expect(registry.resolvedCount).toBe(1);
  });

  it('throws on unknown model id', () => {
    expect(() => registry.resolve('nonexistent')).toThrow(/not found/);
  });

  it('throws on unknown provider', () => {
    registry.registerConfig({
      id: 'bad-provider',
      provider: 'unknown-provider',
      model: 'some-model',
    });
    expect(() => registry.resolve('bad-provider')).toThrow(/No provider factory/);
  });

  it('throws on duplicate provider registration', () => {
    expect(() => registry.registerProvider(createMockProvider('openai'))).toThrow(
      /already registered/
    );
  });

  it('loads configs from registry/models/', () => {
    const modelsDir = path.resolve(__dirname, '../../../registry/models');
    const result = registry.loadConfigsFromDirectory(modelsDir);
    expect(result.loaded).toBeGreaterThanOrEqual(3);
    expect(result.errors).toHaveLength(0);
    expect(registry.hasConfig('gpt-4o')).toBe(true);
    expect(registry.hasConfig('claude-sonnet')).toBe(true);
    expect(registry.hasConfig('local-llama')).toBe(true);
  });

  it('resolveAll() instantiates all registered configs', () => {
    const modelsDir = path.resolve(__dirname, '../../../registry/models');
    registry.loadConfigsFromDirectory(modelsDir);

    const count = registry.resolveAll();
    expect(count).toBeGreaterThanOrEqual(3);
    expect(registry.resolvedCount).toBeGreaterThanOrEqual(3);
  });

  it('listProviders() returns registered provider names', () => {
    expect(registry.listProviders()).toContain('openai');
    expect(registry.listProviders()).toContain('anthropic');
    expect(registry.listProviders()).toContain('local');
  });

  it('listConfigs() returns all registered configs', () => {
    registry.registerConfig({ id: 'a', provider: 'openai', model: 'm1' });
    registry.registerConfig({ id: 'b', provider: 'local', model: 'm2' });
    expect(registry.listConfigs()).toHaveLength(2);
    expect(registry.configCount).toBe(2);
  });
});
