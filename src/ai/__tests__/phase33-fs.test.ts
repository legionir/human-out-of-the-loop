import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PathAccessError,
  applyFileEdits,
  createUnifiedDiff,
  formatSize,
  getFileStats,
  headFile,
  moveFile,
  normalizeLineEndings,
  searchFilesWithValidation,
  tailFile,
  validatePath,
  writeFileContent,
} from '../tools/fs/index.js';
import { LOCAL_TOOL_FACTORIES, LOCAL_TOOL_IDS } from '../tools/local-tools.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createEditFileTool } from '../tools/implementations/edit-file.js';
import { createReadMultipleFilesTool } from '../tools/implementations/read-multiple-files.js';
import { createListDirectoryTool } from '../tools/implementations/list-directory.js';
import { createDirectoryTreeTool } from '../tools/implementations/directory-tree.js';
import { createMoveFileTool } from '../tools/implementations/move-file.js';
import { createGetFileInfoTool } from '../tools/implementations/get-file-info.js';
import { createCreateDirectoryTool } from '../tools/implementations/create-directory.js';
import { createSearchFilesTool } from '../tools/implementations/search-files.js';
import { createListAllowedDirectoriesTool } from '../tools/implementations/list-allowed-directories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

const isWindows = process.platform === 'win32';

// ─── Core: validatePath ──────────────────────────────────────────

describe('Phase 33 — validatePath (ported from the MCP reference server)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-outside-'));

    fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n');
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'nested', 'deep.txt'), 'deep\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('accepts a path inside the allowed directory and returns its real path', async () => {
    const resolved = await validatePath('src/index.ts', [root]);
    expect(resolved).toBe(fs.realpathSync(path.join(root, 'src', 'index.ts')));
  });

  it('refuses a lexical traversal out of the allowed directory', async () => {
    await expect(validatePath('../outside.txt', [root])).rejects.toThrow(PathAccessError);
    await expect(validatePath('../outside.txt', [root])).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ALLOWED',
    });
  });

  it.skipIf(isWindows)('refuses a symlinked directory pointing outside (existing file)', async () => {
    fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');

    await expect(validatePath('link-out/secret.txt', [root])).rejects.toMatchObject({
      code: 'SYMLINK_ESCAPE',
    });
  });

  it.skipIf(isWindows)(
    'refuses a *new* file written through a symlinked parent (the classic escape)',
    async () => {
      fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');

      // The file itself does not exist yet — the old lexical check passed here
      // and created it outside the workspace.
      await expect(validatePath('link-out/new.txt', [root])).rejects.toMatchObject({
        code: 'SYMLINK_ESCAPE',
      });
    }
  );

  it.skipIf(isWindows)('refuses a symlinked file pointing outside', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escaped.txt'), 'file');

    await expect(validatePath('escaped.txt', [root])).rejects.toMatchObject({
      code: 'SYMLINK_ESCAPE',
    });
  });

  it.skipIf(isWindows)('refuses a Windows drive path instead of creating a literal file', async () => {
    await expect(validatePath('C:\\Users\\me\\.ssh\\id_rsa', [root])).rejects.toMatchObject({
      code: 'WINDOWS_PATH_ON_POSIX',
    });
    // Nothing was created under the root.
    expect(fs.readdirSync(root).some((name) => name.startsWith('C:'))).toBe(false);
  });

  it('resolves a Unicode-equivalent (NFD) name to the NFC file that exists', async () => {
    const nfcName = 'café.txt';
    fs.writeFileSync(path.join(root, nfcName), 'unicode\n');
    const nfdRequest = nfcName.normalize('NFD');
    expect(nfdRequest).not.toBe(nfcName); // the two forms really differ

    const resolved = await validatePath(nfdRequest, [root]);
    expect(path.basename(resolved)).toBe(nfcName);
  });

  it('resolves a missing nested path through its existing ancestors', async () => {
    const resolved = await validatePath('src/new/deep/file.txt', [root]);
    expect(resolved).toBe(path.join(fs.realpathSync(path.join(root, 'src')), 'new', 'deep', 'file.txt'));
  });

  it('reports PARENT_MISSING when an allowed directory itself does not exist', async () => {
    const ghost = path.join(os.tmpdir(), 'p33-ghost-does-not-exist');
    await expect(validatePath('file.txt', [ghost])).rejects.toMatchObject({ code: 'PARENT_MISSING' });
  });
});

// ─── Core: file operations ───────────────────────────────────────

describe('Phase 33 — file operations', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-ops-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-ops-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('creates a new file and replaces an existing one atomically', async () => {
    const file = path.join(root, 'a.txt');
    await writeFileContent(file, 'first');
    expect(fs.readFileSync(file, 'utf-8')).toBe('first');

    await writeFileContent(file, 'second');
    expect(fs.readFileSync(file, 'utf-8')).toBe('second');
    // No temp file left behind.
    expect(fs.readdirSync(root)).toEqual(['a.txt']);
  });

  it.skipIf(isWindows)('preserves the original permission bits when overwriting', async () => {
    const file = path.join(root, 'mode.txt');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o600);

    await writeFileContent(file, 'y');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf-8')).toBe('y');
  });

  it.skipIf(isWindows)('never writes through a pre-existing symlink', async () => {
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'original-target\n');
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(target, link, 'file');

    await writeFileContent(link, 'ATTACK\n');

    // The link was replaced by a regular file; the target is untouched.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf-8')).toBe('ATTACK\n');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original-target\n');
  });

  it('refuses to move onto an existing destination', async () => {
    const from = path.join(root, 'from.txt');
    const to = path.join(root, 'to.txt');
    fs.writeFileSync(from, 'from');
    fs.writeFileSync(to, 'to');

    await expect(moveFile(from, to)).rejects.toThrow(/Destination already exists/);
    expect(fs.readFileSync(to, 'utf-8')).toBe('to');
    expect(fs.existsSync(from)).toBe(true);
  });

  it.skipIf(isWindows)('refuses to move onto an existing symlink (lstat, not stat)', async () => {
    const from = path.join(root, 'from.txt');
    fs.writeFileSync(from, 'from');
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(path.join(outside, 'nowhere.txt'), link, 'file');

    await expect(moveFile(from, link)).rejects.toThrow(/Destination already exists/);
  });

  it('moves a file to a free destination', async () => {
    const from = path.join(root, 'from.txt');
    const to = path.join(root, 'sub', 'to.txt');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(from, 'payload');

    await moveFile(from, to);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, 'utf-8')).toBe('payload');
  });

  it('applies an exact edit and returns a fenced diff', async () => {
    const file = path.join(root, 'edit.txt');
    fs.writeFileSync(file, 'line one\nline two\nline three\n');

    const diff = await applyFileEdits(file, [{ oldText: 'line two', newText: 'line TWO' }]);

    expect(fs.readFileSync(file, 'utf-8')).toBe('line one\nline TWO\nline three\n');
    expect(diff.startsWith('```diff')).toBe(true);
    expect(diff).toContain('-line two');
    expect(diff).toContain('+line TWO');
  });

  it('falls back to a whitespace-tolerant match and keeps the original indentation', async () => {
    const file = path.join(root, 'indent.txt');
    fs.writeFileSync(file, 'function f() {\n    return 1;\n}\n');

    // The model re-indented the block it wants to replace.
    await applyFileEdits(file, [
      { oldText: '  return 1;', newText: '  return 2;\n  return 3;' },
    ]);

    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('    return 2;');
    expect(updated).toContain('    return 3;');
  });

  it('throws when an edit matches nowhere (never a silent no-op)', async () => {
    const file = path.join(root, 'nomatch.txt');
    fs.writeFileSync(file, 'content\n');

    await expect(
      applyFileEdits(file, [{ oldText: 'not present', newText: 'x' }])
    ).rejects.toThrow(/Could not find exact match for edit/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('content\n');
  });

  it('dryRun returns the diff without touching the file', async () => {
    const file = path.join(root, 'dry.txt');
    fs.writeFileSync(file, 'before\n');

    const diff = await applyFileEdits(file, [{ oldText: 'before', newText: 'after' }], true);

    expect(fs.readFileSync(file, 'utf-8')).toBe('before\n');
    expect(diff).toContain('+after');
  });

  it('head/tail read the requested lines', async () => {
    const file = path.join(root, 'lines.txt');
    fs.writeFileSync(file, 'l1\nl2\nl3\nl4\nl5\n');

    expect(await headFile(file, 2)).toBe('l1\nl2');
    expect(await tailFile(file, 2)).toBe('l4\nl5');
    expect(await headFile(file, 99)).toBe('l1\nl2\nl3\nl4\nl5');
  });

  it('head/tail on an empty file return an empty string', async () => {
    const file = path.join(root, 'empty.txt');
    fs.writeFileSync(file, '');
    expect(await headFile(file, 3)).toBe('');
    expect(await tailFile(file, 3)).toBe('');
  });

  it('collects file stats in the reference shape', async () => {
    const file = path.join(root, 'stats.txt');
    fs.writeFileSync(file, 'abcdef');

    const info = await getFileStats(file);
    expect(info.size).toBe(6);
    expect(info.isFile).toBe(true);
    expect(info.isDirectory).toBe(false);
    expect(info.modified).toBeInstanceOf(Date);
    expect(info.permissions).toMatch(/^[0-7]{3}$/);
  });

  it('formats sizes, normalizes line endings and builds unified diffs', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.50 KB');
    expect(normalizeLineEndings('a\r\nb\r\n')).toBe('a\nb\n');

    const diff = createUnifiedDiff('one\n', 'two\n', 'f.txt');
    expect(diff).toContain('f.txt');
    expect(diff).toContain('-one');
    expect(diff).toContain('+two');
  });

  it('searchFilesWithValidation matches globs, honors excludes and skips escapes', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'b.test.ts'), '');
    fs.writeFileSync(path.join(root, 'node_modules', 'c.ts'), '');
    fs.writeFileSync(path.join(outside, 'outside.ts'), '');
    if (!isWindows) fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');

    const found = await searchFilesWithValidation(root, '**/*.ts', [root], {
      excludePatterns: ['node_modules/**'],
    });
    const relative = found.map((file) => path.relative(root, file)).sort();

    expect(relative).toEqual([path.join('src', 'a.ts'), path.join('src', 'b.test.ts')]);
  });
});

// ─── Tools ───────────────────────────────────────────────────────

describe('Phase 33 — filesystem tools', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-tools-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-tools-outside-'));

    fs.writeFileSync(path.join(root, 'readme.md'), 'hello\nworld\nthird\n');
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib', 'util.ts'), 'export const util = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const index = 2;\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  // --- read_file (rewritten on the new core) --------------------

  it('read_file supports head/tail slices', async () => {
    const execute = executeOf(createReadFileTool(root));

    const head = await execute({ filePath: 'readme.md', head: 2 });
    expect(head.success).toBe(true);
    expect(head.content).toBe('hello\nworld');
    expect(head.sliced).toBe('head');

    const tail = await execute({ filePath: 'readme.md', tail: 1 });
    expect(tail.content).toBe('third');
    expect(tail.sliced).toBe('tail');
  });

  it('read_file rejects head/tail together with base64', async () => {
    const execute = executeOf(createReadFileTool(root));
    const result = await execute({ filePath: 'readme.md', encoding: 'base64', head: 1 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_ARGUMENTS');
  });

  it.skipIf(isWindows)('read_file blocks a symlink that escapes the workspace', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escaped.txt'), 'file');
    const execute = executeOf(createReadFileTool(root));

    const result = await execute({ filePath: 'escaped.txt' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
    expect(JSON.stringify(result)).not.toContain('TOP SECRET');
  });

  // --- write_file (rewritten on the new core) -------------------

  it('write_file refuses to overwrite without the flag and creates parent dirs with it', async () => {
    const execute = executeOf(createWriteFileTool(root));

    const first = await execute({ filePath: 'new/deep/file.txt', content: 'a' });
    expect(first.success).toBe(true);
    expect(first.overwritten).toBe(false);

    const blocked = await execute({ filePath: 'new/deep/file.txt', content: 'b' });
    expect(blocked.success).toBe(false);
    expect(blocked.code).toBe('EEXIST');

    const replaced = await execute({ filePath: 'new/deep/file.txt', content: 'c', overwrite: true });
    expect(replaced.success).toBe(true);
    expect(replaced.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(root, 'new/deep/file.txt'), 'utf-8')).toBe('c');
  });

  // --- edit_file ------------------------------------------------

  it('edit_file applies edits, reports a relative path and returns the diff', async () => {
    const execute = executeOf(createEditFileTool(root));

    const result = await execute({
      path: 'src/index.ts',
      edits: [{ oldText: 'export const index = 2;', newText: 'export const index = 42;' }],
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join('src', 'index.ts'));
    expect(result.dryRun).toBe(false);
    expect(String(result.diff)).toContain('+export const index = 42;');
    expect(fs.readFileSync(path.join(root, 'src/index.ts'), 'utf-8')).toContain('index = 42');
  });

  it('edit_file dryRun previews without writing', async () => {
    const execute = executeOf(createEditFileTool(root));
    const result = await execute({
      path: 'src/index.ts',
      edits: [{ oldText: 'index = 2', newText: 'index = 99' }],
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/index.ts'), 'utf-8')).toContain('index = 2');
  });

  it('edit_file returns a structured error when the text is absent', async () => {
    const execute = executeOf(createEditFileTool(root));
    const result = await execute({
      path: 'src/index.ts',
      edits: [{ oldText: 'no such line', newText: 'x' }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('EDIT_NOT_FOUND');
  });

  it('edit_file blocks traversal', async () => {
    const execute = executeOf(createEditFileTool(root));
    const result = await execute({
      path: '../outside.txt',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  // --- read_multiple_files -------------------------------------

  it('read_multiple_files returns each file and reports per-file failures', async () => {
    const execute = executeOf(createReadMultipleFilesTool(root));
    const result = (await execute({
      paths: ['readme.md', 'src/index.ts', 'missing.txt', '../outside.txt'],
    })) as { success: boolean; read: number; failed: number; files: Array<Record<string, unknown>> };

    expect(result.read).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.success).toBe(false); // one failure makes the batch partial
    expect(result.files[0]!.content).toBe('hello\nworld\nthird\n');
    expect(result.files[2]!.code).toBe('ENOENT');
    expect(result.files[3]!.code).toBe('PATH_TRAVERSAL_BLOCKED');
    expect(JSON.stringify(result)).not.toContain('TOP SECRET');
  });

  // --- list_directory -------------------------------------------

  it('list_directory marks directories and files in the reference format', async () => {
    const execute = executeOf(createListDirectoryTool(root));
    const result = (await execute({ path: '.' })) as {
      success: boolean;
      entries: Array<{ name: string; type: string }>;
      formatted: string;
    };

    expect(result.success).toBe(true);
    expect(result.formatted).toContain('[DIR] src');
    expect(result.formatted).toContain('[FILE] readme.md');
    // Directories sort before files.
    expect(result.entries[0]).toEqual({ name: 'src', type: 'directory' });
  });

  it.skipIf(isWindows)('list_directory reports a symlink as symlink instead of following it', async () => {
    fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');
    const execute = executeOf(createListDirectoryTool(root));
    const result = (await execute({ path: '.' })) as {
      entries: Array<{ name: string; type: string }>;
    };

    expect(result.entries.find((entry) => entry.name === 'link-out')?.type).toBe('symlink');
  });

  // --- directory_tree -------------------------------------------

  it('directory_tree returns nested JSON with excludes and a depth limit', async () => {
    const execute = executeOf(createDirectoryTreeTool(root));

    const result = (await execute({
      path: '.',
      excludePatterns: ['lib'],
      maxDepth: 5,
    })) as { success: boolean; tree: Array<Record<string, unknown>> };

    expect(result.success).toBe(true);
    const src = result.tree.find((entry) => entry.name === 'src') as {
      children: Array<Record<string, unknown>>;
    };
    expect(src.children.map((child) => child.name)).toEqual(['index.ts']); // lib excluded
    expect(JSON.stringify(result.tree)).toContain('"index.ts"');

    const shallow = (await execute({ path: '.', maxDepth: 1 })) as {
      tree: Array<{ name: string; children?: unknown[]; truncated?: boolean }>;
    };
    const shallowSrc = shallow.tree.find((entry) => entry.name === 'src')!;
    expect(shallowSrc.children).toEqual([]);
    expect(shallowSrc.truncated).toBe(true);
  });

  // --- move_file ------------------------------------------------

  it('move_file renames a file and refuses an occupied destination', async () => {
    const execute = executeOf(createMoveFileTool(root));

    const moved = await execute({ source: 'readme.md', destination: 'docs/readme.md' });
    expect(moved.success).toBe(true);
    expect(moved.destination).toBe(path.join('docs', 'readme.md'));
    expect(fs.existsSync(path.join(root, 'docs', 'readme.md'))).toBe(true);

    fs.writeFileSync(path.join(root, 'other.txt'), 'other');
    const clash = await execute({ source: 'other.txt', destination: 'docs/readme.md' });
    expect(clash.success).toBe(false);
    expect(clash.code).toBe('EEXIST');
  });

  it('move_file validates both ends before moving anything', async () => {
    const execute = executeOf(createMoveFileTool(root));
    const result = await execute({ source: 'readme.md', destination: '../escaped.md' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
    expect(fs.existsSync(path.join(root, 'readme.md'))).toBe(true);
  });

  // --- get_file_info / create_directory -------------------------

  it('get_file_info describes files and directories', async () => {
    const execute = executeOf(createGetFileInfoTool(root));

    const file = (await execute({ path: 'readme.md' })) as Record<string, unknown>;
    expect(file.success).toBe(true);
    expect(file.isFile).toBe(true);
    expect(file.size).toBe(18);
    expect(file.sizeFormatted).toBe('18 B');
    expect(file.isSymlink).toBe(false);

    const dir = (await execute({ path: 'src' })) as Record<string, unknown>;
    expect(dir.isDirectory).toBe(true);
  });

  it('create_directory creates parents and reports whether anything was created', async () => {
    const execute = executeOf(createCreateDirectoryTool(root));

    const first = await execute({ path: 'a/b/c' });
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    expect(fs.statSync(path.join(root, 'a/b/c')).isDirectory()).toBe(true);

    const second = await execute({ path: 'a/b/c' });
    expect(second.created).toBe(false);
  });

  // --- search_files / list_allowed_directories ------------------

  it('search_files finds files by glob relative to the workspace root', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ path: '.', pattern: '**/*.ts' })) as {
      success: boolean;
      totalMatches: number;
      matches: string[];
    };

    expect(result.success).toBe(true);
    expect(result.matches).toContain(path.join('src', 'index.ts'));
    expect(result.matches).toContain(path.join('src', 'lib', 'util.ts'));
    expect(result.totalMatches).toBe(2);
  });

  it('list_allowed_directories reports the workspace without leaking the host path', async () => {
    const execute = executeOf(createListAllowedDirectoriesTool(root));
    const result = (await execute({})) as { success: boolean; directories: string[] };

    expect(result.success).toBe(true);
    expect(result.directories).toEqual(['.']);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});

// ─── Registry consistency ────────────────────────────────────────

describe('Phase 33 — local tool catalog stays in sync with registry/tools/*.json', () => {
  it('every local tool factory has a packaged definition, and vice versa', () => {
    const dir = path.join(REPO_ROOT, 'registry', 'tools');
    const packaged = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as { id: string })
      .map((definition) => definition.id)
      .sort();

    expect([...LOCAL_TOOL_IDS].sort()).toEqual(packaged);
  });
});
