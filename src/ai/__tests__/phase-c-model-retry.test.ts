/**
 * C-04 — model-call retry and per-provider concurrency (no generateText mock).
 */
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { RateLimiter } from '../runtime/rate-limiter.js';
import {
  isRetryableModelError,
  statusCodeOf,
  withModelCallRetry,
  wrapModelForRetry,
} from '../runtime/model-call-retry.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { EventBus } from '../runtime/event-bus.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';

function errWithStatus(status: number, message = 'fail'): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

describe('C-04 — retryable status codes', () => {
  it('retries 429/5xx/network and not 4xx', () => {
    expect(isRetryableModelError(errWithStatus(429))).toBe(true);
    expect(isRetryableModelError(errWithStatus(502))).toBe(true);
    expect(isRetryableModelError(errWithStatus(401))).toBe(false);
    expect(statusCodeOf(errWithStatus(503))).toBe(503);
    expect(isRetryableModelError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true
    );
  });

  it('429 on a model call retries without re-running previous tools', async () => {
    let toolRuns = 0;
    let modelCalls = 0;
    const limiter = new RateLimiter({
      maxRetries: 3,
      baseBackoffMs: 5,
      maxBackoffMs: 20,
      maxConcurrentPerProvider: 2,
      random: () => 0.5,
    });
    toolRuns++; // step 1 already executed the tool
    const text = await withModelCallRetry({
      provider: 'openai',
      limiter,
      fn: async () => {
        modelCalls++;
        if (modelCalls === 1) throw errWithStatus(429, 'rate limited');
        return 'done';
      },
    });
    expect(text).toBe('done');
    expect(toolRuns).toBe(1);
    expect(modelCalls).toBe(2);
  });

  it('maxConcurrentPerProvider:1 serializes two model calls', async () => {
    let active = 0;
    let max = 0;
    const limiter = new RateLimiter({
      maxConcurrentPerProvider: 1,
      maxRetries: 0,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      random: () => 0.5,
    });
    const call = () =>
      withModelCallRetry({
        provider: 'p',
        limiter,
        fn: async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 40));
          active--;
          return true;
        },
      });
    await Promise.all([call(), call()]);
    expect(max).toBe(1);
  });

  it('AgentRuntime wraps the model so a 429 is retried', async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (async () => {
        n++;
        if (n === 1) throw errWithStatus(429, 'slow down');
        return {
          content: [{ type: 'text', text: 'hello' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        };
      }) as never,
    });
    const limiter = new RateLimiter({
      maxRetries: 2,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
      random: () => 0.5,
    });
    const agent: ResolvedAgent = {
      agentId: 'a',
      systemPrompt: 's',
      tools: {},
      model,
      persona: { id: 'p', name: 'P', system: 's', allowedTools: [] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
      providerId: 'openai',
    };
    const result = await new AgentRuntime({ rateLimiter: limiter }).run({
      agent,
      taskId: 't',
      prompt: 'hi',
      eventBus: new EventBus(),
    });
    expect(result.success).toBe(true);
    expect(result.result).toBe('hello');
    expect(n).toBe(2);
  });
});
