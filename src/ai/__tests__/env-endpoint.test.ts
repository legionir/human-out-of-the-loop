/**
 * HOTL_BASE_URL / HOTL_API_KEY / HOTL_MODEL — an endpoint from the
 * environment alone.  Before this, the CLI ignored all three (only the CI
 * workflow knew them) and a user with a gateway got
 * "OPENAI_API_KEY environment variable is not set".
 */
import { describe, it, expect } from 'vitest';
import { envEndpoint, ENV_MODEL_ID } from '../models/env-endpoint.js';
import { openaiProviderFactory } from '../models/providers/openai-provider.js';
import type { ModelConfig } from '../schemas/model-config.js';

const known: ModelConfig[] = [
  { id: 'gpt-4o', provider: 'openai', model: 'gpt-4o', config: { temperature: 0.2 } },
  { id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
];

describe('envEndpoint', () => {
  it('does nothing without HOTL_BASE_URL or HOTL_MODEL', () => {
    expect(envEndpoint({ HOTL_API_KEY: 'k' }, known)).toEqual({});
  });

  it('registers a provider model name as `custom`, over Chat Completions', () => {
    const r = envEndpoint(
      { HOTL_BASE_URL: 'http://localhost:4414/p/free/v1', HOTL_API_KEY: 'k', HOTL_MODEL: '@aur/auto' },
      known,
    );
    expect(r.defaultModelId).toBe(ENV_MODEL_ID);
    expect(r.config).toMatchObject({
      id: 'custom',
      provider: 'openai',
      model: '@aur/auto',
      config: { baseURL: 'http://localhost:4414/p/free/v1', api: 'chat', apiKeyEnv: 'HOTL_API_KEY' },
    });
  });

  it('HOTL_API_STYLE=responses keeps the Responses API', () => {
    const r = envEndpoint({ HOTL_BASE_URL: 'http://x/v1', HOTL_MODEL: 'm', HOTL_API_STYLE: 'responses' }, known);
    expect(r.config?.config).toMatchObject({ api: 'responses' });
  });

  it('a registered id is selected, and pointed at the base URL when one is given', () => {
    expect(envEndpoint({ HOTL_MODEL: 'gpt-4o' }, known)).toEqual({ defaultModelId: 'gpt-4o' });
    const r = envEndpoint({ HOTL_MODEL: 'gpt-4o', HOTL_BASE_URL: 'http://x/v1' }, known);
    expect(r.defaultModelId).toBe('gpt-4o');
    expect(r.config?.config).toEqual({ temperature: 0.2, baseURL: 'http://x/v1', api: 'chat' });
  });

  it('a base URL is not forced onto a non-OpenAI provider', () => {
    expect(envEndpoint({ HOTL_MODEL: 'claude-sonnet', HOTL_BASE_URL: 'http://x/v1' }, known)).toEqual({
      defaultModelId: 'claude-sonnet',
    });
  });

  it('a base URL alone does not displace the global defaultModel', () => {
    const r = envEndpoint({ HOTL_BASE_URL: 'http://x/v1' }, known);
    expect(r).toEqual({});
  });
});

describe('openai provider — key lookup', () => {
  const cfg = (extra: Record<string, unknown> = {}): ModelConfig => ({
    id: 'custom',
    provider: 'openai',
    model: '@aur/auto',
    config: { baseURL: 'http://x/v1', ...extra },
  });

  it('accepts HOTL_API_KEY when OPENAI_API_KEY is absent', () => {
    expect(() => openaiProviderFactory.create(cfg(), { HOTL_API_KEY: 'k' })).not.toThrow();
  });

  it('reads the variable the model names', () => {
    expect(() => openaiProviderFactory.create(cfg({ apiKeyEnv: 'MY_KEY' }), { MY_KEY: 'k' })).not.toThrow();
  });

  it('an empty OPENAI_API_KEY does not hide HOTL_API_KEY', () => {
    expect(() => openaiProviderFactory.create(cfg(), { OPENAI_API_KEY: '', HOTL_API_KEY: 'k' })).not.toThrow();
  });

  it('says which variables to set when there is no key', () => {
    expect(() => openaiProviderFactory.create(cfg(), {})).toThrow(/HOTL_API_KEY \(OPENAI_API_KEY is not sent to a custom baseURL\)/);
  });

  it('builds a Chat Completions model when api=chat', () => {
    const model = openaiProviderFactory.create(cfg({ api: 'chat' }), { HOTL_API_KEY: 'k' }) as unknown as {
      provider: string;
    };
    expect(model.provider).toMatch(/chat/);
  });
});
