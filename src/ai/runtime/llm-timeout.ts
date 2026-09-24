import { NoObjectGeneratedError } from 'ai';
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
  call: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = ms && ms > 0 ? ms : DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new LlmTimeoutError(label, timeoutMs);
          // Abort, then reject: the request is cancelled at the socket,
          // so nothing keeps the process alive after the failure.
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One more attempt when a structured call's answer could not be parsed or
 * did not match the schema (`NoObjectGeneratedError`).  Real models do
 * this occasionally; without a retry a single malformed answer ended the
 * whole run at planning, or failed a finished step and forced a re-plan.
 * Transport errors are NOT retried here — the provider SDK already retries
 * those (429/5xx) with backoff.
 */
export async function withStructuredRetry<T>(
  call: () => Promise<T>,
  attempts = 2
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts || !NoObjectGeneratedError.isInstance(err)) throw err;
    }
  }
}
