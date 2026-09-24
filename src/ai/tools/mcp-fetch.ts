import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * Phase 30 (P10 follow-up) — an HTTP client tuned for MCP transports.
 *
 * Root cause of the `TypeError: terminated` / `UND_ERR_BODY_TIMEOUT` crash
 * seen in a live server log:
 *
 *   The AI SDK's MCP HTTP/SSE transports keep a long-lived `text/event-stream`
 *   connection open for server-initiated messages.  They use whatever `fetch`
 *   they are given — by default the process-global one, whose undici
 *   dispatcher applies a 5-minute *body* timeout (undici's default).  An SSE
 *   connection is idle by design between events, so after five quiet minutes
 *   undici aborts the request; the abort surfaces as an unowned rejection in
 *   the transport's background reader and, if nothing catches it, takes the
 *   whole process down.
 *
 * Two halves of the fix live here:
 *   1. an `undici` dispatcher with `bodyTimeout: 0` (no idle timeout — the
 *      read timeout is the MCP client's `connectTimeoutMs` race instead) and
 *      explicit `headersTimeout` / `connectTimeout` so a dead host still fails
 *      fast;
 *   2. that dispatcher is handed to the SDK through the transports' `fetch`
 *      option, so it applies only to MCP traffic — the rest of the process
 *      keeps Node's defaults.
 */

/** Long-lived SSE streams are idle by design: no body timeout. */
export const MCP_STREAM_BODY_TIMEOUT_MS = 0;
/** Time allowed for response headers once the socket is connected. */
export const MCP_HEADERS_TIMEOUT_MS = 30_000;
/** Time allowed to establish the TCP/TLS connection. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

export interface McpDispatcherOptions {
  bodyTimeout: number;
  headersTimeout: number;
  connectTimeout: number;
}

/** The dispatcher settings used for MCP HTTP/SSE traffic. */
export function mcpDispatcherOptions(
  overrides: Partial<McpDispatcherOptions> = {}
): McpDispatcherOptions {
  return {
    bodyTimeout: MCP_STREAM_BODY_TIMEOUT_MS,
    headersTimeout: MCP_HEADERS_TIMEOUT_MS,
    connectTimeout: MCP_CONNECT_TIMEOUT_MS,
    ...overrides,
  };
}

/** Structural subset of `fetch` that the MCP SDK needs. */
export type McpFetch = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;

export interface McpFetchHandle {
  fetch: McpFetch;
  dispatcher: Dispatcher;
  close: () => Promise<void>;
}

/**
 * Build a fetch bound to a dedicated dispatcher.  `overrides` exists so
 * tests can shrink the timeouts; production uses the defaults above.
 */
export function createMcpFetch(overrides: Partial<McpDispatcherOptions> = {}): McpFetchHandle {
  const dispatcher = new Agent(mcpDispatcherOptions(overrides));
  const fetchImpl: McpFetch = (input, init) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher } as never);
  return {
    fetch: fetchImpl,
    dispatcher,
    close: async () => {
      // `close()` waits for in-flight requests; `destroy()` is the backstop
      // so a stalled stream cannot hold shutdown hostage.
      await Promise.race([
        dispatcher.close(),
        new Promise<void>((resolve) => setTimeout(() => resolve(), 1000).unref?.()),
      ]);
      await dispatcher.destroy().catch(() => undefined);
    },
  };
}

/**
 * One shared handle per process, reference-counted by MCP server id: the
 * first `http`/`sse` connection creates it, the last disconnect closes it.
 */
const handleRefs = new Map<string, number>();
let sharedHandle: McpFetchHandle | undefined;

/** Reference the shared fetch for `serverId` (idempotent). */
export function acquireMcpFetch(serverId: string): McpFetchHandle {
  handleRefs.set(serverId, (handleRefs.get(serverId) ?? 0) + 1);
  if (!sharedHandle) sharedHandle = createMcpFetch();
  return sharedHandle;
}

/** Drop `serverId`'s reference; closes the shared dispatcher at zero. */
export async function releaseMcpFetch(serverId: string): Promise<void> {
  const count = (handleRefs.get(serverId) ?? 0) - 1;
  if (count > 0) {
    handleRefs.set(serverId, count);
    return;
  }
  handleRefs.delete(serverId);
  await releaseAllMcpFetch(serverId);
}

/** Test/diagnostic helper: the shared fetch without taking a reference. */
export function getMcpFetch(): McpFetchHandle | undefined {
  return sharedHandle;
}

/** Close the shared dispatcher once nothing references it any more. */
export async function releaseAllMcpFetch(exceptServerId?: string): Promise<void> {
  if (exceptServerId !== undefined && handleRefs.size > 0) return;
  const handle = sharedHandle;
  sharedHandle = undefined;
  handleRefs.clear();
  if (handle) await handle.close();
}
