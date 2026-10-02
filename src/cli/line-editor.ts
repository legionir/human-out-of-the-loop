/**
 * The interactive prompt's line editor.
 *
 * Node's readline cannot show a list under the cursor, so this is a small
 * raw-mode editor with a suggestion menu, like the Claude Code prompt:
 *
 *   - typing `/` opens the command menu, filtered as you type;
 *   - ↑/↓ move through the menu (through the history when it is closed);
 *   - Tab completes the highlighted entry, Enter runs it, Esc closes the menu;
 *   - ←/→, Home/End (Ctrl-A/E), Backspace/Delete, Ctrl-U (clear line),
 *     Ctrl-W (delete word), Ctrl-L (clear screen);
 *   - Ctrl-C clears a non-empty line, on an empty one it reports `interrupt`;
 *     Ctrl-D on an empty line reports `eof`.
 */
import readline from 'node:readline';
import {
  displayWidth,
  graphemeEndAfter,
  graphemeStartBefore,
} from './utils/graphemes.js';

export interface Suggestion {
  /** Text the line becomes when the suggestion is accepted. */
  value: string;
  /** Left column (defaults to `value`). */
  label?: string;
  description?: string;
}

/** Suggestions for the current line (empty = menu closed). */
export type SuggestFn = (line: string) => Suggestion[];

export type ReadResult =
  | { kind: 'line'; line: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' };

export interface LineEditorOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt: string;
  history: string[];
  suggest: SuggestFn;
  /** Styling for the menu (defaults: plain). */
  style?: {
    selected?: (s: string) => string;
    dim?: (s: string) => string;
  };
  /** Rows of the menu shown at once. */
  menuRows?: number;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

interface BufferedKeypress {
  str: string | undefined;
  key: Key;
}

interface InputSession {
  active?: (str: string | undefined, key: Key) => void;
  captureInactive: boolean;
  pending: BufferedKeypress[];
}

const inputSessions = new WeakMap<NodeJS.ReadStream, InputSession>();
const MAX_BUFFERED_KEYPRESSES = 16_384;

function getInputSession(input: NodeJS.ReadStream): InputSession {
  const existing = inputSessions.get(input);
  if (existing) return existing;
  const session: InputSession = { captureInactive: true, pending: [] };
  inputSessions.set(input, session);
  // Keep one keypress listener for the lifetime of this input stream. Node's
  // keypress decoder detaches itself when its last listener is removed; data
  // typed during an AI run would then be consumed before the next prompt.
  input.on('keypress', (str: string | undefined, key: Key = {}) => {
    if (session.active) session.active(str, key);
    else if (session.captureInactive && session.pending.length < MAX_BUFFERED_KEYPRESSES) {
      session.pending.push({ str, key: { ...key } });
    }
  });
  return session;
}

/** Do not queue keystrokes while another readline-based prompt owns stdin. */
export function suspendInactiveKeypressBuffer(input: NodeJS.ReadStream): () => void {
  const session = inputSessions.get(input);
  if (!session) return () => undefined;
  const previous = session.captureInactive;
  session.captureInactive = false;
  return () => {
    session.captureInactive = previous;
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visibleLength = (s: string): number => displayWidth(s.replace(ANSI, ''));
const BRACKET_PASTE_START = '\x1b[200~';
const BRACKET_PASTE_END = '\x1b[201~';

/** Read one line.  Resolves when the user submits, interrupts or ends input. */
export function readLine(opts: LineEditorOptions): Promise<ReadResult> {
  const { input, output, prompt, history } = opts;
  const menuRows = opts.menuRows ?? 8;
  const selectedStyle = opts.style?.selected ?? ((s: string) => `\x1b[7m${s}\x1b[27m`);
  const dim = opts.style?.dim ?? ((s: string) => s);

  let buffer = '';
  let cursor = 0;
  let historyIndex = -1; // -1 = the line being edited
  let draft = '';
  let selected = 0;
  let scroll = 0;
  let menuDismissed = false;
  let suggestions: Suggestion[] = [];
  /** Rows between the prompt's first row and the cursor row after the last render. */
  let cursorRow = 0;

  const columns = (): number => Math.max(20, output.columns || 80);

  const refreshSuggestions = (): void => {
    suggestions = menuDismissed ? [] : opts.suggest(buffer);
    if (selected >= suggestions.length) selected = Math.max(0, suggestions.length - 1);
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + menuRows) scroll = selected - menuRows + 1;
  };

  const render = (final = false): void => {
    const cols = columns();
    // Back to the first row of the prompt, then clear everything below.
    let out = '';
    if (cursorRow > 0) out += `\x1b[${cursorRow}A`;
    out += '\r\x1b[J';
    out += prompt + buffer;

    const promptLen = visibleLength(prompt);
    const endPos = promptLen + displayWidth(buffer);
    // A line that exactly fills the width leaves the cursor in the last
    // column; normalise so the math below matches the terminal.
    const endRow = Math.floor(endPos / cols);
    if (endPos > 0 && endPos % cols === 0) out += '\n';

    let menuLines = 0;
    if (!final && suggestions.length > 0) {
      const shown = suggestions.slice(scroll, scroll + menuRows);
      const labelWidth = Math.min(
        28,
        Math.max(...shown.map((s) => (s.label ?? s.value).length)),
      );
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i]!;
        const index = scroll + i;
        const label = (s.label ?? s.value).padEnd(labelWidth);
        const desc = s.description ? `  ${s.description}` : '';
        let text = ` ${label}${desc}`;
        if (text.length > cols - 1) text = text.slice(0, cols - 2) + '…';
        out += '\n' + (index === selected ? selectedStyle(text) : dim(text));
        menuLines++;
      }
      if (suggestions.length > menuRows) {
        out += '\n' + dim(` ${selected + 1}/${suggestions.length}  ↑↓ select · Tab complete · Enter run · Esc close`);
        menuLines++;
      } else {
        out += '\n' + dim(' ↑↓ select · Tab complete · Enter run · Esc close');
        menuLines++;
      }
    }

    if (final) {
      output.write(out + '\n');
      cursorRow = 0;
      return;
    }

    // Put the cursor back where it belongs.
    const curPos = promptLen + displayWidth(buffer.slice(0, cursor));
    const curRow = Math.floor(curPos / cols);
    const curCol = curPos % cols;
    // After the text the terminal cursor is on row `endRow` (the '\n' above
    // settles an exactly-full line), and each menu line adds one row.
    const rowsBelow = endRow + menuLines - curRow;
    if (rowsBelow > 0) out += `\x1b[${rowsBelow}A`;
    out += '\r';
    if (curCol > 0) out += `\x1b[${curCol}C`;
    output.write(out);
    cursorRow = curRow;
  };

  const setBuffer = (text: string, keepMenuClosed = false): void => {
    buffer = text;
    cursor = text.length;
    if (!keepMenuClosed) menuDismissed = false;
    selected = 0;
    scroll = 0;
  };

  return new Promise<ReadResult>((resolve) => {
    readline.emitKeypressEvents(input);
    const session = getInputSession(input);
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    if (input.isTTY) output.write('\x1b[?2004h');
    let pasting = false;
    let finished = false;

    const finish = (result: ReadResult): void => {
      if (finished) return;
      finished = true;
      suggestions = [];
      render(true);
      session.active = undefined;
      if (input.isTTY) output.write('\x1b[?2004l');
      if (input.isTTY) input.setRawMode(wasRaw ?? false);
      input.pause();
      resolve(result);
    };

    const insertText = (text: string): void => {
      if (!text) return;
      buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
      cursor += text.length;
      menuDismissed = false;
      selected = 0;
      scroll = 0;
      historyIndex = -1;
    };

    const onKey = (str: string | undefined, key: Key = {}): void => {
      const menuOpen = suggestions.length > 0;
      const name = key.name;
      const sequence = `${key.sequence ?? ''}${str ?? ''}`;
      if (sequence.includes(BRACKET_PASTE_START)) pasting = true;
      if (sequence.includes(BRACKET_PASTE_END)) pasting = false;
      if (sequence.includes(BRACKET_PASTE_START) || sequence.includes(BRACKET_PASTE_END)) {
        const inner = sequence
          .replaceAll(BRACKET_PASTE_START, '')
          .replaceAll(BRACKET_PASTE_END, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        if (inner) insertText(inner);
        refreshSuggestions();
        render();
        return;
      }

      if (key.ctrl && name === 'c') {
        if (buffer.length > 0) {
          setBuffer('');
          refreshSuggestions();
          render();
          return;
        }
        finish({ kind: 'interrupt' });
        return;
      }
      if (key.ctrl && name === 'd') {
        if (buffer.length === 0) {
          finish({ kind: 'eof' });
          return;
        }
        if (cursor < buffer.length) buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
      } else if (name === 'return' || name === 'enter') {
        if (pasting) {
          insertText('\n');
          refreshSuggestions();
          render();
          return;
        }
        if (menuOpen) {
          const choice = suggestions[selected]!;
          // Enter on a highlighted entry that is not what was typed runs it.
          if (choice.value.trimEnd() !== buffer.trimEnd()) setBuffer(choice.value.trimEnd());
        }
        const line = buffer;
        if (line.trim() && history[0] !== line) history.unshift(line);
        finish({ kind: 'line', line });
        return;
      } else if (name === 'tab') {
        if (menuOpen) {
          const choice = suggestions[selected]!;
          setBuffer(choice.value);
        }
      } else if (name === 'escape') {
        menuDismissed = true;
      } else if (name === 'up') {
        if (menuOpen) {
          selected = (selected - 1 + suggestions.length) % suggestions.length;
        } else if (historyIndex + 1 < history.length) {
          if (historyIndex === -1) draft = buffer;
          historyIndex++;
          setBuffer(history[historyIndex]!, true);
          menuDismissed = true;
        }
      } else if (name === 'down') {
        if (menuOpen) {
          selected = (selected + 1) % suggestions.length;
        } else if (historyIndex >= 0) {
          historyIndex--;
          setBuffer(historyIndex === -1 ? draft : history[historyIndex]!, true);
          menuDismissed = true;
        }
      } else if (name === 'left') {
        cursor = graphemeStartBefore(buffer, cursor);
      } else if (name === 'right') {
        cursor = graphemeEndAfter(buffer, cursor);
      } else if (name === 'home' || (key.ctrl && name === 'a')) {
        cursor = 0;
      } else if (name === 'end' || (key.ctrl && name === 'e')) {
        cursor = buffer.length;
      } else if (name === 'backspace') {
        if (cursor > 0) {
          const from = graphemeStartBefore(buffer, cursor);
          buffer = buffer.slice(0, from) + buffer.slice(cursor);
          cursor = from;
          menuDismissed = false;
        }
      } else if (name === 'delete') {
        if (cursor < buffer.length) {
          const to = graphemeEndAfter(buffer, cursor);
          buffer = buffer.slice(0, cursor) + buffer.slice(to);
        }
      } else if (key.ctrl && name === 'u') {
        buffer = buffer.slice(cursor);
        cursor = 0;
      } else if (key.ctrl && name === 'w') {
        const before = buffer.slice(0, cursor).replace(/\S+\s*$/, '');
        buffer = before + buffer.slice(cursor);
        cursor = before.length;
      } else if (key.ctrl && name === 'l') {
        output.write('\x1b[2J\x1b[3J\x1b[H');
        cursorRow = 0;
      } else if (str && !key.ctrl && !key.meta) {
        if (pasting || (str.length > 1 && /[\r\n]/.test(str))) {
          insertText(str.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        } else if (str >= ' ' && !/[\r\n]/.test(str)) {
          insertText(str);
        } else {
          return;
        }
      } else {
        return;
      }
      refreshSuggestions();
      render();
    };

    // Activate the editor before resuming stdin: a terminal may have already
    // buffered keystrokes while the previous AI response was being handled.
    session.active = onKey;
    for (const event of session.pending.splice(0)) {
      if (finished) break;
      session.active(event.str, event.key);
    }
    if (!finished) {
      input.resume();
      refreshSuggestions();
      render();
    }
  });
}
