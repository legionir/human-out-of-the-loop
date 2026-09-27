/**
 * Phase 24 (UI): minimal Server-Sent-Events hub.
 *
 * Subscribers register per plan id; the Orchestrator's ProgressEvents
 * are fanned out here.  Events carry only COMPACT data — tool names,
 * never arguments (Law 14), and no credentials can reach the frontend.
 *
 * F-10: a per-process connection cap so a stuck tab cannot unbounded-grow
 * the set of live sockets.
 */
import type { ServerResponse } from 'node:http';

export interface SseMessage {
  event: string;
  data: unknown;
}

export const DEFAULT_MAX_SSE_CONNECTIONS = 32;

export class SseHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly maxConnections: number;
  private live = 0;

  constructor(options: { maxConnections?: number } = {}) {
    this.maxConnections =
      options.maxConnections ?? DEFAULT_MAX_SSE_CONNECTIONS;
  }

  /** Live sockets across every plan. */
  connectionCount(): number {
    return this.live;
  }

  /**
   * Register a response for a plan.  Returns `null` when the process is
   * already at the connection cap (caller should 503).
   */
  subscribe(planId: string, res: ServerResponse): (() => void) | null {
    if (this.live >= this.maxConnections) return null;
    let set = this.subscribers.get(planId);
    if (!set) {
      set = new Set();
      this.subscribers.set(planId, set);
    }
    set.add(res);
    this.live++;
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
    const set = this.subscribers.get(planId);
    if (!set || set.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      payload = JSON.stringify({ error: 'unserializable payload' });
    }
    const frame = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        // Broken socket — drop silently; unsubscribe happens on 'close'.
      }
    }
  }

  /** Number of live subscribers (for tests/observability). */
  subscriberCount(planId: string): number {
    return this.subscribers.get(planId)?.size ?? 0;
  }
}
