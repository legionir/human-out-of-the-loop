/**
 * F-04 — keep the multi-step tool transcript inside `contextBudgetChars`.
 *
 * Older tool results are replaced with a stub so the model still sees that
 * a call happened, without paying for the payload again.  The most recent
 * results stay intact; if the whole transcript is still over budget, older
 * stubs are dropped until it fits.
 */

export const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;
export const KEEP_RECENT_TOOL_RESULTS = 3;

const OMITTED = '[omitted: older tool result trimmed to fit the context budget]';

type AnyMessage = { role?: string; content?: unknown };

function isToolMessage(message: AnyMessage): boolean {
  if (message.role === 'tool') return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (part) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type?: string }).type === 'tool-result',
  );
}

function shrinkToolMessage(message: AnyMessage): void {
  if (typeof message.content === 'string') {
    message.content = OMITTED;
    return;
  }
  if (Array.isArray(message.content)) {
    message.content = message.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const typed = part as Record<string, unknown>;
      if (typed.type === 'tool-result') {
        return { ...typed, output: OMITTED, result: OMITTED, truncated: true };
      }
      return part;
    });
  }
}

/**
 * Return a clone of `messages` whose JSON size is ≤ `budgetChars`.
 */
export function trimConversationMessages<T>(
  messages: readonly T[],
  budgetChars: number = DEFAULT_CONTEXT_BUDGET_CHARS,
  keepRecent: number = KEEP_RECENT_TOOL_RESULTS,
): T[] {
  const cloned = structuredClone(messages as unknown as AnyMessage[]);
  const toolIdx: number[] = [];
  cloned.forEach((message, index) => {
    if (isToolMessage(message)) toolIdx.push(index);
  });

  const keep = new Set(toolIdx.slice(-Math.max(0, keepRecent)));
  for (const index of toolIdx) {
    if (!keep.has(index)) shrinkToolMessage(cloned[index]!);
  }

  const fits = (): boolean => {
    try {
      return JSON.stringify(cloned).length <= budgetChars;
    } catch {
      return true;
    }
  };

  if (fits()) return cloned as T[];

  for (const index of toolIdx) {
    if (fits()) break;
    shrinkToolMessage(cloned[index]!);
  }

  if (!fits()) {
    for (let i = 0; i < cloned.length && !fits(); i++) {
      const message = cloned[i]!;
      if (message.role === 'system' || message.role === 'user') continue;
      if (typeof message.content === 'string' && message.content.length > 200) {
        message.content = `${message.content.slice(0, 200)}…`;
      }
    }
  }

  return cloned as T[];
}
