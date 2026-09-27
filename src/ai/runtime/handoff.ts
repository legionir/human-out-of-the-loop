/**
 * Structured handoff between plan steps (J-04).
 *
 * A dependent step receives `{changedFiles, keyResult, notes}` rather than
 * the predecessor's full transcript.
 */
export interface StepHandoff {
  changedFiles: string[];
  keyResult: string;
  notes: string;
}

const EMPTY: StepHandoff = { changedFiles: [], keyResult: '', notes: '' };

export function emptyHandoff(): StepHandoff {
  return { ...EMPTY };
}

/**
 * Prefer an explicit `HANDOFF:` JSON block in the step summary; otherwise
 * treat the first line as keyResult.
 */
export function extractHandoff(summary: string | undefined, changedFiles: string[] = []): StepHandoff {
  const text = (summary ?? '').trim();
  const block = /HANDOFF:\s*(\{[\s\S]*\})/.exec(text);
  if (block) {
    try {
      const parsed = JSON.parse(block[1]!) as Partial<StepHandoff>;
      return {
        changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String) : changedFiles,
        keyResult: typeof parsed.keyResult === 'string' ? parsed.keyResult : text.split('\n')[0] ?? '',
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      };
    } catch {
      /* fall through */
    }
  }
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  return {
    changedFiles,
    keyResult: first.slice(0, 500),
    notes: '',
  };
}

export function formatHandoff(handoff: StepHandoff): string {
  const files = handoff.changedFiles.length > 0 ? handoff.changedFiles.join(', ') : '(none)';
  const notes = handoff.notes.trim() ? `\nnotes: ${handoff.notes.trim()}` : '';
  return `keyResult: ${handoff.keyResult || '(none)'}\nchangedFiles: ${files}${notes}`;
}
