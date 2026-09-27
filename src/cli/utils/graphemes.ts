/**
 * G-06: grapheme-aware cursor math for the REPL line editor.
 *
 * Terminal columns are not UTF-16 code units: an emoji or a CJK ideograph
 * occupies two cells, and zero-width joiners / Persian combining marks occupy
 * none.  Backspace and left/right must move by extended grapheme cluster.
 */

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

/** Split `s` into extended grapheme clusters. */
export function graphemes(s: string): string[] {
  if (!s) return [];
  if (segmenter) {
    return Array.from(segmenter.segment(s), (part) => part.segment);
  }
  return Array.from(s);
}

/** True for format/combining code points that must not move the cursor. */
export function isZeroWidthCodePoint(code: number): boolean {
  if (code === 0x200c || code === 0x200d) return true; // ZWNJ / ZWJ
  if (code === 0x200b || code === 0x2060 || code === 0xfeff) return true;
  if (code >= 0x0300 && code <= 0x036f) return true; // combining diacritics
  if (code >= 0x064b && code <= 0x065f) return true; // Arabic/Persian harakat
  if (code === 0x0670) return true;
  if (code >= 0x06d6 && code <= 0x06ed) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true; // variation selectors
  if (code >= 0x20d0 && code <= 0x20ff) return true;
  if (code >= 0x1ab0 && code <= 0x1aff) return true;
  return false;
}

function isWideCodePoint(code: number): boolean {
  if (code >= 0x1100 && code <= 0x115f) return true;
  if (code >= 0x2329 && code <= 0x232a) return true;
  if (code >= 0x2e80 && code <= 0xa4cf) return true;
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  if (code >= 0xf900 && code <= 0xfaff) return true;
  if (code >= 0xfe10 && code <= 0xfe19) return true;
  if (code >= 0xfe30 && code <= 0xfe6f) return true;
  if (code >= 0xff00 && code <= 0xff60) return true;
  if (code >= 0xffe0 && code <= 0xffe6) return true;
  if (code >= 0x1f300 && code <= 0x1faff) return true;
  if (code >= 0x1f000 && code <= 0x1f02f) return true;
  if (code >= 0x2600 && code <= 0x27bf) return true;
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return true; // regional indicators
  return false;
}

/** Display columns occupied by one grapheme cluster. */
export function graphemeWidth(g: string): number {
  if (!g) return 0;
  let wide = false;
  let anyVisible = false;
  for (const ch of g) {
    const code = ch.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(code)) continue;
    anyVisible = true;
    if (isWideCodePoint(code)) wide = true;
  }
  if (!anyVisible) return 0;
  return wide ? 2 : 1;
}

/** Terminal column width of `s` (emoji = 2, ZWNJ/diacritics = 0). */
export function displayWidth(s: string): number {
  let width = 0;
  for (const g of graphemes(s)) width += graphemeWidth(g);
  return width;
}

/** UTF-16 index of the grapheme that ends at or before `index`. */
export function graphemeStartBefore(s: string, index: number): number {
  if (index <= 0) return 0;
  let offset = 0;
  let prev = 0;
  for (const g of graphemes(s)) {
    const next = offset + g.length;
    if (next >= index) return offset;
    prev = offset;
    offset = next;
  }
  return prev;
}

/** UTF-16 index just after the grapheme that starts at or after `index`. */
export function graphemeEndAfter(s: string, index: number): number {
  if (index >= s.length) return s.length;
  let offset = 0;
  for (const g of graphemes(s)) {
    const next = offset + g.length;
    if (offset >= index) return next;
    if (offset < index && next > index) return next;
    offset = next;
  }
  return s.length;
}
