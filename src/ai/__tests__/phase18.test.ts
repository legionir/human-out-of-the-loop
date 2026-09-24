import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { createGitStatusTool } from '../tools/implementations/git-status.js';
import { validateWorkspacePath } from '../tools/implementations/path-security.js';
import { isUnsafeRegex, MAX_PATTERN_LENGTH } from '../tools/implementations/regex-guard.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { Orchestrator } from '../orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

type ToolExecute = (args: unknown) => Promise<unknown>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

// ─── Factory-level workspace isolation ───────────────────────────

describe('Phase 18 — FS tools are bound to projectRoot (not process.cwd())', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-'));
    fs.writeFileSync(path.join(projectRoot, 'sentinel.txt'), 'sentinel-from-projectroot\n', 'utf-8');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'app.ts'), 'export const marker = "search-me";\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('read_file reads from projectRoot even when process.cwd() differs', async () => {
    // The repo root (process.cwd()) has no sentinel.txt — if the tool
    // used process.cwd() this would fail with ENOENT.
    expect(fs.existsSync(path.join(process.cwd(), 'sentinel.txt'))).toBe(false);

    const execute = executeOf(createReadFileTool(projectRoot));
    const result = (await execute({ filePath: 'sentinel.txt', encoding: 'utf-8' })) as {
      success: boolean;
      content?: string;
      filePath?: string;
    };
    expect(result.success).toBe(true);
    expect(result.content).toBe('sentinel-from-projectroot\n');
  });

  it('read_file returns a path relative to projectRoot (no absolute path leak)', async () => {
    const execute = executeOf(createReadFileTool(projectRoot));
    const result = (await execute({ filePath: 'src/app.ts', encoding: 'utf-8' })) as {
      success: boolean;
      filePath?: string;
    };
    expect(result.success).toBe(true);
    expect(result.filePath).toBe(path.join('src', 'app.ts'));
    expect(result.filePath).not.toContain(projectRoot);
    expect(result.filePath).not.toMatch(/^\//);
  });

  it('search_code searches inside projectRoot and returns relative file paths', async () => {
    const execute = executeOf(createSearchCodeTool(projectRoot));
    const result = (await execute({
      pattern: 'search-me',
      directory: '.',
      fileExtension: '.ts',
      maxResults: 10,
    })) as { success: boolean; totalMatches: number; matches: Array<{ file: string }> };
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    for (const m of result.matches) {
      expect(m.file).not.toContain(projectRoot);
      expect(m.file).not.toMatch(/^\//);
    }
  });

  it('write_file writes inside projectRoot and returns a relative path', async () => {
    const execute = executeOf(createWriteFileTool(projectRoot));
    const result = (await execute({
      filePath: 'out/hi.txt',
      content: 'hello',
      overwrite: true,
    })) as { success: boolean; filePath?: string };
    expect(result.success).toBe(true);
    expect(result.filePath).toBe(path.join('out', 'hi.txt'));
    expect(fs.readFileSync(path.join(projectRoot, 'out', 'hi.txt'), 'utf-8')).toBe('hello');
  });
});

// ─── Path traversal blocking ─────────────────────────────────────

describe('Phase 18 — paths outside projectRoot are blocked', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-block-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('search_code blocks an absolute directory outside projectRoot (PATH-03)', async () => {
    const execute = executeOf(createSearchCodeTool(projectRoot));
    const result = (await execute({ pattern: 'x', directory: '/etc' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('search_code blocks relative traversal outside projectRoot', async () => {
    const execute = executeOf(createSearchCodeTool(projectRoot));
    const result = (await execute({ pattern: 'x', directory: '../' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('git_status blocks a directory outside projectRoot (PATH-04)', async () => {
    const execute = executeOf(createGitStatusTool(projectRoot));
    const result = (await execute({ directory: '/etc', short: true })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('read_file blocks absolute and relative traversal (PATH-01)', async () => {
    const execute = executeOf(createReadFileTool(projectRoot));
    const abs = (await execute({ filePath: '/etc/passwd', encoding: 'utf-8' })) as {
      success: boolean;
      code?: string;
    };
    expect(abs.success).toBe(false);
    expect(abs.code).toBe('PATH_TRAVERSAL_BLOCKED');

    const rel = (await execute({ filePath: '../../../etc/passwd', encoding: 'utf-8' })) as {
      success: boolean;
      code?: string;
    };
    expect(rel.success).toBe(false);
    expect(rel.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('write_file blocks writes outside projectRoot (PATH-02)', async () => {
    const execute = executeOf(createWriteFileTool(projectRoot));
    const result = (await execute({ filePath: '/tmp/phase18-evil.txt', content: 'x' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('validateWorkspacePath requires an explicit root (PATH-09)', () => {
    const safe = validateWorkspacePath('a/b.txt', '/wsp');
    expect(safe.safe).toBe(true);
    const blocked = validateWorkspacePath('../escape.txt', '/wsp');
    expect(blocked.safe).toBe(false);
  });
});

// ─── ReDoS guard ─────────────────────────────────────────────────

describe('Phase 18 — search_code ReDoS guard (SEC-01)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-redos-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('detects nested quantifiers as unsafe', () => {
    expect(isUnsafeRegex('(a+)+$')).toBe(true);
    expect(isUnsafeRegex('(a*)*')).toBe(true);
    expect(isUnsafeRegex('([a-z]+)+')).toBe(true);
    expect(isUnsafeRegex('(\\w+)*b')).toBe(true);
  });

  it('accepts safe patterns', () => {
    expect(isUnsafeRegex('a+b*')).toBe(false);
    expect(isUnsafeRegex('(a|b)+')).toBe(false);
    expect(isUnsafeRegex('([a-z]+)')).toBe(false);
    expect(isUnsafeRegex('foo\\bar+')).toBe(false);
  });

  it('tool rejects a catastrophic pattern before execution', async () => {
    const execute = executeOf(createSearchCodeTool(projectRoot));
    const result = (await execute({ pattern: '(a+)+$', directory: '.' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('UNSAFE_REGEX');
  });

  it('tool rejects patterns longer than MAX_PATTERN_LENGTH', async () => {
    expect(MAX_PATTERN_LENGTH).toBe(200);
    const execute = executeOf(createSearchCodeTool(projectRoot));
    const result = (await execute({
      pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1),
      directory: '.',
    })) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATTERN_TOO_LONG');
  });
});

// ─── SkillRegistry boundary (PATH-05) ────────────────────────────

describe('Phase 18 — SkillRegistry instructions path boundary', () => {
  it('throws when skill.json instructions escape the skill directory', () => {
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry({ toolRegistry });
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-skill-'));

    try {
      expect(() =>
        skillRegistry.registerFromDirectory(
          {
            id: 'evil-skill',
            name: 'Evil',
            version: '1.0.0',
            instructions: '../../../etc/passwd.md',
            tools: [],
          },
          skillDir
        )
      ).toThrow(/path traversal blocked/i);
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('allows a SKILL.md inside the skill directory', () => {
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry({ toolRegistry });
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-skill2-'));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# instructions here\n', 'utf-8');

    try {
      const resolved = skillRegistry.registerFromDirectory(
        {
          id: 'ok-skill',
          name: 'Ok',
          version: '1.0.0',
          instructions: 'SKILL.md',
          tools: [],
        },
        skillDir
      );
      expect(resolved.resolvedInstructions).toBe('# instructions here');
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

// ─── Orchestrator-level injection (the acceptance test) ──────────

describe('Phase 18 — Orchestrator({ projectRoot }) injects root into tools', () => {
  let projectRoot: string;
  // Assigned in beforeEach; `?.` in afterEach guards against a failed setup.
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    // Full temp project with a copy of the real registry
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-orch-'));
    fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'sentinel.txt'), 'orch-sentinel\n', 'utf-8');

    orchestrator = new Orchestrator({ projectRoot });
    await orchestrator.initialize();
  });

  afterEach(async () => {
    await orchestrator?.shutdown();
    if (projectRoot && fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('read_file registered by the Orchestrator uses projectRoot, not process.cwd()', async () => {
    // Discriminator: the repo root (process.cwd()) has no sentinel.txt.
    expect(fs.existsSync(path.join(process.cwd(), 'sentinel.txt'))).toBe(false);
    expect(projectRoot).not.toBe(process.cwd());

    const impl = orchestrator.toolRegistry.getImplementation('read_file');
    expect(impl).toBeDefined();
    const result = (await executeOf(impl)({ filePath: 'sentinel.txt', encoding: 'utf-8' })) as {
      success: boolean;
      content?: string;
    };
    expect(result.success).toBe(true);
    expect(result.content).toBe('orch-sentinel\n');
  });

  it('search_code registered by the Orchestrator stays inside projectRoot', async () => {
    const impl = orchestrator.toolRegistry.getImplementation('search_code');
    expect(impl).toBeDefined();
    const result = (await executeOf(impl)({ pattern: 'x', directory: '/etc' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });
});
