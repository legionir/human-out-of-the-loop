import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Phase 43 — the MCP protocol layer: JSON-RPC 2.0 framing, the version
 * handshake, and the conversion of a zod tool schema into the JSON Schema an
 * MCP client expects.
 *
 * This file knows nothing about tools or transports; it is the vocabulary the
 * server and the CLI share.  The rules it encodes are the ones a client will
 * actually exercise:
 *
 *   - a request has an `id`, a notification does not, and a notification never
 *     gets a reply (answering one is a protocol violation that clients log);
 *   - an unparseable line is `-32700`, a non-JSON-RPC object is `-32600`, an
 *     unknown method or tool is `-32601`, bad parameters are `-32602`;
 *   - version negotiation is *ours* to answer: if the client asks for something
 *     we do not implement, the reply carries the version we do, and the client
 *     decides whether to continue.
 */

/** Protocol versions this server implements, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const MCP_DEFAULT_PROTOCOL_VERSION: McpProtocolVersion = '2025-06-18';

export const MCP_SERVER_NAME = 'human-out-of-the-loop';

/** JSON-RPC 2.0 error codes (plus MCP's `-32002` for an unknown resource). */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP: the resource does not exist. */
  resourceNotFound: -32002,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Is this a JSON-RPC *request* (something that must be answered)? */
export function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;
  if (typeof message.method !== 'string' || message.method === '') return false;
  // `id: null` is still a request per JSON-RPC; a *missing* id is a notification.
  return 'id' in message;
}

export type ParsedMessage =
  { ok: true; value: Record<string, unknown> } | { ok: false; response: JsonRpcResponse };

/**
 * Parse one protocol frame (a line on stdio, a body over HTTP).
 *
 * The error responses come back already built, because the id is unknown at
 * this point and JSON-RPC says it must be `null` — the client matches the
 * failure to the call by order.
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      ok: false,
      response: jsonRpcError(null, JSON_RPC_ERRORS.parseError, 'Empty message: nothing to parse.'),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      response: jsonRpcError(
        null,
        JSON_RPC_ERRORS.parseError,
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      ),
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      response: jsonRpcError(
        null,
        JSON_RPC_ERRORS.invalidRequest,
        'A JSON-RPC message must be an object.'
      ),
    };
  }
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return {
      ok: false,
      response: jsonRpcError(
        typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null,
        JSON_RPC_ERRORS.invalidRequest,
        'Not a JSON-RPC 2.0 request: expected { jsonrpc: "2.0", method, … }.'
      ),
    };
  }
  return { ok: true, value: message };
}

/**
 * Pick the version to answer with.
 *
 * MCP is explicit about this: the server replies with a version *it* supports.
 * If the client asked for one of ours, we agree to it; otherwise we answer with
 * the newest we have and let the client decide whether it can continue.
 */
export function negotiateProtocolVersion(requested: unknown): {
  version: McpProtocolVersion;
  supported: boolean;
} {
  if (
    typeof requested === 'string' &&
    (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return { version: requested as McpProtocolVersion, supported: true };
  }
  return { version: MCP_DEFAULT_PROTOCOL_VERSION, supported: false };
}

// ─── JSON Schema for tool inputs ─────────────────────────────────

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * The tool's own zod schema, as JSON Schema.
 *
 * This is the phase-43 rule "one source of truth, no redefinition": the same
 * `inputSchema` that the internal runtime validates against is what an MCP
 * client receives, so a client can never build a call the runtime would
 * reject for shape reasons — and adding a parameter cannot forget to update a
 * hand-written copy.
 */
export function toolInputJsonSchema(schema: unknown): JsonSchemaObject {
  try {
    // zod 4 is the single source of truth for every tool's input shape; this is
    // the same object the AI SDK validates with, so the two can never drift.
    const converted = z.toJSONSchema(schema as never, {
      target: 'draft-2020-12',
      io: 'input',
    }) as JsonSchemaObject;
    const result = { ...converted };
    // MCP requires an object schema for `inputSchema`; a tool whose input is
    // "nothing" still has to describe that.
    if (result.type === undefined && result.$ref === undefined) result.type = 'object';
    return result;
  } catch (err) {
    // A schema zod cannot convert must not take the whole `tools/list` down:
    // the tool is still callable by arguments, and the client is told the truth
    // (`{"type":"object"}` accepts anything).
    return {
      type: 'object',
      properties: {},
      'x-schema-error': err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── server identity ─────────────────────────────────────────────

/** The package version, read from `package.json` next to the built code. */
export function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'package.json'), // src/mcp → repo root
    path.join(here, '..', '..', '..', 'package.json'), // dist/src/mcp → repo root
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}
