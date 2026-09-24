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
export const anthropicProviderFactory: ProviderFactory = {
  name: 'anthropic',

  create(config: ModelConfig, env?: EnvSource): LanguageModel {
    // Phase 27 (CFG-08): an injected env wins; process.env is the
    // default — the DevOps gate asserts this explicit fallback.
    const apiKey = env ? env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(`[anthropicProvider] ANTHROPIC_API_KEY environment variable is not set.`);
    }

    const { createAnthropic } = getAnthropicSdk();

    const anthropic = createAnthropic({ apiKey });
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
