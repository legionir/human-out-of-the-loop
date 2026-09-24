import { AgentRuntime, type AgentRunOptions, type AgentRunResult } from './agent-runtime.js';
import { RateLimiter } from './rate-limiter.js';

// ─── Types ────────────────────────────────────────────────────────

export interface RetryableAgentRunOptions extends AgentRunOptions {
  /** Maximum retry attempts on recoverable errors (default: 1) */
  maxRetries?: number;
  /** Provider name for rate-limit tracking (default: "default") */
  providerName?: string;
}

// ─── RetryableAgentRuntime ───────────────────────────────────────

/**
 * Wraps AgentRuntime with automatic retry on recoverable errors
 * (rate-limit, timeout) and rate-limit awareness.
 *
 * Distinction from Phase 13 RateLimiter:
 *   - RateLimiter handles per-provider concurrency and 429 backoff.
 *   - This wrapper handles retry of the ENTIRE agent run on
 *     transient failures (timeout, provider crash).
 *   - They compose: RateLimiter wraps individual API calls,
 *     this wraps the full agent execution.
 */
export class RetryableAgentRuntime {
  private readonly runtime: AgentRuntime;
  private readonly rateLimiter: RateLimiter;

  constructor(runtime?: AgentRuntime, rateLimiter?: RateLimiter) {
    this.runtime = runtime ?? new AgentRuntime();
    this.rateLimiter = rateLimiter ?? new RateLimiter();
  }

  async run(options: RetryableAgentRunOptions): Promise<AgentRunResult> {
    const maxRetries = options.maxRetries ?? 1;
    const provider = options.providerName ?? 'default';
    let lastResult: AgentRunResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.rateLimiter.executeWithRetry(
          provider,
          () => this.runtime.run(options)
        );

        if (result.success) return result;

        // Check if the failure is recoverable
        if (this.isRecoverable(result) && attempt < maxRetries) {
          lastResult = result;
          continue; // Retry
        }

        return result; // Non-recoverable or last attempt
      } catch (err) {
        if (attempt < maxRetries) {
          lastResult = {
            taskId: options.taskId,
            agentId: options.agent.agentId,
            success: false,
            summary: `Retry ${attempt + 1} after error: ${err instanceof Error ? err.message : String(err)}`,
            result: '',
            toolsUsed: [],
            errors: [err instanceof Error ? err.message : String(err)],
            failureType: 'technical',
          };
          continue;
        }

        return {
          taskId: options.taskId,
          agentId: options.agent.agentId,
          success: false,
          summary: `All ${maxRetries + 1} attempts failed.`,
          result: '',
          toolsUsed: [],
          errors: [err instanceof Error ? err.message : String(err)],
          failureType: 'technical',
        };
      }
    }

    return lastResult!;
  }

  private isRecoverable(result: AgentRunResult): boolean {
    if (result.success) return false;
    const errors = result.errors.join(' ').toLowerCase();
    return (
      errors.includes('timeout') ||
      errors.includes('timedout') ||
      errors.includes('timed out') ||
      errors.includes('etimedout') ||
      errors.includes('rate limit') ||
      errors.includes('429') ||
      errors.includes('503') ||
      errors.includes('502') ||
      errors.includes('econnreset') ||
      errors.includes('econnrefused')
    );
  }
}
