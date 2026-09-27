/**
 * Poll until `predicate` is true, instead of sleeping a guessed number of
 * milliseconds.  Fixed sleeps flake on loaded CI runners (I-03).
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const extra = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(options.message ?? `waitUntil timed out after ${timeoutMs}ms${extra}`);
}
