import { createRequire } from 'node:module';
import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

const require = createRequire(import.meta.url);

/**
 * OpenAI provider factory.
 *
 * Requires `OPENAI_API_KEY` environment variable.
 * Uses dynamic require so that `@ai-sdk/openai` is only loaded
 * when this provider is actually used.
 */
export const openaiProviderFactory: ProviderFactory = {
  name: 'openai',

  create(config: ModelConfig): LanguageModel {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(`[openaiProvider] OPENAI_API_KEY environment variable is not set.`);
    }

    const { createOpenAI } = require('@ai-sdk/openai') as {
      createOpenAI: (opts: unknown) => (model: string) => LanguageModel;
    };

    const openai = createOpenAI({
      apiKey,
      ...(config.config?.baseURL ? { baseURL: config.config.baseURL as string } : {}),
    });

    return openai(config.model) as unknown as LanguageModel;
  },
};
