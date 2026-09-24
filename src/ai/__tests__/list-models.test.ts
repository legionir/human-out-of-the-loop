/**
 * Runtime model selection: listing what the providers serve, and turning
 * any listed name into a usable model (no registry file needed).
 */
import { describe, it, expect, vi } from 'vitest';
import { listRemoteModels, modelSources } from '../models/list-models.js';
import { modelIdForSpec, parseModelSpec, runtimeModelConfig } from '../models/env-endpoint.js';

const ok = (ids: string[]) => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) });

describe('modelSources', () => {
  it('asks only the providers that are configured', () => {
    expect(modelSources({})).toEqual([]);
    const sources = modelSources({
      HOTL_BASE_URL: 'http://localhost:4414/p/free/v1/',
      HOTL_API_KEY: 'k1',
      OPENAI_API_KEY: 'k2',
      ANTHROPIC_API_KEY: 'k3',
    });
    expect(sources.map((s) => [s.label, s.url, s.specPrefix])).toEqual([
      ['HOTL_BASE_URL', 'http://localhost:4414/p/free/v1/models', ''],
      ['OpenAI', 'https://api.openai.com/v1/models', 'openai:'],
      ['Anthropic', 'https://api.anthropic.com/v1/models?limit=1000', 'anthropic:'],
    ]);
  });
});

describe('listRemoteModels', () => {
  it('merges every source into specs, each key sent only to its own provider', async () => {
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.includes('anthropic')) {
        expect(init.headers['x-api-key']).toBe('k3');
        expect(init.headers.authorization).toBeUndefined();
        return ok(['claude-3-5-haiku-latest']);
      }
      expect(init.headers.authorization).toBe('Bearer k1');
      return ok(['@aur/auto', 'stub-small', '@aur/auto']);
    });
    const list = await listRemoteModels(
      { HOTL_BASE_URL: 'http://gw/v1', HOTL_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k3' },
      { fetchImpl: fetchImpl as never },
    );
    expect(list.errors).toEqual([]);
    expect(list.models.map((m) => m.spec)).toEqual(['@aur/auto', 'stub-small', 'anthropic:claude-3-5-haiku-latest']);
  });

  it('a failing provider is reported without its key, the others still list', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openai.com')) throw new Error('boom with sk-secret-123456 inside');
      return ok(['m1']);
    });
    const list = await listRemoteModels(
      { HOTL_BASE_URL: 'http://gw/v1', OPENAI_API_KEY: 'sk-secret-123456' },
      { fetchImpl: fetchImpl as never },
    );
    expect(list.models.map((m) => m.spec)).toEqual(['m1']);
    expect(list.errors).toEqual([{ source: 'OpenAI', error: 'boom with [REDACTED] inside' }]);
  });

  it('an HTTP error names the status', async () => {
    const list = await listRemoteModels(
      { HOTL_BASE_URL: 'http://gw/v1' },
      { fetchImpl: (async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) })) as never },
    );
    expect(list.errors[0]!.error).toBe('HTTP 401 Unauthorized');
  });
});

describe('runtime model specs', () => {
  it('parses provider prefixes, and only known ones', () => {
    expect(parseModelSpec('anthropic:claude-3-5-haiku')).toEqual({ provider: 'anthropic', name: 'claude-3-5-haiku' });
    expect(parseModelSpec('local:llama3:8b')).toEqual({ provider: 'local', name: 'llama3:8b' });
    expect(parseModelSpec('llama3:8b')).toEqual({ name: 'llama3:8b' });
    expect(parseModelSpec('@aur/auto')).toEqual({ name: '@aur/auto' });
  });

  it('stores a spec under a valid registry id', () => {
    expect(modelIdForSpec('gpt-4o')).toBe('gpt-4o');
    expect(modelIdForSpec('@aur/auto')).toBe('aur-auto');
    expect(modelIdForSpec('anthropic:claude-3-5-haiku-latest')).toBe('anthropic-claude-3-5-haiku-latest');
    expect(modelIdForSpec('gpt-4.1')).toBe('gpt-4-1');
  });

  it('a plain name uses the HOTL endpoint when one is set, a prefixed one its provider', () => {
    expect(runtimeModelConfig('@aur/auto', { HOTL_BASE_URL: 'http://gw/v1', HOTL_API_KEY: 'k' })).toMatchObject({
      id: 'aur-auto',
      provider: 'openai',
      model: '@aur/auto',
      config: { baseURL: 'http://gw/v1', api: 'chat', apiKeyEnv: 'HOTL_API_KEY' },
    });
    expect(runtimeModelConfig('gpt-4.1', {})).toMatchObject({ provider: 'openai', model: 'gpt-4.1', config: {} });
    expect(runtimeModelConfig('openai:gpt-4.1', { HOTL_BASE_URL: 'http://gw/v1' })).toEqual(
      expect.not.objectContaining({ config: expect.anything() }),
    );
    expect(runtimeModelConfig('anthropic:claude-3-5-haiku-latest', {})).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
    });
  });
});
