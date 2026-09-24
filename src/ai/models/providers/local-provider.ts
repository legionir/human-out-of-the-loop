import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { EnvSource } from '../../env.js';
import type { LanguageModel } from 'ai';
import { createRequire } from 'node:module';

/**
 * Local / OpenAI-compatible provider factory (e.g. Ollama, LM Studio).
 *
 * Does NOT require an API key — uses a configurable baseURL
 * (default: `http://localhost:11434/v1` for Ollama).
 */
export const localProviderFactory: ProviderFactory = {
  name: 'local',

  create(config: ModelConfig, env?: EnvSource): LanguageModel {
    // Phase 27 (CFG-08): `LOCAL_MODEL_BASE_URL` comes from the injected
    // env when given, otherwise from `process.env` (unchanged default).
    // Phase 27 (CFG-08): injected env wins; explicit process.env fallback.
    const envBase = env ? env.LOCAL_MODEL_BASE_URL : process.env.LOCAL_MODEL_BASE_URL;
    const baseURL = (config.config?.baseURL as string) ?? envBase ?? 'http://localhost:11434/v1';

    const { createOpenAI } = getOpenAISdkLocal();

    const local = createOpenAI({
      baseURL,
      apiKey: 'ollama', // Ollama accepts any non-empty string
    });

    return local(config.model) as unknown as LanguageModel;
  },
};

// Phase 22: typed (was `any`) — the package is installed.
type LocalOpenAiSdk = typeof import('@ai-sdk/openai');
let _localOpenAISdk: LocalOpenAiSdk | null = null;
// Phase 27: `require` is not a global in ESM (this package sets
// "type": "module"), so the lazy SDK load goes through a
// createRequire instance — the previous bare `require(...)` threw
// ReferenceError under the real runtime and was only masked by
// Vitest's require shim.
const requireSdk = createRequire(import.meta.url);

function getOpenAISdkLocal(): LocalOpenAiSdk {
  if (!_localOpenAISdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _localOpenAISdk = requireSdk('@ai-sdk/openai') as LocalOpenAiSdk;
    } catch {
      throw new Error(
        '[localProvider] @ai-sdk/openai is not installed. Run: npm install @ai-sdk/openai'
      );
    }
  }
  return _localOpenAISdk;
}
