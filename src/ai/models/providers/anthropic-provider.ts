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
  const baseURL = typeof config.config?.baseURL === 'string' ? config.config.baseURL : undefined;
  // R0-07 (same rule as the OpenAI provider): ANTHROPIC_API_KEY is only ever
  // sent to Anthropic itself.  A custom baseURL — which a project's model
  // config can set — must name its own key variable (or use HOTL_API_KEY).
  const isRealAnthropicEndpoint =
    baseURL === undefined ||
    (() => {
      try {
        return /(^|\.)api\.anthropic\.com$/i.test(new URL(baseURL).hostname);
      } catch {
        return false;
      }
    })();
  const configured =
    typeof config.config?.apiKeyEnv === 'string' ? config.config.apiKeyEnv : undefined;
  const keyVar =
    configured === 'ANTHROPIC_API_KEY' && !isRealAnthropicEndpoint ? undefined : configured;
  const apiKey =
    (keyVar ? source[keyVar] : undefined) ||
    (isRealAnthropicEndpoint ? source.ANTHROPIC_API_KEY : source.HOTL_API_KEY);
  if (!apiKey) {
    const wanted = isRealAnthropicEndpoint
      ? `${keyVar && keyVar !== 'ANTHROPIC_API_KEY' ? `${keyVar} (or ANTHROPIC_API_KEY)` : 'ANTHROPIC_API_KEY'}`
      : `${keyVar ? `${keyVar} or ` : ''}HOTL_API_KEY (ANTHROPIC_API_KEY is not sent to a custom baseURL)`;
    throw new Error(`[anthropicProvider] ${wanted} environment variable is not set.`);
  }
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
