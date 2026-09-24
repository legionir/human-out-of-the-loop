import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWriteMultipleFilesTool } from '../tools/implementations/write-multiple-files.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { searchContentTree } from '../tools/fs/index.js';
import { LOCAL_TOOL_IDS } from '../tools/local-tools.js';

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

const isWindows = process.platform === 'win32';

// ─── write_multiple_files (phase 34) ─────────────────────────────

describe('Phase 34 — write_multiple_files (batch / scaffold)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-write-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-write-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('writes a whole scaffold in one call and creates the parent directories', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(root));
    const result = await execute({
      files: [
        { path: 'src/components/Button.tsx', content: 'export const Button = 1;\n' },
        { path: 'src/components/Button.test.tsx', content: 'test("button");\n' },
        { path: 'src/index.ts', content: "export * from './components/Button.js';\n" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(3);
    expect(result.conflicts).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.dryRun).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src/components/Button.tsx'), 'utf-8')).toBe(
      'export const Button = 1;\n'
    );
    expect(fs.statSync(path.join(root, 'src/components')).isDirectory()).toBe(true);
    expect(result.directoriesCreated).toEqual([
      'src',
      path.join('src', 'components'),
    ]);
    expect(result.summary).toContain('created 3');

    const files = result.files as Array<{ path: string; status: string; bytes?: number }>;
    expect(files.map((file) => file.status)).toEqual(['created', 'created', 'created']);
    expect(files[0]!.path).toBe(path.join('src', 'components', 'Button.tsx'));
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('is idempotent: a second identical run reports unchanged and rewrites nothing', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(root));
    const files = [{ path: 'notes/a.txt', content: 'same\n' }];
    await execute({ files });

    const before = fs.statSync(path.join(root, 'notes/a.txt')).mtimeMs;
    const second = await execute({ files });

    expect(second.success).toBe(true);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(fs.statSync(path.join(root, 'notes/a.txt')).mtimeMs).toBe(before);
  });

  it('reports a conflicting file without touching it, and still writes the rest', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
    const execute = executeOf(createWriteMultipleFilesTool(root));

    const result = await execute({
      files: [
        { path: 'a.txt', content: 'replacement\n' },
        { path: 'b.txt', content: 'brand new\n' },
      ],
    });

    expect(result.success).toBe(false); // the batch was not fully applied
    expect(result.conflicts).toBe(1);
    expect(result.created).toBe(1);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8')).toBe('original\n');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8')).toBe('brand new\n');

    const files = result.files as Array<{
      path: string;
      status: string;
      code?: string;
      error?: string;
    }>;
    expect(files[0]).toMatchObject({ path: 'a.txt', status: 'conflict', code: 'EEXIST' });
    expect(files[0]!.error).toMatch(/overwrite=true/);
  });

  it('replaces a conflicting file when overwrite=true', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
    const execute = executeOf(createWriteMultipleFilesTool(root));

    const result = await execute({
      files: [{ path: 'a.txt', content: 'replacement\n' }],
      overwrite: true,
    });

    expect(result.success).toBe(true);
    expect(result.replaced).toBe(1);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8')).toBe('replacement\n');
    // Atomic write: no temp file left behind.
    expect(fs.readdirSync(root)).toEqual(['a.txt']);
  });

  it.skipIf(isWindows)('keeps the original permission bits when replacing', async () => {
    fs.writeFileSync(path.join(root, 'script.sh'), 'echo old\n');
    fs.chmodSync(path.join(root, 'script.sh'), 0o755);
    const execute = executeOf(createWriteMultipleFilesTool(root));

    await execute({ files: [{ path: 'script.sh', content: 'echo new\n' }], overwrite: true });

    expect(fs.statSync(path.join(root, 'script.sh')).mode & 0o777).toBe(0o755);
  });

  it('dryRun reports every status without writing or creating directories', async () => {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n');
    const execute = executeOf(createWriteMultipleFilesTool(root));

    fs.writeFileSync(path.join(root, 'same.txt'), 'same\n');
    const result = await execute({
      files: [
        { path: 'new/deep.txt', content: 'x' },
        { path: 'keep.txt', content: 'different' },
        { path: 'same.txt', content: 'same\n' },
      ],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.summary).toContain('would create 1');
    expect(fs.existsSync(path.join(root, 'new'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf-8')).toBe('keep\n');
  });

  it('aborts the whole batch when a path escapes the workspace (nothing is written)', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(root));

    const result = await execute({
      files: [
        { path: 'fine.txt', content: 'fine\n' },
        { path: '../escape.txt', content: 'nope\n' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
    expect(fs.existsSync(path.join(root, 'fine.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.txt'))).toBe(false);
    const errors = result.errors as Array<{ path: string; code: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: '../escape.txt', code: 'PATH_TRAVERSAL_BLOCKED' });
  });

  it.skipIf(isWindows)(
    'aborts when a symlinked parent would write outside the workspace',
    async () => {
      fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');
      const execute = executeOf(createWriteMultipleFilesTool(root));

      const result = await execute({
        files: [
          { path: 'safe.txt', content: 'safe\n' },
          { path: 'link-out/evil.txt', content: 'evil\n' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
      expect(fs.existsSync(path.join(root, 'safe.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
    }
  );

  it('rejects a duplicated path before writing anything', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(root));

    const result = await execute({
      files: [
        { path: 'dup.txt', content: 'first' },
        { path: 'sub/../dup.txt', content: 'second' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('DUPLICATE_PATH');
    expect(fs.existsSync(path.join(root, 'dup.txt'))).toBe(false);
  });

  it('rejects an empty batch with a structured error', async () => {
    const execute = executeOf(createWriteMultipleFilesTool(root));
    const result = await execute({ files: [] });

    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_BATCH');
  });

  it('reports a per-file failure without aborting the others', async () => {
    fs.mkdirSync(path.join(root, 'adir'));
    const execute = executeOf(createWriteMultipleFilesTool(root));

    const result = await execute({
      files: [
        { path: 'adir', content: 'cannot write a directory' },
        { path: 'after.txt', content: 'written anyway\n' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    expect(fs.readFileSync(path.join(root, 'after.txt'), 'utf-8')).toBe('written anyway\n');
    const files = result.files as Array<{ path: string; status: string; error?: string }>;
    expect(files[0]).toMatchObject({ path: 'adir', status: 'error' });
    expect(files[0]!.error).toBeTruthy();
  });
});

// ─── search_code (phase 34: VS Code-style search) ─────────────────

describe('Phase 34 — search_code: path pattern, toggles, columns, context', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-search-'));
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      'const fooBar = 1;\nconst foobar = 2;\ncall(fooBar, fooBar);\n'
    );
    fs.writeFileSync(
      path.join(root, 'src', 'components', 'Button.tsx'),
      'export function Button() {}\n'
    );
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), 'fooBar in prose\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pathPattern limits the search to matching files', async () => {
    const execute = executeOf(createSearchCodeTool(root));
    const result = (await execute({
      pattern: 'fooBar',
      pathPattern: '\\.tsx$',
    })) as { success: boolean; files: string[]; totalMatches: number };

    expect(result.success).toBe(true);
    // Button.tsx has no fooBar; the point is that docs/guide.md was excluded.
    expect(result.files).toEqual([]);
    expect(result.totalMatches).toBe(0);

    const scoped = (await execute({
      pattern: 'fooBar',
      pathPattern: '^src/',
    })) as { files: string[] };
    expect(scoped.files).toEqual([path.join('src', 'app.ts')]);
  });

  it('reports every occurrence with its column, and the matching file list', async () => {
    const execute = executeOf(createSearchCodeTool(root));
    const result = (await execute({
      pattern: 'fooBar',
      caseSensitive: true,
      excludePatterns: ['docs/**'],
    })) as {
      success: boolean;
      totalMatches: number;
      fileCount: number;
      files: string[];
      matches: Array<{ file: string; line: number; column: number; text: string }>;
      formatted: string;
    };

    expect(result.success).toBe(true);
    // Line 1 once, the third line twice.
    expect(result.totalMatches).toBe(3);
    expect(result.fileCount).toBe(1);
    expect(result.files).toEqual([path.join('src', 'app.ts')]);
    expect(result.matches[0]).toMatchObject({ line: 1, column: 7, text: 'const fooBar = 1;' });
    expect(result.matches[1]).toMatchObject({ line: 3, column: 6 });
    expect(result.matches[2]).toMatchObject({ line: 3, column: 14 });
    expect(result.matches[1]!.text).toBe('call(fooBar, fooBar);');
    expect(result.formatted).toContain('src/app.ts:1:7: const fooBar = 1;');
  });

  it('caseSensitive distinguishes fooBar from foobar (default is insensitive)', async () => {
    const execute = executeOf(createSearchCodeTool(root));

    const insensitive = (await execute({ pattern: 'foobar', excludePatterns: ['docs/**'] })) as {
      totalMatches: number;
    };
    expect(insensitive.totalMatches).toBe(4); // line 1, line 2 and both on line 3

    const sensitive = (await execute({
      pattern: 'foobar',
      caseSensitive: true,
      excludePatterns: ['docs/**'],
    })) as { totalMatches: number; matches: Array<{ line: number }> };
    expect(sensitive.totalMatches).toBe(1);
    expect(sensitive.matches[0]!.line).toBe(2);
  });

  it('wholeWord does not match fooBar inside a larger word', async () => {
    fs.writeFileSync(path.join(root, 'src', 'word.ts'), 'const myFooBar = x; const fooBar = y;\n');
    const execute = executeOf(createSearchCodeTool(root));

    const result = (await execute({
      pattern: 'fooBar',
      wholeWord: true,
      pathPattern: 'word\\.ts$',
    })) as { totalMatches: number; matches: Array<{ column: number }> };

    // `myFooBar` is not a match; the standalone one starts at index 26.
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]!.column).toBe(27);
  });

  it('wholeWord works when the pattern starts with punctuation', async () => {
    // A `\b` based guard would fail here (the pattern starts with a non-word
    // char), so lookarounds are used. The second call is *preceded* by a word
    // char and must be excluded — that is what whole-word means.
    fs.writeFileSync(path.join(root, 'src', 'punct.ts'), 'x = (foo); other(foo);\n');
    const execute = executeOf(createSearchCodeTool(root));

    const result = (await execute({
      pattern: '\\(foo\\)',
      wholeWord: true,
      pathPattern: 'punct\\.ts$',
    })) as { totalMatches: number; matches: Array<{ column: number }> };

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]!.column).toBe(5);
  });

  it('literal turns the regex off', async () => {
    // As a regex, `a.b` matches both lines (the dot is a wildcard); as literal
    // text it only matches the line that really contains `a.b`.
    fs.writeFileSync(path.join(root, 'src', 'literal.ts'), 'a.b\naXb\n');
    const execute = executeOf(createSearchCodeTool(root));

    const asRegex = (await execute({ pattern: 'a.b', pathPattern: 'literal\\.ts$' })) as {
      totalMatches: number;
    };
    expect(asRegex.totalMatches).toBe(2);

    const asText = (await execute({
      pattern: 'a.b',
      literal: true,
      pathPattern: 'literal\\.ts$',
    })) as { totalMatches: number; matches: Array<{ line: number }> };
    expect(asText.totalMatches).toBe(1);
    expect(asText.matches[0]!.line).toBe(1);
  });

  it('contextLines adds the surrounding lines', async () => {
    const execute = executeOf(createSearchCodeTool(root));
    const result = (await execute({
      pattern: 'const foobar',
      caseSensitive: true,
      contextLines: 1,
    })) as {
      matches: Array<{ line: number; contextBefore?: string[]; contextAfter?: string[] }>;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.contextBefore).toEqual(['const fooBar = 1;']);
    expect(result.matches[0]!.contextAfter).toEqual(['call(fooBar, fooBar);']);
  });

  it('stops at maxMatchesPerFile and flags the result as truncated', async () => {
    const lines = Array.from({ length: 30 }, () => 'HIT').join('\n');
    fs.writeFileSync(path.join(root, 'src', 'many.ts'), `${lines}\n`);
    const execute = executeOf(createSearchCodeTool(root));

    const result = (await execute({
      pattern: 'HIT',
      pathPattern: 'many\\.ts$',
      maxMatchesPerFile: 5,
    })) as { totalMatches: number; truncated: boolean; matches: Array<{ line: number }> };

    expect(result.totalMatches).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.matches.map((match) => match.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips binary files without reporting them as unreadable', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'blob.bin'),
      Buffer.from([0x48, 0x49, 0x54, 0x00, 0x48])
    );
    const execute = executeOf(createSearchCodeTool(root));

    const result = (await execute({ pattern: 'HIT', pathPattern: '\\.bin$' })) as {
      success: boolean;
      totalMatches: number;
      skippedBinary: number;
      skippedCount: number;
      skipped: unknown[];
    };

    expect(result.success).toBe(true);
    expect(result.totalMatches).toBe(0);
    expect(result.skippedBinary).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('rejects an unsafe or invalid pathPattern with the same codes as the content pattern', async () => {
    const execute = executeOf(createSearchCodeTool(root));

    const unsafe = (await execute({ pattern: 'x', pathPattern: '(a+)+$' })) as {
      success: boolean;
      code?: string;
    };
    expect(unsafe.success).toBe(false);
    expect(unsafe.code).toBe('UNSAFE_REGEX');

    const invalid = (await execute({ pattern: 'x', pathPattern: '([unclosed' })) as {
      success: boolean;
      code?: string;
    };
    expect(invalid.success).toBe(false);
    expect(invalid.code).toBe('INVALID_REGEX');

    const tooLong = (await execute({ pattern: 'x', pathPattern: 'a'.repeat(201) })) as {
      code?: string;
    };
    expect(tooLong.code).toBe('PATTERN_TOO_LONG');
  });

  it('keeps the original contract (directory, fileExtension, maxResults, relative paths)', async () => {
    const execute = executeOf(createSearchCodeTool(root));
    const result = (await execute({
      pattern: 'export',
      directory: path.join('src', 'components'),
      fileExtension: '.tsx',
      maxResults: 10,
    })) as {
      success: boolean;
      totalMatches: number;
      matches: Array<{ file: string; line: number; text: string }>;
      filesScanned: number;
    };

    expect(result.success).toBe(true);
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]!.file).toBe(path.join('src', 'components', 'Button.tsx'));
    expect(result.matches[0]!.file).not.toMatch(/^[/\\]/);
    expect(result.matches[0]!.file).not.toContain(root);
    expect(result.filesScanned).toBe(1);
  });

  it('blocks a directory outside the workspace (unchanged from phase 18)', async () => {
    const execute = executeOf(createSearchCodeTool(root));
    const result = (await execute({ pattern: 'x', directory: '/etc' })) as { code?: string };
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });
});

// ─── engine-level guarantees ─────────────────────────────────────

describe('Phase 34 — content-search engine safeguards', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-engine-'));
    fs.writeFileSync(path.join(root, 'small.txt'), 'HIT\n');
    fs.writeFileSync(path.join(root, 'big.txt'), `${'x'.repeat(500)}HIT\n`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not read files above maxFileSizeBytes and counts them', async () => {
    const outcome = await searchContentTree({
      baseDirectory: root,
      workspaceRoot: root,
      contentRegex: /HIT/,
      maxResults: 10,
      maxFileSizeBytes: 64,
    });

    expect(outcome.matches.map((match) => match.file)).toEqual(['small.txt']);
    expect(outcome.skippedTooLarge).toBe(1);
    expect(outcome.skipped).toEqual([]);
  });

  it.skipIf(isWindows)('never follows symlinks and counts them', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-engine-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'HIT SECRET\n');
    fs.symlinkSync(outsideDir, path.join(root, 'link-out'), 'dir');
    fs.symlinkSync(path.join(root, 'small.txt'), path.join(root, 'link-in.txt'), 'file');

    try {
      const outcome = await searchContentTree({
        baseDirectory: root,
        workspaceRoot: root,
        contentRegex: /HIT/,
        maxResults: 10,
      });

      expect(outcome.matches.map((match) => match.file)).toEqual(['big.txt', 'small.txt']);
      expect(outcome.skippedSymlinks).toBe(2);
      expect(JSON.stringify(outcome)).not.toContain('SECRET');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('handles patterns that can match the empty string without looping forever', async () => {
    fs.writeFileSync(path.join(root, 'empty.txt'), 'aaa\n');
    const outcome = await searchContentTree({
      baseDirectory: root,
      workspaceRoot: root,
      contentRegex: /a*/,
      maxResults: 10,
    });

    expect(outcome.matches.length).toBeGreaterThan(0);
    expect(outcome.matches[0]!.column).toBe(1);
  });
});

// ─── catalog consistency ─────────────────────────────────────────

describe('Phase 34 — tool catalog', () => {
  it('lists write_multiple_files next to the other local tools', () => {
    expect(LOCAL_TOOL_IDS).toContain('write_multiple_files');
    expect(LOCAL_TOOL_IDS).toContain('search_code');
  });
});
