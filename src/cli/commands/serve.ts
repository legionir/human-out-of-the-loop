/**
 * Phase 43 — `hootl serve --mcp`.
 *
 *   human-out-of-the-loop serve --mcp [--project-root DIR]
 *     [--http [--port 3300] --token <t>] [--read-only] [--allow-tools a,b] [--prefix m]
 *
 * This is the reverse of `hootl mcp list`: instead of consuming other servers'
 * tools, the runtime *becomes* an MCP server, so Claude Desktop, Cursor or any
 * other client can use the same 45 local tools the agent uses — through the
 * same sandboxed, journalled execution path.
 *
 * Defaults are the ones a careful person would pick:
 *   - transport: **stdio** (what MCP clients spawn), and stdout is *only*
 *     protocol — the banner goes to stderr;
 *   - `--http` binds **127.0.0.1** and refuses to start without a bearer token;
 *   - `--read-only` exposes only tools that cannot change anything;
 *   - `--allow-tools` narrows further (both filters apply to `tools/list` and
 *     `tools/call`).
 */
import path from 'node:path';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out } from '../utils/output.js';
import { McpServer } from '../../mcp/server.js';
import { serveHttp, serveStdio } from '../../mcp/transports.js';
import { LOCAL_TOOL_IDS } from '../../ai/tools/local-tools.js';

export interface ServeCommandOptions {
  projectRoot?: string;
  /** `--mcp` — required; this command exists to serve MCP. */
  mcp?: boolean;
  http?: boolean;
  port?: number;
  token?: string;
  readOnly?: boolean;
  /** Comma-separated list of local tool ids. */
  allowTools?: string;
  prefix?: string;
}

/**
 * Split `a,b , c` into trimmed ids. `--allow-tools` with no value, an empty
 * string, or only commas is a usage error (R0-06) — it must never be
 * silently treated as "no restriction" and open every tool.
 */
export function parseAllowTools(value: string | undefined): string[] {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) {
    throw new Error(
      '--allow-tools requires at least one tool id (got an empty value); omit the flag entirely to allow every tool.'
    );
  }
  return ids;
}

/** Throws with the full list of valid ids if any of `ids` is unknown. */
export function validateAllowTools(ids: string[], validIds: readonly string[] = LOCAL_TOOL_IDS): void {
  const valid = new Set(validIds);
  const unknown = ids.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `--allow-tools has unknown tool id(s): ${unknown.join(', ')}. Valid ids: ${[...valid].sort().join(', ')}.`
    );
  }
}

/**
 * The bearer token for HTTP mode: `--token`, else `HOTL_MCP_TOKEN`, else nothing
 * — and nothing is a refusal, not a default.
 */
export function resolveToken(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = env.HOTL_MCP_TOKEN?.trim();
  return fromEnv && fromEnv !== '' ? fromEnv : undefined;
}

export async function serveCommand(options: ServeCommandOptions): Promise<number> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);

  if (options.mcp !== true) {
    err(
      `\`${'serve'}\` currently serves MCP only — add --mcp (see \`--help\`). ` +
        'Exposing this runtime over plain HTTP is not part of this release.'
    );
    return 2;
  }

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  ) {
    err(`--port must be an integer between 0 and 65535 (got ${options.port}).`);
    return 2;
  }

  const token = resolveToken(options.token);
  if (options.http === true && !token) {
    err(
      'Refusing to serve MCP over HTTP without a token: pass --token <t> or set HOTL_MCP_TOKEN. ' +
        'This endpoint can read and write files in the project, so an unauthenticated port is not an option.'
    );
    return 2;
  }

  let allowTools: string[] | undefined;
  if (options.allowTools !== undefined) {
    try {
      allowTools = parseAllowTools(options.allowTools);
      validateAllowTools(allowTools);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  let server: McpServer;
  try {
    server = new McpServer({
      projectRoot,
      readOnly: options.readOnly === true,
      ...(allowTools ? { allowTools } : {}),
      ...(options.prefix !== undefined && options.prefix !== '' ? { prefix: options.prefix } : {}),
      // The token is a transport secret, never something the journal should
      // keep: it is redacted by value like every other credential.
      // The bearer token is a transport secret: handed to the server's
      // environment so the Journal redacts it by value, never written anywhere.
      env: token ? { ...process.env, HOTL_MCP_TOKEN: token } : process.env,
    });
  } catch (error) {
    err(
      `Could not start the MCP server: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }

  const summary =
    `${server.toolNames.length} tools` +
    `${options.readOnly === true ? ' (read-only)' : ''}` +
    `${allowTools ? ` (allow-tools: ${allowTools.join(',')})` : ''}` +
    `${options.prefix ? ` (prefix: ${options.prefix}_)` : ''}`;

  if (options.http === true) {
    const handle = await serveHttp(server, {
      token: token!,
      ...(options.port !== undefined ? { port: options.port } : {}),
      banner: `${color.dim('MCP server on')} ${color.bold(`http://127.0.0.1:${options.port ?? 3300}/mcp`)} ${color.dim(`— ${summary}, bearer token required`)}`,
    });
    out(`Listening on ${handle.url} (${summary}). Press Ctrl-C to stop.`);
    await waitForSignal(handle.close);
    await server.close();
    out('MCP server stopped.');
    return 0;
  }

  const handle = serveStdio(server, {
    banner: '', // stderr banner below; stdout must stay pure protocol
  });
  process.stderr.write(
    `${color.dim('MCP server on')} ${color.bold('stdio')} ${color.dim(`— ${summary}; waiting for a client`)}\n`
  );
  await handle.done;
  await server.close();
  return 0;
}

/** Resolve when the user interrupts (Ctrl-C) or the process is terminated. */
function waitForSignal(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      close()
        .catch(() => undefined)
        .then(() => resolve());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
