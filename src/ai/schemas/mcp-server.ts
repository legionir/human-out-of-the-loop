import { z } from 'zod';

/**
 * MCP Server configuration schema.
 *
 * Loaded from `registry/mcp-servers/*.json`.  Credentials are NEVER
 * stored inline — they are referenced by environment variable name
 * so that the raw value never appears in JSON, logs, or compact events.
 *
 * Transport types mirror the MCP spec:
 *   - "http" / "sse": remote server accessed via HTTP(S)
 *   - "stdio":        local process spawned as a child
 */
export const McpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    /** Name of the env var holding the bearer token (NOT the token itself) */
    tokenEnvVar: z.string().min(1),
  }),
  z.object({
    type: z.literal('api-key'),
    /** Name of the env var holding the API key */
    keyEnvVar: z.string().min(1),
    /** HTTP header name to send the key in (e.g. "x-api-key") */
    headerName: z.string().min(1).default('x-api-key'),
  }),
]);

export const McpServerConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(['http', 'sse', 'stdio']).default('http'),
  /** URL for http/sse transports */
  url: z.string().url().optional(),
  /** Command + args for stdio transport */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  auth: McpAuthSchema.default({ type: 'none' }),
  /** Optional tool-id prefix to avoid collisions between servers */
  toolPrefix: z.string().optional(),
  /** Startup timeout in ms — server marked unavailable if not ready in time */
  connectTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpAuth = z.infer<typeof McpAuthSchema>;
