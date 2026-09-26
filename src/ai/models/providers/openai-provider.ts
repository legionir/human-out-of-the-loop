import type { ProviderFactory } from '../../registries/model-registry.js';
import type { ModelConfig } from '../../schemas/model-config.js';
import type { EnvSource } from '../../env.js';
import type { LanguageModel } from 'ai';
import { createRequire } from 'node:module';

/**
 * OpenAI provider factory.
 *
 * Requires `OPENAI_API_KEY`.  Phase 27 (CFG-08): the key is read from
 * the injected `env` when given, otherwise from `process.env`.
 * Uses lazy-loaded SDK with caching and error handling.
 */
export const openaiProviderFactory: ProviderFactory = {
  name: 'openai',

  create(config: ModelConfig, env?: EnvSource): LanguageModel {
    // Phase 27 (CFG-08): an injected env wins; process.env is the
    // default — the DevOps gate asserts this explicit fallback.
    const source = env ?? process.env;
    // A model may name its own key variable (the HOTL_* endpoint does);
    // HOTL_API_KEY is the generic fallback for any endpoint.
    const keyVar = typeof config.config?.apiKeyEnv === 'string' ? config.config.apiKeyEnv : undefined;
    const baseURL = typeof config.config?.baseURL === 'string' ? config.config.baseURL : undefined;
    // R0-07: OPENAI_API_KEY is the real, high-value OpenAI credential. It
    // must never be sent to a custom baseURL — a project-controlled model
    // config or .env pointing baseURL somewhere else must not be able to
    // exfiltrate it. It is only used as a fallback when talking to the
    // real OpenAI API (no baseURL, or api.openai.com explicitly).
    const isRealOpenAiEndpoint =
      baseURL === undefined ||
      (() => {
        try {
          return /(^|\.)api\.openai\.com$/i.test(new URL(baseURL).hostname);
        } catch {
          return false;
        }
      })();
    const apiKey =
      (keyVar ? source[keyVar] : undefined) ||
      source.HOTL_API_KEY ||
      (isRealOpenAiEndpoint ? source.OPENAI_API_KEY : undefined);
    if (!apiKey) {
      throw new Error(
        `[openaiProvider] No API key: set ${keyVar && keyVar !== 'HOTL_API_KEY' ? `${keyVar} or ` : ''}HOTL_API_KEY` +
          `${isRealOpenAiEndpoint ? ' (or OPENAI_API_KEY)' : ` (OPENAI_API_KEY is not sent to a custom baseURL)`}.`
      );
    }

    const { createOpenAI } = getOpenAISdk();

    const openai = createOpenAI({
      apiKey,
      ...(config.config?.baseURL ? { baseURL: config.config.baseURL as string } : {}),
    });

    // Most OpenAI-compatible gateways implement Chat Completions only;
    // the Responses API is the SDK default for api.openai.com.
    if (config.config?.api === 'chat') return openai.chat(config.model) as unknown as LanguageModel;
    return openai(config.model) as unknown as LanguageModel;
  },
};

// Lazy-loaded SDK cache.  Phase 22: typed (was `any`) — the package is
// installed, so the module type resolves.
type OpenAiSdk = typeof import('@ai-sdk/openai');
let _openaiSdk: OpenAiSdk | null = null;
// Phase 27: `require` is not a global in ESM (this package sets
// "type": "module"), so the lazy SDK load goes through a
// createRequire instance — the previous bare `require(...)` threw
// ReferenceError under the real runtime and was only masked by
// Vitest's require shim.
const requireSdk = createRequire(import.meta.url);

function getOpenAISdk(): OpenAiSdk {
  if (!_openaiSdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _openaiSdk = requireSdk('@ai-sdk/openai') as OpenAiSdk;
    } catch {
      throw new Error(
        '[openaiProvider] @ai-sdk/openai is not installed. Run: npm install @ai-sdk/openai'
      );
    }
  }
  return _openaiSdk;
}
