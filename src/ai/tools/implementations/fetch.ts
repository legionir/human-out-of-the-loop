import { tool, type Tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { packageRoot } from '../../registries/layout.js';
import { htmlToMarkdown } from '../net/html-to-markdown.js';
import { RobotsCache, parseRobotsTxt, robotsAllows } from '../net/robots.js';
import { checkUrlSafety, type UrlSafetyResult } from '../net/url-safety.js';

/**
 * Phase 40 — `fetch`, ported from the reference `fetch` server.
 *
 * What the reference gives the model: a URL in, readable content out, with a
 * `max_length` / `start_index` window so a long page can be paged, and `raw` for
 * the times when the HTML itself is the answer. What a *coding agent* needs on
 * top of that is judgement about *what it is allowed to ask for* — because the
 * URL does not come from a human at a keyboard, it comes from the model's
 * context, and that context is full of files and pages a stranger wrote.
 *
 * Four deliberate differences from the reference, all documented in the result:
 *
 *   1. **SSRF defence.** Loopback, private, link-local, CGNAT and reserved
 *      addresses are refused *by default* (`allowPrivate: true` is the explicit
 *      human override). The check runs on the resolved IP, and again on every
 *      redirect hop — a public URL that 302s to `10.0.0.5` is still a request to
 *      `10.0.0.5`.
 *   2. **Bounded everything.** 10 s per request, ≤ 5 redirects, ≤ 2 MB read
 *      from the wire (the stream is cancelled at the cap, not read and then
 *      discarded), ≤ 100 000 characters returned.
 *   3. **No credentials, ever.** One header set for every request: our own
 *      User-Agent and a plain `Accept`. Nothing from the environment is
 *      forwarded, so a fetch can never carry a token somewhere by accident.
 *   4. **Robots before the request.** The reference checks robots.txt too; here
 *      a robots.txt that cannot be *read* (5xx, network error) is a refusal
 *      rather than a silent allow — "we could not find out whether we are
 *      welcome" is not permission. `respectRobots: false` is the documented
 *      override.
 */

/** Time allowed for one HTTP request (the reference uses 30 s). */
export const FETCH_TIMEOUT_MS = 10_000;
/** Time allowed for the robots.txt request of one host. */
export const ROBOTS_TIMEOUT_MS = 5_000;
/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;
/** Bytes read from the wire before the body is cancelled. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Largest `maxLength` a caller may ask for. */
export const MAX_CONTENT_CHARS = 100_000;
/** robots.txt above this size is not parsed (nobody writes one this big). */
export const MAX_ROBOTS_BYTES = 512 * 1024;

const DEFAULT_MAX_LENGTH = 5000;

function userAgent(): string {
  try {
    const root = packageRoot();
    if (root) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
        version?: string;
      };
      if (manifest.version) return `human-out-of-the-loop/${manifest.version}`;
    }
  } catch {
    // A missing or unreadable manifest must not break fetching.
  }
  return 'human-out-of-the-loop';
}

const inputSchema = z.object({
  url: z.string().min(1).describe('Absolute http(s) URL to read, e.g. "https://example.com/docs".'),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTENT_CHARS)
    .default(DEFAULT_MAX_LENGTH)
    .describe(`Characters to return (default ${DEFAULT_MAX_LENGTH}, max ${MAX_CONTENT_CHARS}).`),
  startIndex: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset to start from — use nextStartIndex from a truncated result.'),
  raw: z
    .boolean()
    .default(false)
    .describe(
      'Return the raw HTML instead of Markdown (for markup that matters: structured data, meta tags).'
    ),
  respectRobots: z
    .boolean()
    .default(true)
    .describe(
      'Honour robots.txt (default true). Set false only when the user asked for this exact page.'
    ),
  allowPrivate: z
    .boolean()
    .default(false)
    .describe(
      'Allow loopback/private/link-local addresses (default false: blocked, because URLs can come from untrusted content).'
    ),
});

export interface FetchRobotsInfo {
  checked: boolean;
  allowed: boolean;
  /** The robots.txt URL consulted. */
  url?: string;
  status?: number;
  /** The rule that decided, e.g. `Disallow: /private`. */
  rule?: string;
  cached?: boolean;
}

export interface FetchOutcome {
  success: boolean;
  url?: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  /** `<title>` of an HTML page (Markdown mode). */
  title?: string;
  content?: string;
  /** True when `raw` was requested and honoured. */
  raw?: boolean;
  totalChars?: number;
  startIndex?: number;
  truncated?: boolean;
  nextStartIndex?: number;
  remainingChars?: number;
  redirects?: number;
  bytesRead?: number;
  /** Content type was not text — metadata only, body not downloaded. */
  unsupportedContentType?: boolean;
  robots?: FetchRobotsInfo;
  /** Set when `allowPrivate` was used, so the caller sees the exception. */
  privateAllowed?: boolean;
  error?: string;
  code?: string;
}

type FetchInput = {
  url: string;
  maxLength: number;
  startIndex: number;
  raw: boolean;
  respectRobots: boolean;
  allowPrivate: boolean;
};

/** What a direct caller (tests, e2e) may pass: the same, with the defaults omitted. */
export type FetchToolInput = Partial<Omit<FetchInput, 'url'>> & Pick<FetchInput, 'url'>;

interface RawResponse {
  status: number;
  /** Plain, lower-cased header map (undici's `Headers`, flattened). */
  headers: Record<string, string>;
  body: string;
  bytesRead: number;
}

type FetchFailure = { ok: false; code: string; error: string; status?: number };

/** Flatten undici's `Headers` into a plain lower-cased map. */
function headerMap(headers: {
  entries: () => IterableIterator<[string, string]>;
}): Record<string, string> {
  return Object.fromEntries(headers.entries());
}
type FetchSuccess = { ok: true; response: RawResponse };

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()];
}

function isTextual(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type === '') return true;
  if (type.startsWith('text/')) return true;
  return (
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/xhtml+xml' ||
    type === 'application/javascript' ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/rss+xml' ||
    type === 'application/atom+xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

function charsetOf(contentType: string): string | undefined {
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match?.[1]?.trim();
}

function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = charsetOf(contentType);
  if (!charset || /^utf-?8$/i.test(charset)) return buffer.toString('utf-8');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf-8'); // unknown label: UTF-8 is the right guess
  }
}

interface RequestOptions {
  timeoutMs: number;
  maxBytes: number;
  agent: Agent;
  /** User-Agent for this request (never read from the environment). */
  userAgent: string;
  signal?: AbortSignal;
}

/**
 * One HTTP GET with a byte ceiling, returned as a string.
 *
 * The body is read through an async iterator so the cap can *cancel* the
 * stream: a 2 GB download must cost 2 MB, not "2 MB kept and 2 GB received".
 */
async function requestOnce(
  url: string,
  options: RequestOptions
): Promise<RawResponse | FetchFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': options.userAgent,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.1',
        'accept-language': 'en',
      },
      signal: controller.signal,
      dispatcher: options.agent,
    });

    const headers = headerMap(response.headers);
    const declared = Number(headerValue(headers, 'content-length') ?? '0');
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        code: 'TOO_LARGE',
        status: response.status,
        error: `The response is ${declared} bytes, above the ${options.maxBytes}-byte limit.`,
      };
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let capped = false;
    const body = response.body;
    if (body) {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytesRead += buffer.byteLength;
        if (bytesRead > options.maxBytes) {
          const keep = options.maxBytes - (bytesRead - buffer.byteLength);
          if (keep > 0) chunks.push(buffer.subarray(0, keep));
          bytesRead = options.maxBytes;
          capped = true;
          break; // exiting the loop cancels the stream in undici
        }
        chunks.push(buffer);
      }
    }

    const contentType = headerValue(headers, 'content-type') ?? '';
    return {
      status: response.status,
      headers,
      body: capped ? '' : decodeBody(Buffer.concat(chunks), contentType),
      bytesRead,
    };
  } catch (err) {
    const error = err as Error & { code?: string; cause?: { code?: string } };
    const name = error.name;
    if (name === 'AbortError' || name === 'TimeoutError' || error.code === 'UND_ERR_ABORTED') {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `No answer from the server within ${options.timeoutMs} ms.`,
      };
    }
    return {
      ok: false,
      code: 'FETCH_FAILED',
      error: `Request failed: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

function isFailure(value: RawResponse | FetchFailure): value is FetchFailure {
  return 'ok' in value && value.ok === false;
}

interface FollowResult {
  ok: true;
  url: string;
  response: RawResponse;
  redirects: number;
  privateAllowed: boolean;
}

/**
 * Follow redirects by hand: each hop is vetted like the first URL.
 *
 * `redirect: 'manual'` is what makes this possible — the runtime never lets a
 * server choose an address the model could not have asked for directly.
 */
async function followRedirects(
  start: string,
  options: RequestOptions & {
    allowPrivate: boolean;
    maxRedirects: number;
    lookup?: (h: string) => Promise<string[]>;
  }
): Promise<FollowResult | FetchFailure> {
  let current = start;
  let redirects = 0;
  let privateAllowed = options.allowPrivate;

  for (;;) {
    const safety: UrlSafetyResult = await checkUrlSafety(current, {
      allowPrivate: options.allowPrivate,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    if (!safety.ok) {
      return { ok: false, code: safety.code, error: safety.error };
    }
    if (options.allowPrivate === false) privateAllowed = false;

    const response = await requestOnce(safety.url.href, options);
    if (isFailure(response)) return response;

    const location = headerValue(response.headers, 'location');
    const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;
    if (!isRedirect) {
      return { ok: true, url: safety.url.href, response, redirects, privateAllowed };
    }

    redirects += 1;
    if (redirects > options.maxRedirects) {
      return {
        ok: false,
        code: 'TOO_MANY_REDIRECTS',
        status: response.status,
        error: `More than ${options.maxRedirects} redirects (last: ${current} → ${location}).`,
      };
    }

    let next: URL;
    try {
      next = new URL(location, safety.url);
    } catch {
      return {
        ok: false,
        code: 'FETCH_FAILED',
        status: response.status,
        error: `The server redirected to an unparsable location: ${location}`,
      };
    }
    current = next.href;
  }
}

export interface FetchToolOptions {
  /** Per-request timeout (default 10 s). */
  timeoutMs?: number;
  /** robots.txt timeout (default 5 s). */
  robotsTimeoutMs?: number;
  /** Bytes read from the wire before the body is cancelled (default 2 MB). */
  maxBytes?: number;
  /** Redirect hops (default 5). */
  maxRedirects?: number;
  /** Override the User-Agent header. */
  userAgent?: string;
  /** Injection point for tests: resolve a hostname to addresses. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export function createFetchTool(projectRoot: string, toolOptions: FetchToolOptions = {}) {
  void projectRoot; // the web is not workspace-scoped
  const robotsCache = new RobotsCache();
  const timeoutMs = toolOptions.timeoutMs ?? FETCH_TIMEOUT_MS;
  const robotsTimeoutMs = toolOptions.robotsTimeoutMs ?? ROBOTS_TIMEOUT_MS;
  const maxBytes = toolOptions.maxBytes ?? MAX_BODY_BYTES;
  const maxRedirects = toolOptions.maxRedirects ?? MAX_REDIRECTS;
  const agentHeader = toolOptions.userAgent ?? userAgent();
  const agent = new Agent({
    connect: { timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  const fetchTool: Tool<FetchInput, FetchOutcome> & {
    execute: (input: FetchToolInput) => Promise<FetchOutcome>;
  } = {
    description:
      'Fetches a URL and returns its content as Markdown (or raw HTML with raw: true). Use it to read ' +
      'documentation, a changelog or a spec you do not have locally. Long pages are paged: a result ' +
      'with truncated: true carries nextStartIndex for the next call. Only http/https; loopback and ' +
      'private addresses are blocked unless allowPrivate is set; robots.txt is honoured unless ' +
      'respectRobots is false.',
    inputSchema,
    execute: async (input) => {
      // The schema's `.default()` values are applied by the SDK when the model
      // calls the tool; a direct `execute()` (tests, e2e) does not go through
      // it, so the same defaults are applied here — one source of truth for
      // both paths.
      const {
        url,
        maxLength = DEFAULT_MAX_LENGTH,
        startIndex = 0,
        raw = false,
        respectRobots = true,
        allowPrivate = false,
      } = input;
      const started = Date.now();
      const remaining = (): number => Math.max(500, timeoutMs - (Date.now() - started));

      // ── 1. Which URL, and is it allowed at all? ──────────────────────────
      const safety = await checkUrlSafety(url, {
        allowPrivate,
        ...(toolOptions.lookup ? { lookup: toolOptions.lookup } : {}),
      });
      if (!safety.ok) {
        return { success: false, error: safety.error, code: safety.code };
      }

      // ── 2. robots.txt, unless the caller turned it off ───────────────────
      let robots: FetchRobotsInfo = { checked: false, allowed: true };
      if (respectRobots) {
        const robotsUrl = `${safety.url.origin}/robots.txt`;
        let entry = robotsCache.get(safety.url.host);
        let cached = entry !== undefined;

        if (!entry) {
          const fetched = await requestOnce(robotsUrl, {
            timeoutMs: Math.min(robotsTimeoutMs, remaining()),
            maxBytes: MAX_ROBOTS_BYTES,
            agent,
            userAgent: agentHeader,
          });
          if (isFailure(fetched)) {
            entry = {
              rules: { groups: [] },
              status: 0,
              fetchedAt: Date.now(),
              error: fetched.error,
            };
          } else {
            entry = {
              rules: parseRobotsTxt(fetched.body),
              status: fetched.status,
              fetchedAt: Date.now(),
            };
          }
          robotsCache.set(safety.url.host, entry);
          cached = false;
        }

        const status = entry.status;
        if (status === 401 || status === 403) {
          return {
            success: false,
            code: 'ROBOTS_FORBIDDEN',
            url: safety.url.href,
            robots: { checked: true, allowed: false, url: robotsUrl, status, cached },
            error:
              `${robotsUrl} answered ${status}: the site guards its robots.txt, so it is not ` +
              `inviting automated readers. Ask the user before fetching it (or pass ` +
              `respectRobots: false to override deliberately).`,
          };
        }
        if (entry.error !== undefined || status === 0 || status >= 500) {
          return {
            success: false,
            code: 'ROBOTS_UNAVAILABLE',
            url: safety.url.href,
            robots: { checked: true, allowed: false, url: robotsUrl, status, cached },
            error:
              `Could not read ${robotsUrl}${entry.error ? ` (${entry.error})` : ` (status ${status})`}. ` +
              `An unknown robots.txt is treated as "not allowed"; pass respectRobots: false to ` +
              `override deliberately.`,
          };
        }

        const decision = robotsAllows(entry.rules, safety.url, agentHeader);
        robots = {
          checked: true,
          allowed: decision.allowed,
          url: robotsUrl,
          status,
          cached,
          ...(decision.rule ? { rule: decision.rule } : {}),
        };
        if (!decision.allowed) {
          return {
            success: false,
            code: 'ROBOTS_FORBIDDEN',
            url: safety.url.href,
            robots,
            error:
              `robots.txt (${robotsUrl}) disallows this page for "${agentHeader}" — ` +
              `${decision.rule}. Tell the user the page could not be read; they can approve ` +
              `respectRobots: false if they want it anyway.`,
          };
        }
      }

      // ── 3. The fetch itself (redirects vetted hop by hop) ────────────────
      const followed = await followRedirects(safety.url.href, {
        timeoutMs: remaining(),
        maxBytes,
        agent,
        allowPrivate,
        maxRedirects,
        userAgent: agentHeader,
        ...(toolOptions.lookup ? { lookup: toolOptions.lookup } : {}),
      });
      if (!followed.ok) {
        return {
          success: false,
          error: followed.error,
          code: followed.code,
          ...(followed.status === undefined ? {} : { status: followed.status }),
          ...(robots.checked ? { robots } : {}),
        };
      }

      const { response, url: finalUrl, redirects } = followed;
      const contentType = headerValue(response.headers, 'content-type') ?? '';
      const base: FetchOutcome = {
        success: true,
        url: safety.url.href,
        finalUrl,
        status: response.status,
        contentType,
        redirects,
        bytesRead: response.bytesRead,
        ...(robots.checked ? { robots } : {}),
      };

      if (response.status >= 400) {
        return {
          ...base,
          success: false,
          code: 'HTTP_ERROR',
          error: `The server answered ${response.status} for ${finalUrl}.`,
        };
      }

      // ── 4. Turn the body into something a model can use ──────────────────
      if (!isTextual(contentType)) {
        return {
          ...base,
          unsupportedContentType: true,
          content: `[${contentType.split(';')[0]} — not text, so the body was not downloaded]`,
          totalChars: 0,
          startIndex,
          truncated: false,
        };
      }
      if (response.body === '' && response.bytesRead >= maxBytes) {
        return {
          ...base,
          success: false,
          code: 'TOO_LARGE',
          error: `The page is larger than the ${maxBytes}-byte limit.`,
        };
      }

      const looksHtml =
        !raw &&
        (contentType === '' ||
          /html/i.test(contentType) ||
          /^\s*<(?:!doctype|html)/i.test(response.body));
      const converted = looksHtml
        ? htmlToMarkdown(response.body, { baseUrl: finalUrl })
        : { markdown: response.body };

      const text = converted.markdown;
      const totalChars = text.length;
      const from = Math.min(startIndex, totalChars);
      const window = text.slice(from, from + maxLength);
      const end = from + window.length;
      const truncated = end < totalChars;

      // The reference's own affordance, kept in spirit: a truncated result says
      // exactly where to continue, so the model never guesses an offset.
      const content = truncated
        ? `${window}\n\n<error>Content truncated. Call fetch with startIndex ${end} for more.</error>`
        : window;

      return {
        ...base,
        raw,
        ...(converted.title ? { title: converted.title } : {}),
        content,
        totalChars,
        startIndex: from,
        truncated,
        ...(truncated ? { nextStartIndex: end, remainingChars: totalChars - end } : {}),
        ...(allowPrivate ? { privateAllowed: true } : {}),
      };
    },
  };

  return tool(fetchTool);
}
