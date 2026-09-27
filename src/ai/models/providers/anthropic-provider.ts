import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { EnvSource } from '../../env.js';
import type { LanguageModel } from 'ai';
import { createRequire } from 'node:module';

/**
 * Anthropic provider factory.
 *
 * Requires `ANTHROPIC_API_KEY`.  Phase 27 (CFG-08): the key is read from
 * the injected `env` when given, otherwise from `process.env`.
 */
export function resolveAnthropicClientOptions(
  config: ModelConfig,
  env?: EnvSource
): { apiKey: string; baseURL?: string } {
  const source = env ?? process.env;
  const keyVar =
    typeof config.config?.apiKeyEnv === 'string' ? config.config.apiKeyEnv : 'ANTHROPIC_API_KEY';
  const apiKey = source[keyVar] || source.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      `[anthropicProvider] ${keyVar === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY' : `${keyVar} (or ANTHROPIC_API_KEY)`} environment variable is not set.`
    );
  }
  const baseURL = typeof config.config?.baseURL === 'string' ? config.config.baseURL : undefined;
  return { apiKey, ...(baseURL ? { baseURL } : {}) };
}

export const anthropicProviderFactory: ProviderFactory = {
  name: 'anthropic',

  create(config: ModelConfig, env?: EnvSource): LanguageModel {
    const options = resolveAnthropicClientOptions(config, env);
    const { createAnthropic } = getAnthropicSdk();
    const anthropic = createAnthropic(options);
    return anthropic(config.model) as unknown as LanguageModel;
  },
};

// Phase 22: typed (was `any`) — the package is installed.
type AnthropicSdk = typeof import('@ai-sdk/anthropic');
let _anthropicSdk: AnthropicSdk | null = null;
// Phase 27: `require` is not a global in ESM (this package sets
// "type": "module"), so the lazy SDK load goes through a
// createRequire instance — the previous bare `require(...)` threw
// ReferenceError under the real runtime and was only masked by
// Vitest's require shim.
const requireSdk = createRequire(import.meta.url);

function getAnthropicSdk(): AnthropicSdk {
  if (!_anthropicSdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _anthropicSdk = requireSdk('@ai-sdk/anthropic') as AnthropicSdk;
    } catch {
      throw new Error(
        '[anthropicProvider] @ai-sdk/anthropic is not installed. Run: npm install @ai-sdk/anthropic'
      );
    }
  }
  return _anthropicSdk;
}
