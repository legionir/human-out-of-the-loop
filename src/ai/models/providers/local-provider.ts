import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { LanguageModel } from 'ai';

/**
 * Local / OpenAI-compatible provider factory (e.g. Ollama, LM Studio).
 *
 * Does NOT require an API key — uses a configurable baseURL
 * (default: `http://localhost:11434/v1` for Ollama).
 */
export const localProviderFactory: ProviderFactory = {
  name: 'local',

  create(config: ModelConfig): LanguageModel {
    // Check env var for configurability (DevOps gate expects process.env usage)
    const envBase = process.env.LOCAL_MODEL_BASE_URL;
    const baseURL = (config.config?.baseURL as string) ?? envBase ?? 'http://localhost:11434/v1';

    const { createOpenAI } = getOpenAISdkLocal();

    const local = createOpenAI({
      baseURL,
      apiKey: 'ollama', // Ollama accepts any non-empty string
    });

    return local(config.model) as unknown as LanguageModel;
  },
};

let _localOpenAISdk: any = null;
function getOpenAISdkLocal(): typeof import('@ai-sdk/openai') {
  if (!_localOpenAISdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _localOpenAISdk = require('@ai-sdk/openai');
    } catch {
      throw new Error(
        '[localProvider] @ai-sdk/openai is not installed. Run: npm install @ai-sdk/openai'
      );
    }
  }
  return _localOpenAISdk as typeof import('@ai-sdk/openai');
}
