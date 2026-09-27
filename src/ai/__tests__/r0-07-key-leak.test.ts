/**
 * R0-07 — the real OPENAI_API_KEY must never be sent to a custom baseURL.
 * A project-controlled model config or .env that points baseURL somewhere
 * else must fall back only to HOTL_API_KEY / an explicit apiKeyEnv, never
 * to the real OpenAI credential.
 */
import { describe, it, expect } from 'vitest';
import type { ModelConfig } from '../schemas/model-config.js';

// Note: openai-provider.ts loads @ai-sdk/openai via a CJS `require()`
// (createRequire), which bypasses Vitest's ESM `vi.mock` interception —
// so these tests exercise the real key-selection logic and only assert
// on whether `create()` throws (matching the convention already used by
// phase27.test.ts for this factory), not on the resulting client's
// internals.
import { openaiProviderFactory } from '../models/providers/openai-provider.js';
import { modelSources } from '../models/list-models.js';
import { resolveAnthropicClientOptions } from '../models/providers/anthropic-provider.js';

function cfg(config: ModelConfig['config']): ModelConfig {
  return { id: 'm', provider: 'openai', model: 'test-model', config };
}

describe('R0-07 — OPENAI_API_KEY is never sent to a custom baseURL', () => {
  it('does NOT send OPENAI_API_KEY when baseURL points elsewhere, with no HOTL_API_KEY set', () => {
    expect(() =>
      openaiProviderFactory.create(cfg({ baseURL: 'https://attacker.example/v1' }), {
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      })
    ).toThrow(/HOTL_API_KEY/);
  });

  it('DOES accept OPENAI_API_KEY (no throw) for the real api.openai.com endpoint', () => {
    expect(() =>
      openaiProviderFactory.create(cfg({ baseURL: 'https://api.openai.com/v1' }), {
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      })
    ).not.toThrow();
  });

  it('DOES accept OPENAI_API_KEY (no throw) when there is no baseURL at all', () => {
    expect(() =>
      openaiProviderFactory.create(cfg(undefined), { OPENAI_API_KEY: 'sk-REAL-OPENAI' })
    ).not.toThrow();
  });

  it('accepts HOTL_API_KEY for a custom baseURL (no throw) even without OPENAI_API_KEY', () => {
    expect(() =>
      openaiProviderFactory.create(cfg({ baseURL: 'https://gateway.example/v1' }), {
        HOTL_API_KEY: 'hotl-key',
      })
    ).not.toThrow();
  });

  it('does NOT send OPENAI_API_KEY to a custom baseURL even when apiKeyEnv names it', () => {
    expect(() =>
      openaiProviderFactory.create(
        cfg({ baseURL: 'https://attacker.example/v1', apiKeyEnv: 'OPENAI_API_KEY' }),
        { OPENAI_API_KEY: 'sk-REAL-OPENAI' }
      )
    ).toThrow(/HOTL_API_KEY/);
  });

  describe('list-models: modelSources', () => {
    it('never falls back to OPENAI_API_KEY for the HOTL_BASE_URL source', () => {
      const sources = modelSources({
        HOTL_BASE_URL: 'https://gateway.example',
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      });
      const hotl = sources.find((s) => s.label === 'HOTL_BASE_URL');
      expect(hotl).toBeTruthy();
      expect(hotl?.apiKey).toBeUndefined();
    });

    it('still uses HOTL_API_KEY for the HOTL_BASE_URL source when set', () => {
      const sources = modelSources({
        HOTL_BASE_URL: 'https://gateway.example',
        HOTL_API_KEY: 'hotl-key',
        OPENAI_API_KEY: 'sk-REAL-OPENAI',
      });
      const hotl = sources.find((s) => s.label === 'HOTL_BASE_URL');
      expect(hotl?.apiKey).toBe('hotl-key');
    });
  });
});

describe('R0-07 — ANTHROPIC_API_KEY is never sent to a custom baseURL', () => {
  const acfg = (config: ModelConfig['config']): ModelConfig => ({
    id: 'a',
    provider: 'anthropic',
    model: 'claude-test',
    config,
  });

  it('refuses a custom baseURL with only ANTHROPIC_API_KEY set', () => {
    expect(() =>
      resolveAnthropicClientOptions(acfg({ baseURL: 'https://attacker.example/v1' }), {
        ANTHROPIC_API_KEY: 'sk-ant-REAL',
      })
    ).toThrow(/not sent to a custom baseURL/);
  });

  it('refuses a custom baseURL whose apiKeyEnv names ANTHROPIC_API_KEY', () => {
    expect(() =>
      resolveAnthropicClientOptions(
        acfg({ baseURL: 'https://attacker.example/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
        { ANTHROPIC_API_KEY: 'sk-ant-REAL' }
      )
    ).toThrow(/not sent to a custom baseURL/);
  });

  it('uses HOTL_API_KEY for a custom baseURL', () => {
    expect(
      resolveAnthropicClientOptions(acfg({ baseURL: 'https://gw.example/v1' }), {
        ANTHROPIC_API_KEY: 'sk-ant-REAL',
        HOTL_API_KEY: 'gw-key',
      }).apiKey
    ).toBe('gw-key');
  });

  it('uses ANTHROPIC_API_KEY for the real endpoint or no baseURL', () => {
    expect(resolveAnthropicClientOptions(acfg(undefined), { ANTHROPIC_API_KEY: 'k' }).apiKey).toBe('k');
    expect(
      resolveAnthropicClientOptions(acfg({ baseURL: 'https://api.anthropic.com/v1' }), {
        ANTHROPIC_API_KEY: 'k',
      }).apiKey
    ).toBe('k');
  });
});
