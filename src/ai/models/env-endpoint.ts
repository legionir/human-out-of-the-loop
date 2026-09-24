import type { ModelConfig } from '../schemas/model-config.js';

/**
 * A model endpoint configured entirely from the environment — no registry
 * file to edit:
 *
 *   HOTL_BASE_URL   OpenAI-compatible base URL (a gateway, a local server, …)
 *   HOTL_API_KEY    its key (read at call time; OPENAI_API_KEY also works)
 *   HOTL_MODEL      the model to use: a registered model id (e.g. gpt-4o), or
 *                   any provider model name (e.g. "@aur/auto", "llama3:8b")
 *   HOTL_API_STYLE  "chat" (Chat Completions) or "responses" (Responses API);
 *                   default "chat" for a custom base URL — what almost every
 *                   OpenAI-compatible gateway implements.
 *
 * A model name that is not a registered id is registered under the id
 * `custom` (registry ids are restricted to [a-z0-9_-]).
 */
export const ENV_MODEL_ID = 'custom';

export type EnvLike = Record<string, string | undefined>;

export interface EnvEndpoint {
  /** Config to register (replacing a same-id entry), when the env asks for one. */
  config?: ModelConfig;
  /** The model id the env selects as the default. */
  defaultModelId?: string;
}

const REGISTRY_ID = /^[a-z0-9_-]+$/;

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function envEndpoint(env: EnvLike, known: ReadonlyArray<ModelConfig>): EnvEndpoint {
  const baseURL = nonEmpty(env.HOTL_BASE_URL);
  const name = nonEmpty(env.HOTL_MODEL);
  if (!baseURL && !name) return {};

  const style = nonEmpty(env.HOTL_API_STYLE)?.toLowerCase();
  const api = style === 'responses' || style === 'chat' ? style : baseURL ? 'chat' : undefined;
  const keyVar = nonEmpty(env.HOTL_API_KEY) ? 'HOTL_API_KEY' : undefined;

  const registered = name && REGISTRY_ID.test(name) ? known.find((m) => m.id === name) : undefined;
  if (registered) {
    // A known id: only point it at the custom endpoint when one is given.
    if (!baseURL || registered.provider !== 'openai') return { defaultModelId: registered.id };
    return {
      defaultModelId: registered.id,
      config: {
        ...registered,
        config: {
          ...(registered.config ?? {}),
          baseURL,
          ...(api ? { api } : {}),
          ...(keyVar ? { apiKeyEnv: keyVar } : {}),
        },
      },
    };
  }

  return {
    defaultModelId: ENV_MODEL_ID,
    config: {
      id: ENV_MODEL_ID,
      provider: 'openai',
      model: name ?? 'gpt-4o',
      config: {
        ...(baseURL ? { baseURL } : {}),
        ...(api ? { api } : {}),
        ...(keyVar ? { apiKeyEnv: keyVar } : {}),
      },
      description: `From the environment (HOTL_MODEL=${name ?? 'gpt-4o'}${baseURL ? `, HOTL_BASE_URL=${baseURL}` : ''})`,
    },
  };
}
