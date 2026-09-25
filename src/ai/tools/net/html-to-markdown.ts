/**
 * Phase 40 — HTML → Markdown, without a dependency.
 *
 * `fetch` is only useful if what comes back is *content*. A real page is 90%
 * markup a model should never pay tokens for: scripts, styles, navigation,
 * cookie banners, `<div>` soup. The reference server handles this with the
 * `readability-lxml` + `markdownify` pair (a C-accelerated article extractor
 * plus a general-purpose converter); here it is a small deterministic
 * converter, which is the right size for the job: headings, paragraphs, links,
 * lists, code, tables and quotes — and dropped, not converted, for everything
 * that is not content.
 *
 * Rendering rules worth knowing:
 *   - `script/style/nav/footer/header/aside/svg/…` are removed with their
 *     contents, not rendered as text (that is where a page hides its noise).
 *   - links are made **absolute** against the page URL, because a model reading
 *     `[config](./settings.html)` in a dump has no way to use it.
 *   - `<pre>` keeps its whitespace verbatim in a fenced block (the one place
 *     where collapsing spaces would destroy meaning).
 *   - everything else collapses whitespace: HTML's own rendering rules, and the
 *     difference between a readable page and one long line.
 */

const SKIP_TAGS = new Set([
  'script',
  'style',
  'head',
  'nav',
  'footer',
  'header',
  'aside',
  'svg',
  'iframe',
  'noscript',
  'form',
  'template',
  'button',
  'select',
  'option',
  'textarea',
  'input',
  'video',
  'audio',
  'canvas',
  'dialog',
  'menu',
  'object',
  'embed',
  'map',
  'area',
  'link',
  'meta',
  'base',
  'title',
]);

const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'source',
  'track',
  'wbr',
  'area',
  'base',
  'col',
  'embed',
  'param',
]);

/** Inline elements that wrap their text: `[open, close]` markers. */
const INLINE_TAGS: Record<string, [string, string]> = {
  strong: ['**', '**'],
  b: ['**', '**'],
  em: ['*', '*'],
  i: ['*', '*'],
  del: ['~~', '~~'],
  s: ['~~', '~~'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  kbd: ['`', '`'],
  samp: ['`', '`'],
  var: ['`', '`'],
  q: ['"', '"'],
};

/** Elements that end the current paragraph. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'fieldset',
  'dl',
  'dt',
  'dd',
  'center',
  'span',
  'label',
]);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  minus: '−',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  shy: '',
};

/** Decode the entities that actually appear in real pages (plus numeric ones). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export interface HtmlToMarkdownOptions {
  /**
   * Page URL used to resolve relative links/images. Without it, `href` values
   * are kept exactly as written.
   */
  baseUrl?: string;
}

export interface HtmlToMarkdownResult {
  markdown: string;
  /** The `<title>`, when the page has a usable one. */
  title?: string;
}

/** Absolute href, or the raw value when it cannot be resolved. */
function resolveUrl(value: string, baseUrl?: string): string {
  const trimmed = value.trim().replace(/\s+/g, '');
  if (trimmed === '' || baseUrl === undefined) return value.trim();
  if (/^(mailto:|tel:|data:|javascript:|#)/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/** Strip every remaining tag from a chunk of raw HTML (used inside `<pre>`). */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/**
 * Convert an HTML document to Markdown.
 *
 * Not a full HTML parser: it is a single pass over tags and text, which is
 * enough for well-formed pages and *predictable* on malformed ones (unclosed
 * tags degrade to "text in the wrong block", never to a crash or a hang).
 */
export function htmlToMarkdown(
  html: string,
  options: HtmlToMarkdownOptions = {}
): HtmlToMarkdownResult {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  // The title is read up front: it lives in <head>, which the converter drops
  // with its contents, and it is the single most useful line of a page.
  const declaredTitle = /<\s*title[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/i.exec(source);
  const out: string[] = [];
  let buf = '';
  let title = '';
  let inTitle = false;

  const listStack: Array<{ ordered: boolean; index: number; depth: number }> = [];
  const liFrames: Array<{ marker: string; savedBuf: string; lines: string[] }> = [];
  const linkStack: Array<{ href: string; savedBuf: string }> = [];
  let quoteDepth = 0;
  let headingLevel = 0;
  let table: string[][] | undefined;
  let tableRow: string[] | undefined;
  let inTableCell = false;

  const currentIndent = (): string => '  '.repeat(Math.max(0, listStack.length - 1));

  const prefix = (line: string): string =>
    quoteDepth > 0 ? `${'> '.repeat(quoteDepth)}${line}` : line;

  let lastKind: 'list' | 'block' = 'block';
  const push = (text: string, kind: 'list' | 'block' = 'block'): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const line = prefix(trimmed);
    // List items stack tightly (nested items included); everything else is a
    // paragraph of its own.
    if (kind === 'list' && lastKind === 'list' && out.length > 0)
      out[out.length - 1] += `\n${line}`;
    else out.push(line);
    lastKind = kind;
  };

  const flush = (): void => {
    if (inTitle) return;
    if (buf.trim() !== '') push(buf);
    buf = '';
  };

  const append = (text: string): void => {
    buf += text;
  };

  const tokenRe = /<[^>]*>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(source)) !== null) {
    const text = source.slice(lastIndex, match.index);
    if (text !== '') {
      const decoded = decodeEntities(text).replace(/[\t\r\n]+/g, ' ');
      append(inTitle ? decoded : decoded.replace(/ {2,}/g, ' '));
    }
    lastIndex = tokenRe.lastIndex;

    const raw = match[0];
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1]!.toLowerCase();
    const closing = /^<\s*\//.test(raw);
    const selfClosing = /\/>$/.test(raw) || VOID_TAGS.has(tag);

    // ── elements dropped with their contents ────────────────────────────────
    if (!closing && SKIP_TAGS.has(tag)) {
      if (tag === 'title') {
        inTitle = true;
        buf = '';
        continue;
      }
      const close = new RegExp(`</\\s*${tag}\\s*>`, 'i');
      const rest = source.slice(lastIndex);
      const found = close.exec(rest);
      if (found) {
        tokenRe.lastIndex = lastIndex + found.index + found[0].length;
        lastIndex = tokenRe.lastIndex;
      } else {
        tokenRe.lastIndex = source.length;
        lastIndex = source.length;
      }
      continue;
    }
    if (closing && tag === 'title') {
      title = decodeEntities(buf).replace(/\s+/g, ' ').trim();
      buf = '';
      inTitle = false;
      continue;
    }

    // ── verbatim blocks ────────────────────────────────────────────────────
    if (tag === 'pre' && !closing) {
      if (liFrames.length > 0) {
        // Inside a list item a fenced block would split the item in two; the
        // code goes inline as a code span instead.
        const rest = source.slice(lastIndex);
        const close = /<\/\s*pre\s*>/i.exec(rest);
        const inner = close ? rest.slice(0, close.index) : rest;
        if (close) {
          tokenRe.lastIndex = lastIndex + close.index + close[0].length;
          lastIndex = tokenRe.lastIndex;
        } else {
          tokenRe.lastIndex = source.length;
          lastIndex = source.length;
        }
        const code = stripTags(inner).replace(/\s+/g, ' ').trim();
        if (code !== '') append(`\`${code}\``);
        continue;
      }
      flush();
      const rest = source.slice(lastIndex);
      const close = /<\/\s*pre\s*>/i.exec(rest);
      const inner = close ? rest.slice(0, close.index) : rest;
      if (close) {
        tokenRe.lastIndex = lastIndex + close.index + close[0].length;
        lastIndex = tokenRe.lastIndex;
      } else {
        tokenRe.lastIndex = source.length;
        lastIndex = source.length;
      }
      const code = stripTags(inner).replace(/^\n+/, '').replace(/\s+$/, '');
      if (code !== '') push(`\`\`\`\n${code}\n\`\`\``);
      continue;
    }

    // ── tables ─────────────────────────────────────────────────────────────
    if (tag === 'table' && !closing) {
      flush();
      table = [];
      continue;
    }
    if (tag === 'table' && closing) {
      flush();
      if (table && table.length > 0) {
        const rows = table.map((row) => `| ${row.map((cell) => cell.trim()).join(' | ')} |`);
        const [header, ...body] = rows;
        push([header!, `| ${(table[0] ?? []).map(() => '---').join(' | ')} |`, ...body].join('\n'));
      }
      table = undefined;
      continue;
    }
    if (tag === 'tr' && table) {
      flush();
      if (!closing) tableRow = [];
      else {
        if (tableRow) table.push(tableRow);
        tableRow = undefined;
      }
      continue;
    }
    if ((tag === 'td' || tag === 'th') && table) {
      if (inTableCell) {
        if (tableRow) tableRow.push(buf.trim());
        inTableCell = false;
      }
      buf = '';
      if (!closing) {
        inTableCell = true;
        // Cells are their own text container; keep it flat.
      }
      continue;
    }

    if (BLOCK_TAGS.has(tag)) {
      // Inside a list item the item's own text stays inline: a <p> or <div> in
      // there is a soft break ("- item text"), not a new block.
      if (liFrames.length > 0) append(' ');
      else flush();
      continue;
    }

    // ── headings ───────────────────────────────────────────────────────────
    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        const level = headingLevel || 1;
        const heading = buf.replace(/\s+/g, ' ').trim();
        buf = '';
        headingLevel = 0;
        if (heading !== '') push(`${'#'.repeat(level)} ${heading}`);
      } else {
        flush();
        headingLevel = Number(tag[1]);
        buf = '';
      }
      continue;
    }

    // ── lists ──────────────────────────────────────────────────────────────
    if (tag === 'ul' || tag === 'ol') {
      if (liFrames.length === 0) flush();
      if (!closing) {
        const start = Number(/\bstart\s*=\s*"?(\d+)/i.exec(raw)?.[1] ?? '1');
        listStack.push({
          ordered: tag === 'ol',
          index: Number.isFinite(start) ? start : 1,
          depth: listStack.length + 1,
        });
      } else {
        listStack.pop();
      }
      continue;
    }
    if (tag === 'li') {
      if (!closing) {
        if (liFrames.length === 0) flush();
        const parent = listStack[listStack.length - 1];
        const ordered = parent?.ordered ?? false;
        const indent = '  '.repeat(Math.max(0, listStack.length - 1));
        const marker = `${indent}${ordered ? `${parent?.index ?? 1}.` : '-'} `;
        if (parent) parent.index += 1;
        liFrames.push({ marker, savedBuf: buf, lines: [] });
        buf = '';
      } else {
        const frame = liFrames.pop();
        const text = buf.replace(/\s+/g, ' ').trim();
        buf = frame ? frame.savedBuf : buf;
        if (frame) {
          // The item's own line first, then its nested list (the nested frame
          // already recorded itself in `lines`, because it closes first).
          const rendered = [`${frame.marker}${text}`.trimEnd(), ...frame.lines];
          if (liFrames.length > 0) liFrames[liFrames.length - 1]!.lines.push(...rendered);
          else push(rendered.join('\n'), 'list');
        }
      }
      continue;
    }

    // ── quotes ─────────────────────────────────────────────────────────────
    if (tag === 'blockquote') {
      flush();
      quoteDepth += closing ? -1 : 1;
      if (quoteDepth < 0) quoteDepth = 0;
      continue;
    }

    // ── links and images ───────────────────────────────────────────────────
    if (tag === 'a') {
      if (closing) {
        const link = linkStack.pop();
        if (link) {
          buf = link.savedBuf + `${buf.trim()}](${resolveUrl(link.href, options.baseUrl)})`;
        }
      } else {
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
        const value = href?.[2] ?? href?.[3] ?? href?.[4] ?? '';
        const label = buf;
        buf = '';
        linkStack.push({ href: value, savedBuf: `${label}[` });
      }
      continue;
    }
    if (tag === 'img') {
      const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
      const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
      const value = src?.[2] ?? src?.[3] ?? src?.[4] ?? '';
      if (value !== '') {
        append(
          `![${decodeEntities(alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? '')}](${resolveUrl(value, options.baseUrl)})`
        );
      }
      continue;
    }

    // ── line breaks and rules ──────────────────────────────────────────────
    if (tag === 'br') {
      append('  \n');
      continue;
    }
    if (tag === 'hr') {
      flush();
      push('---');
      continue;
    }

    // ── inline emphasis and code ───────────────────────────────────────────
    const inline = INLINE_TAGS[tag];
    if (inline) {
      append(closing ? inline[1] : inline[0]);
      continue;
    }

    if (selfClosing) continue; // any other void element
    // Unknown tag: treat as a span — text inside still flows into the buffer.
  }

  if (lastIndex < source.length) {
    append(decodeEntities(source.slice(lastIndex)).replace(/[\t\r\n]+/g, ' '));
  }
  flush();

  const markdown = out
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');

  const finalTitle =
    title !== ''
      ? title
      : decodeEntities(declaredTitle?.[1] ?? '')
          .replace(/\s+/g, ' ')
          .trim();
  return finalTitle === '' ? { markdown } : { markdown, title: finalTitle };
}

/** A one-line label for a page: its `<title>`, else its first heading. */
export function titleOf(html: string): string | undefined {
  const { title } = htmlToMarkdown(html);
  return title === '' ? undefined : title;
}
