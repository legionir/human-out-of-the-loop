import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from 'ai';
import { JournalWriter, journalOptionsFromEnv, withJournal } from '../ai/runtime/journal.js';
import { collectSecretValues } from '../ai/runtime/secret-scrub.js';
import { FilePlanStore } from '../ai/runtime/plan-store.js';
import { createLocalTools, LOCAL_TOOL_IDS } from '../ai/tools/local-tools.js';
import {
  JSON_RPC_ERRORS,
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  isRequest,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  packageVersion,
  parseMessage,
  toolInputJsonSchema,
  type JsonRpcId,
  type JsonRpcResponse,
} from './protocol.js';

/**
 * Phase 43 — this runtime, exposed *as* an MCP server.
 *
 * Until now the relationship ran one way: `McpConnector` pulls other servers'
 * tools in.  This is the mirror image — any MCP client (Claude Desktop, Cursor,
 * an IDE) can list and call the same 45 local tools, over stdio or over HTTP.
 *
 * Three properties are the whole design:
 *
 *   1. **One execution path.** A `tools/call` reaches the very same tool object
 *      the agent runtime uses — the same workspace sandbox, the same argument
 *      validation, the same structured `{ success: false, code }` results. There
 *      is no second, looser implementation for external callers.
 *   2. **Audited from outside too.** Calls are wrapped by `withJournal`, so an
 *      MCP client's edit lands in `<project>/.ai-runtime/journal/` exactly like
 *      the agent's own — `agentId: "mcp"` marks where it came from. A tool that
 *      ran without leaving a journal line would be the bug.
 *   3. **Least privilege is a flag, not a hope.** `--read-only` exposes only
 *      tools that cannot change anything, and `--allow-tools` narrows further;
 *      both filter `tools/list` *and* `tools/call`, because a client that
 *      ignored the listing must not be able to call what it never saw.
 */

export interface McpServerOptions {
  projectRoot: string;
  /** Expose only tools that cannot write (a whitelist, see `isReadOnlyTool`). */
  readOnly?: boolean;
  /** Expose only these local tool ids (before any prefix is applied). */
  allowTools?: readonly string[];
  /** Name tools `"<prefix>_<id>"` — for clients that merge several servers. */
  prefix?: string;
  /** Tool set to expose; defaults to every local tool bound to `projectRoot`. */
  tools?: Record<string, Tool>;
  /** Journal to write tool calls to; `null` disables it, `undefined` = default. */
  journal?: JournalWriter | null;
  env?: NodeJS.ProcessEnv;
  name?: string;
  version?: string;
  /** Names the caller in journal entries (`agentId`). */
  clientId?: string;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

interface ExposedTool {
  /** The name a client sees (prefix applied). */
  exposed: string;
  /** The local id the runtime knows. */
  local: string;
  tool: Tool;
}

import { isReadOnlyTool, readOnlyToolIds } from '../ai/tools/read-only.js';

// The read-only rule itself lives with the tools (`src/ai/tools/read-only.ts`)
// because chat mode uses it too; re-exported here so `--read-only` consumers and
// the phase-43 tests keep importing it from the server module they know.
export {
  isReadOnlyTool,
  readOnlyToolIds,
  READ_ONLY_IDS,
  READ_ONLY_PREFIXES,
} from '../ai/tools/read-only.js';

export class McpServer {
  readonly projectRoot: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly readOnly: boolean;
  readonly prefix: string;
  readonly journal: JournalWriter | null;
  /** Names, as a client sees them, of the exposed tools. */
  readonly toolNames: string[];
  private readonly exposed: Map<string, ExposedTool>;
  private readonly localOrder: string[];

  constructor(options: McpServerOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverName = options.name ?? MCP_SERVER_NAME;
    this.serverVersion = options.version ?? packageVersion();
    this.readOnly = options.readOnly === true;
    this.prefix = (options.prefix ?? '').trim().replace(/_+$/, '');

    const env = options.env ?? process.env;
    const base = options.tools ?? createLocalTools(this.projectRoot);
    const allowed = options.allowTools ? new Set(options.allowTools) : undefined;

    this.localOrder = Object.keys(base).filter((id) => {
      if (this.readOnly && !isReadOnlyTool(id)) return false;
      if (allowed && !allowed.has(id)) return false;
      return true;
    });

    const journal =
      options.journal !== undefined
        ? options.journal
        : new JournalWriter({
            runtimeDir: path.join(this.projectRoot, '.ai-runtime'),
            ...journalOptionsFromEnv(env),
            redactValues: collectSecretValues(env),
          });
    this.journal = journal;

    // The same tools the agent uses, wrapped so an external call is audited.
    const wrapped = withJournal(
      base,
      {
        agentId: options.clientId ?? 'mcp',
        taskId: 'mcp-server',
      },
      journal
    );

    this.exposed = new Map();
    for (const local of this.localOrder) {
      const tool = (wrapped as Record<string, Tool>)[local];
      if (!tool) continue;
      const exposedName = this.prefix === '' ? local : `${this.prefix}_${local}`;
      this.exposed.set(exposedName, { exposed: exposedName, local, tool });
    }
    this.toolNames = [...this.exposed.keys()];
  }

  /** `tools/list` — the catalog, with each tool's real JSON Schema. */
  listTools(): McpToolDefinition[] {
    return this.localOrder.flatMap((local) => {
      const entry = this.exposed.get(this.prefix === '' ? local : `${this.prefix}_${local}`);
      if (!entry) return [];
      const tool = entry.tool as Tool & { description?: string; title?: string };
      return [
        {
          name: entry.exposed,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description ?? '',
          inputSchema: toolInputJsonSchema(
            (tool as { inputSchema?: unknown }).inputSchema
          ) as Record<string, unknown>,
          // Read-only tools say so, which is what lets a client mark them safe
          // to auto-approve without trusting the server's word for the rest.
          annotations: {
            readOnlyHint: isReadOnlyTool(local),
            destructiveHint: !isReadOnlyTool(local),
            ...(entry.exposed === local ? {} : { 'x-local-name': local }),
          },
        },
      ];
    });
  }

  /** The resources this server publishes: plan, journal, memory — all reads. */
  listResources(): McpResource[] {
    return [
      {
        uri: 'plan://{id}',
        name: 'Plan',
        description: 'A persisted plan (id from `hootl plans list`), as JSON.',
        mimeType: 'application/json',
      },
      {
        uri: 'journal://{YYYY-MM-DD}',
        name: 'Journal',
        description:
          'One day of the Journal — every tool call the AI or an MCP client made, as JSONL.',
        mimeType: 'application/x-ndjson',
      },
      {
        uri: 'memory://graph',
        name: 'Project memory',
        description: 'The project-scoped knowledge graph.',
        mimeType: 'application/json',
      },
    ];
  }

  /**
   * `resources/read`.
   *
   * Every uri is validated against a shape, not concatenated into a path: an id
   * of `../../etc/passwd` is refused before it is looked up, so a resource read
   * cannot become a file read outside the project.
   */
  readResource(uri: string): McpResourceContents {
    const fail = (message: string): never => {
      throw new McpResourceError(message);
    };
    if (uri === 'memory://graph') {
      const file = path.join(this.projectRoot, '.ai-runtime', 'memory.json');
      if (!fs.existsSync(file)) {
        return {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ entities: [], relations: [] }),
        };
      }
      return { uri, mimeType: 'application/json', text: fs.readFileSync(file, 'utf-8') };
    }

    const planMatch = /^plan:\/\/(?:\/)?([^/?#]+)$/.exec(uri);
    if (planMatch) {
      const id = planMatch[1]!;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id))
        fail(`"${id}" is not a plan id (letters, digits, . _ - only).`);
      const store = new FilePlanStore(path.join(this.projectRoot, '.ai-runtime', 'plans'));
      const plan = store.load(id);
      if (!plan) fail(`No plan with id "${id}" in this project (see \`hootl plans list\`).`);
      return { uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) };
    }

    const journalMatch = /^journal:\/\/(?:\/)?([^/?#]+)$/.exec(uri);
    if (journalMatch) {
      const day = journalMatch[1]!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`"${day}" is not a journal day (YYYY-MM-DD).`);
      const file = path.join(this.projectRoot, '.ai-runtime', 'journal', `${day}.jsonl`);
      if (!fs.existsSync(file)) fail(`No journal entries for ${day}.`);
      return { uri, mimeType: 'application/x-ndjson', text: fs.readFileSync(file, 'utf-8') };
    }

    return fail(
      `Unknown resource "${uri}". Known: plan://{id}, journal://{YYYY-MM-DD}, memory://graph.`
    );
  }

  /** `tools/call` — validate, execute through the runtime's own path, wrap. */
  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    const entry = this.exposed.get(name);
    if (!entry) {
      const visible = this.toolNames.slice(0, 8).join(', ');
      throw new McpToolError(
        JSON_RPC_ERRORS.methodNotFound,
        `Unknown tool "${name}". This server exposes ${this.toolNames.length} tools: ${visible}${this.toolNames.length > 8 ? ', …' : ''}`
      );
    }

    const tool = entry.tool as Tool & {
      execute?: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const schema = (tool as { inputSchema?: { safeParse?: (value: unknown) => unknown } })
      .inputSchema;
    let input: unknown = args ?? {};

    // The tool's own schema validates the call, exactly as it does inside the
    // runtime — an external client gets the same `-32602` the model would get an
    // error for.
    if (schema && typeof schema.safeParse === 'function') {
      const parsed = schema.safeParse(input) as
        | { success: true; data: unknown }
        | {
            success: false;
            error: { issues: Array<{ path: Array<string | number>; message: string }> };
          };
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new McpToolError(
          JSON_RPC_ERRORS.invalidParams,
          `Invalid arguments for "${name}" — ${issues}`
        );
      }
      input = parsed.data;
    }

    if (typeof tool.execute !== 'function') {
      throw new McpToolError(
        JSON_RPC_ERRORS.internalError,
        `Tool "${name}" has no execute function.`
      );
    }

    let output: unknown;
    try {
      output = await tool.execute(input, { toolCallId: `mcp-${Date.now().toString(36)}` });
    } catch (err) {
      // A tool that throws is a server-side bug; report it as a *tool* failure
      // so the client sees the message in-band rather than as a protocol error.
      return {
        content: [
          {
            type: 'text',
            text: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    const record =
      output && typeof output === 'object'
        ? (output as Record<string, unknown>)
        : { result: output };
    const failed = record.success === false || typeof record.error === 'string';
    const text = failed
      ? `Tool "${name}" failed${record.code ? ` (${String(record.code)})` : ''}: ${String(record.error ?? 'unknown error')}`
      : JSON.stringify(record, null, 2);

    return {
      content: [{ type: 'text', text }],
      structuredContent: record,
      ...(failed ? { isError: true } : {}),
    };
  }

  // ─── JSON-RPC dispatch ─────────────────────────────────────────

  /**
   * Handle one parsed message.
   *
   * Returns `null` for notifications (a reply to one is a protocol violation).
   */
  async handle(message: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    const id = (
      typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
    ) as JsonRpcId;
    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;
    const wantsReply = isRequest(message);

    switch (method) {
      // Notifications: no reply, whatever happens.
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return null;

      case 'initialize': {
        const { version, supported } = negotiateProtocolVersion(params.protocolVersion);
        return jsonRpcResult(id, {
          protocolVersion: version,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { name: this.serverName, version: this.serverVersion },
          instructions: this.instructions(supported),
        });
      }

      case 'ping':
        return jsonRpcResult(id, {});

      case 'tools/list':
        return jsonRpcResult(id, { tools: this.listTools() });

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (name === '') {
          return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, '`tools/call` needs a tool name.');
        }
        try {
          const result = await this.callTool(name, params.arguments ?? {});
          return jsonRpcResult(id, result);
        } catch (err) {
          if (err instanceof McpToolError) return jsonRpcError(id, err.code, err.message);
          return jsonRpcError(
            id,
            JSON_RPC_ERRORS.internalError,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      case 'resources/list':
        return jsonRpcResult(id, { resources: this.listResources() });

      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (uri === '') {
          return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, '`resources/read` needs a uri.');
        }
        try {
          const contents = this.readResource(uri);
          return jsonRpcResult(id, { contents: [contents] });
        } catch (err) {
          if (err instanceof McpResourceError) {
            return jsonRpcError(id, JSON_RPC_ERRORS.resourceNotFound, err.message);
          }
          return jsonRpcError(
            id,
            JSON_RPC_ERRORS.internalError,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      case 'prompts/list':
        // We expose no prompts; answering with an empty list is friendlier than
        // an error, and it is what the spec allows.
        return jsonRpcResult(id, { prompts: [] });

      default:
        if (!wantsReply) return null;
        return jsonRpcError(
          id,
          JSON_RPC_ERRORS.methodNotFound,
          `Unknown method "${method}". Supported: initialize, ping, tools/list, tools/call, resources/list, resources/read.`
        );
    }
  }

  /** Handle one wire frame (a stdio line): parse, dispatch, serialise. */
  async handleFrame(frame: string): Promise<string[]> {
    const parsed = parseMessage(frame);
    if (!parsed.ok) return [JSON.stringify(parsed.response)];
    const response = await this.handle(parsed.value);
    return response === null ? [] : [JSON.stringify(response)];
  }

  async close(): Promise<void> {
    // Nothing to release: the journal writer keeps a file descriptor that is
    // reopened on demand, and `JournalWriter.log` is synchronous.
    return Promise.resolve();
  }

  /** The `instructions` field a client shows its model — the security note. */
  private instructions(supported: boolean): string {
    const lines = [
      `Tools from the human-out-of-the-loop runtime, bound to the project at ${this.projectRoot}.`,
      'Every call is sandboxed to that project and recorded in its Journal (.ai-runtime/journal).',
    ];
    if (this.readOnly) {
      lines.push('This server runs READ-ONLY: only tools that cannot change anything are exposed.');
    } else {
      lines.push(
        'Write tools are exposed: file writes, git commits and pushes. Git protects main/master, and anything irreversible needs explicit confirmation.',
        'Access is scoped to this project only; run with --read-only to expose just the reading tools.'
      );
    }
    if (!supported) {
      lines.push(
        `Requested protocol version is not implemented; answering as ${MCP_DEFAULT_PROTOCOL_VERSION}.`
      );
    }
    return lines.join('\n');
  }
}

/** An error that maps to a JSON-RPC error code. */
export class McpToolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

/** A bad resource uri (MCP's own `-32002`). */
export class McpResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpResourceError';
  }
}

export function createMcpServer(options: McpServerOptions): McpServer {
  return new McpServer(options);
}
