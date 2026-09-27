import type { LanguageModelUsage } from 'ai';
import type { TokenUsage } from './event-bus.js';

/**
 * Token usage of the structured (non-agent) model calls: planning,
 * acceptance judgments and the final review.
 *
 * Only agent turns reach the EventBus (`agent:completed`), so before this
 * callback existed every `generateObject` call was billed by the provider
 * but invisible in the final report and in `hootl usage`.
 */
export type LlmCallPurpose = 'planning' | 'acceptance' | 'review';

export interface LlmUsageReport {
  purpose: LlmCallPurpose;
  usage: TokenUsage;
  /** Plan the call worked for, when it is known at call time. */
  planId?: string;
  /** J-06: model id that produced this usage. */
  modelId?: string;
}

export type LlmUsageReporter = (report: LlmUsageReport) => void;

type LegacyUsageShape = { promptTokens?: number; completionTokens?: number };

/**
 * Normalize an AI SDK usage object.  `LanguageModelUsage` is the SDK v7
 * shape (inputTokens/outputTokens); the promptTokens/completionTokens
 * fallback keeps test mocks built against the older shape working.
 */
type CacheUsageShape = {
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0);
  const completionTokens = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0);
  const cacheReadTokens = (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0);
  const cacheWriteTokens = (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0) || promptTokens + completionTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

export function toTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as LanguageModelUsage & LegacyUsageShape & CacheUsageShape;
  const promptTokens = u.promptTokens ?? u.inputTokens ?? 0;
  const completionTokens = u.completionTokens ?? u.outputTokens ?? 0;
  const cacheReadTokens = u.cachedInputTokens ?? u.cacheReadInputTokens ?? 0;
  const cacheWriteTokens = u.cacheCreationInputTokens ?? u.cacheWriteInputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.totalTokens ?? promptTokens + completionTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

/** Report a structured call's usage; a failing reporter never fails the call. */
export function reportLlmUsage(
  reporter: LlmUsageReporter | undefined,
  purpose: LlmCallPurpose,
  raw: unknown,
  planId?: string
): void {
  if (!reporter) return;
  const usage = toTokenUsage(raw);
  if (!usage) return;
  try {
    reporter({ purpose, usage, ...(planId ? { planId } : {}) });
  } catch {
    // accounting must never break a run
  }
}
