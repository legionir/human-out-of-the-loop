import { type EnvLike } from './env-endpoint.js';

/**
 * Ask the providers which models they serve, so a model can be picked at
 * runtime (CLI `/model`, `hootl models --remote`, the web UI) instead of
 * only from the registry files.
 *
 *   HOTL_BASE_URL (+ HOTL_API_KEY)  GET <base>/models        specs: "<name>"
 *   OPENAI_API_KEY                  GET api.openai.com/v1/models
 *                                   specs: "<name>", or "openai:<name>" when a
 *                                   HOTL endpoint is the default
 *   ANTHROPIC_API_KEY               GET api.anthropic.com/v1/models
 *                                   specs: "anthropic:<name>"
 *
 * Keys are sent only to their own provider and never appear in results or
 * errors.
 */
export interface ModelSource {
  /** Shown to the user: "HOTL_BASE_URL", "OpenAI", "Anthropic". */
  label: string;
  kind: 'openai-compatible' | 'anthropic';
  url: string;
  /** Prefix that turns a listed name into a runtime model spec. */
  specPrefix: string;
  apiKey?: string;
}

export interface RemoteModel {
  /** Pass this to --model / /model / the UI. */
  spec: string;
  /** The provider's own model name. */
  name: string;
  source: string;
}

export interface RemoteModelList {
  models: RemoteModel[];
  errors: Array<{ source: string; error: string }>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function modelSources(env: EnvLike): ModelSource[] {
  const sources: ModelSource[] = [];
  const hotlBase = nonEmpty(env.HOTL_BASE_URL);
  if (hotlBase) {
    sources.push({
      label: 'HOTL_BASE_URL',
      kind: 'openai-compatible',
      url: `${hotlBase.replace(/\/+$/, '')}/models`,
      specPrefix: '',
      // R0-07: OPENAI_API_KEY is the real OpenAI credential and must never
      // be sent to a custom HOTL_BASE_URL — only the generic HOTL_API_KEY is.
      apiKey: nonEmpty(env.HOTL_API_KEY),
    });
  }
  const openaiKey = nonEmpty(env.OPENAI_API_KEY);
  if (openaiKey) {
    sources.push({
      label: 'OpenAI',
      kind: 'openai-compatible',
      url: 'https://api.openai.com/v1/models',
      specPrefix: hotlBase ? 'openai:' : '',
      apiKey: openaiKey,
    });
  }
  const anthropicKey = nonEmpty(env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    sources.push({
      label: 'Anthropic',
      kind: 'anthropic',
      url: 'https://api.anthropic.com/v1/models?limit=1000',
      specPrefix: 'anthropic:',
      apiKey: anthropicKey,
    });
  }
  return sources;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

async function listOne(source: ModelSource, fetchImpl: FetchLike, timeoutMs: number): Promise<string[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (source.kind === 'anthropic') {
    if (source.apiKey) headers['x-api-key'] = source.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (source.apiKey) {
    headers.authorization = `Bearer ${source.apiKey}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(source.url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> } | Array<{ id?: unknown }>;
    const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    return items.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`no answer within ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function listRemoteModels(
  env: EnvLike,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<RemoteModelList> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sources = modelSources(env);
  const secrets = sources.map((s) => s.apiKey).filter((k): k is string => Boolean(k));
  const scrub = (text: string): string => secrets.reduce((t, k) => t.split(k).join('[REDACTED]'), text);

  const settled = await Promise.allSettled(sources.map((s) => listOne(s, fetchImpl, timeoutMs)));
  const models: RemoteModel[] = [];
  const errors: RemoteModelList['errors'] = [];
  settled.forEach((result, i) => {
    const source = sources[i]!;
    if (result.status === 'fulfilled') {
      for (const name of [...new Set(result.value)].sort()) {
        models.push({ spec: `${source.specPrefix}${name}`, name, source: source.label });
      }
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ source: source.label, error: scrub(reason) });
    }
  });
  return { models, errors };
}
