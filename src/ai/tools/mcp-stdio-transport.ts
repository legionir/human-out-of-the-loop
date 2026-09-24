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
import { spawn, type ChildProcess } from 'node:child_process';
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

export function createStdioTransport(config: StdioTransportConfig): MCPTransport {
  let child: ChildProcess | undefined;
  let closed = false;

  const transport: MCPTransport = {
    async start(): Promise<void> {
      if (child) return;

      const proc = spawn(config.command, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: config.env ? { ...process.env, ...config.env } : process.env,
      });
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
          proc.kill('SIGKILL');
          done();
        }, CLOSE_GRACE_MS);
        proc.once('exit', done);
        proc.kill('SIGTERM');
      });

      if (!closed) {
        closed = true;
        transport.onclose?.();
      }
    },
  };

  return transport;
}
