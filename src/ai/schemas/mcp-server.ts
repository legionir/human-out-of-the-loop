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
 *
 * A-06: `env` is extra environment for a stdio child (merged over the
 * R0-04 allowlist in `createStdioTransport`). A-07: http/sse URLs must
 * be http(s), and credential env-var names must look like env vars.
 */

/** POSIX-ish env var name: letters, digits, underscore; not starting with a digit. */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const McpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    /** Name of the env var holding the bearer token (NOT the token itself) */
    tokenEnvVar: z.string().regex(ENV_VAR_NAME, 'tokenEnvVar must be a valid environment variable name'),
  }),
  z.object({
    type: z.literal('api-key'),
    /** Name of the env var holding the API key */
    keyEnvVar: z.string().regex(ENV_VAR_NAME, 'keyEnvVar must be a valid environment variable name'),
    /** HTTP header name to send the key in (e.g. "x-api-key") */
    headerName: z.string().min(1).default('x-api-key'),
  }),
]);

export const McpServerConfigSchema = z
  .object({
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
    /**
     * Extra environment variables for a stdio child. Merged over the
     * R0-04 base allowlist — never a substitute for `tokenEnvVar`.
     */
    env: z.record(z.string().regex(ENV_VAR_NAME), z.string()).optional(),
    /** Optional tool-id prefix to avoid collisions between servers */
    toolPrefix: z.string().optional(),
    /** Startup timeout in ms — server marked unavailable if not ready in time */
    connectTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  })
  .superRefine((val, ctx) => {
    if (val.transport !== 'http' && val.transport !== 'sse') return;
    if (!val.url) return;
    let parsed: URL;
    try {
      parsed = new URL(val.url);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url must be a valid URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: `${val.transport} transport only allows http: or https: URLs (got ${parsed.protocol})`,
      });
    }
  });

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpAuth = z.infer<typeof McpAuthSchema>;
