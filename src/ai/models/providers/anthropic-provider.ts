import { createRequire } from 'node:module';
import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

const require = createRequire(import.meta.url);

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

    const { createAnthropic } = require('@ai-sdk/anthropic') as {
      createAnthropic: (opts: unknown) => (model: string) => LanguageModel;
    };

    const anthropic = createAnthropic({ apiKey });
    return anthropic(config.model) as unknown as LanguageModel;
  },
};
