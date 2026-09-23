// ─── Types ────────────────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Maximum concurrent requests per provider (default: 5) */
  maxConcurrentPerProvider: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseBackoffMs: number;
  /** Maximum backoff delay in ms (default: 30000) */
  maxBackoffMs: number;
  /** Maximum retry attempts on rate-limit (default: 3) */
  maxRetries: number;
}

interface ProviderState {
  activeRequests: number;
  queue: Array<() => void>;
}

// ─── RateLimiter ─────────────────────────────────────────────────

/**
 * Per-provider concurrency limiter with exponential backoff.
 *
 * When a provider returns a 429 (rate-limit) error:
 *   1. The task is NOT marked as failed.
 *   2. A backoff delay is calculated: baseBackoff * 2^attempt.
 *   3. The task is retried after the delay (up to maxRetries).
 *   4. Only after exhausting retries is the task marked as failed.
 *
 * This is separate from the global `maxConcurrentTasks` in
 * TaskRuntime (Phase 8) — this limiter operates at the provider
 * API level to avoid hitting rate limits.
 */
export class RateLimiter {
  private readonly config: Required<RateLimiterConfig>;
  private readonly providers = new Map<string, ProviderState>();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      maxConcurrentPerProvider: config?.maxConcurrentPerProvider ?? 5,
      baseBackoffMs: config?.baseBackoffMs ?? 1000,
      maxBackoffMs: config?.maxBackoffMs ?? 30_000,
      maxRetries: config?.maxRetries ?? 3,
    };
  }

  /**
   * Acquire a slot for a provider.  If the provider is at its
   * concurrency limit, the call waits until a slot opens.
   */
  async acquire(provider: string): Promise<void> {
    const state = this.getOrCreateState(provider);

    if (state.activeRequests < this.config.maxConcurrentPerProvider) {
      state.activeRequests++;
      return;
    }

    // Wait in queue
    return new Promise<void>((resolve) => {
      state.queue.push(() => {
        state.activeRequests++;
        resolve();
      });
    });
  }

  /**
   * Release a slot for a provider and wake the next queued request.
   */
  release(provider: string): void {
    const state = this.providers.get(provider);
    if (!state) return;

    state.activeRequests = Math.max(0, state.activeRequests - 1);

    // Wake next in queue
    if (state.queue.length > 0 && state.activeRequests < this.config.maxConcurrentPerProvider) {
      const next = state.queue.shift()!;
      next();
    }
  }

  /**
   * Calculate backoff delay for a rate-limited request.
   */
  getBackoffDelay(attempt: number): number {
    const delay = this.config.baseBackoffMs * Math.pow(2, attempt);
    // Add jitter (±25%)
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(delay + jitter, this.config.maxBackoffMs);
  }

  /**
   * Check if a retry should be attempted.
   */
  shouldRetry(attempt: number): boolean {
    return attempt < this.config.maxRetries;
  }

  /**
   * Check if an error is a rate-limit error.
   */
  isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('throttl')
      );
    }
    return false;
  }

  /**
   * Execute a function with rate-limit awareness.
   * Retries with backoff on 429 errors.
   */
  async executeWithRetry<T>(
    provider: string,
    fn: () => Promise<T>
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      await this.acquire(provider);
      try {
        const result = await fn();
        return result;
      } catch (err) {
        if (this.isRateLimitError(err) && this.shouldRetry(attempt)) {
          const delay = this.getBackoffDelay(attempt);
          attempt++;
          await this.sleep(delay);
          continue;
        }
        throw err;
      } finally {
        this.release(provider);
      }
    }
  }

  /**
   * Get current concurrency stats for a provider.
   */
  getStats(provider: string): { active: number; queued: number } {
    const state = this.providers.get(provider);
    if (!state) return { active: 0, queued: 0 };
    return { active: state.activeRequests, queued: state.queue.length };
  }

  // ── Private ───────────────────────────────────────────────────

  private getOrCreateState(provider: string): ProviderState {
    if (!this.providers.has(provider)) {
      this.providers.set(provider, { activeRequests: 0, queue: [] });
    }
    return this.providers.get(provider)!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
