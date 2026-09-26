/**
 * R0-06 — an empty (or comma-only) `--allow-tools` value must not silently
 * open every tool, and an unknown tool id must be rejected with a clear
 * message instead of being ignored.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { serveCommand } from '../commands/serve.js';

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-06-'));
  return dir;
}

describe('R0-06 — --allow-tools validation', () => {
  it('rejects an empty --allow-tools with exit 2', async () => {
    const projectRoot = tempProject();
    const code = await serveCommand({ projectRoot, mcp: true, allowTools: '' });
    expect(code).toBe(2);
  });

  it('rejects a comma-only --allow-tools with exit 2', async () => {
    const projectRoot = tempProject();
    const code = await serveCommand({ projectRoot, mcp: true, allowTools: ',,' });
    expect(code).toBe(2);
  });

  it('rejects an unknown tool id with exit 2 and lists valid ids', async () => {
    const projectRoot = tempProject();
    const errors: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await serveCommand({ projectRoot, mcp: true, allowTools: 'readfile' });
      expect(code).toBe(2);
      expect(errors.join('')).toMatch(/readfile/);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
