/**
 * Phase 40 — robots.txt, the part of `fetch` that keeps the agent a guest.
 *
 * The reference server checks robots.txt before every autonomous fetch (with
 * `protego`, the full RFC 9309 matcher) and refuses when the page is
 * disallowed; `respectRobots: false` is the explicit override. This is the same
 * idea, small enough to read: parse the groups, pick the one that matches our
 * user agent (an exact product token beats `*`), then apply the **longest**
 * matching rule — with Allow winning ties, the ordering every real crawler
 * implements.
 *
 * Two behaviours are deliberate and documented in the tool result:
 *   - 401/403 on robots.txt counts as "do not fetch" (the reference does this
 *     too: a site that guards its robots.txt is not inviting crawlers);
 *   - everything else that goes wrong while *reading* robots.txt (a network
 *     error, a 5xx) is reported as `ROBOTS_UNAVAILABLE` and refuses the fetch,
 *     because "we could not find out whether we are allowed" is not permission.
 *     The model can say so, and the human can pass `respectRobots: false`.
 */

export interface RobotsRule {
  allow: boolean;
  /** Raw pattern, including any `*` and trailing `$`. */
  pattern: string;
}

export interface RobotsGroup {
  /** Lowercased agent tokens from `User-agent:` lines (one group may list several). */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
  crawlDelaySeconds?: number;
}

const EMPTY_RULES: RobotsRules = { groups: [] };

/** Parse robots.txt into groups. Unknown directives are ignored, as required. */
export function parseRobotsTxt(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let expectingAgent = false;
  let crawlDelaySeconds: number | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (value === '') continue;
      // Consecutive User-agent lines share the group that follows them.
      if (!current || !expectingAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgent = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    expectingAgent = false;

    if (field === 'disallow' || field === 'allow') {
      // `Disallow:` with an empty value is the standard "allow everything".
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
      continue;
    }
    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelaySeconds = seconds;
    }
  }

  return crawlDelaySeconds === undefined ? { groups } : { groups, crawlDelaySeconds };
}

/** Compile one robots pattern (`*` wildcard, optional `$` anchor) to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** The path (with query) a rule must match against — RFC 9309 §2.2.2. */
function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided, formatted for the message (`Disallow: /private`). */
  rule?: string;
  /** Which agent token matched: ours, or `*`. */
  matchedAgent?: string;
}

/**
 * Decide whether `userAgent` may fetch `url` according to `rules`.
 *
 * No matching group (or no matching rule inside it) means allowed: robots.txt
 * is a deny-list, and the absence of a rule is permission.
 */
export function robotsAllows(rules: RobotsRules, url: URL, userAgent: string): RobotsDecision {
  const product = productToken(userAgent).toLowerCase();
  const path = pathOf(url);

  let bestGroup: RobotsGroup | undefined;
  let bestScore = -1;
  for (const group of rules.groups) {
    for (const agent of group.agents) {
      let score = -1;
      if (agent === '*') score = 0;
      else if (agent === product) score = agent.length;
      else if (agent !== '' && product.includes(agent)) score = agent.length - 1;
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }
  }
  if (!bestGroup) return { allowed: true };

  let winner: RobotsRule | undefined;
  let winnerLength = -1;
  for (const rule of bestGroup.rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.length;
    // Longest pattern wins; on a tie the Allow rule wins (RFC 9309 §2.2.2).
    if (length > winnerLength || (length === winnerLength && rule.allow && !winner?.allow)) {
      winner = rule;
      winnerLength = length;
    }
  }

  if (!winner) return { allowed: true, matchedAgent: bestGroup.agents.join(', ') };
  return {
    allowed: winner.allow,
    rule: `${winner.allow ? 'Allow' : 'Disallow'}: ${winner.pattern}`,
    matchedAgent: bestGroup.agents.join(', '),
  };
}

/** The product token of a User-Agent header (`Name/1.0 (comment)` → `Name`). */
export function productToken(userAgent: string): string {
  const match = /^\s*([A-Za-z0-9._~-]+)/.exec(userAgent);
  return match?.[1] ?? userAgent.trim();
}

export interface RobotsCacheEntry {
  rules: RobotsRules;
  /** HTTP status of the robots.txt response, for the tool result. */
  status: number;
  fetchedAt: number;
  error?: string;
}

/**
 * A tiny per-host cache. robots.txt changes rarely and every fetch of the same
 * site would otherwise pay for it; the TTL keeps a long run from ignoring a
 * site's updates for hours.
 */
export class RobotsCache {
  private readonly entries = new Map<string, RobotsCacheEntry>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 50
  ) {}

  get(host: string, now = Date.now()): RobotsCacheEntry | undefined {
    const entry = this.entries.get(host);
    if (!entry) return undefined;
    if (now - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(host);
      return undefined;
    }
    return entry;
  }

  set(host: string, entry: Omit<RobotsCacheEntry, 'fetchedAt'>, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(host, { ...entry, fetchedAt: now });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export { EMPTY_RULES };
