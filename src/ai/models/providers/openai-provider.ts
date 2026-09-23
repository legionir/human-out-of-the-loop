import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

/**
 * OpenAI provider factory.
 *
 * Requires `OPENAI_API_KEY` environment variable.
 * Uses lazy-loaded SDK with caching and error handling.
 */
export const openaiProviderFactory: ProviderFactory = {
  name: 'openai',

  create(config: ModelConfig): LanguageModel {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(`[openaiProvider] OPENAI_API_KEY environment variable is not set.`);
    }

    const { createOpenAI } = getOpenAISdk();

    const openai = createOpenAI({
      apiKey,
      ...(config.config?.baseURL ? { baseURL: config.config.baseURL as string } : {}),
    });

    return openai(config.model) as unknown as LanguageModel;
  },
};

// Lazy-loaded SDK cache
let _openaiSdk: any = null;
function getOpenAISdk(): typeof import('@ai-sdk/openai') {
  if (!_openaiSdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _openaiSdk = require('@ai-sdk/openai');
    } catch {
      throw new Error(
        '[openaiProvider] @ai-sdk/openai is not installed. Run: npm install @ai-sdk/openai'
      );
    }
  }
  return _openaiSdk as typeof import('@ai-sdk/openai');
}
