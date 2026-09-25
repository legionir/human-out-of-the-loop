/**
 * Phase 32 — the model's live "thinking" text.
 *
 * A run can spend a long time inside one model call: planning, a step's
 * agent turn, an acceptance judgment.  Until now the CLI printed nothing
 * while it waited, and the user could not tell a slow provider from a
 * hung process.
 *
 * This module is the (deliberately tiny) seam for the other half of that
 * fix: the reasoning text itself.  Providers that expose reasoning
 * (`reasoning-delta` parts — OpenAI reasoning summaries, Anthropic
 * extended thinking, …) and OpenAI-compatible chat gateways that stream
 * `reasoning_content` in the raw chunk are both funnelled into ONE
 * callback, `ThoughtSink`, which the CLI renders as it arrives.
 *
 * Design notes:
 *   - Reasoning text is **user-facing output**, not an event: it never
 *     reaches the EventBus, the observability log or the plan artifacts
 *     (Law 14 — compact events only, no transcripts).
 *   - A sink that throws must not break the run: `emitThought` swallows
 *     the error (the terminal is not the model's problem).
 *   - Chunks carry the same correlation ids the agent events carry
 *     (`taskId`/`agentId`/`planId`/`planStepId`) so a renderer can tell
 *     whose turn is thinking when several tasks run in parallel.
 */

/** Where the thinking text came from — useful for a renderer's debug line. */
export type ThoughtSource =
  /** A provider reasoning part (`reasoning-delta`). */
  | 'reasoning'
  /** A provider field the AI SDK does not map (`delta.reasoning_content`, …). */
  | 'provider-field';

/** One piece of thinking text: the block opens, streams, then closes. */
export interface ThoughtChunk {
  kind: 'start' | 'delta' | 'end';
  /** Text of the delta (`delta` chunks only). */
  text?: string;
  source?: ThoughtSource;
  /** Correlation ids (same meaning as on the agent events). */
  taskId?: string;
  agentId?: string;
  planId?: string;
  planStepId?: string;
}

/** Consumer of thinking text (the CLI's renderer, a test recorder, …). */
export type ThoughtSink = (chunk: ThoughtChunk) => void;

/**
 * Forward one chunk.  Never throws: a broken sink (a closed terminal, a
 * failing test spy) must not fail the model call it is attached to.
 */
export function emitThought(sink: ThoughtSink | undefined, chunk: ThoughtChunk): void {
  if (!sink) return;
  try {
    sink(chunk);
  } catch {
    // User-facing output must never break a run.
  }
}

/**
 * Chat Completions fields that carry thinking text in the wild.  The AI
 * SDK's own chunk schema only keeps `content`/`tool_calls`, so gateways
 * that answer like DeepSeek/Qwen (`delta.reasoning_content`) lose their
 * reasoning before any SDK callback can see it — unless raw chunks are
 * requested, which is why `streamText` is called with
 * `includeRawChunks: true` on the thinking path.
 */
const REASONING_FIELDS = [
  'reasoning_content',
  'reasoning',
  'thinking',
  'reasoning_details',
] as const;

/** Collect any `text` entries of an OpenRouter-style `reasoning_details` array. */
function textOfReasoningDetails(value: unknown): string {
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const item of value) {
    if (item && typeof item === 'object') {
      const part = (item as { text?: unknown }).text;
      if (typeof part === 'string') text += part;
    }
  }
  return text;
}

/** One piece of thinking text read from a raw RESPONSES-API chunk. */
export interface ResponsesReasoningChunk {
  text: string;
  /**
   * `true` when `text` is an item's COMPLETE reasoning (an
   * `output_item.done`/`reasoning_text.done`) rather than one delta — the
   * caller then shows only the part that was not streamed already.
   */
  full: boolean;
}

/** Read the `summary[]`/`content[]` text of a Responses API reasoning item. */
function reasoningItemText(item: { summary?: unknown; content?: unknown }): string {
  let text = '';
  for (const field of [item.summary, item.content]) {
    if (!Array.isArray(field)) continue;
    for (const entry of field) {
      if (!entry || typeof entry !== 'object') continue;
      const part = entry as { type?: unknown; text?: unknown };
      if (typeof part.text !== 'string') continue;
      if (
        part.type !== undefined &&
        part.type !== 'summary_text' &&
        part.type !== 'reasoning_text'
      ) {
        continue;
      }
      text += part.text;
    }
  }
  return text;
}

/**
 * Pull thinking text out of a raw RESPONSES-API chunk (v27.17.2).
 *
 * The AI SDK maps exactly ONE reasoning event to its own stream —
 * `response.reasoning_summary_text.delta`.  Everything else a provider may use
 * is dropped before any callback sees it, and the reporter's gateway used the
 * other ones:
 *
 *   - `response.reasoning_text.delta` / `.done` — the raw reasoning text
 *     (what OpenAI streams when summaries are not in play);
 *   - `response.output_item.added` / `.done` with `item.type: "reasoning"` —
 *     the item as a whole, its text under `content[]` (`reasoning_text`) or
 *     `summary[]` (`summary_text`).  A gateway that only fills the item at the
 *     end produced the reported symptom: the CLI opened a thinking block (from
 *     the SDK's reasoning-start) and then showed nothing at all.
 *
 * Returns `undefined` when the chunk carries no reasoning.
 */
export function responsesReasoningFromRawChunk(raw: unknown): ResponsesReasoningChunk | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as { type?: unknown; delta?: unknown; text?: unknown; item?: unknown };
  const type = typeof event.type === 'string' ? event.type : '';

  // `reasoning_summary_text.*` is deliberately NOT handled here: the SDK maps
  // it to a reasoning part of its own, and the provider sends the raw chunk
  // BEFORE that part — reading both would print every summary delta twice.
  if (type === 'response.reasoning_text.delta') {
    const text = typeof event.delta === 'string' ? event.delta : '';
    return text.length > 0 ? { text, full: false } : undefined;
  }

  if (type === 'response.reasoning_text.done') {
    const text = typeof event.text === 'string' ? event.text : '';
    return text.length > 0 ? { text, full: true } : undefined;
  }

  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = event.item;
    if (!item || typeof item !== 'object') return undefined;
    const reasoning = item as { type?: unknown; summary?: unknown; content?: unknown };
    if (reasoning.type !== 'reasoning') return undefined;
    const text = reasoningItemText(reasoning);
    return text.length > 0 ? { text, full: true } : undefined;
  }

  return undefined;
}

/**
 * Pull thinking text out of one RAW provider chunk.
 *
 * Only Chat-Completions-shaped chunks (`choices[0].delta` /
 * `choices[0].message`) are inspected: the Responses API's reasoning
 * summaries arrive as real
 * `reasoning-delta` parts (handled by the caller), and matching its raw
 * events here too would print every thought twice.
 *
 * Returns `undefined` when the chunk carries no reasoning.
 */
export function reasoningFromRawChunk(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;

  const first = choices[0];
  if (!first || typeof first !== 'object') return undefined;
  const container = (first as { delta?: unknown }).delta ?? (first as { message?: unknown }).message;
  if (!container || typeof container !== 'object') return undefined;

  // First field that has text wins: gateways that answer with both
  // (`reasoning` and `reasoning_details`, say) must not print twice.
  for (const field of REASONING_FIELDS) {
    const value = (container as Record<string, unknown>)[field];
    const text =
      typeof value === 'string' ? value : value === undefined ? '' : textOfReasoningDetails(value);
    if (text.length > 0) return text;
  }
  return undefined;
}
