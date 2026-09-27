/**
 * Project tree index — static context (directory counts) plus on-demand
 * file metadata.  See docs/PROJECT_INDEX.md.
 *
 *   hootl index                         print structure.json
 *   hootl index --write [dir]           write structure.json + files.json
 *   hootl index --files src/services    list_files(path)
 *   hootl index --find "*.ts" --path src
 *   hootl index --search TODO
 */
import path from 'node:path';
import { resolveCliDefaults } from '../utils/config.js';
import { err, out } from '../utils/output.js';
import {
  buildProjectIndex,
  findFiles,
  listFiles,
  listTree,
  searchProject,
  writeProjectIndex,
  PROJECT_INDEX_DIR,
  type ProjectIndex,
} from '../../ai/project-index.js';

export interface IndexCommandOptions {
  projectRoot?: string;
  write?: boolean | string;
  files?: string;
  find?: string;
  search?: string;
  path?: string;
  json?: boolean;
}

export async function indexCommand(opts: IndexCommandOptions): Promise<number> {
  const { projectRoot: root } = resolveCliDefaults({ projectRoot: opts.projectRoot });
  let index: ProjectIndex;
  try {
    index = await buildProjectIndex(root);
  } catch (e) {
    err(`index failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (opts.write !== undefined && opts.write !== false) {
    const outDir =
      typeof opts.write === 'string' && opts.write.trim() !== ''
        ? path.resolve(opts.write)
        : path.join(root, '.ai-runtime', PROJECT_INDEX_DIR);
    await writeProjectIndex(outDir, index);
    out(JSON.stringify({ ok: true, outDir, structure: 'structure.json', files: 'files.json' }, null, 2));
    return 0;
  }

  if (typeof opts.files === 'string') {
    out(JSON.stringify(listFiles(index, opts.files), null, 2));
    return 0;
  }

  if (typeof opts.find === 'string') {
    const hits = findFiles(index, opts.find, opts.path);
    out(JSON.stringify(hits, null, 2));
    return 0;
  }

  if (typeof opts.search === 'string') {
    const hits = await searchProject(root, index, opts.search, opts.path);
    out(JSON.stringify(hits, null, 2));
    return 0;
  }

  out(JSON.stringify(listTree(index), null, 2));
  return 0;
}
