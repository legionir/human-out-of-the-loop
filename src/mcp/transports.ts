import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import {
  JSON_RPC_ERRORS,
  jsonRpcError,
  jsonRpcResult,
  parseMessage,
  type JsonRpcResponse,
} from './protocol.js';
import type { McpServer } from './server.js';

/**
 * Phase 43 — the two transports.
 *
 * **stdio** is the default and the one every MCP client supports: one JSON-RPC
 * message per line on stdin, one response per line on stdout, and *nothing else
 * ever on stdout* — a stray `console.log` corrupts the stream, which is why the
 * banner a human sees goes to stderr and a parse failure is answered in-band.
 *
 * **HTTP** exists for clients that cannot spawn a process (a browser, a remote
 * editor). It binds `127.0.0.1` only and *requires* a bearer token: an MCP
 * server hands out filesystem and git access, so "no token" is not a valid
 * configuration and the flag refuses to start without one.
 */

export interface StdioServerOptions {
  input?: Readable;
  output?: Writable;
  /** Human-facing note (tool count, read-only, …). Always written to stderr. */
  banner?: string;
  /** Where the banner goes; defaults to `process.stderr`. */
  errorOutput?: Writable;
  onError?: (error: unknown) => void;
}

export interface StdioServerHandle {
  /** Resolves when the input stream ends (or is closed). */
  done: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Serve MCP over stdio.
 *
 * Lines are processed **in order**: a client may send `initialize` immediately
 * followed by `tools/list`, and answering the second first would break it. The
 * queue is a single promise chain, which is enough (the messages per second here
 * are human-scale) and needs no lock.
 */
export function serveStdio(server: McpServer, options: StdioServerOptions = {}): StdioServerHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let closed = false;
  let buffer = '';
  let queue: Promise<void> = Promise.resolve();

  if (options.banner) errorOutput.write(`${options.banner}\n`);

  const write = (line: string): void => {
    if (!closed) output.write(`${line}\n`);
  };

  const handleFrame = (frame: string): void => {
    queue = queue
      .then(async () => {
        try {
          const responses = await server.handleFrame(frame);
          for (const response of responses) write(response);
        } catch (err) {
          options.onError?.(err);
          write(
            JSON.stringify(
              jsonRpcError(
                null,
                JSON_RPC_ERRORS.internalError,
                err instanceof Error ? err.message : String(err)
              )
            )
          );
        }
      })
      .catch((err) => {
        options.onError?.(err);
      });
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (frame.trim() !== '') handleFrame(frame);
      index = buffer.indexOf('\n');
    }
  };

  const finish = (): void => {
    if (buffer.trim() !== '') {
      const leftover = buffer;
      buffer = '';
      handleFrame(leftover);
    }
  };

  const done = new Promise<void>((resolve) => {
    input.on('data', onData);
    input.on('end', () => {
      finish();
      queue.then(() => {
        closed = true;
        resolve();
      });
    });
    input.on('close', () => {
      finish();
      queue.then(() => {
        closed = true;
        resolve();
      });
    });
  });

  return {
    done,
    close: async () => {
      closed = true;
      input.removeAllListeners('data');
      await queue;
    },
  };
}

// ─── HTTP ────────────────────────────────────────────────────────

export interface HttpServerOptions {
  /** Bearer token a client must present. Required — there is no default. */
  token: string;
  port?: number;
  /** Fixed to loopback; exposed only so a test can bind an ephemeral port. */
  host?: string;
  /** `POST /mcp` by default. */
  path?: string;
  banner?: string;
  errorOutput?: Writable;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  app: Express;
  close: () => Promise<void>;
}

/**
 * Serve MCP over HTTP on loopback.
 *
 * One endpoint, `POST /mcp`, carrying a single JSON-RPC request — the same
 * messages stdio carries, so the server logic is shared. `GET /health` is the
 * only unauthenticated route, and it answers with nothing but "the process is
 * up", which is what a supervisor needs.
 */
export async function serveHttp(
  server: McpServer,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  if (!options.token || options.token.trim() === '') {
    throw new Error(
      'Refusing to serve MCP over HTTP without a bearer token: pass --token <t> (or HOTL_MCP_TOKEN).'
    );
  }
  const host = options.host ?? '127.0.0.1';
  const route = options.path ?? '/mcp';
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      server: server.serverName,
      version: server.serverVersion,
      tools: server.toolNames.length,
    });
  });

  const unauthorized = (res: Response): void => {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'Missing or invalid bearer token.' },
    });
  };

  app.post(route, async (req: Request, res: Response) => {
    const header = req.get('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (presented === '' || presented !== options.token) {
      unauthorized(res);
      return;
    }

    // The body is already parsed by express.json; a client that sends a string
    // body (a raw frame) is treated the same as a parsed object.
    const body: unknown = req.body;
    let message: Record<string, unknown>;
    if (typeof body === 'string') {
      const parsed = parseMessage(body);
      if (!parsed.ok) {
        res.status(400).json(parsed.response);
        return;
      }
      message = parsed.value;
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      message = body as Record<string, unknown>;
    } else {
      res
        .status(400)
        .json(
          jsonRpcError(
            null,
            JSON_RPC_ERRORS.parseError,
            'POST a JSON-RPC 2.0 request object to this endpoint.'
          )
        );
      return;
    }

    try {
      const response: JsonRpcResponse | null = await server.handle(message);
      // A notification has no response: 202 Accepted is the honest answer.
      if (response === null) {
        res.status(202).json(jsonRpcResult(null, {}));
        return;
      }
      res.json(response);
    } catch (err) {
      res
        .status(500)
        .json(
          jsonRpcError(
            null,
            JSON_RPC_ERRORS.internalError,
            err instanceof Error ? err.message : String(err)
          )
        );
    }
  });

  // `express.json()` rejects a malformed body with its own HTML error page;
  // this turns that into the JSON-RPC answer the client can actually read.
  app.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    const parseFailed =
      err instanceof Error &&
      ((err as { type?: string }).type === 'entity.parse.failed' || err.name === 'SyntaxError');
    if (!parseFailed) {
      next(err);
      return;
    }
    res
      .status(400)
      .json(jsonRpcError(null, JSON_RPC_ERRORS.parseError, `Invalid JSON: ${err.message}`));
  });

  const httpServer: Server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(options.port ?? 3300, host, () => resolve(listener));
    listener.on('error', reject);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 3300);
  const url = `http://${host}:${port}${route}`;
  if (options.banner) (options.errorOutput ?? process.stderr).write(`${options.banner}\n`);

  return {
    port,
    url,
    app,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
