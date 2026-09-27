/**
 * A-01 / A-08 — web-server authentication and bind policy.
 *
 * The UI used to listen on `0.0.0.0` with no credential at all. MCP HTTP
 * (`serve --http`) already refuses that shape; the web server now follows
 * the same rule:
 *
 *   - default bind is loopback (`127.0.0.1`);
 *   - a non-loopback bind without a token is refused at startup;
 *   - when a token is configured, every `/api/*` route requires
 *     `Authorization: Bearer <token>` (401 otherwise);
 *   - a run/plan/session is bound to the presenting token so a second
 *     authenticated client cannot drive someone else's run (403).
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const DEFAULT_BIND_HOST = '127.0.0.1';

export interface AuthedRequest extends Request {
  authToken?: string;
}

/** Loopback names we treat as "not exposed to the network". */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === '::1' ||
    h === 'localhost' ||
    h === '::ffff:127.0.0.1' ||
    h === '[::1]'
  );
}

/** Split a token flag/env value into non-empty unique tokens. */
export function parseTokenList(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '' || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function resolveServerTokens(options: {
  token?: string;
  authTokens?: string[];
  env?: NodeJS.ProcessEnv;
} = {}): string[] {
  if (options.authTokens && options.authTokens.length > 0) {
    return parseTokenList(options.authTokens.join(','));
  }
  const env = options.env ?? process.env;
  const fromFlag = parseTokenList(options.token);
  if (fromFlag.length > 0) return fromFlag;
  return parseTokenList(env.HOTL_SERVER_TOKEN);
}

/**
 * Non-loopback bind without a token is a startup refusal, not a runtime
 * 401 — otherwise the port is already on the network.
 */
export function assertCanBind(host: string, tokens: readonly string[]): void {
  if (isLoopbackHost(host)) return;
  if (tokens.length > 0) return;
  throw new Error(
    `Refusing to bind the web server to ${host} without a token: ` +
      'pass --token <t> or set HOTL_SERVER_TOKEN. ' +
      'An unauthenticated non-loopback port can read and write the project.',
  );
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function tokenMatches(presented: string, allowed: readonly string[]): boolean {
  return allowed.some((token) => tokensEqual(token, presented));
}

export function presentedBearerToken(req: Request): string | undefined {
  const header = req.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token === '' ? undefined : token;
}

/**
 * `EventSource` cannot send headers, so the two SSE routes also accept the
 * token as `?access_token=` — GET only, and nowhere else, so a token never
 * rides on a state-changing request's URL.
 */
const QUERY_TOKEN_PATHS = [/^\/api\/stream\/[^/]+$/, /^\/api\/observability\/stream$/];

export function presentedQueryToken(req: Request): string | undefined {
  if (req.method !== 'GET') return undefined;
  if (!QUERY_TOKEN_PATHS.some((re) => re.test(req.path))) return undefined;
  const raw = req.query?.access_token;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function getAuthToken(req: Request): string | undefined {
  return (req as AuthedRequest).authToken;
}

/** Express middleware: 401 every `/api/*` route without a valid bearer token. */
export function createApiAuthMiddleware(tokens: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith('/api')) {
      next();
      return;
    }
    const presented = presentedBearerToken(req) ?? presentedQueryToken(req);
    if (!presented || !tokenMatches(presented, tokens)) {
      res.status(401).json({ error: 'Missing or invalid bearer token.' });
      return;
    }
    (req as AuthedRequest).authToken = presented;
    next();
  };
}

/**
 * True when this authenticated client does not own `ownerToken`.
 * Auth-off (no tokens configured) never 403s — there is only one user.
 */
export function isOwnerForbidden(
  authEnabled: boolean,
  presented: string | undefined,
  ownerToken: string | undefined,
): boolean {
  if (!authEnabled) return false;
  if (!presented || !ownerToken) return true;
  return !tokensEqual(presented, ownerToken);
}
