import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace, checkProtectedPath } from './path-security.js';
import { applyFileEdits, FileEditError } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must not be empty'),
  edits: z
    .array(
      z.object({
        oldText: z
          .string()
          .min(1, 'oldText must not be empty')
          .describe('Text to search for - must match the file exactly'),
        newText: z.string().describe('Text to replace it with'),
      })
    )
    .min(1, 'at least one edit is required'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Preview the changes as a git-style diff without writing anything'),
});

/**
 * Phase 33: `edit_file`, ported from the MCP reference filesystem server.
 *
 * The missing half of the write story: until now an agent could only replace a
 * whole file (`write_file`), so a one-line fix meant rewriting — and
 * re-indenting — everything, with the associated data-loss risk.  This tool
 * replaces exact line sequences and returns the unified diff it produced, so the
 * change is reviewable in the run log.
 *
 * Three behaviours worth knowing (all from the reference implementation):
 *   - an edit that does not match is an ERROR, never a silent no-op;
 *   - a whitespace-only difference is tolerated, and the original indentation is
 *     re-applied to the replacement;
 *   - `dryRun: true` returns the diff without touching the file.
 */
export function createEditFileTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Makes line-based edits to a text file: each edit replaces an exact line sequence with new ' +
      'content. Returns a git-style diff of the changes. Set dryRun=true to preview without writing.',
    inputSchema,
    execute: async ({ path: requestedPath, edits, dryRun }) => {
      try {
        // Schema defaults are not applied when execute() is called directly.
        const preview = dryRun ?? false;
        const validation = await resolvePathInWorkspace(requestedPath, allowed);
        if (!validation.safe) {
          return {
            success: false as const,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const protectedCheck = checkProtectedPath(validation.resolvedPath, allowed);
        if (protectedCheck.protected) {
          return {
            success: false as const,
            error: protectedCheck.reason!,
            code: 'PROTECTED_PATH',
          };
        }

        const diff = await applyFileEdits(validation.resolvedPath, edits, preview);
        return {
          success: true as const,
          path: path.relative(projectRoot, validation.resolvedPath) || '.',
          editsApplied: edits.length,
          dryRun: preview,
          diff,
        };
      } catch (err) {
        if (err instanceof FileEditError) {
          return {
            success: false as const,
            error: err.message,
            code: err.code,
            ...(err.matchCount !== undefined ? { matchCount: err.matchCount } : {}),
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        const isNoMatch = message.startsWith('Could not find exact match for edit:');
        return {
          success: false as const,
          error: message,
          code: isNoMatch ? 'EDIT_NOT_FOUND' : ((err as NodeJS.ErrnoException).code ?? 'UNKNOWN'),
        };
      }
    },
  });
}
