import { APICallError, NoObjectGeneratedError } from 'ai';
import { abortReason } from './abort.js';
import { collectSecretValues, scrubSecretValues } from './secret-scrub.js';
/**
 * Phase 30 (P5): bounded LLM calls.
 *
 * `--timeout-ms` has always covered an *agent run*, but every structured
 * call (planner assessment, plan generation, acceptance judgment, final
 * review) went out with no deadline at all: a provider that accepted the
 * connection and then never answered left the CLI waiting forever, with
 * no output and no way out.  Driving the real CLI against a deliberately
 * silent stub proved it — the process was still alive after 90 s.
 *
 * `withLlmTimeout` gives those calls the same deadline as a run and, on
 * expiry, **aborts the request**: an abandoned socket would otherwise keep
 * the Node event loop (and the CLI process) alive until the provider
 * finally answered.
 */

/** Same default as `agentTimeoutMs` (OrchestratorConfig). */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export class LlmTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Run one LLM call under a hard deadline.
 *
 * @param label  Human-readable call name, used in the error message.
 * @param ms     Deadline in milliseconds (falls back to the default).
 * @param call   Receives the `AbortSignal` to hand to the SDK call
 *               (`generateObject({ …, abortSignal })`).
 */
export async function withLlmTimeout<T>(
  label: string,
  ms: number | undefined,
  call: (signal: AbortSignal) => Promise<T>,
  /** A-04: operator cancel (run abort) races the timeout and the call. */
  external?: AbortSignal,
): Promise<T> {
  if (external?.aborted) throw abortReason(external, label);
  const timeoutMs = ms && ms > 0 ? ms : DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = (): void => {
    controller.abort(abortReason(external, label));
  };
  external?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new LlmTimeoutError(label, timeoutMs);
        // Abort, then reject: the request is cancelled at the socket,
        // so nothing keeps the process alive after the failure.
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const cancelled = external
      ? new Promise<never>((_resolve, reject) => {
          if (external.aborted) {
            reject(abortReason(external, label));
            return;
          }
          external.addEventListener(
            'abort',
            () => reject(abortReason(external, label)),
            { once: true },
          );
        })
      : undefined;
    return await Promise.race([
      call(controller.signal),
      timeout,
      ...(cancelled ? [cancelled] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * One more attempt when a structured call's answer could not be parsed or
 * did not match the schema (`NoObjectGeneratedError`).  Real models do
 * this occasionally; without a retry a single malformed answer ended the
 * whole run at planning, or failed a finished step and forced a re-plan.
 * Transport errors are NOT retried here — the provider SDK already retries
 * those (429/5xx) with backoff — except an unreadable 200 body, which it
 * does not retry.
 */
/**
 * A 200 whose body the provider SDK could not read as its response
 * ("Invalid JSON response"): a gateway glitch, not a bad request.  The SDK
 * retries only 429/5xx, so without this one garbled body ended the run.
 */
export function isUnreadableResponse(err: unknown): boolean {
  return APICallError.isInstance(err) && err.message === 'Invalid JSON response';
}

/**
 * The error's message, plus — for an unreadable response — what the
 * provider actually sent (status and the start of the body, secrets
 * scrubbed), so "Invalid JSON response" is diagnosable from the log.
 */
export function describeLlmError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!isUnreadableResponse(err)) return message;
  const body = String((err as { responseBody?: unknown }).responseBody ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const shown = scrubSecretValues(body.slice(0, 200), collectSecretValues(process.env));
  const status = (err as { statusCode?: number }).statusCode;
  return `${message} (HTTP ${status ?? '?'}, body: ${shown ? `"${shown}${body.length > 200 ? '…' : ''}"` : 'empty'})`;
}

export async function withStructuredRetry<T>(
  call: () => Promise<T>,
  attempts = 2,
  onAttemptError?: (err: unknown) => void
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const retryable = NoObjectGeneratedError.isInstance(err) || isUnreadableResponse(err);
      if (attempt >= attempts || !retryable) throw err;
      onAttemptError?.(err);
    }
  }
}
