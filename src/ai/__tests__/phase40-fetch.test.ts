import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFetchTool, type FetchOutcome } from '../tools/implementations/fetch.js';
import { htmlToMarkdown, decodeEntities } from '../tools/net/html-to-markdown.js';
import { RobotsCache, parseRobotsTxt, productToken, robotsAllows } from '../tools/net/robots.js';
import {
  checkUrlSafety,
  classifyAddress,
  expandIpv6,
  hostnameOf,
} from '../tools/net/url-safety.js';

/**
 * Phase 40 — `fetch`, against a real (local) HTTP server.
 *
 * No external network is touched: every request goes to a server this file
 * starts on 127.0.0.1, which is also what makes the SSRF assertions meaningful
 * (the blocked target *is* the fixture) and the runs deterministic.
 */

type ToolExecute = (args: unknown) => Promise<FetchOutcome>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const PAGE = `<!doctype html>
<html><head>
  <title>Widget API &mdash; Docs</title>
  <style>.hidden { color: red }</style>
  <script>var SCRIPTLEAK = "should-not-appear";</script>
</head>
<body>
  <nav>NAVJUNK should not appear</nav>
  <h1>Widget API</h1>
  <p>Use <strong>care</strong> and read the <a href="./guide.html">guide</a>, or
     the <a href="https://example.org/x">upstream</a>.</p>
  <ul><li>first</li><li>second with <code>code()</code></li></ul>
  <pre>const a = 1;
  indented();</pre>
  <table><tr><th>Field</th><th>Type</th></tr><tr><td>id</td><td>string</td></tr></table>
  <blockquote>Quoted wisdom</blockquote>
  <p>Tail &amp; end</p>
  <footer>FOOTERJUNK</footer>
</body></html>`;

type RobotsMode = 'allow' | 'missing' | 'down' | 'forbidden';

interface Fixture {
  origin: string;
  requests: string[];
  readonly robotsRequests: number;
  close: () => Promise<void>;
}

let fixture: Fixture;

async function startFixture(robotsMode: RobotsMode = 'allow'): Promise<Fixture> {
  const state = { requests: [] as string[], robotsRequests: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    state.requests.push(url);

    if (url === '/robots.txt') {
      state.robotsRequests += 1;
      if (robotsMode === 'down') {
        res.writeHead(503).end('temporarily down');
        return;
      }
      if (robotsMode === 'forbidden') {
        res.writeHead(403).end('guarded');
        return;
      }
      if (robotsMode === 'missing') {
        res.writeHead(404).end('no robots here');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
      return;
    }
    if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (url === '/private') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>secret</h1>');
      return;
    }
    if (url === '/redirect') {
      res.writeHead(302, { location: '/page' }).end();
      return;
    }
    if (url === '/redirect-private') {
      res.writeHead(307, { location: 'ftp://10.0.0.5/inside' }).end();
      return;
    }
    if (url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
      return;
    }
    if (url === '/slow') {
      return; // never answers: the client's timeout must fire
    }
    if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"n":2}');
      return;
    }
    if (url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('y'.repeat(300_000));
      return;
    }
    if (url === '/plain.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('line one\nline two\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found here');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: state.requests,
    get robotsRequests() {
      return state.robotsRequests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  } as Fixture;
}

/**
 * Every fetch in this file goes to the fixture, which is loopback by design.
 * R0-02: `allowPrivate` is an operator-only factory option, not a model
 * input, so it is set here on `options`, never smuggled into `execute()`.
 */
function fetchTool(options: Record<string, unknown> = {}) {
  const execute = executeOf(createFetchTool(REPO_ROOT, { allowPrivate: true, ...options } as never));
  return (input: { url: string } & Record<string, unknown>) => execute(input);
}

describe('Phase 40 — url safety (the SSRF gate)', () => {
  const blocked = [
    '127.0.0.1',
    '127.10.20.30',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:0001::1', // 6to4 around 127.0.0.1
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];

  it('blocks loopback, private, link-local, CGNAT, multicast and reserved ranges', () => {
    for (const address of blocked) {
      expect(classifyAddress(address).blocked, `${address} should be blocked`).toBe(true);
    }
  });

  it('lets public addresses through', () => {
    for (const address of allowed) {
      const verdict = classifyAddress(address);
      expect(verdict.blocked, `${address}: ${verdict.reason}`).toBe(false);
    }
  });

  it('names the reason, so the refusal can explain itself', () => {
    expect(classifyAddress('169.254.169.254').reason).toMatch(/link-local/);
    expect(classifyAddress('127.0.0.1').reason).toMatch(/loopback/);
    expect(classifyAddress('192.168.0.10').reason).toMatch(/RFC 1918/);
  });

  it('expands IPv6 forms, including the embedded IPv4 ones', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('[fe80::1]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(expandIpv6('2606:4700:4700::1111')).toEqual([
      0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111,
    ]);
    expect(expandIpv6('not-an-address')).toBeUndefined();
  });

  it('rejects a non-IP string instead of guessing', () => {
    expect(classifyAddress('example.com').blocked).toBe(true);
    expect(classifyAddress('999.1.1.1').blocked).toBe(true);
  });

  it('refuses a scheme that is not http(s)', async () => {
    const result = await checkUrlSafety('file:///etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BLOCKED_PROTOCOL');
  });

  it('refuses a relative or empty URL with a usable message', async () => {
    const result = await checkUrlSafety('example.com/docs');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_URL');
      expect(result.error).toMatch(/absolute URL/);
    }
  });

  it('blocks a public-looking host that resolves to a private address', async () => {
    const result = await checkUrlSafety('http://internal.example.com/', {
      lookup: async () => ['10.1.2.3'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BLOCKED_PRIVATE_ADDRESS');
      expect(result.error).toContain('10.1.2.3');
    }
  });

  it('blocks when *any* resolved address is private (dual-homed host)', async () => {
    const result = await checkUrlSafety('http://mixed.example.com/', {
      lookup: async () => ['93.184.216.34', '127.0.0.1'],
    });
    expect(result.ok).toBe(false);
  });

  it('allows the same host with allowPrivate, and still reports the record', async () => {
    const result = await checkUrlSafety('http://internal.example.com/', {
      allowPrivate: true,
      lookup: async () => ['10.1.2.3'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addresses).toEqual(['10.1.2.3']);
  });

  it('reports a DNS failure instead of pretending the host is safe', async () => {
    const result = await checkUrlSafety('http://nope.example.com/', {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DNS_FAILED');
      expect(result.error).toContain('ENOTFOUND');
    }
  });

  it('accepts a URL by its literal address without resolving anything', async () => {
    const result = await checkUrlSafety('https://93.184.216.34/x', {
      lookup: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result.ok).toBe(true);
  });

  it('normalises bracketed IPv6 host names', () => {
    expect(hostnameOf(new URL('http://[::1]:8080/'))).toBe('::1');
    expect(hostnameOf(new URL('http://example.com/'))).toBe('example.com');
  });
});

describe('Phase 40 — robots.txt', () => {
  it('parses groups, several agents per group, and crawl-delay', () => {
    const rules = parseRobotsTxt(`
      # a comment
      User-agent: BadBot
      Disallow: /

      User-agent: * 
      Crawl-delay: 2
      Disallow: /private
      Allow: /private/ok
      Disallow:
    `);
    expect(rules.groups).toHaveLength(2);
    expect(rules.groups[0]!.agents).toEqual(['badbot']);
    expect(rules.crawlDelaySeconds).toBe(2);
  });

  it('matches the longest rule, and Allow wins a tie', () => {
    const rules = parseRobotsTxt(
      'User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /tie\nAllow: /tie'
    );
    const allows = (p: string) =>
      robotsAllows(rules, new URL(`http://x.test${p}`), 'human-out-of-the-loop/1.0');

    expect(allows('/a/b').allowed).toBe(true);
    expect(allows('/a/b').rule).toBe('Allow: /a/b');
    expect(allows('/a/c').allowed).toBe(false);
    expect(allows('/tie').allowed).toBe(true); // same length: Allow wins
    expect(allows('/other').allowed).toBe(true); // no rule = allowed
  });

  it('supports `*` wildcards and a `$` anchor', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /*.json$\nDisallow: /tmp/*/secret');
    const allows = (p: string) => robotsAllows(rules, new URL(`http://x.test${p}`), 'ua/1');

    expect(allows('/data.json').allowed).toBe(false);
    expect(allows('/data.json?x=1').allowed).toBe(true); // anchored, so the query breaks it
    expect(allows('/tmp/a/b/secret').allowed).toBe(false);
    expect(allows('/tmp/secret').allowed).toBe(true);
  });

  it('prefers the group that names us over `*`', () => {
    const rules = parseRobotsTxt(
      'User-agent: *\nDisallow: /\n\nUser-agent: human-out-of-the-loop\nDisallow: /admin'
    );
    const allows = (p: string) =>
      robotsAllows(rules, new URL(`http://x.test${p}`), 'human-out-of-the-loop/27.0');
    expect(allows('/docs').allowed).toBe(true);
    expect(allows('/admin').allowed).toBe(false);
    expect(allows('/admin').matchedAgent).toBe('human-out-of-the-loop');
  });

  it('treats an empty robots.txt (or a 404 body) as "everything allowed"', () => {
    const rules = parseRobotsTxt('');
    expect(robotsAllows(rules, new URL('http://x.test/anything'), 'ua').allowed).toBe(true);
  });

  it('reads the product token from a full User-Agent header', () => {
    expect(productToken('human-out-of-the-loop/27.12.0 (node)')).toBe('human-out-of-the-loop');
    expect(productToken('  SomeBot  ')).toBe('SomeBot');
  });

  it('caches per host and expires', () => {
    const cache = new RobotsCache(50, 2);
    cache.set('a.test', { rules: parseRobotsTxt(''), status: 200 }, 1000);
    expect(cache.get('a.test', 1040)?.status).toBe(200);
    expect(cache.get('a.test', 1100)).toBeUndefined(); // expired
    cache.set('a.test', { rules: parseRobotsTxt(''), status: 200 }, 1000);
    cache.set('b.test', { rules: parseRobotsTxt(''), status: 200 }, 1000);
    cache.set('c.test', { rules: parseRobotsTxt(''), status: 200 }, 1000);
    expect(cache.size).toBe(2); // maxEntries honoured
  });
});

describe('Phase 40 — HTML→Markdown', () => {
  it('converts headings, links (absolutised), lists, code, tables and quotes', () => {
    const { markdown, title } = htmlToMarkdown(PAGE, { baseUrl: 'http://x.test/docs/page' });
    expect(title).toBe('Widget API — Docs');
    expect(markdown).toContain('# Widget API');
    expect(markdown).toContain('**care**');
    expect(markdown).toContain('[guide](http://x.test/docs/guide.html)');
    expect(markdown).toContain('[upstream](https://example.org/x)');
    expect(markdown).toContain('- first\n- second with `code()`');
    expect(markdown).toContain('```\nconst a = 1;\n  indented();\n```');
    expect(markdown).toContain('| Field | Type |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| id | string |');
    expect(markdown).toContain('> Quoted wisdom');
    expect(markdown).toContain('Tail & end');
  });

  it('drops what is not content, contents included', () => {
    const { markdown } = htmlToMarkdown(PAGE);
    for (const junk of ['SCRIPTLEAK', 'should-not-appear', 'NAVJUNK', 'FOOTERJUNK', 'color: red']) {
      expect(markdown, `"${junk}" leaked into the markdown`).not.toContain(junk);
    }
  });

  it('renders ordered lists, nesting and images', () => {
    const { markdown } = htmlToMarkdown(
      '<ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol><img src="/a.png" alt="An A">',
      { baseUrl: 'http://x.test/' }
    );
    expect(markdown).toContain('1. one');
    expect(markdown).toContain('2. two');
    expect(markdown).toContain('  - nested');
    expect(markdown).toContain('![An A](http://x.test/a.png)');
  });

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;tag&gt; &#65; &#x42;')).toBe('a & b <tag> A B');
    expect(decodeEntities('x&nbsp;y')).toBe('x y');
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;');
  });

  it('does not hang or crash on broken markup', () => {
    const { markdown } = htmlToMarkdown('<p>unclosed <b>bold <script>var x=1;');
    expect(markdown).toContain('unclosed');
    expect(markdown).not.toContain('var x=1');
  });

  it('keeps text when there is no element at all', () => {
    expect(htmlToMarkdown('just words').markdown).toBe('just words');
  });
});

describe('Phase 40 — the fetch tool against a local server', () => {
  beforeAll(async () => {
    fixture = await startFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('returns Markdown, a title, and the response metadata', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/page` });
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.title).toBe('Widget API — Docs');
    expect(result.contentType).toContain('text/html');
    expect(result.content).toContain('# Widget API');
    expect(result.content).toContain('[guide](');
    expect(result.robots?.checked).toBe(true);
    expect(result.robots?.allowed).toBe(true);
    expect(result.redirects).toBe(0);
  });

  it('leaves non-HTML text as-is (no accidental conversion)', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/plain.txt` });
    expect(result.success).toBe(true);
    expect(result.content).toBe('line one\nline two\n');
    const json = await fetchTool()({ url: `${fixture.origin}/json` });
    expect(json.content).toBe('{"ok":true,"n":2}');
  });

  it('returns the raw body when raw: true', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/page`, raw: true });
    expect(result.success).toBe(true);
    expect(result.raw).toBe(true);
    expect(result.content).toContain('<h1>Widget API</h1>');
    expect(result.content).toContain('SCRIPTLEAK');
  });

  it('pages with maxLength/startIndex and says where to continue', async () => {
    const first = await fetchTool()({ url: `${fixture.origin}/page`, maxLength: 80 });
    expect(first.truncated).toBe(true);
    expect(first.content).not.toContain('<error>Content truncated');
    expect(first.nextStartIndex).toBe(80);
    expect(first.remainingChars).toBe(first.totalChars! - first.nextStartIndex!);

    const second = await fetchTool()({
      url: `${fixture.origin}/page`,
      maxLength: 80,
      startIndex: first.nextStartIndex!,
    });
    expect(second.success).toBe(true);
    expect(second.startIndex).toBe(80);
    expect(second.content).not.toBe(first.content);

    // Reading past the end is an empty page, not an error.
    const past = await fetchTool()({ url: `${fixture.origin}/page`, startIndex: 100_000 });
    expect(past.success).toBe(true);
    expect(past.content).toBe('');
    expect(past.truncated).toBe(false);
  });

  it('follows a relative redirect and reports both URLs', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/redirect` });
    expect(result.success).toBe(true);
    expect(result.redirects).toBe(1);
    expect(result.url).toContain('/redirect');
    expect(result.finalUrl).toContain('/page');
    expect(result.content).toContain('# Widget API');
  });

  it('vets every redirect hop, not just the first URL', async () => {
    // R0-03 pins each hop's connection to the address its own safety check
    // vetted, so a hop can no longer look public to the check and privately
    // connect elsewhere (that gap is what R0-03 closes) — this test instead
    // proves the *second* hop is independently checked at all: the first hop
    // is honestly loopback (allowPrivate: true), and the redirect target uses
    // a scheme (`ftp:`) that is always refused, regardless of address.
    const result = await fetchTool()({ url: `${fixture.origin}/redirect-private` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BLOCKED_PROTOCOL');
  });

  it('stops after the redirect budget', async () => {
    const result = await fetchTool({ maxRedirects: 3 })({ url: `${fixture.origin}/loop` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('TOO_MANY_REDIRECTS');
    expect(result.error).toContain('3 redirects');
  });

  it('times out on a server that never answers', async () => {
    const result = await fetchTool({ timeoutMs: 300, robotsTimeoutMs: 300 })({
      url: `${fixture.origin}/slow`,
      respectRobots: false,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('TIMEOUT');
  }, 10_000);

  it('cancels the body at the byte cap instead of reading it all', async () => {
    const result = await fetchTool({ maxBytes: 1000 })({ url: `${fixture.origin}/large` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('TOO_LARGE');
    expect(result.bytesRead).toBe(1000);
    expect(result.error).toContain('1000-byte');
  });

  it('reports a non-text content type without downloading the body', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/image` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(result.unsupportedContentType).toBe(true);
    expect(result.content).toBe('');
    expect(result.totalChars).toBe(0);
  });

  it('reports an HTTP error status with the URL', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/missing` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('HTTP_ERROR');
    expect(result.status).toBe(404);
  });

  it('honours robots.txt, and reports the rule that said no', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/private` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('ROBOTS_FORBIDDEN');
    expect(result.robots?.rule).toBe('Disallow: /private');
    expect(result.robots?.allowed).toBe(false);
  });

  it('fetches anyway when respectRobots is false — the deliberate override', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/private`, respectRobots: false });
    expect(result.success).toBe(true);
    expect(result.content).toContain('secret');
    expect(result.robots).toBeUndefined(); // nothing was consulted at all
  });

  it('caches robots.txt within a tool (one request, many fetches)', async () => {
    const cached = fetchTool();
    const before = fixture.robotsRequests;
    await cached({ url: `${fixture.origin}/json` });
    const afterFirst = fixture.robotsRequests;
    await cached({ url: `${fixture.origin}/plain.txt` });
    expect(afterFirst).toBe(before + 1);
    expect(fixture.robotsRequests).toBe(afterFirst);
  });

  it('treats an unreadable robots.txt (5xx) as a refusal, not as permission', async () => {
    const broken = await startFixture('down');
    try {
      const result = await fetchTool()({ url: `${broken.origin}/json` });
      expect(result.success).toBe(false);
      expect(result.code).toBe('ROBOTS_UNAVAILABLE');
      expect(result.robots?.status).toBe(503);
      expect(result.error).toMatch(/respectRobots: false/);
    } finally {
      await broken.close();
    }
  });

  it('treats a guarded robots.txt (403) as a refusal', async () => {
    const guarded = await startFixture('forbidden');
    try {
      const result = await fetchTool()({ url: `${guarded.origin}/json` });
      expect(result.success).toBe(false);
      expect(result.code).toBe('ROBOTS_FORBIDDEN');
      expect(result.robots?.status).toBe(403);
    } finally {
      await guarded.close();
    }
  });

  it('treats a missing robots.txt (404) as permission, like every crawler', async () => {
    const bare = await startFixture('missing');
    try {
      const result = await fetchTool()({ url: `${bare.origin}/json` });
      expect(result.success).toBe(true);
      expect(result.robots?.status).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it('blocks loopback by default, and says why', async () => {
    const guarded = executeOf(createFetchTool(REPO_ROOT, { timeoutMs: 500 } as never));
    const result = await guarded({ url: `${fixture.origin}/page` });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(result.error).toMatch(/loopback/);
    expect(result.error).toMatch(/allowPrivate: true/);
  });

  it('blocks the cloud-metadata address even when the caller asks for it', async () => {
    const guarded = executeOf(createFetchTool(REPO_ROOT, { timeoutMs: 500 } as never));
    const result = await guarded({
      url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BLOCKED_PRIVATE_ADDRESS');
  });

  it('R0-02: the model schema has no allowPrivate field at all', () => {
    const t = createFetchTool(REPO_ROOT) as unknown as { inputSchema: { shape: Record<string, unknown> } };
    expect(Object.keys(t.inputSchema.shape)).not.toContain('allowPrivate');
  });

  it('R0-02: passing allowPrivate as a tool argument cannot bypass the SSRF block', async () => {
    const guarded = executeOf(createFetchTool(REPO_ROOT, { timeoutMs: 500 } as never));
    const result = await guarded({
      url: `${fixture.origin}/page`,
      // A model influenced by prompt injection tries the old escape hatch.
      allowPrivate: true,
    } as never);
    expect(result.success).toBe(false);
    expect(result.code).toBe('BLOCKED_PRIVATE_ADDRESS');
  });

  it('R0-02: only the operator env var enables private addresses, never the call', async () => {
    process.env.HOTL_FETCH_ALLOW_PRIVATE = '1';
    try {
      const enabled = executeOf(createFetchTool(REPO_ROOT, { timeoutMs: 500 } as never));
      const result = await enabled({ url: `${fixture.origin}/plain.txt` });
      expect(result.success).toBe(true);
      expect(result.privateAllowed).toBe(true);
    } finally {
      delete process.env.HOTL_FETCH_ALLOW_PRIVATE;
    }
  });

  it('flags that a private target was allowed on purpose', async () => {
    const result = await fetchTool()({ url: `${fixture.origin}/plain.txt` });
    expect(result.privateAllowed).toBe(true);
  });

  it('R0-03: the connection is pinned to the address checkUrlSafety vetted, not re-resolved', async () => {
    // A hostname with no real DNS record at all. If the fetch performed a
    // second, independent lookup at connect time (the pre-fix behaviour),
    // it would get ENOTFOUND/DNS_FAILED from the real resolver — exactly the
    // gap a DNS-rebinding attacker relies on to answer differently on the
    // second lookup. After the fix, the connection is pinned to the address
    // the safety check already approved, so the request must still succeed.
    const port = new URL(fixture.origin).port;
    let lookupCalls = 0;
    const tool = executeOf(
      createFetchTool(REPO_ROOT, {
        timeoutMs: 2000,
        allowPrivate: true,
        lookup: async () => {
          lookupCalls += 1;
          return ['127.0.0.1'];
        },
      } as never)
    );
    const result = await tool({
      url: `http://this-host-does-not-exist-anywhere.invalid:${port}/plain.txt`,
      respectRobots: false,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    // Two safety checks run for a non-redirected request (the initial one and
    // the one inside followRedirects's loop) — both go through the injected
    // lookup. What must NOT happen is a third, independent resolution at
    // connect time: if undici performed its own DNS lookup for a hostname
    // with no real record, the request would fail outright instead of
    // succeeding via the pinned address.
    expect(lookupCalls).toBe(2);
  });

  it('never sends credentials: only our User-Agent and Accept', async () => {
    const captured: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      captured.push(req.headers);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env.SECRET_TOKEN = 'must-not-be-sent';

    const tool = executeOf(createFetchTool(REPO_ROOT, { timeoutMs: 2000, allowPrivate: true } as never));
    await tool({ url: `http://127.0.0.1:${port}/x`, respectRobots: false });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const headers = captured[0]!;
    expect(headers['authorization']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
    expect(String(headers['user-agent'])).toMatch(/^human-out-of-the-loop/);
    expect(headers['accept']).toBeDefined();
    expect(JSON.stringify(headers)).not.toContain('must-not-be-sent');
  });

  it('rejects a non-http scheme before anything is requested', async () => {
    const result = await fetchTool()({ url: 'ftp://example.com/file' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('BLOCKED_PROTOCOL');
  });
});

describe('Phase 40 — fetch registry wiring', () => {
  it('ships a registry entry for fetch', () => {
    const file = path.join(REPO_ROOT, 'registry', 'tools', 'fetch.json');
    expect(fs.existsSync(file)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(entry.id).toBe('fetch');
    expect(entry.category).toBe('web');
    expect(entry.modulePath).toBe('./implementations/fetch');
    expect(entry.source).toBe('local');
  });

  it('learns the web_research skill, which names the tools it teaches', () => {
    const dir = path.join(REPO_ROOT, 'registry', 'skills', 'web_research');
    const skill = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf-8'));
    expect(skill.id).toBe('web_research');
    expect(skill.tools).toContain('fetch');
    const markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(markdown).toContain('allowPrivate');
    expect(markdown).toContain('respectRobots');
  });

  it('grants fetch to the personas that run work, not to the planner', () => {
    const toolsOf = (persona: string): string[] =>
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'registry', 'personas', `${persona}.json`), 'utf-8')
      ).allowedTools;
    for (const persona of ['coder', 'architect', 'reviewer']) {
      expect(toolsOf(persona)).toContain('fetch');
    }
    expect(toolsOf('planner')).not.toContain('fetch');
  });
});

// Local cleanup so an accidentally-set env var cannot leak between suites.
let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env.SECRET_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.SECRET_TOKEN;
  else process.env.SECRET_TOKEN = savedToken;
});
