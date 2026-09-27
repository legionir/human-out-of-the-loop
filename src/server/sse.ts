/**
 * Phase 24 (UI): minimal Server-Sent-Events hub.
 *
 * Subscribers register per plan (or run) id; the Orchestrator's ProgressEvents
 * are fanned out here.  Events carry only COMPACT data — tool names,
 * never arguments (Law 14), and no credentials can reach the frontend.
 *
 * F-10: a per-process connection cap so a stuck tab cannot unbounded-grow
 * the set of live sockets.
 *
 * H-02: each channel keeps a ring buffer of frames with monotonically
 * increasing `id:` so a subscriber that connects late (or reconnects with
 * `Last-Event-ID`) still sees `plan:started` and the rest of the timeline.
 */
import type { ServerResponse } from 'node:http';

export interface SseMessage {
  event: string;
  data: unknown;
}

export const DEFAULT_MAX_SSE_CONNECTIONS = 32;
export const DEFAULT_SSE_BUFFER_SIZE = 200;

interface BufferedFrame {
  id: number;
  event: string;
  data: unknown;
  frame: string;
}

export class SseHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly buffers = new Map<string, BufferedFrame[]>();
  private readonly nextIds = new Map<string, number>();
  private readonly maxConnections: number;
  private readonly bufferSize: number;
  private live = 0;

  constructor(options: { maxConnections?: number; bufferSize?: number } = {}) {
    this.maxConnections =
      options.maxConnections ?? DEFAULT_MAX_SSE_CONNECTIONS;
    this.bufferSize = options.bufferSize ?? DEFAULT_SSE_BUFFER_SIZE;
  }

  /** Live sockets across every plan. */
  connectionCount(): number {
    return this.live;
  }

  /** True when the next `subscribe` would be refused (F-10). */
  atCapacity(): boolean {
    return this.live >= this.maxConnections;
  }

  /**
   * Register a response for a plan.  Returns `null` when the process is
   * already at the connection cap (caller should 503).
   *
   * When `lastEventId` is set, buffered frames with a greater id are
   * written immediately (SSE replay).
   */
  subscribe(
    planId: string,
    res: ServerResponse,
    lastEventId?: number,
  ): (() => void) | null {
    if (this.live >= this.maxConnections) return null;
    let set = this.subscribers.get(planId);
    if (!set) {
      set = new Set();
      this.subscribers.set(planId, set);
    }
    set.add(res);
    this.live++;
    this.replay(planId, res, lastEventId);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      const current = this.subscribers.get(planId);
      if (current) {
        current.delete(res);
        if (current.size === 0) this.subscribers.delete(planId);
      }
      this.live = Math.max(0, this.live - 1);
    };
  }

  /** Fan a message out to all subscribers of a plan id. */
  emit(planId: string, event: string, data: unknown): void {
    const id = (this.nextIds.get(planId) ?? 0) + 1;
    this.nextIds.set(planId, id);
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      payload = JSON.stringify({ error: 'unserializable payload' });
    }
    const frame = `id: ${id}\nevent: ${event}\ndata: ${payload}\n\n`;
    const buf = this.buffers.get(planId) ?? [];
    buf.push({ id, event, data, frame });
    if (buf.length > this.bufferSize) buf.shift();
    this.buffers.set(planId, buf);

    const set = this.subscribers.get(planId);
    if (!set || set.size === 0) return;
    for (const res of set) {
      try {
        const ok = res.write(frame);
        void ok;
      } catch {
        // Broken socket — drop silently; unsubscribe happens on 'close'.
      }
    }
  }

  /** Number of live subscribers (for tests/observability). */
  subscriberCount(planId: string): number {
    return this.subscribers.get(planId)?.size ?? 0;
  }

  /** Frames currently buffered for a channel (tests / replay). */
  buffered(planId: string): ReadonlyArray<{ id: number; event: string; data: unknown }> {
    return this.buffers.get(planId) ?? [];
  }

  private replay(planId: string, res: ServerResponse, lastEventId?: number): void {
    const buf = this.buffers.get(planId);
    if (!buf || buf.length === 0) return;
    for (const item of buf) {
      if (lastEventId !== undefined && item.id <= lastEventId) continue;
      try {
        res.write(item.frame);
      } catch {
        return;
      }
    }
  }
}
