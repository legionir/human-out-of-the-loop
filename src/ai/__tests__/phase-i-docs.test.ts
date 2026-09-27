import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'src');
const CONFIG = fs.readFileSync(path.join(ROOT, 'docs/CONFIGURATION.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('I-07 — docs stay aligned with the code', () => {
  it('documents every HOTL_* the runtime reads', () => {
    const names = new Set<string>();
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/HOTL_[A-Z0-9_]+/g)) names.add(match[0]!);
    }
    const missing = [...names].filter((name) => !CONFIG.includes(name)).sort();
    expect(missing, `undocumented HOTL_* vars: ${missing.join(', ')}`).toEqual([]);
  });

  it('README and CHANGELOG mention the test suite and the current version', () => {
    expect(README).toContain('npx vitest run');
    expect(README).toContain('N/M tests passed');
    expect(CHANGELOG).toContain(`[${PKG.version}]`);
  });

  it('planner agent skillIds include task_decomposition (same as runtime)', () => {
    const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry/agents.json'), 'utf8')) as Array<{
      id: string;
      skillIds: string[];
    }>;
    const planner = agents.find((agent) => agent.id === 'planner');
    expect(planner?.skillIds).toContain('task_decomposition');
  });

  it('CONFIGURATION documents maxContextTokens', () => {
    expect(CONFIG).toContain('maxContextTokens');
    expect(CONFIG).toContain('HOTL_NO_SPLASH');
  });
});
