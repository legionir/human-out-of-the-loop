import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReadMediaFileTool } from '../tools/implementations/read-media-file.js';
import { createListDirectoryWithSizesTool } from '../tools/implementations/list-directory-with-sizes.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { mediaTypeForFile, formatSize } from '../tools/fs/index.js';
import { LOCAL_TOOL_IDS } from '../tools/local-tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}
type ModelOutput = { type: string; value: unknown };
function modelOutputOf(toolObj: unknown, output: unknown): ModelOutput {
  const fn = (toolObj as unknown as { toModelOutput?: (o: unknown) => ModelOutput }).toModelOutput!;
  return fn({ toolCallId: 'call-1', input: {}, output });
}

/** A real 1×1 PNG — small enough to inline, real enough to be a real image. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+1G0ZAAAAAElFTkSuQmCC';

const isWindows = process.platform === 'win32';

// ─── read_media_file (phase 35) ──────────────────────────────────

describe('Phase 35 — read_media_file', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-media-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-media-outside-'));
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'plain text\n');
    fs.writeFileSync(path.join(root, 'archive.bin'), Buffer.from([1, 2, 3, 4, 5]));
    fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns a PNG as base64 with its MIME type and a relative path', async () => {
    const execute = executeOf(createReadMediaFileTool(root));
    const result = (await execute({ path: 'assets/logo.png' })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join('assets', 'logo.png'));
    expect(result.mediaType).toBe('image/png');
    expect(result.kind).toBe('image');
    expect(result.attachedToModel).toBe(true);
    expect(result.bytes).toBe(Buffer.from(PNG_1X1_BASE64, 'base64').length);
    expect(result.base64).toBe(PNG_1X1_BASE64);
    expect(JSON.stringify(result.path)).not.toContain(root);
  });

  it('attaches an image to the model call as a content part', async () => {
    const tool = createReadMediaFileTool(root);
    const output = (await executeOf(tool)({ path: 'assets/logo.png' })) as Record<string, unknown>;

    const modelOutput = modelOutputOf(tool, output);
    expect(modelOutput.type).toBe('content');

    const parts = modelOutput.value as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(String(parts[0]!.text)).toContain('image/png');
    expect(parts[1]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      filename: 'logo.png',
      data: { type: 'data', data: PNG_1X1_BASE64 },
    });
  });

  it('does NOT attach a non-media binary, and keeps its payload out of the prompt', async () => {
    const tool = createReadMediaFileTool(root);
    const output = (await executeOf(tool)({ path: 'archive.bin' })) as Record<string, unknown>;

    expect(output.success).toBe(true);
    expect(output.mediaType).toBe('application/octet-stream');
    expect(output.kind).toBe('binary');
    expect(output.attachedToModel).toBe(false);

    const modelOutput = modelOutputOf(tool, output);
    expect(modelOutput.type).toBe('json');
    const value = modelOutput.value as Record<string, unknown>;
    expect(value.base64).toBeUndefined(); // no 4 MB blob in the prompt
    expect(String(value.summary)).toContain('not attached');
  });

  it('keeps a failure visible to the model and to the runtime', async () => {
    const tool = createReadMediaFileTool(root);
    const output = (await executeOf(tool)({ path: 'missing.png' })) as Record<string, unknown>;

    expect(output.success).toBe(false);
    expect(output.code).toBe('ENOENT'); // describeToolFailure reads this raw output
    const modelOutput = modelOutputOf(tool, output);
    expect(modelOutput.type).toBe('json');
    expect((modelOutput.value as Record<string, unknown>).success).toBe(false);
  });

  it('refuses a file above maxBytes with FILE_TOO_LARGE', async () => {
    const execute = executeOf(createReadMediaFileTool(root));
    const result = (await execute({ path: 'assets/logo.png', maxBytes: 10 })) as {
      success: boolean;
      code?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('FILE_TOO_LARGE');
    expect(result.error).toMatch(/maxBytes|limit/);
  });

  it('reports a directory as EISDIR instead of reading it', async () => {
    const execute = executeOf(createReadMediaFileTool(root));
    const result = (await execute({ path: 'assets' })) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('EISDIR');
  });

  it('blocks traversal and symlink escapes before reading anything', async () => {
    const execute = executeOf(createReadMediaFileTool(root));

    const traversal = (await execute({ path: '../secret.png' })) as { code?: string };
    expect(traversal.code).toBe('PATH_TRAVERSAL_BLOCKED');

    if (!isWindows) {
      fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'escaped.png'), 'file');
      const escaped = (await execute({ path: 'escaped.png' })) as {
        code?: string;
        base64?: string;
      };
      expect(escaped.code).toBe('PATH_TRAVERSAL_BLOCKED');
      expect(escaped.base64).toBeUndefined();
    }
  });

  it('maps every reference extension to its MIME type', () => {
    expect(mediaTypeForFile('/x/a.png')).toBe('image/png');
    expect(mediaTypeForFile('/x/a.JPG')).toBe('image/jpeg');
    expect(mediaTypeForFile('/x/a.jpeg')).toBe('image/jpeg');
    expect(mediaTypeForFile('/x/a.gif')).toBe('image/gif');
    expect(mediaTypeForFile('/x/a.webp')).toBe('image/webp');
    expect(mediaTypeForFile('/x/a.bmp')).toBe('image/bmp');
    expect(mediaTypeForFile('/x/a.svg')).toBe('image/svg+xml');
    expect(mediaTypeForFile('/x/a.mp3')).toBe('audio/mpeg');
    expect(mediaTypeForFile('/x/a.wav')).toBe('audio/wav');
    expect(mediaTypeForFile('/x/a.ogg')).toBe('audio/ogg');
    expect(mediaTypeForFile('/x/a.flac')).toBe('audio/flac');
    expect(mediaTypeForFile('/x/a.unknown')).toBe('application/octet-stream');
  });
});

// ─── list_directory_with_sizes (phase 35) ────────────────────────

describe('Phase 35 — list_directory_with_sizes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-sizes-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'small.txt'), 'abc'); // 3 bytes
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(2048)); // 2 KB
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists entries with sizes, types and totals, sorted by name', async () => {
    const execute = executeOf(createListDirectoryWithSizesTool(root));
    const result = (await execute({ path: '.' })) as {
      success: boolean;
      entries: Array<{ name: string; type: string; size: number; sizeFormatted: string }>;
      totalFiles: number;
      totalDirectories: number;
      totalSize: number;
      totalSizeFormatted: string;
      formatted: string;
    };

    expect(result.success).toBe(true);
    expect(result.entries.map((entry) => entry.name)).toEqual(['large.txt', 'small.txt', 'src']);
    expect(result.entries.find((entry) => entry.name === 'large.txt')).toMatchObject({
      type: 'file',
      size: 2048,
      sizeFormatted: '2.00 KB',
    });
    expect(result.entries.find((entry) => entry.name === 'src')).toMatchObject({
      type: 'directory',
      size: 0,
    });
    expect(result.totalFiles).toBe(2);
    expect(result.totalDirectories).toBe(1);
    expect(result.totalSize).toBe(2051);
    expect(result.formatted).toContain('[FILE] large.txt');
    expect(result.formatted).toContain('[DIR] src');
    expect(result.formatted).toContain('Total: 2 files, 1 directories');
    expect(result.formatted).toContain(`Combined size: ${formatSize(2051)}`);
  });

  it('sorts by size, largest first', async () => {
    const execute = executeOf(createListDirectoryWithSizesTool(root));
    const result = (await execute({ path: '.', sortBy: 'size' })) as {
      sortBy: string;
      entries: Array<{ name: string; size: number }>;
    };

    expect(result.sortBy).toBe('size');
    expect(result.entries[0]).toMatchObject({ name: 'large.txt', size: 2048 });
    // 2048 → 3 → 0, and the directory (no size) comes last.
    expect(result.entries.map((entry) => entry.name)).toEqual(['large.txt', 'small.txt', 'src']);
  });

  it.skipIf(isWindows)('reports a symlink as [LINK] without following it', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-sizes-outside-'));
    fs.writeFileSync(path.join(target, 'big.bin'), 'x'.repeat(4096));
    fs.symlinkSync(target, path.join(root, 'link-out'), 'dir');

    try {
      const execute = executeOf(createListDirectoryWithSizesTool(root));
      const result = (await execute({ path: '.' })) as {
        entries: Array<{ name: string; type: string; size: number }>;
        formatted: string;
        totalSize: number;
      };

      const link = result.entries.find((entry) => entry.name === 'link-out')!;
      expect(link.type).toBe('symlink');
      // Never the 4096 bytes behind the link — and not the link's own path
      // length either: only regular files carry a size.
      expect(link.size).toBe(0);
      expect(result.formatted).toContain('[LINK] link-out');
      expect(result.totalSize).toBe(2051); // unchanged: symlinks are not files
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('blocks a path outside the workspace', async () => {
    const execute = executeOf(createListDirectoryWithSizesTool(root));
    const result = (await execute({ path: '/etc' })) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('reports a missing directory with its errno code', async () => {
    const execute = executeOf(createListDirectoryWithSizesTool(root));
    const result = (await execute({ path: 'nope' })) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('ENOENT');
  });
});

// ─── read_file reference parity ──────────────────────────────────

describe('Phase 35 — read_file head/tail parity with the reference', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-headtail-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nl2\nl3\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses head and tail together instead of silently choosing one', async () => {
    const execute = executeOf(createReadFileTool(root));
    const result = (await execute({ filePath: 'a.txt', head: 1, tail: 1 })) as {
      success: boolean;
      code?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_ARGUMENTS');
    expect(result.error).toBe('Cannot specify both head and tail parameters simultaneously.');
  });
});

// ─── Reference parity: the filesystem set is complete ────────────

describe('Phase 35 — filesystem parity with the vendored MCP reference server', () => {
  /**
   * Tool names registered by `servers-main/src/filesystem/index.ts`, mapped to
   * the tool this runtime exposes for the same capability.
   *
   * `read_file` is the reference's deprecated alias of `read_text_file`, and
   * this runtime's `read_file` carries `head`/`tail` — one tool, both entries.
   * `search_code` is a superset of `search_files` for content (the reference
   * only globs names) and `write_multiple_files` is ours.
   */
  const REFERENCE_PARITY: Record<string, string | null> = {
    read_file: 'read_file', // deprecated alias in the reference
    read_text_file: 'read_file',
    read_media_file: 'read_media_file',
    read_multiple_files: 'read_multiple_files',
    write_file: 'write_file',
    edit_file: 'edit_file',
    create_directory: 'create_directory',
    list_directory: 'list_directory',
    list_directory_with_sizes: 'list_directory_with_sizes',
    directory_tree: 'directory_tree',
    move_file: 'move_file',
    search_files: 'search_files',
    get_file_info: 'get_file_info',
    list_allowed_directories: 'list_allowed_directories',
  };

  it('covers every tool the reference filesystem server registers', () => {
    const referenceIndex = path.join(REPO_ROOT, 'servers-main', 'src', 'filesystem', 'index.ts');
    if (!fs.existsSync(referenceIndex)) {
      // The vendored reference is optional in a published tarball.
      return;
    }

    const source = fs.readFileSync(referenceIndex, 'utf-8');
    const registered = [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(
      (match) => match[1]!
    );
    expect(registered.length).toBeGreaterThan(0);

    for (const referenceTool of registered) {
      const ours = REFERENCE_PARITY[referenceTool];
      expect(ours, `reference tool "${referenceTool}" has no mapping`).toBeDefined();
      if (ours === null) continue;
      expect(LOCAL_TOOL_IDS, `"${referenceTool}" maps to a tool that does not exist`).toContain(
        ours
      );
    }
  });

  it('has no parity entry for a tool the reference does not register (no dead map entries)', () => {
    const referenceIndex = path.join(REPO_ROOT, 'servers-main', 'src', 'filesystem', 'index.ts');
    if (!fs.existsSync(referenceIndex)) return;

    const source = fs.readFileSync(referenceIndex, 'utf-8');
    const registered = new Set(
      [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]!)
    );
    for (const referenceTool of Object.keys(REFERENCE_PARITY)) {
      expect(registered, `"${referenceTool}" is not registered by the reference server`).toContain(
        referenceTool
      );
    }
  });

  it('lists the complete filesystem toolset in the local catalog', () => {
    // The reference's 14 registrations collapse to 13 tools here (its
    // deprecated `read_file` is the same `read_file`), plus our three:
    // `search_code` (content search), `write_multiple_files` (batch) and
    // `git_status` — and the phase-38 trio (time, time conversion,
    // sequential thinking), which comes from other reference servers.
    expect(LOCAL_TOOL_IDS.length).toBe(28);
    expect([...LOCAL_TOOL_IDS]).toEqual(
      expect.arrayContaining(['get_current_time', 'convert_time', 'sequentialthinking'])
    );
    expect([...LOCAL_TOOL_IDS]).toEqual(
      expect.arrayContaining([
        'read_file',
        'read_media_file',
        'read_multiple_files',
        'write_file',
        'write_multiple_files',
        'edit_file',
        'create_directory',
        'list_directory',
        'list_directory_with_sizes',
        'directory_tree',
        'move_file',
        'search_code',
        'search_files',
        'get_file_info',
        'list_allowed_directories',
        'git_status',
      ])
    );
  });
});
