import { createHash } from 'node:crypto';
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
  // B-22: HOTL_BASE_URL alone must not displace the global defaultModel.
  if (!name) return {};

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

// ─── Runtime model specs ─────────────────────────────────────────

/**
 * A model chosen at runtime (CLI `--model`, `/model`, the web UI) does not
 * have to be in the registry.  A spec is:
 *
 *   <registered id>           gpt-4o, claude-sonnet, custom …
 *   <provider>:<model name>   anthropic:claude-3-5-haiku-latest,
 *                             openai:gpt-4.1, local:llama3:8b
 *   <model name>              @aur/auto, gpt-4.1 — on the default endpoint:
 *                             HOTL_BASE_URL when set, else OpenAI
 */
export const SPEC_PROVIDERS = ['openai', 'anthropic', 'local'] as const;

export function parseModelSpec(spec: string): { provider?: string; name: string } {
  const colon = spec.indexOf(':');
  if (colon > 0) {
    const provider = spec.slice(0, colon);
    if ((SPEC_PROVIDERS as readonly string[]).includes(provider)) {
      return { provider, name: spec.slice(colon + 1) };
    }
  }
  return { name: spec };
}

/** The registry id a spec is stored under (ids allow only [a-z0-9_-]). */
export function modelIdForSpec(
  spec: string,
  known: ReadonlyArray<Pick<ModelConfig, 'id' | 'provider' | 'model'>> = [],
): string {
  const trimmed = spec.trim();
  if (!trimmed) return ENV_MODEL_ID;
  if (REGISTRY_ID.test(trimmed)) return trimmed;
  const { provider, name } = parseModelSpec(trimmed);
  if (!name.trim()) return ENV_MODEL_ID;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const id = slug || ENV_MODEL_ID;
  const existing = known.find((m) => m.id === id);
  if (existing) {
    const wantProvider = provider ?? 'openai';
    if (existing.provider !== wantProvider || existing.model !== name) {
      const suffix = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
      return `${id}-${suffix}`;
    }
  }
  return id;
}

/** The config a runtime spec registers (when its id is not registered yet). */
export function runtimeModelConfig(
  spec: string,
  env: EnvLike,
  known: ReadonlyArray<Pick<ModelConfig, 'id' | 'provider' | 'model'>> = [],
): ModelConfig {
  const { provider, name } = parseModelSpec(spec.trim());
  const id = modelIdForSpec(spec, known);
  const description = `Selected at runtime (${spec.trim()})`;
  if (provider === 'anthropic' || provider === 'local') {
    return { id, provider, model: name, description };
  }
  if (provider === 'openai') {
    // Explicitly the official OpenAI API — no gateway override.
    return { id, provider: 'openai', model: name, description };
  }
  const baseURL = nonEmpty(env.HOTL_BASE_URL);
  const style = nonEmpty(env.HOTL_API_STYLE)?.toLowerCase();
  const api = style === 'responses' || style === 'chat' ? style : baseURL ? 'chat' : undefined;
  return {
    id,
    provider: 'openai',
    model: name,
    config: {
      ...(baseURL ? { baseURL } : {}),
      ...(api ? { api } : {}),
      ...(nonEmpty(env.HOTL_API_KEY) ? { apiKeyEnv: 'HOTL_API_KEY' } : {}),
    },
    description,
  };
}
