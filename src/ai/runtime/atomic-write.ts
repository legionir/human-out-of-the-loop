import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Phase 19 (PERS-01): write a file atomically.
 *
 * Strategy: write to a unique temp file in the SAME directory, then
 * `rename` over the target.  `rename` on the same filesystem is atomic
 * on POSIX and Windows — readers (and crash recovery) never observe a
 * partially-written file.
 *
 *   1. `<target>.tmp-<uuid>` ← full contents
 *   2. rename(tmp, target)
 *
 * If the process dies between 1 and 2, the target is untouched and
 * only an orphan temp file remains (safe to clean up).
 *
 * Phase 30 (P9): the target directory is created on demand.  Stores
 * create it in their constructor, but a long-running process can outlive
 * the directory (e.g. `rm -rf .ai-runtime` under a running web server);
 * recreating it here keeps such a write working instead of failing with
 * a bare ENOENT.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, data, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // The directory disappeared after the store was constructed — recreate
    // it once and retry (Phase 30 / P9).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, data, 'utf-8');
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Remove leftover `.tmp-*` files (from crashed writes) in a directory.
 * Non-recursive; missing directory is not an error.
 */
export function cleanupStaleTempFiles(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.includes('.tmp-')) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // ignore
      }
    }
  }
}
