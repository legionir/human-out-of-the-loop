import { createRequire } from 'node:module';
import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

const require = createRequire(import.meta.url);

/**
 * Local / OpenAI-compatible provider factory (e.g. Ollama, LM Studio).
 *
 * Does NOT require an API key — uses a configurable baseURL
 * (default: `http://localhost:11434/v1` for Ollama).
 */
export const localProviderFactory: ProviderFactory = {
  name: 'local',

  create(config: ModelConfig): LanguageModel {
    const baseURL = (config.config?.baseURL as string) ?? 'http://localhost:11434/v1';

    const { createOpenAI } = require('@ai-sdk/openai') as {
      createOpenAI: (opts: unknown) => (model: string) => LanguageModel;
    };

    const local = createOpenAI({
      baseURL,
      apiKey: 'ollama', // Ollama accepts any non-empty string
    });

    return local(config.model) as unknown as LanguageModel;
  },
};
