/**
 * Phase 30 (P10 follow-up) — root cause of the `UND_ERR_BODY_TIMEOUT` crash.
 *
 * A live server log once showed `TypeError: terminated` (cause:
 * `BodyTimeoutError`) killing the process minutes after an MCP probe.  The
 * chain is:
 *
 *   MCP HTTP/SSE transports hold one long-lived `text/event-stream` open;
 *   the default fetch dispatcher aborts an *idle* body after 5 minutes;
 *   the abort surfaced as an unowned rejection and took the server down.
 *
 * These tests reproduce the mechanism with a 250 ms body timeout (instead of
 * waiting five minutes) and then prove the fix: `mcp-fetch.ts` gives MCP
 * traffic a dispatcher with no body timeout, while still failing fast on a
 * dead host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_HEADERS_TIMEOUT_MS,
  MCP_STREAM_BODY_TIMEOUT_MS,
  acquireMcpFetch,
  createMcpFetch,
  getMcpFetch,
  mcpDispatcherOptions,
  releaseMcpFetch,
} from '../tools/mcp-fetch.js';

const servers: http.Server[] = [];

/** An SSE endpoint that says hello and then goes quiet — like a real one. */
function startSilentSseServer(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': keep-alive\n\n');
    // …and never write another byte.
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}/sse`);
    });
  });
}

/** Read the body until it errors or `deadlineMs` passes. */
async function readBody(
  url: string,
  fetchImpl: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>,
  init: Record<string, unknown> = {},
  deadlineMs = 800
): Promise<{ outcome: 'alive' } | { outcome: 'error'; error: unknown }> {
  const response = (await fetchImpl(url, init)) as { body: ReadableStream<Uint8Array> };
  const reader = response.body.getReader();
  const deadline = new Promise<{ outcome: 'alive' }>((resolve) =>
    setTimeout(() => resolve({ outcome: 'alive' }), deadlineMs)
  );
  const read = (async (): Promise<{ outcome: 'alive' } | { outcome: 'error'; error: unknown }> => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return { outcome: 'alive' };
      }
    } catch (error) {
      return { outcome: 'error', error };
    }
  })();
  return Promise.race([read, deadline]);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          // `close()` alone waits for open keep-alive sockets — including the
          // deliberately-silent SSE stream this file creates.
          s.closeAllConnections?.();
          s.close(() => resolve());
        })
    )
  );
});

describe('Phase 30 / P10 — MCP HTTP client (undici root cause)', () => {
  it('uses no body timeout for streams, but keeps header/connect deadlines', () => {
    expect(mcpDispatcherOptions()).toEqual({
      bodyTimeout: MCP_STREAM_BODY_TIMEOUT_MS,
      headersTimeout: MCP_HEADERS_TIMEOUT_MS,
      connectTimeout: MCP_CONNECT_TIMEOUT_MS,
    });
    expect(MCP_STREAM_BODY_TIMEOUT_MS).toBe(0);
    expect(mcpDispatcherOptions({ bodyTimeout: 250 }).bodyTimeout).toBe(250);
  });

  it('reproduces the crash: the default dispatcher kills an idle SSE body', async () => {
    const url = await startSilentSseServer();
    const dispatcher = new Agent({ bodyTimeout: 250 }); // undici default is 300 000

    const result = await readBody(
      url,
      undiciFetch as never,
      { dispatcher, headers: { accept: 'text/event-stream' } },
      1500
    );

    expect(result.outcome).toBe('error');
    const error = (result as { error: { code?: string; message?: string; cause?: unknown } }).error;
    const code =
      error.code ?? (error.cause as { code?: string } | undefined)?.code ?? '';
    expect(`${error.message ?? ''} ${code}`).toMatch(/body timeout|UND_ERR_BODY_TIMEOUT|terminated/i);

    await dispatcher.close();
    await dispatcher.destroy();
  });

  it('the MCP fetch keeps the same idle stream alive (the fix)', async () => {
    const url = await startSilentSseServer();
    const handle = createMcpFetch();

    const result = await readBody(url, handle.fetch, { headers: { accept: 'text/event-stream' } }, 900);

    expect(result).toEqual({ outcome: 'alive' });
    await handle.close();
  });

  it('a dead host still fails fast instead of hanging (connect timeout)', async () => {
    const handle = createMcpFetch({ connectTimeout: 400, headersTimeout: 2000, bodyTimeout: 0 });
    const startedAt = Date.now();

    // 192.0.2.0/24 is TEST-NET-1: reserved and never routable.
    const outcome = await readBody(
      'http://192.0.2.1:9/mcp',
      handle.fetch,
      { headers: { accept: 'text/event-stream' } },
      5000
    ).catch((error: unknown) => ({ outcome: 'error' as const, error }));

    expect(outcome.outcome).toBe('error');
    expect(Date.now() - startedAt).toBeLessThan(4000);
    await handle.close();
  });

  it('reference counting: the shared dispatcher closes only at zero', async () => {
    const first = acquireMcpFetch('srv-a');
    const second = acquireMcpFetch('srv-b');
    expect(first.fetch).toBe(second.fetch);
    expect(getMcpFetch()).toBeDefined();

    await releaseMcpFetch('srv-a');
    expect(getMcpFetch()).toBeDefined(); // srv-b still holds it

    await releaseMcpFetch('srv-b');
    expect(getMcpFetch()).toBeUndefined(); // last one out closed it
  });
});
