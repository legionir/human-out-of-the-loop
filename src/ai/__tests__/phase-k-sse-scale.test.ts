/**
 * K-04 / K-06 — SSE connection + ring-buffer caps (F-10) and idle MCP
 * streams (bodyTimeout 0). Production telemetry is still an owner input;
 * these tests prove the guards exist and hold under a synthetic load.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SseHub, DEFAULT_MAX_SSE_CONNECTIONS, DEFAULT_SSE_BUFFER_SIZE } from '../../server/sse.js';
import { MCP_STREAM_BODY_TIMEOUT_MS, mcpDispatcherOptions } from '../tools/mcp-fetch.js';

function fakeRes(): ServerResponse {
  const res = new EventEmitter() as ServerResponse & { writableEnded?: boolean };
  res.write = () => true;
  res.end = () => res;
  res.writableEnded = false;
  return res;
}

describe('K-04 — SSE caps', () => {
  it('refuses the N+1 connection and keeps the ring buffer bounded', () => {
    const hub = new SseHub({ maxConnections: 3, bufferSize: 5 });
    const unsubs = [hub.subscribe('p', fakeRes()), hub.subscribe('p', fakeRes()), hub.subscribe('p', fakeRes())];
    expect(unsubs.every(Boolean)).toBe(true);
    expect(hub.atCapacity()).toBe(true);
    expect(hub.subscribe('p', fakeRes())).toBeNull();
    expect(DEFAULT_MAX_SSE_CONNECTIONS).toBe(32);
    expect(DEFAULT_SSE_BUFFER_SIZE).toBe(200);

    for (let i = 0; i < 20; i++) hub.emit('p', 'tick', { i });
    const late = fakeRes();
    const writes: string[] = [];
    late.write = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    unsubs[0]!();
    expect(hub.subscribe('p', late, 0)).toBeTruthy();
    expect(writes.length).toBeLessThanOrEqual(5);
  });
});

describe('K-06 — MCP SSE idle timeout is disabled', () => {
  it('dispatcher bodyTimeout is 0 so undici will not UND_ERR_BODY_TIMEOUT an idle stream', () => {
    expect(MCP_STREAM_BODY_TIMEOUT_MS).toBe(0);
    expect(mcpDispatcherOptions().bodyTimeout).toBe(0);
  });
});
