import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { RateLimiter } from './rate-limiter.js';

/**
 * C-04: retry *model calls* (doGenerate / doStream), never the whole agent
 * run — so tools from a previous step are not executed again on a 429.
 */

export function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as Record<string, unknown>;
  for (const key of ['statusCode', 'status', 'status_code'] as const) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const cause = rec.cause;
  if (cause && cause !== error) return statusCodeOf(cause);
  return undefined;
}

export function isRetryableModelError(error: unknown): boolean {
  if (error == null) return false;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'PlanningAbortedError') {
    return false;
  }
  const status = statusCodeOf(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;

  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  return false;
}

export async function withModelCallRetry<T>(params: {
  provider: string;
  limiter: RateLimiter;
  fn: () => Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  const { provider, limiter, fn, signal } = params;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error('Aborted');
    }
    await limiter.acquire(provider);
    let backoffMs: number | undefined;
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isRetryableModelError(err) && limiter.shouldRetry(attempt)) {
        backoffMs = limiter.getBackoffDelay(attempt);
        attempt++;
      } else {
        throw err;
      }
    } finally {
      limiter.release(provider);
    }
    await sleep(backoffMs ?? 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryMiddleware(limiter: RateLimiter, provider: string): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) =>
      withModelCallRetry({ limiter, provider, fn: () => Promise.resolve(doGenerate()) }),
    wrapStream: async ({ doStream }) =>
      withModelCallRetry({ limiter, provider, fn: () => Promise.resolve(doStream()) }),
  };
}

/** Wrap a language model so each provider call is rate-limited and retried. */
export function wrapModelForRetry(
  model: LanguageModel,
  limiter: RateLimiter | undefined,
  provider = 'default'
): LanguageModel {
  if (!limiter) return model;
  if (typeof model !== 'object' || model === null) return model;
  try {
    return wrapLanguageModel({
      model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
      middleware: retryMiddleware(limiter, provider),
    }) as LanguageModel;
  } catch {
    return model;
  }
}
