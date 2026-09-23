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

let _anthropicSdk: any = null;
function getAnthropicSdk(): typeof import('@ai-sdk/anthropic') {
  if (!_anthropicSdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _anthropicSdk = require('@ai-sdk/anthropic');
    } catch {
      throw new Error(
        '[anthropicProvider] @ai-sdk/anthropic is not installed. Run: npm install @ai-sdk/anthropic'
      );
    }
  }
  return _anthropicSdk as typeof import('@ai-sdk/anthropic');
}
