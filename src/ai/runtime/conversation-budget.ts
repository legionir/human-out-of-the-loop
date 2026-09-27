/**
 * F-04 — keep the multi-step tool transcript inside `contextBudgetChars`.
 *
 * Older tool results are replaced with a stub so the model still sees that
 * a call happened, without paying for the payload again.  The most recent
 * results stay intact; if the whole transcript is still over budget, older
 * stubs are dropped until it fits.
 *
 * The stub keeps the SDK's `ToolResultOutput` shape (`{ type: 'text', value }`):
 * providers switch on `output.type`, and a bare string there made them send a
 * tool message with no content at all, which the API rejects.
 */

export const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;
export const KEEP_RECENT_TOOL_RESULTS = 3;

const OMITTED = '[omitted: older tool result trimmed to fit the context budget]';
const OMITTED_OUTPUT = { type: 'text', value: OMITTED } as const;

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
        return { ...typed, output: OMITTED_OUTPUT };
      }
      return part;
    });
  }
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Return a clone of `messages` whose JSON size is ≤ `budgetChars` (as far as
 * shrinking tool results and assistant text can get it).
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

  // Per-message sizes, updated as messages shrink — one stringify per
  // message instead of re-serialising the whole transcript on every check.
  const sizes = cloned.map(sizeOf);
  let total = sizes.reduce((a, b) => a + b, 0);
  const resize = (index: number): void => {
    const next = sizeOf(cloned[index]);
    total += next - sizes[index]!;
    sizes[index] = next;
  };

  for (const index of toolIdx) {
    if (total <= budgetChars) break;
    shrinkToolMessage(cloned[index]!);
    resize(index);
  }

  for (let i = 0; i < cloned.length && total > budgetChars; i++) {
    const message = cloned[i]!;
    if (message.role === 'system' || message.role === 'user') continue;
    if (typeof message.content === 'string' && message.content.length > 200) {
      message.content = `${message.content.slice(0, 200)}…`;
      resize(i);
    }
  }

  return cloned as T[];
}
