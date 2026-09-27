/**
 * Phase B — registry loader, personas, skills/MCP isolation, initialize errors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import { createRegistry } from '../registries/base-registry.js';
import { z } from 'zod';
import { Orchestrator } from '../orchestrator.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { loadRegistries } from '../../cli/utils/registries.js';

const Entry = z.object({ id: z.string(), name: z.string() });

describe('B-17 — duplicate ids inside one layer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-dup-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a duplicate even when override is true', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'same', name: 'A' }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'same', name: 'B' }));
    const registry = createRegistry({ schema: Entry, label: 'T' });
    const result = loadRegistryFromDirectory({
      directory: dir,
      registry,
      schema: Entry,
      override: true,
    });
    expect(result.errors.some((e) => e.error.includes('Duplicate id'))).toBe(true);
    expect(result.loaded).toBe(1);
  });
});

describe('B-16 — initialize throws on corrupt models JSON', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-bad-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a malformed models file', async () => {
    const modelsDir = path.join(root, 'registry', 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(path.join(modelsDir, 'broken.json'), '{nope');
    const orch = new Orchestrator({
      projectRoot: root,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await expect(orch.initialize()).rejects.toThrow(/Invalid model/i);
  });
});

describe('B-18 — persona allowedTools validated', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-per-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws on a typo in allowedTools', async () => {
    fs.mkdirSync(path.join(root, 'registry', 'personas'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'registry', 'personas', 'coder.json'),
      JSON.stringify({
        id: 'coder',
        name: 'Coder',
        system: 'you code',
        allowedTools: ['read-file', 'write_fiel'],
      }),
    );
    const orch = new Orchestrator({
      projectRoot: root,
      env: { ...process.env, HOTL_NO_PACKAGE_REGISTRY: '1' },
    });
    await expect(orch.initialize()).rejects.toThrow(/allowedTools/i);
  });
});

describe('B-19 — unknown MCP tools do not fail skill load when deferred', () => {
  it('registers the skill and drops missing tools', () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerDefinition({
      id: 'read_file',
      name: 'read_file',
      description: 'r',
      source: 'local',
      modulePath: './read_file',
    });
    const skills = new SkillRegistry({ toolRegistry });
    skills.setAllowUnknownTools(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-sk-'));
    try {
      const resolved = skills.registerFromDirectory(
        {
          id: 'mcp-dep',
          name: 'MCP Dep',
          version: '1.0',
          instructions: 'Use the search tool',
          tools: ['read_file', 'mcp_search'],
        },
        tmp,
      );
      expect(resolved.resolvedTools).toEqual(['read_file']);
      expect(skills.unknownToolWarnings.some((w) => w.missing.includes('mcp_search'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('B-20 — CLI loadRegistries vs initialize model ids', () => {
  it('lists the same model ids the orchestrator loaded (package layer)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-b-par-'));
    try {
      const orch = new Orchestrator({ projectRoot: root });
      await orch.initialize();
      const loaded = loadRegistries(root);
      const runtimeIds = orch.modelRegistry.listConfigs().map((m) => m.id).sort();
      const cliIds = loaded.models.map((m) => m.id).sort();
      for (const id of cliIds) {
        expect(runtimeIds).toContain(id);
      }
      await orch.shutdown();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
