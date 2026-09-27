/**
 * Working-tree checkpoint / rollback (J-05).
 *
 * Before a writable step we copy project files (skipping .git, node_modules,
 * .ai-runtime) into `.ai-runtime/checkpoints/<planId>/<stepId>/`.  Rollback
 * restores that tree so a failed write does not leave the workspace dirty.
 *
 * Copies use copy-on-write clones where the filesystem supports them, a tree
 * larger than the limits below is not snapshotted at all (the step still
 * runs, it just cannot be rolled back automatically), only the newest
 * snapshots of a plan are kept, and old plans' snapshots are pruned.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', '.ai-runtime', 'dist', 'coverage']);

/** A tree with more files than this is not snapshotted. */
export const CHECKPOINT_MAX_FILES = 5_000;
/** …or with more bytes than this. */
export const CHECKPOINT_MAX_BYTES = 200 * 1024 * 1024;
/** Snapshots kept per plan (the newest ones). */
export const CHECKPOINTS_KEPT_PER_PLAN = 2;

export function checkpointDir(projectRoot: string, planId: string, stepId: string): string {
  return path.join(projectRoot, '.ai-runtime', 'checkpoints', planId, stepId);
}

function checkpointsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'checkpoints');
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

function copyFile(from: string, to: string): void {
  // COPYFILE_FICLONE: a reflink (instant, no extra space) on CoW filesystems,
  // an ordinary copy elsewhere.
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
}

/** Keep only the newest `keep` snapshots of one plan. */
function pruneStepSnapshots(projectRoot: string, planId: string, keep: number): void {
  const dir = path.join(checkpointsRoot(projectRoot), planId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const withTime = names
    .map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(dir, name, 'manifest.json')).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of withTime.slice(keep)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Snapshot the tree.  Returns the snapshot directory, or `undefined` when the
 * tree is over the size limits (nothing is written then).
 */
export function captureCheckpoint(
  projectRoot: string,
  planId: string,
  stepId: string,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): string | undefined {
  const files = listProjectFiles(projectRoot);
  if (files.length > (limits.maxFiles ?? CHECKPOINT_MAX_FILES)) return undefined;
  let bytes = 0;
  const maxBytes = limits.maxBytes ?? CHECKPOINT_MAX_BYTES;
  for (const rel of files) {
    try {
      bytes += fs.statSync(path.join(projectRoot, rel)).size;
    } catch {
      /* vanished — skipped by the copy below as well */
    }
    if (bytes > maxBytes) return undefined;
  }

  const dest = checkpointDir(projectRoot, planId, stepId);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'files'), { recursive: true });
  const copied: string[] = [];
  for (const rel of files) {
    const from = path.join(projectRoot, rel);
    const to = path.join(dest, 'files', rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      copyFile(from, to);
      copied.push(rel);
    } catch {
      /* a file removed mid-walk is simply not part of the snapshot */
    }
  }
  fs.writeFileSync(
    path.join(dest, 'manifest.json'),
    JSON.stringify({ planId, stepId, files: copied, capturedAt: Date.now() }),
  );
  pruneStepSnapshots(projectRoot, planId, CHECKPOINTS_KEPT_PER_PLAN);
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
    copyFile(from, to);
  }
  return true;
}

export function latestCheckpointStep(projectRoot: string, planId: string): string | undefined {
  const dir = path.join(checkpointsRoot(projectRoot), planId);
  if (!fs.existsSync(dir)) return undefined;
  const steps = fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'manifest.json')))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name, 'manifest.json')).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return steps.at(-1)?.name;
}

/** Remove every plan's snapshots older than `days` (housekeeping at start-up). */
export function pruneCheckpoints(projectRoot: string, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const root = checkpointsRoot(projectRoot);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
