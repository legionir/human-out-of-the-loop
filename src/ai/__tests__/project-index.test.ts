import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjectIndex,
  countLines,
  findFiles,
  listFiles,
  listTree,
  readFileRange,
  searchProject,
  writeProjectIndex,
  indexOutputPaths,
} from '../project-index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-index-'));
  fs.mkdirSync(path.join(root, 'src', 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'controllers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1\n');
  fs.writeFileSync(path.join(root, '.hidden'), 'nope\n');
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(
    path.join(root, 'src', 'services', 'auth.ts'),
    'export function auth() {\n  return true;\n}\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'services', 'user.ts'), 'export const user = 1;\n');
  fs.writeFileSync(
    path.join(root, 'src', 'controllers', 'login.controller.ts'),
    'export class Login {}\n',
  );
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'gitdir\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('countLines', () => {
  it('empty → 0; trailing newline does not add a line', () => {
    expect(countLines(Buffer.from(''))).toBe(0);
    expect(countLines(Buffer.from('a'))).toBe(1);
    expect(countLines(Buffer.from('a\n'))).toBe(1);
    expect(countLines(Buffer.from('a\nb'))).toBe(2);
    expect(countLines(Buffer.from('a\nb\n'))).toBe(2);
  });
});

describe('buildProjectIndex', () => {
  it('list_tree counts only direct files and skips ignored dirs', async () => {
    const index = await buildProjectIndex(root);
    const tree = listTree(index);
    expect(tree.files).toBe(2); // README.md + .env
    expect(tree.node_modules).toBeUndefined();
    expect(tree['.git']).toBeUndefined();
    const src = tree.src as { files: number; services: { files: number } };
    expect(src.files).toBe(2); // main.ts, app.ts
    expect(src.services.files).toBe(2);
  });

  it('list_files returns size in bytes and line counts', async () => {
    const index = await buildProjectIndex(root);
    const listed = listFiles(index, 'src/services');
    expect(listed.path).toBe('src/services');
    expect(listed.files['auth.ts']).toEqual({
      size: fs.statSync(path.join(root, 'src', 'services', 'auth.ts')).size,
      lines: 3,
    });
    expect(listed.files['user.ts']?.lines).toBe(1);
  });

  it('find_files matches a glob under an optional path', async () => {
    const index = await buildProjectIndex(root);
    expect(findFiles(index, '*.controller.ts')).toEqual(['src/controllers/login.controller.ts']);
    expect(findFiles(index, '*.ts', 'src/services')).toEqual([
      'src/services/auth.ts',
      'src/services/user.ts',
    ]);
  });

  it('search finds a regex without listing ignored trees', async () => {
    const index = await buildProjectIndex(root);
    const hits = await searchProject(root, index, 'function auth');
    expect(hits).toEqual([
      expect.objectContaining({ path: 'src/services/auth.ts', line: 1 }),
    ]);
    expect(hits.every((h) => !h.path.includes('node_modules'))).toBe(true);
  });

  it('read_file_range returns an inclusive line slice', async () => {
    const text = await readFileRange(root, 'src/services/auth.ts', 2, 3);
    expect(text).toBe('  return true;\n}');
  });

  it('writeProjectIndex separates structure.json from files.json', async () => {
    const index = await buildProjectIndex(root);
    const outDir = path.join(root, 'project');
    await writeProjectIndex(outDir, index);
    const paths = indexOutputPaths(outDir);
    const structure = JSON.parse(fs.readFileSync(paths.structure, 'utf8')) as { files: number };
    const files = JSON.parse(fs.readFileSync(paths.files, 'utf8')) as Record<
      string,
      Record<string, { size: number; lines: number }>
    >;
    expect(structure.files).toBe(2);
    expect(files['src/services']?.['auth.ts']?.lines).toBe(3);
    expect(JSON.stringify(structure)).not.toContain('auth.ts');
  });
});
