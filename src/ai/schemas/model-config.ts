import { z } from 'zod';

/**
 * ModelConfig = تنظیمات provider مدل.
 * فیلد `config` آزاد است چون هر provider پارامترهای متفاوتی دارد.
 */
export const ModelConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  /** e.g. "openai", "anthropic", "local" */
  provider: z.string().min(1),
  /** Provider model name (e.g. the OpenAI or Anthropic catalog id) */
  model: z.string().min(1),
  /** Provider-specific options (temperature, maxTokens, …) */
  config: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
  /** J-03: USD per million tokens, used by `--budget` / `--estimate`. */
  pricing: z
    .object({
      inputUsdPerMTok: z.number().nonnegative(),
      outputUsdPerMTok: z.number().nonnegative(),
    })
    .optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
