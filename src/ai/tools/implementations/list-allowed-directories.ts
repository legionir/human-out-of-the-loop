import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';

const inputSchema = z.object({});

/**
 * Phase 33: `list_allowed_directories`, ported from the MCP reference
 * filesystem server.
 *
 * The reference answers with the absolute directories the server may touch.  In
 * this runtime every filesystem tool takes paths **relative to the workspace
 * root**, and tool results must not carry host paths: they end up in the plan,
 * the observability log and the final report (SEC-05).  So the answer is the
 * workspace root as `.` plus the rule, which is the part the model actually
 * needs to use the other tools correctly.
 */
export function createListAllowedDirectoriesTool(projectRoot: string) {
  const allowed = [projectRoot];
  return tool({
    description:
      'Returns the directories this workspace allows access to. Every path passed to the other ' +
      'filesystem tools is relative to this root (reported as ".").',
    inputSchema,
    execute: async () => {
      const check = await resolvePathInWorkspace('.', allowed);
      if (!check.safe) {
        return {
          success: false as const,
          error: check.reason!,
          code: 'PATH_TRAVERSAL_BLOCKED',
        };
      }

      const root = check.resolvedPath;
      return {
        success: true as const,
        directories: ['.'],
        rootName: path.basename(root),
        note:
          'One allowed directory: the workspace root, reported as ".". All paths given to ' +
          'read_file/write_file/edit_file/search_code/search_files and the other filesystem tools are ' +
          'relative to it, and nothing outside it is reachable — the absolute host path is ' +
          'deliberately hidden so it can never leak into run artifacts.',
      };
    },
  });
}
