import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace, checkProtectedPath } from './path-security.js';
import { writeFileContent } from '../fs/lib.js';

const inputSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1, 'path must not be empty'),
        content: z.string(),
      })
    )
    .min(1, 'at least one file is required')
    .max(200, 'at most 200 files per call')
    .describe('Files to create, e.g. [{ "path": "src/index.ts", "content": "…" }]'),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      'Replace files whose content differs. Default false: such a file is reported as a conflict.'
    ),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Validate the whole batch and report what would happen, without writing anything.'),
});

type FileStatus = 'created' | 'replaced' | 'unchanged' | 'conflict' | 'error';

/**
 * The directories that would have to be created for `directory` to exist,
 * outermost first.  `fs.mkdir(recursive)` returns only the *first* directory it
 * created, so the chain is computed here — "what did the scaffold add?" is part
 * of the result, not a guess.
 */
async function missingDirectoryChain(directory: string): Promise<string[]> {
  const missing: string[] = [];
  let current = directory;

  for (;;) {
    const exists = await fs
      .stat(current)
      .then(() => true)
      .catch(() => false);
    if (exists) break;

    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return missing;
}

interface FileOutcome {
  path: string;
  status: FileStatus;
  bytes?: number;
  error?: string;
  code?: string;
}

/**
 * Phase 34: `write_multiple_files` — the batch/scaffold counterpart of
 * `write_file` and the write-side sibling of `read_multiple_files`.
 *
 * Why it exists: scaffolding a feature (a component + its test + its styles +
 * an index re-export) took one `write_file` call per file, one after another.
 * This writes the whole set in one call, creating parent directories as needed.
 *
 * The rules, all of them deliberate:
 *
 *   1. **Path problems abort the batch.** Every path is resolved and validated
 *      first; if any of them escapes the workspace, is a duplicate, or is
 *      otherwise unusable, *nothing* is written and each problem is reported.
 *      A half-applied scaffold is the worst possible outcome — worse than
 *      none — and a refused path means the request itself is wrong.
 *   2. **Content problems do not.** A file whose content differs and
 *      `overwrite` is false is reported as a `conflict` while the other files
 *      are still written, exactly like `read_multiple_files` returning the
 *      files it could read. The caller sees precisely what was and was not
 *      applied.
 *   3. **Identical content is `unchanged`, not a conflict.** Re-running a
 *      scaffold is a no-op instead of an error, and the file's mtime is left
 *      alone because nothing is rewritten.
 *   4. **Writes go through the ported core**: `O_EXCL` for a new file (a
 *      pre-existing symlink is never written through) and temp file + `rename`
 *      with the original permissions restored for an existing one.
 *   5. **`dryRun` touches nothing at all** — not even the directories — and
 *      reports the same statuses, so a scaffold can be previewed.
 */
export function createWriteMultipleFilesTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Creates or updates several files in one call (scaffolding): parent directories are created ' +
      'and each file is written atomically. Files that already exist with different content are ' +
      'reported as conflicts unless overwrite=true (identical content is left untouched). ' +
      'If any path is invalid or escapes the workspace, nothing is written. ' +
      'Use dryRun=true to preview. Returns a per-file status.',
    inputSchema,
    execute: async ({ files, overwrite, dryRun }) => {
      // Schema defaults are not applied when execute() is called directly.
      const batch = files ?? [];
      const replace = overwrite ?? false;
      const preview = dryRun ?? false;

      if (batch.length === 0) {
        return {
          success: false as const,
          code: 'INVALID_BATCH',
          error: 'The batch is empty: pass at least one { path, content } entry.',
        };
      }

      try {
        // ── 1. Resolve and validate every path before touching the disk ──
        const prepared: Array<{
          absolute: string;
          relative: string;
          content: string;
        }> = [];
        const errors: Array<{ path: string; error: string; code: string }> = [];
        const seen = new Map<string, number>();

        for (const [index, file] of batch.entries()) {
          const validation = await resolvePathInWorkspace(file.path, allowed);
          if (!validation.safe) {
            errors.push({
              path: file.path,
              error: validation.reason!,
              code: 'PATH_TRAVERSAL_BLOCKED',
            });
            continue;
          }

          const protectedCheck = checkProtectedPath(validation.resolvedPath, allowed);
          if (protectedCheck.protected) {
            errors.push({
              path: file.path,
              error: protectedCheck.reason!,
              code: 'PROTECTED_PATH',
            });
            continue;
          }

          const relative = path.relative(projectRoot, validation.resolvedPath) || '.';
          const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
          const firstIndex = seen.get(key);
          if (firstIndex !== undefined) {
            errors.push({
              path: file.path,
              error: `Same file appears twice in this batch (entry #${firstIndex + 1} and #${index + 1}): ${relative}`,
              code: 'DUPLICATE_PATH',
            });
            continue;
          }
          seen.set(key, index);
          prepared.push({
            absolute: validation.resolvedPath,
            relative,
            content: file.content,
          });
        }

        if (errors.length > 0) {
          const code = errors.every((entry) => entry.code === 'PATH_TRAVERSAL_BLOCKED')
            ? 'PATH_TRAVERSAL_BLOCKED'
            : errors.every((entry) => entry.code === 'DUPLICATE_PATH')
              ? 'DUPLICATE_PATH'
              : 'INVALID_BATCH';
          return {
            success: false as const,
            code,
            error:
              `Nothing was written: ${errors.length} of ${batch.length} path(s) failed validation. ` +
              'Fix the paths and call the tool again.',
            errors,
          };
        }

        // ── 2. Apply each file independently: one conflict must not stop the rest ──
        const outcomes: FileOutcome[] = [];
        const directoriesCreated: string[] = [];
        let created = 0;
        let replaced = 0;
        let unchanged = 0;
        let conflicts = 0;
        let failed = 0;
        let bytesWritten = 0;

        for (const item of prepared) {
          try {
            const existing = await fs.stat(item.absolute).catch(() => undefined);

            if (existing?.isDirectory()) {
              throw Object.assign(new Error(`Path exists and is a directory: ${item.relative}`), {
                code: 'EISDIR',
              });
            }

            if (existing) {
              const current = await fs.readFile(item.absolute, 'utf-8').catch(() => undefined);
              if (current === item.content) {
                unchanged++;
                outcomes.push({ path: item.relative, status: 'unchanged' });
                continue;
              }
              if (!replace) {
                conflicts++;
                outcomes.push({
                  path: item.relative,
                  status: 'conflict',
                  error: `File already exists with different content: ${item.relative} (set overwrite=true to replace it)`,
                  code: 'EEXIST',
                });
                continue;
              }

              if (!preview) await writeFileContent(item.absolute, item.content);
              replaced++;
              bytesWritten += Buffer.byteLength(item.content, 'utf-8');
              outcomes.push({
                path: item.relative,
                status: 'replaced',
                bytes: Buffer.byteLength(item.content, 'utf-8'),
              });
              continue;
            }

            if (!preview) {
              const parent = path.dirname(item.absolute);
              for (const created of await missingDirectoryChain(parent)) {
                const relativeCreated = path.relative(projectRoot, created) || '.';
                if (!directoriesCreated.includes(relativeCreated)) {
                  directoriesCreated.push(relativeCreated);
                }
              }
              await fs.mkdir(parent, { recursive: true });
              await writeFileContent(item.absolute, item.content);
            }
            created++;
            bytesWritten += Buffer.byteLength(item.content, 'utf-8');
            outcomes.push({
              path: item.relative,
              status: 'created',
              bytes: Buffer.byteLength(item.content, 'utf-8'),
            });
          } catch (err) {
            failed++;
            outcomes.push({
              path: item.relative,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
              code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
            });
          }
        }

        const summary =
          `${preview ? 'would create' : 'created'} ${created}, ` +
          `${preview ? 'would replace' : 'replaced'} ${replaced}, unchanged ${unchanged}, ` +
          `conflicts ${conflicts}, failed ${failed}`;

        return {
          success: conflicts === 0 && failed === 0,
          dryRun: preview,
          totalFiles: batch.length,
          created,
          replaced,
          unchanged,
          conflicts,
          failed,
          directoriesCreated,
          bytes: bytesWritten,
          files: outcomes,
          summary,
        };
      } catch (err) {
        return {
          success: false as const,
          error: err instanceof Error ? err.message : String(err),
          code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        };
      }
    },
  });
}
