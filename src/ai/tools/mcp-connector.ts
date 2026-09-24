import type { Tool } from 'ai';
import type { McpServerConfig, McpAuth } from '../schemas/mcp-server.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

// ─── Types ────────────────────────────────────────────────────────

export type McpServerStatus = 'connecting' | 'ready' | 'unavailable';

export interface McpServerState {
  config: McpServerConfig;
  status: McpServerStatus;
  /** Tool ids fetched from this server (with prefix applied) */
  toolIds: string[];
  /** Last error message (safe — never contains credentials) */
  lastError?: string;
  /** Client handle for cleanup; opaque type from AI SDK */
  client?: unknown;
}

export interface McpConnectorOptions {
  /** ToolRegistry to populate with fetched MCP tools */
  toolRegistry: ToolRegistry;
  /**
   * Optional injected MCP client factory — used by tests to avoid
   * real network calls.  Default: `experimental_createMCPClient` from AI SDK.
   */
  createClient?: (options: {
    transport: unknown;
    name: string;
  }) => Promise<{ tools: () => Promise<Record<string, Tool>>; close: () => Promise<void> }>;
  /**
   * Optional transport factory — used by tests.
   * Default: AI SDK's built-in HTTP/SSE/stdio transports.
   */
  createTransport?: (config: McpServerConfig) => unknown;
}

// ─── Credential resolution ───────────────────────────────────────

/**
 * Resolve credentials from environment variables.
 * Returns the auth headers to attach to MCP requests.
 * NEVER returns the raw config auth object (which itself only
 * contains env var *names*, not values — but this makes the split
 * explicit).
 */
function resolveAuthHeaders(auth: McpAuth, serverId: string): Record<string, string> {
  switch (auth.type) {
    case 'none':
      return {};

    case 'bearer': {
      const token = process.env[auth.tokenEnvVar];
      if (!token) {
        throw new Error(
          `[mcp:${serverId}] Environment variable "${auth.tokenEnvVar}" is not set (required for bearer auth).`
        );
      }
      return { Authorization: `Bearer ${token}` };
    }

    case 'api-key': {
      const key = process.env[auth.keyEnvVar];
      if (!key) {
        throw new Error(
          `[mcp:${serverId}] Environment variable "${auth.keyEnvVar}" is not set (required for api-key auth).`
        );
      }
      return { [auth.headerName]: key };
    }

    default: {
      // Exhaustiveness check
      const _exhaustive: never = auth;
      throw new Error(`[mcp] Unknown auth type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Sanitise an error message so credentials never leak into logs.
 * We strip any occurrence of the resolved credential values.
 */
function sanitiseError(err: unknown, credentials: Record<string, string>): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const value of Object.values(credentials)) {
    if (!value || value.length <= 4) continue;
    // Redact full header value
    msg = msg.split(value).join('***REDACTED***');
    // If it's a Bearer token, also redact the raw token part
    if (value.startsWith('Bearer ')) {
      const raw = value.slice('Bearer '.length);
      if (raw.length > 4) {
        msg = msg.split(raw).join('***REDACTED***');
      }
    }
    // For api-key or other cases, also redact substrings that might be the raw value alone
    // (already covered by full value, but we also handle if error contains raw without prefix)
    // Split by space and redact each token piece as extra safety.
    // Phase 20 (SEC-03): threshold lowered from 8 to 4 — a 5-8 char secret
    // fragment previously slipped through.
    const parts = value.split(/\s+/);
    for (const part of parts) {
      if (part.length > 4) {
        msg = msg.split(part).join('***REDACTED***');
      }
    }
  }
  return msg;
}

// ─── Default transport / client factories ────────────────────────

/**
 * Default transport factory.  Uses AI SDK's built-in transports.
 * Kept as a separate function so tests can override it.
 */
function defaultCreateTransport(config: McpServerConfig): unknown {
  const headers = resolveAuthHeaders(config.auth, config.id);

  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`[mcp:${config.id}] stdio transport requires "command" field.`);
    }
    // For now, stdio is not supported in this bootstrap without extra deps.
    // We return a descriptor that will fail gracefully if attempted.
    // In production, this would instantiate Experimental_StdioMCPTransport.
    throw new Error(
      `[mcp:${config.id}] stdio transport is not supported in this version — use http/sse or provide a custom createTransport.`
    );
  }

  // http / sse — use plain transport descriptor object accepted by
  // experimental_createMCPClient or @ai-sdk/mcp createMCPClient
  if (!config.url) {
    throw new Error(`[mcp:${config.id}] "${config.transport}" transport requires "url" field.`);
  }
  return {
    type: config.transport === 'sse' ? 'sse' : 'http',
    url: config.url,
    headers,
  };
}

/**
 * Phase 25 (LEAK-03): the MCP SDK is resolved through a memoized loader —
 * the dynamic `import()` used to run on EVERY connection attempt.  ESM
 * caches the module itself, but the promise/microtask per connect is now
 * avoided too (and a failed resolution is not cached, so a later attempt
 * can still succeed).
 */
let mcpSdkPromise: Promise<typeof import('@ai-sdk/mcp')> | null = null;

function loadMcpSdk(): Promise<typeof import('@ai-sdk/mcp')> {
  if (!mcpSdkPromise) {
    mcpSdkPromise = import('@ai-sdk/mcp').catch((err: unknown) => {
      mcpSdkPromise = null;
      throw err;
    });
  }
  return mcpSdkPromise;
}

async function defaultCreateClient(options: {
  transport: unknown;
  name: string;
}): Promise<{ tools: () => Promise<Record<string, Tool>>; close: () => Promise<void> }> {
  try {
    const { createMCPClient } = await loadMcpSdk();
    const client = await createMCPClient({
      transport: options.transport as never,
    } as never);
    return {
      tools: () => client.tools() as Promise<Record<string, Tool>>,
      close: () => client.close(),
    };
  } catch (err) {
    throw new Error(
      `[mcp] Failed to create MCP client — no compatible factory found. Original: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── McpConnector ────────────────────────────────────────────────

/**
 * Manages one or more MCP server connections and registers their
 * tools into the ToolRegistry.
 *
 * Key design decisions:
 *   - A failure on ONE server does NOT prevent others from loading.
 *   - Each server's status is tracked separately and queryable.
 *   - Tool ids may be prefixed to avoid collisions.
 *   - Credentials are read from env vars only, and stripped from
 *     any error messages that surface to the caller.
 */
export class McpConnector {
  private readonly toolRegistry: ToolRegistry;
  private readonly createTransport: (config: McpServerConfig) => unknown;
  private readonly createClient: NonNullable<McpConnectorOptions['createClient']>;
  private readonly servers = new Map<string, McpServerState>();

  constructor(options: McpConnectorOptions) {
    this.toolRegistry = options.toolRegistry;
    this.createTransport = options.createTransport ?? defaultCreateTransport;
    this.createClient = options.createClient ?? defaultCreateClient;
  }

  /**
   * Connect to a single MCP server and register its tools.
   *
   * Returns true on success, false on failure.  NEVER throws
   * (failure is captured in the server state).
   */
  async connectServer(config: McpServerConfig): Promise<boolean> {
    const state: McpServerState = {
      config,
      status: 'connecting',
      toolIds: [],
    };
    this.servers.set(config.id, state);

    // Capture credentials for sanitisation, then discard
    let credentials: Record<string, string> = {};
    try {
      credentials = resolveAuthHeaders(config.auth, config.id);
    } catch (err) {
      state.status = 'unavailable';
      state.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }

    // Phase 20 (LEAK-01): the timeout timer MUST be cleared when the
    // race settles, or every successful connection leaves a pending
    // timer that keeps the process alive.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      // Race the connection against the configured timeout
      const client = await Promise.race([
        this.createClient({
          transport: this.createTransport(config),
          name: config.id,
        }),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () =>
              reject(
                new Error(`Connection timeout after ${config.connectTimeoutMs}ms`)
              ),
            config.connectTimeoutMs
          );
        }),
      ]);

      state.client = client;

      // Fetch tools from the server
      const tools = await client.tools();

      // Register each tool into ToolRegistry with source="mcp"
      const registeredIds: string[] = [];
      for (const [rawId, tool] of Object.entries(tools)) {
        const finalId = config.toolPrefix ? `${config.toolPrefix}${rawId}` : rawId;

        // Skip if this id collides with an already-registered tool
        if (this.toolRegistry.hasDefinition(finalId)) {
          // Non-fatal: log and skip
          state.lastError = `Skipped tool "${finalId}" — id already registered`;
          continue;
        }

        this.toolRegistry.registerDefinition({
          id: finalId,
          name: (tool as { name?: string }).name ?? finalId,
          description:
            (tool as { description?: string }).description ?? `MCP tool from ${config.id}`,
          source: 'mcp',
          mcpServerId: config.id,
          category: 'mcp',
        });
        this.toolRegistry.registerImplementation(finalId, tool);
        registeredIds.push(finalId);
      }

      state.toolIds = registeredIds;
      state.status = 'ready';
      return true;
    } catch (err) {
      state.status = 'unavailable';
      state.lastError = sanitiseError(err, credentials);
      return false;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  /**
   * Connect to multiple servers in parallel.
   * Returns per-server results — one failed server does not block others.
   */
  async connectAll(
    configs: McpServerConfig[]
  ): Promise<Array<{ id: string; success: boolean; toolCount: number; error?: string }>> {
    const results = await Promise.all(
      configs.map(async (config) => {
        const success = await this.connectServer(config);
        const state = this.servers.get(config.id)!;
        return {
          id: config.id,
          success,
          toolCount: state.toolIds.length,
          error: success ? undefined : state.lastError,
        };
      })
    );
    return results;
  }

  /** Query the status of a specific server. */
  getServerState(id: string): McpServerState | undefined {
    return this.servers.get(id);
  }

  /** List all known servers with their current status. */
  listServers(): ReadonlyArray<McpServerState> {
    return Array.from(this.servers.values());
  }

  /**
   * Gracefully close all connections.  Safe to call multiple times.
   */
  async closeAll(): Promise<void> {
    const closures = Array.from(this.servers.values())
      .filter((s) => s.client)
      .map(async (s) => {
        try {
          await (s.client as { close: () => Promise<void> }).close();
        } catch {
          // Swallow — closing is best-effort
        }
      });
    await Promise.all(closures);
  }
}
