/**
 * v27.17.3 — the CLI's tool-call log.
 *
 * Exactly four things per call: the tool's type, its name, the input it was
 * given and how it ended.  The records come from the runtime
 * (`src/ai/runtime/tool-call-log.ts`, covered in
 * `src/ai/__tests__/v27173-tool-call-log.test.ts`); these tests are about the
 * line a human reads (and greps).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolCallRecord } from '../../ai/runtime/tool-call-log.js';
import {
  createToolLogRenderer,
  formatToolCallLine,
  formatToolStatus,
  resolveToolLogEnabled,
} from '../utils/tool-log.js';
import { out } from '../utils/output.js';

const start = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  phase: 'start',
  status: 'running',
  toolType: 'filesystem',
  toolName: 'write_file',
  input: { filePath: 'notes/a.txt' },
  ...over,
});

const end = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  ...start(over),
  phase: 'end',
  status: 'success',
  durationMs: 12,
  ...over,
});

// ─── the line ────────────────────────────────────────────────────

describe('v27.17.3 — the tool-call line', () => {
  it('carries type, name, input and status', () => {
    const line = formatToolCallLine(end());
    expect(line).toContain('tool: write_file');
    expect(line).toContain('type: filesystem');
    expect(line).toContain('input: {"filePath":"notes/a.txt"}');
    expect(line).toContain('status: ✅ success');
  });

  it('names the input only when the tool was given one', () => {
    const line = formatToolCallLine(end({ toolName: 'git_status', toolType: 'git', input: {} }));
    expect(line).toContain('type: git');
    expect(line).not.toContain('input:');
  });

  it('shows a failure with the tool’s own message and code', () => {
    const line = formatToolCallLine(
      end({
        status: 'failure',
        error: 'path escapes the project root',
        code: 'PATH_TRAVERSAL_BLOCKED',
      })
    );
    expect(line).toContain('status: ❌ failed');
    expect(line).toContain('PATH_TRAVERSAL_BLOCKED: path escapes the project root');
  });

  it('does not print a code twice when the message already starts with it', () => {
    const line = formatToolCallLine(
      end({ status: 'failure', error: 'ENOENT: no such file or directory', code: 'ENOENT' })
    );
    expect(line.match(/ENOENT/g)).toHaveLength(1);
  });

  it('renders a failure without a message as just the status', () => {
    expect(formatToolStatus(end({ status: 'failure', error: undefined, code: undefined }))).toBe(
      '❌ failed'
    );
  });

  it('caps a long input the same way the runtime does', () => {
    const line = formatToolCallLine(end({ input: { content: 'x'.repeat(5000) } }));
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(1000);
  });
});

// ─── the renderer ────────────────────────────────────────────────

describe('v27.17.3 — the renderer', () => {
  let writes: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('prints one line per finished call', () => {
    const render = createToolLogRenderer();
    render(start());
    render(end());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('tool: write_file');
    expect(writes[0]).toContain('status: ✅ success');
  });

  it('can print the start of a call as well', () => {
    const render = createToolLogRenderer({ onStart: true });
    render(start());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('status: ⏳ running');
  });

  it('is silent when disabled', () => {
    const render = createToolLogRenderer({ enabled: false });
    render(end());
    expect(writes).toEqual([]);
  });
});

// ─── the switch ──────────────────────────────────────────────────

describe('v27.17.3 — on, off, or the environment', () => {
  it('defaults to on', () => {
    expect(resolveToolLogEnabled(undefined, {})).toBe(true);
    expect(resolveToolLogEnabled('auto', {})).toBe(true);
  });

  it('honours the flag', () => {
    expect(resolveToolLogEnabled('off', {})).toBe(false);
    expect(resolveToolLogEnabled('on', { HOTL_TOOL_LOG: '0' })).toBe(true);
  });

  it('honours HOTL_TOOL_LOG when the flag is auto', () => {
    expect(resolveToolLogEnabled('auto', { HOTL_TOOL_LOG: '0' })).toBe(false);
    expect(resolveToolLogEnabled(undefined, { HOTL_TOOL_LOG: 'off' })).toBe(false);
    expect(resolveToolLogEnabled(undefined, { HOTL_TOOL_LOG: 'yes' })).toBe(true);
  });
});

// ─── the activity line ───────────────────────────────────────────

describe('v27.17.3 — the log and the spinner', () => {
  it('prints after the spinner is cleared (out() is the one capture point)', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    out('hello');
    spy.mockRestore();
    expect(writes.join('')).toBe('hello\n');
  });
});
