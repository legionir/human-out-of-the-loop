/**
 * Working-tree checkpoint / rollback (J-05).
 *
 * Before a writable step we copy project files (skipping .git, node_modules,
 * .ai-runtime) into `.ai-runtime/checkpoints/<planId>/<stepId>/`.  Rollback
 * restores that tree so a failed write does not leave the workspace dirty.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', '.ai-runtime', 'dist', 'coverage']);

export function checkpointDir(projectRoot: string, planId: string, stepId: string): string {
  return path.join(projectRoot, '.ai-runtime', 'checkpoints', planId, stepId);
}

function walkFiles(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
}

export function listProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];
  walkFiles(projectRoot, projectRoot, files);
  return files.sort();
}

export function captureCheckpoint(projectRoot: string, planId: string, stepId: string): string {
  const dest = checkpointDir(projectRoot, planId, stepId);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'files'), { recursive: true });
  const files = listProjectFiles(projectRoot);
  for (const rel of files) {
    const from = path.join(projectRoot, rel);
    const to = path.join(dest, 'files', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ planId, stepId, files, capturedAt: Date.now() }));
  return dest;
}

export function restoreCheckpoint(projectRoot: string, planId: string, stepId: string): boolean {
  const dest = checkpointDir(projectRoot, planId, stepId);
  const manifestPath = path.join(dest, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] };
  const snap = new Set(manifest.files);
  for (const rel of listProjectFiles(projectRoot)) {
    if (!snap.has(rel)) {
      try {
        fs.unlinkSync(path.join(projectRoot, rel));
      } catch {
        /* ignore */
      }
    }
  }
  for (const rel of manifest.files) {
    const from = path.join(dest, 'files', rel);
    const to = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return true;
}

export function latestCheckpointStep(projectRoot: string, planId: string): string | undefined {
  const dir = path.join(projectRoot, '.ai-runtime', 'checkpoints', planId);
  if (!fs.existsSync(dir)) return undefined;
  const steps = fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'manifest.json')))
    .sort();
  return steps.at(-1);
}
