/**
 * Phase 30 (P6): a real stdio transport for MCP servers.
 *
 * The registry schema (`McpServerConfigSchema`), the CLI help and
 * `CONFIGURATION.md` all advertise `transport: "stdio"` with a `command`
 * field — but the runtime threw
 * `stdio transport is not supported in this version`, so every stdio
 * server (the most common kind: `npx @modelcontextprotocol/server-filesystem`,
 * local Python servers, …) was unusable.
 *
 * This implements the MCP stdio framing directly — newline-delimited
 * JSON-RPC 2.0 over the child's stdin/stdout — so no extra dependency is
 * needed (`@ai-sdk/mcp` does not ship a stdio transport).
 *
 * Spec details that matter here:
 *   - messages are delimited by `\n` and contain no embedded newlines;
 *   - **stdout is the protocol channel only** — server logs belong on
 *     stderr (we never forward either to the user: they may contain
 *     credentials);
 *   - the server may exit at any time; `onclose` must fire exactly once.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { JSONRPCMessage, MCPTransport, MCPTransportSendOptions } from '@ai-sdk/mcp';

export interface StdioTransportConfig {
  /** Executable to spawn (e.g. `node`, `python3`, `npx`). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Extra environment variables for the child (merged over process.env). */
  env?: Record<string, string | undefined>;
}

/** How long the child gets to exit after SIGTERM before SIGKILL. */
const CLOSE_GRACE_MS = 1000;

/** Windows needs a shell for `.cmd` shims and `taskkill` to kill a tree. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Environment variables the base allowlist keeps from the parent process
 * (R0-04). An MCP stdio server declared in `registry/mcp-servers` used to
 * inherit the *entire* `process.env` — including every API key, token or
 * secret the orchestrator's own process happened to have — even though the
 * server only ever asked for `config.env`. A server never needs more than
 * these to run at all; anything else must be named explicitly in its own
 * `env` block.
 */
const BASE_ENV_ALLOWLIST = [
  'PATH',
  'Path', // Windows env lookups are case-insensitive but the key case varies
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'APPDATA',
  'ComSpec',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const;

/** The base environment every stdio child gets, before `config.env`. */
export function baseChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/**
 * Spawn options for the child process (a pure function of the platform, so
 * the Windows decision is unit-testable from Linux).
 *
 * Phase 30 (P8): on Windows the classic stdio MCP servers are `npx …` /
 * `npm …` — `.cmd` shims that CreateProcess cannot execute directly, so
 * spawning them without a shell fails with ENOENT.  Command and args come
 * from the user's own registry file, never from model output.
 *
 * R0-04: the child's environment is the base allowlist plus whatever the
 * server's own config declares — never the orchestrator's full
 * `process.env`, so a compromised or merely careless server config cannot
 * exfiltrate secrets it was never given.
 */
export function stdioSpawnOptions(
  platform: NodeJS.Platform,
  env?: Record<string, string | undefined>
): SpawnOptions {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...baseChildEnv(), ...env },
    ...(platform === 'win32' ? { shell: true } : {}),
  };
}

/**
 * Terminate the child (and, on Windows, the process tree).
 *
 * `child.kill()` only signals the process we spawned.  With `shell: true`
 * (required on Windows for `npx`/`npm` shims) the real MCP server is a
 * GRANDCHILD, so a plain signal leaves it running — `taskkill /T` is the
 * documented way to take the whole tree down.
 */
function terminate(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (IS_WINDOWS && proc.pid !== undefined) {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to the plain signal below
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Best-effort: the child may already be gone.
  }
}

export function createStdioTransport(config: StdioTransportConfig): MCPTransport {
  let child: ChildProcess | undefined;
  let closed = false;

  const transport: MCPTransport = {
    async start(): Promise<void> {
      if (child) return;

      const proc = spawn(
        config.command,
        config.args ?? [],
        stdioSpawnOptions(process.platform, config.env)
      );
      child = proc;
      closed = false;

      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          proc.removeListener('error', onError);
          resolve();
        };
        const onError = (err: Error): void => {
          proc.removeListener('spawn', onSpawn);
          child = undefined;
          reject(err);
        };
        proc.once('spawn', onSpawn);
        proc.once('error', onError);
      });

      // ── stdout: newline-delimited JSON-RPC ──────────────────────
      let buffer = '';
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: JSONRPCMessage;
          try {
            message = JSON.parse(line) as JSONRPCMessage;
          } catch {
            // Not protocol traffic (a stray log line on stdout) — ignore
            // rather than killing the connection.
            continue;
          }
          transport.onmessage?.(message);
        }
      });

      // ── stderr: never forwarded (may contain secrets) ───────────
      proc.stderr?.resume();

      // A child that dies under us makes stdin writes fail with EPIPE.
      // Node emits 'error' on the socket stream as well, and an unheard
      // 'error' event is thrown — it crashed the whole CLI.  The write
      // callback below still rejects the pending `send()`.
      proc.stdin?.on('error', (err: Error) => transport.onerror?.(err));
      proc.stdout?.on('error', (err: Error) => transport.onerror?.(err));

      proc.on('error', (err: Error) => transport.onerror?.(err));
      proc.on('exit', () => {
        child = undefined;
        if (!closed) {
          closed = true;
          transport.onclose?.();
        }
      });
    },

    async send(message: JSONRPCMessage, _options?: MCPTransportSendOptions): Promise<void> {
      const proc = child;
      if (!proc || proc.exitCode !== null || proc.stdin === null || !proc.stdin.writable) {
        throw new Error('[mcp:stdio] transport is not connected');
      }
      const line = JSON.stringify(message) + '\n';
      const stdin = proc.stdin;
      await new Promise<void>((resolve, reject) => {
        try {
          stdin.write(line, (err) => (err ? reject(err) : resolve()));
        } catch (err) {
          // The child vanished between the checks above and this write.
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    async close(_options?): Promise<void> {
      const proc = child;
      child = undefined;
      if (!proc || proc.exitCode !== null) {
        if (!closed) {
          closed = true;
          transport.onclose?.();
        }
        return;
      }

      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(killTimer);
          resolve();
        };
        const killTimer = setTimeout(() => {
          terminate(proc, 'SIGKILL');
          done();
        }, CLOSE_GRACE_MS);
        proc.once('exit', done);
        terminate(proc, 'SIGTERM');
      });

      if (!closed) {
        closed = true;
        transport.onclose?.();
      }
    },
  };

  return transport;
}
