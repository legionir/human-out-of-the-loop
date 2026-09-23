/**
 * Phase 24 (UI): minimal Server-Sent-Events hub.
 *
 * Subscribers register per plan id; the Orchestrator's ProgressEvents
 * are fanned out here.  Events carry only COMPACT data — tool names,
 * never arguments (Law 14), and no credentials can reach the frontend.
 */
import type { ServerResponse } from 'node:http';

export interface SseMessage {
  event: string;
  data: unknown;
}

export class SseHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();

  /** Register a response for a plan; returns an unsubscribe function. */
  subscribe(planId: string, res: ServerResponse): () => void {
    let set = this.subscribers.get(planId);
    if (!set) {
      set = new Set();
      this.subscribers.set(planId, set);
    }
    set.add(res);
    return () => {
      const current = this.subscribers.get(planId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) this.subscribers.delete(planId);
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
