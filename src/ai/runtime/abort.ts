/** Shared abort helpers for planner cancellation (A-04). */

export class PlanningAbortedError extends Error {
  constructor(message = 'Planning was cancelled') {
    super(message);
    this.name = 'PlanningAbortedError';
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof PlanningAbortedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'PlanningAbortedError';
}

export function throwIfAborted(signal: AbortSignal | undefined, label = 'Planning'): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new PlanningAbortedError(`${label} was cancelled`);
}

export function abortReason(signal: AbortSignal | undefined, label: string): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new PlanningAbortedError(`${label} was cancelled`);
}
