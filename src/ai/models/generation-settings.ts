import type { ModelConfig } from '../schemas/model-config.js';

/** Sampling / length settings forwarded to the AI SDK. */
export interface GenerationSettings {
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Read `temperature` and `maxOutputTokens` (or the older `maxTokens` alias)
 * from a model config so every `generateText` / `generateObject` / `streamText`
 * call can pass them through.
 */
export function generationSettingsFromConfig(
  config: ModelConfig | undefined
): GenerationSettings | undefined {
  const raw = config?.config;
  if (!raw || typeof raw !== 'object') return undefined;
  const temperature = typeof raw.temperature === 'number' ? raw.temperature : undefined;
  const maxOutputTokens =
    typeof raw.maxOutputTokens === 'number'
      ? raw.maxOutputTokens
      : typeof raw.maxTokens === 'number'
        ? raw.maxTokens
        : undefined;
  if (temperature === undefined && maxOutputTokens === undefined) return undefined;
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

/** Merge generation settings onto an AI SDK call options object. */
export function withGenerationSettings<T extends Record<string, unknown>>(
  options: T,
  settings: GenerationSettings | undefined
): T {
  if (!settings) return options;
  return {
    ...options,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.maxOutputTokens !== undefined ? { maxOutputTokens: settings.maxOutputTokens } : {}),
  };
}
