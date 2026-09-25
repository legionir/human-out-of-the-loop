import { tool, type Tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { mediaTypeForFile, readFileAsBase64 } from '../fs/lib.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must not be empty'),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024)
    .describe(
      'Refuse files larger than this (default 10 MiB) — a media payload goes into the model call'
    ),
});

/** 10 MiB of bytes ≈ 13.4 MiB of base64 text in every following model call. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

interface MediaOutcome {
  success: boolean;
  path?: string;
  mediaType?: string;
  kind?: 'image' | 'audio' | 'binary';
  bytes?: number;
  base64?: string;
  attachedToModel?: boolean;
  error?: string;
  code?: string;
}

type ReadMediaInput = { path: string; maxBytes: number };
type ReadMediaToolShape = Tool<ReadMediaInput, MediaOutcome>;

/**
 * The tool-result part the runtime sees keeps the raw output — that is where
 * `describeToolFailure` reads `success: false` from — so a failed read is still
 * a first-class tool error.  What the *model* receives is decided here: an
 * image/audio content part it can actually look at, or a small JSON summary.
 *
 * Typed through `Tool` itself: the SDK does not re-export `ToolResultOutput`,
 * so deriving it from the tool shape keeps the two in step.
 */
const toModelOutput: NonNullable<ReadMediaToolShape['toModelOutput']> = ({ output }) => {
  if (!output.success) {
    // Keep the project's failure contract visible to the model verbatim.
    return { type: 'json', value: output } as never;
  }

  const summary =
    `${output.path} — ${output.mediaType}, ${output.bytes} bytes` +
    (output.attachedToModel ? '' : ' (not attached: not an image or audio file)');

  if (!output.attachedToModel || !output.base64) {
    const { base64: _omitted, ...withoutPayload } = output;
    return { type: 'json', value: { ...withoutPayload, summary } } as never;
  }

  return {
    type: 'content',
    value: [
      { type: 'text', text: summary },
      {
        type: 'file',
        data: { type: 'data', data: output.base64 },
        mediaType: output.mediaType!,
        filename: path.basename(output.path ?? 'file'),
      },
    ],
  } as never;
};

/**
 * Phase 35: `read_media_file`, the last tool of the MCP reference filesystem
 * server that this runtime did not have.
 *
 * Reading a PNG as text tells a model nothing. This tool returns the file as
 * base64 with its MIME type **and** attaches it to the model call as a real
 * content part, so a vision-capable model can look at a screenshot, a diagram or
 * an icon — what the reference server's `read_media_file` does over MCP, and
 * what text-only `read_file` cannot do.
 *
 * Two deliberate deviations, both about not flooding a run:
 *   - `maxBytes` (default 10 MiB) refuses an oversized file with
 *     `FILE_TOO_LARGE` instead of pushing tens of megabytes into every
 *     following model call;
 *   - anything that is *not* an image or audio file is returned with its
 *     metadata (and base64) but is **not** attached to the model call
 *     (`attachedToModel: false`) — a 4 MB archive must not become part of the
 *     prompt. The model still sees the type, the size and the path.
 *
 * Everything else follows the reference: the same extension → MIME table, the
 * same read-through-a-stream base64 encoding, and path validation through the
 * ported core (a symlink out of the workspace is refused before any byte is
 * read).
 */
export function createReadMediaFileTool(projectRoot: string) {
  const allowed = [projectRoot];

  const readMediaFileTool: ReadMediaToolShape & {
    execute: (input: ReadMediaInput) => Promise<MediaOutcome>;
  } = {
    description:
      'Reads an image or audio file (png, jpg, gif, webp, bmp, svg, mp3, wav, ogg, flac) and ' +
      'returns it as base64 with its MIME type. Image and audio files are attached to the model ' +
      'call, so a vision model can actually look at the file. Other binaries are returned as ' +
      'metadata + base64 without being attached.',
    inputSchema,
    execute: async ({ path: requestedPath, maxBytes }) => {
      const limit = maxBytes ?? DEFAULT_MAX_BYTES;
      try {
        const validation = await resolvePathInWorkspace(requestedPath, allowed);
        if (!validation.safe) {
          return {
            success: false,
            error: validation.reason!,
            code: 'PATH_TRAVERSAL_BLOCKED',
          };
        }

        const resolved = validation.resolvedPath;
        const relative = path.relative(projectRoot, resolved) || '.';

        const stats = await fs.stat(resolved);
        if (stats.isDirectory()) {
          return {
            success: false,
            path: relative,
            error: `Path is a directory, not a file: ${relative}`,
            code: 'EISDIR',
          };
        }
        if (stats.size > limit) {
          return {
            success: false,
            path: relative,
            error:
              `File is ${stats.size} bytes, above the ${limit}-byte limit for a media read. ` +
              'Raise maxBytes deliberately (the payload goes into every following model call) ' +
              'or use get_file_info to inspect it instead.',
            code: 'FILE_TOO_LARGE',
          };
        }

        const mediaType = mediaTypeForFile(resolved);
        const kind: 'image' | 'audio' | 'binary' = mediaType.startsWith('image/')
          ? 'image'
          : mediaType.startsWith('audio/')
            ? 'audio'
            : 'binary';
        const base64 = await readFileAsBase64(resolved);

        return {
          success: true,
          path: relative,
          mediaType,
          kind,
          bytes: stats.size,
          base64,
          attachedToModel: kind !== 'binary',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: message,
          code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        };
      }
    },
    toModelOutput,
  };

  return tool(readMediaFileTool);
}
