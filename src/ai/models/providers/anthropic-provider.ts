import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

/**
 * Anthropic provider factory.
 *
 * Requires `ANTHROPIC_API_KEY` environment variable.
 */
export const anthropicProviderFactory: ProviderFactory = {
  name: 'anthropic',

  create(config: ModelConfig): LanguageModel {
    const apiKey = process.env.ANTHROPIC_API_KEY;
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
function getAnthropicSdk(): AnthropicSdk {
  if (!_anthropicSdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _anthropicSdk = require('@ai-sdk/anthropic') as AnthropicSdk;
    } catch {
      throw new Error(
        '[anthropicProvider] @ai-sdk/anthropic is not installed. Run: npm install @ai-sdk/anthropic'
      );
    }
  }
  return _anthropicSdk;
}
