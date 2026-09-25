import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createSearchFilesTool } from '../tools/implementations/search-files.js';
import { scanFilesWithValidation } from '../tools/fs/index.js';
import { DEFAULT_EXCLUDE_DIRS } from '../tools/fs/content-search.js';
import {
  buildEnvironmentContext,
  collectEnvironmentFacts,
  environmentBullets,
} from '../environment-context.js';
import { buildProjectContext, buildAssessmentPrompt } from '../planning/planner.js';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { createAgent } from '../agents/agent-factory.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');

const isWindows = process.platform === 'win32';

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

// ─── search_files, levelled up (phase 36) ────────────────────────

describe('Phase 36 — search_files with an editor-grade glob scan', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p36-scan-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p36-scan-outside-'));

    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const index = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'lib', 'util.ts'), 'export const util = 1;\n');
    fs.writeFileSync(path.join(root, 'src', '__tests__', 'util.test.ts'), 'test\n');
    fs.writeFileSync(path.join(root, 'src', 'notes.md'), '# notes\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.ts'), 'dep\n');
    fs.writeFileSync(path.join(root, 'dist', 'bundle.ts'), 'built\n');
    fs.writeFileSync(path.join(root, 'top.test.ts'), 'top\n');
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'secret\n');
    if (!isWindows) fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("matches a bare name at any depth ('*.ts' is a name, not a path)", async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ pattern: '*.ts' })) as {
      success: boolean;
      matchMode: string;
      matches: string[];
      totalMatches: number;
      counts: { files: number; directories: number };
    };

    expect(result.success).toBe(true);
    expect(result.matchMode).toBe('basename');
    expect(result.matches).toContain(path.join('src', 'index.ts'));
    expect(result.matches).toContain(path.join('src', 'lib', 'util.ts'));
    expect(result.matches).toContain(path.join('src', '__tests__', 'util.test.ts'));
    expect(result.matches).toContain('top.test.ts');
    expect(result.counts.files).toBe(4);
    expect(result.counts.directories).toBe(0);
  });

  it('skips node_modules and dist by default, and says which names it skipped', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ pattern: '*.ts' })) as {
      matches: string[];
      ignoredDirectories: string[];
      filesScanned: number;
    };

    expect(result.matches.some((match) => match.includes('node_modules'))).toBe(false);
    expect(result.matches.some((match) => match.includes('dist'))).toBe(false);
    expect(result.ignoredDirectories).toEqual(['dist', 'node_modules']);
    expect(result.filesScanned).toBe(5); // src/{index.ts,notes.md}, the two test files, top.test.ts

    // Deliberately asking for them is still possible.
    const explicit = (await execute({ pattern: '*.ts', skipBuildDirs: false })) as {
      matches: string[];
    };
    expect(explicit.matches).toContain(path.join('node_modules', 'dep', 'index.ts'));
    expect(explicit.matches).toContain(path.join('dist', 'bundle.ts'));
  });

  it('can match the whole relative path when asked (reference behaviour)', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({
      pattern: 'src/**/*.test.ts',
      matchBaseName: false,
    })) as { matchMode: string; matches: string[] };

    expect(result.matchMode).toBe('path');
    expect(result.matches).toEqual([path.join('src', '__tests__', 'util.test.ts')]);
  });

  it('filters by entry type — directories only, files only', async () => {
    const execute = executeOf(createSearchFilesTool(root));

    const directories = (await execute({
      pattern: 'src*',
      matchBaseName: false,
      includeFiles: false,
    })) as { matches: string[]; counts: { files: number; directories: number } };
    expect(directories.matches).toEqual(['src']);
    expect(directories.counts.directories).toBe(1);

    const files = (await execute({ pattern: '*.md', includeDirectories: false })) as {
      matches: string[];
    };
    expect(files.matches).toEqual([path.join('src', 'notes.md')]);
  });

  it("honours excludePatterns, including '!' re-includes", async () => {
    const execute = executeOf(createSearchFilesTool(root));

    const excluded = (await execute({
      pattern: '*.ts',
      excludePatterns: ['**/__tests__'],
    })) as { matches: string[] };
    expect(excluded.matches.some((match) => match.includes('__tests__'))).toBe(false);

    const reIncluded = (await execute({
      pattern: '*.ts',
      excludePatterns: ['**/*.test.ts', '!**/__tests__/util.test.ts'],
    })) as { matches: string[] };
    expect(reIncluded.matches).toContain(path.join('src', '__tests__', 'util.test.ts'));
    expect(reIncluded.matches).not.toContain('top.test.ts');
  });

  it('reports sizes by lstat and never follows an escaping symlink', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ pattern: '*.ts' })) as {
      entries: Array<{ path: string; type: string; size: number }>;
      matches: string[];
      skippedSymlinks: number;
    };

    const entry = result.entries.find((item) => item.path === path.join('src', 'index.ts'))!;
    expect(entry.type).toBe('file');
    expect(entry.size).toBe(Buffer.byteLength('export const index = 1;\n'));

    if (!isWindows) {
      expect(result.matches).not.toContain('link-out');
      expect(result.matches.some((match) => match.includes('secret.ts'))).toBe(false);
      expect(result.skippedSymlinks).toBeGreaterThan(0);
    }
  });

  it('truncates at maxResults but still reports the true total', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ pattern: '*.ts', maxResults: 2 })) as {
      matches: string[];
      totalMatches: number;
      truncated: boolean;
    };

    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('refuses a negated pattern and an empty type filter', async () => {
    const execute = executeOf(createSearchFilesTool(root));

    const notPattern = (await execute({ pattern: '*.ts', includeFiles: false })) as {
      success: boolean;
      matches?: string[];
    };
    // includeDirectories still true — the pattern simply matches no directory.
    expect(notPattern.success).toBe(true);
    expect(notPattern.matches).toEqual([]);

    const neither = (await execute({
      pattern: '*.ts',
      includeFiles: false,
      includeDirectories: false,
    })) as { success: boolean; code?: string };
    expect(neither.success).toBe(false);
    expect(neither.code).toBe('INVALID_ARGUMENTS');
  });

  it('still blocks a path that escapes the workspace', async () => {
    const execute = executeOf(createSearchFilesTool(root));
    const result = (await execute({ path: '..', pattern: '*' })) as {
      success: boolean;
      code?: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('matches POSIX-style patterns on Windows too (the port used to hand `\\` to minimatch)', async () => {
    const scan = async (pattern: string): Promise<string[]> => {
      const outcome = await scanFilesWithValidation(root, pattern, [root], {
        matchBaseName: false,
        skipBuildDirs: true,
      });
      return outcome.matches.map((match) => match.relative).sort();
    };

    // On Windows `path.relative` returns `src\lib\util.ts`; matched natively, the
    // backslash is a glob escape and both patterns below find nothing.
    expect(await scan('src/**/*.ts')).toEqual([
      'src/__tests__/util.test.ts',
      'src/index.ts',
      'src/lib/util.ts',
    ]);
    expect(await scan('**/*.md')).toEqual(['src/notes.md']);
  });

  it('shares one default-exclude list with search_code', () => {
    expect(DEFAULT_EXCLUDE_DIRS.has('node_modules')).toBe(true);
    expect(DEFAULT_EXCLUDE_DIRS.has('dist')).toBe(true);
    expect(DEFAULT_EXCLUDE_DIRS.has('.git')).toBe(true);
    expect(DEFAULT_EXCLUDE_DIRS.has('.ai-runtime')).toBe(true);
  });
});

// ─── Environment facts ───────────────────────────────────────────

describe('Phase 36 — the runtime knows which machine it is on', () => {
  it('names the OS, the shell, the separator and the line ending', () => {
    const facts = collectEnvironmentFacts();
    expect(facts.platform).toBe(process.platform);
    expect(facts.osName.length).toBeGreaterThan(0);
    expect(facts.shell.length).toBeGreaterThan(0);
    expect(facts.pathSeparator).toBe(path.sep);
    expect(facts.pathJoinExample).toBe(path.join('src', 'index.ts'));
    expect(facts.lineEnding).toBe(isWindows ? 'CRLF' : 'LF');
    expect(facts.caseSensitive).toBe(!isWindows && process.platform !== 'darwin');
  });

  it('describes Windows as cmd/PowerShell, with CRLF and case-insensitive paths', () => {
    const facts = collectEnvironmentFacts({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32');
    expect(facts.isWindows).toBe(true);
    expect(facts.shellFamily).toBe('cmd');
    expect(facts.shell).toContain('cmd.exe');
    expect(facts.lineEnding).toBe('CRLF');
    expect(facts.caseSensitive).toBe(false);

    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain('platform: win32');
    expect(bullets).toContain('dir, type, findstr');
    expect(bullets).toContain('POSIX commands (ls, cat, grep, chmod, rm -rf) may not exist');
    expect(bullets).toContain('CON, NUL, AUX');
    expect(bullets).toContain('path separator: "\\"');
  });

  it('describes PowerShell when PSModulePath is present', () => {
    const facts = collectEnvironmentFacts({ PSModulePath: 'C:\\Modules' }, 'win32');
    expect(facts.shellFamily).toBe('powershell');
    expect(facts.shell).toBe('PowerShell');
    expect(environmentBullets(facts).join('\n')).toContain('PowerShell syntax, not sh');
  });

  it('warns about BSD userland on macOS (sed -i, grep -P, case-insensitive FS)', () => {
    const facts = collectEnvironmentFacts({ SHELL: '/bin/zsh' }, 'darwin');
    expect(facts.isMac).toBe(true);
    expect(facts.shell).toBe('/bin/zsh');
    expect(facts.osName).toContain('macOS');
    expect(facts.caseSensitive).toBe(false);

    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain('BSD userland, not GNU');
    expect(bullets).toContain("sed -i ''");
    expect(bullets).toContain('NFD');
  });

  it('describes Linux as GNU userland with a case-sensitive filesystem', () => {
    const facts = collectEnvironmentFacts({ SHELL: '/bin/bash' }, 'linux');
    expect(facts.isLinux).toBe(true);
    expect(facts.caseSensitive).toBe(true);
    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain('GNU userland');
    expect(bullets).toContain('case-sensitive');
  });

  it('notices WSL and warns that the shell is not cmd.exe', () => {
    const facts = collectEnvironmentFacts(
      { SHELL: '/bin/bash', WSL_DISTRO_NAME: 'Ubuntu' },
      'linux'
    );
    expect(facts.wslDistro).toBe('Ubuntu');
    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain('WSL (Ubuntu)');
    expect(bullets).toContain('/mnt/c');
  });

  it('falls back to /bin/sh when SHELL is unset', () => {
    const facts = collectEnvironmentFacts({}, 'linux');
    expect(facts.shell).toBe('/bin/sh');
  });

  it('renders the block under its header, and the header explains itself', () => {
    const block = buildEnvironmentContext(collectEnvironmentFacts({ SHELL: '/bin/bash' }, 'linux'));
    expect(block.startsWith('ENVIRONMENT (')).toBe(true);
    expect(block).toContain('- platform: linux');
    expect(block).toContain('default shell: /bin/bash (POSIX sh syntax)');
    expect(block).toContain('node:path');
  });

  it('rides along with the planner PROJECT CONTEXT and never grows the block with the project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p36-env-'));
    fs.writeFileSync(path.join(root, 'README.md'), '# x');
    try {
      const context = buildProjectContext(root);
      expect(context).toContain(`platform: ${process.platform}`);
      expect(context).toContain('default shell:');
      expect(context).toContain('path separator:');
      expect(buildAssessmentPrompt('do something', root)).toContain('default shell:');
      // The environment block must not smuggle heavy directory names into the
      // planner prompt (the phase-32 test asserts node_modules is absent).
      expect(context).not.toContain('node_modules');
      expect(context).not.toContain('.ai-runtime');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is part of the agent system prompt, so the agent writes the right commands', () => {
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry, process.cwd());
    // The catalog skills are part of registry/skills; loadSkillsFromDirectory
    // cross-validates them against the tool catalog, so give them definitions
    // (the same bootstrap phase5's fixture does).
    for (const id of ['list_personas', 'list_skills', 'list_tools']) {
      toolRegistry.registerDefinition({
        id,
        name: id,
        description: id,
        source: 'local',
        modulePath: `./${id}`,
        category: 'catalog',
      });
      toolRegistry.registerImplementation(id, {
        description: id,
        inputSchema: { type: 'object', properties: {} } as never,
        execute: async () => ({ ok: true }),
      } as never);
    }

    const personaRegistry = new PersonaRegistry();
    const personaLoad = personaRegistry.loadFromDirectory(PERSONAS_DIR);
    expect(personaLoad.errors).toHaveLength(0);

    const skillRegistry = new SkillRegistry({ toolRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);

    const modelRegistry = new ModelRegistry();
    const provider: ProviderFactory = {
      name: 'openai',
      create: () =>
        ({ specificationVersion: 'v1', provider: 'openai' }) as unknown as LanguageModel,
    };
    modelRegistry.registerProvider(provider);
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    const agent = createAgent({
      agentDefinition: {
        id: 'agent-1',
        name: 'Agent One',
        personaId: 'coder',
        skillIds: ['file_management'],
        toolIds: ['read_file'],
        modelId: 'gpt-4o',
      },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
    });

    // The persona and its skills are still there...
    expect(agent.systemPrompt).toContain('# Persona: Software Engineer');
    // ...and the machine facts come with them, after the skills.
    expect(agent.systemPrompt).toContain('ENVIRONMENT (the machine this runtime runs on');
    expect(agent.systemPrompt).toContain(`platform: ${process.platform}`);
    expect(agent.systemPrompt).toContain('default shell:');
    expect(agent.systemPrompt).toContain('path separator');
    expect(agent.systemPrompt.indexOf('ENVIRONMENT (')).toBeGreaterThan(
      agent.systemPrompt.indexOf('# Skill:')
    );
  });
});
