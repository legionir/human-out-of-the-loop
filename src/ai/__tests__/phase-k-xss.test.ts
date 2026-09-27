/**
 * K-08 — XSS discipline: one encoder (`escapeHtml` in public/ui-logic.js),
 * markdown escapes first, and every `innerHTML` interpolation in app.js
 * goes through that encoder (or is a static literal).
 */
// @ts-nocheck — public/ui-logic.js is vanilla ESM without a project .d.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, renderMarkdown } from '../../../public/ui-logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('K-08 — escapeHtml is the single encoder', () => {
  it('neutralises script, attributes and quotes', () => {
    const payload = `<img src=x onerror="alert(1)">&"'`;
    const out = escapeHtml(payload);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#39;');
    expect(out).not.toContain('<script');
  });

  it('renderMarkdown escapes before applying markers', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> **bold**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('fenced code is also escaped', () => {
    const html = renderMarkdown('```\n<script>x</script>\n```');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script>/);
  });

  it('app.js does not redefine escapeHtml and interpolates only through it', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    expect(app).toMatch(/import \{[\s\S]*escapeHtml[\s\S]*\} from '\.\/ui-logic\.js'/);
    expect(app).not.toMatch(/function escapeHtml\s*\(/);

    const interpolations: string[] = [];
    const re = /\.innerHTML\s*=\s*([`'"])([\s\S]*?)\1/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(app))) {
      interpolations.push(match[2] ?? '');
    }
    expect(interpolations.length).toBeGreaterThan(0);
    for (const body of interpolations) {
      const vars = [...body.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
      for (const expr of vars) {
        expect(
          expr.startsWith('escapeHtml(') || expr.startsWith('renderMarkdown('),
          `unescaped innerHTML interpolation: \${${expr}}`,
        ).toBe(true);
      }
    }
  });
});
