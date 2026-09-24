import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGitStatusTool } from '../tools/implementations/git-status.js';

// Phase 18: filesystem tools are factories bound to a workspace root.
// Tests run from the repo root, so binding to process.cwd() keeps behavior identical.
const TEST_ROOT = process.cwd();
const readFileTool = createReadFileTool(TEST_ROOT);
const searchCodeTool = createSearchCodeTool(TEST_ROOT);
const writeFileTool = createWriteFileTool(TEST_ROOT);
const gitStatusTool = createGitStatusTool(TEST_ROOT);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ─────────────────────────────────────────────────────

const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');

/**
 * Creates a ToolRegistry pre-populated with the four baseline tools
 * so that SkillRegistry cross-validation passes.
 */
function createToolRegistry(withCatalog = false, personaRegistry?: any, skillRegistry?: any): ToolRegistry {
  const reg = new ToolRegistry();

  const defs = [
    {
      id: 'read_file',
      name: 'Read File',
      description: 'Reads a file',
      source: 'local' as const,
      modulePath: './read-file',
    },
    {
      id: 'search_code',
      name: 'Search Code',
      description: 'Searches code',
      source: 'local' as const,
      modulePath: './search-code',
    },
    {
      id: 'write_file',
      name: 'Write File',
      description: 'Writes a file',
      source: 'local' as const,
      modulePath: './write-file',
    },
    {
      id: 'git_status',
      name: 'Git Status',
      description: 'Git status',
      source: 'local' as const,
      modulePath: './git-status',
    },
  ];
  for (const d of defs) reg.registerDefinition(d);

  reg.registerImplementation('read_file', readFileTool);
  reg.registerImplementation('search_code', searchCodeTool);
  reg.registerImplementation('write_file', writeFileTool);
  reg.registerImplementation('git_status', gitStatusTool);

  if (withCatalog && personaRegistry && skillRegistry) {
    // Dynamically import to avoid circular deps — use require-like via import
    // But we can inline the bootstrap logic for catalog tools here
    // Instead, caller will bootstrap after creating registries
  }

  return reg;
}

function bootstrapCatalogForTest(
  toolRegistry: ToolRegistry,
  personaRegistry: any,
  skillRegistry: any
) {
  // Inline minimal catalog bootstrap to avoid import cycles in this helper
  // We use the actual bootstrap function if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bootstrapCatalogTools } = require('../tools/catalog-bootstrap.js');
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  } catch {
    // Fallback: register dummy definitions so task_decomposition validation passes
    for (const id of ['list_personas', 'list_skills', 'list_tools']) {
      if (!toolRegistry.hasDefinition(id)) {
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
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({ success: true }),
        } as any);
      }
    }
  }
}

// ─── SkillRegistry unit tests ───────────────────────────────────

describe('SkillRegistry', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = createToolRegistry();
  });

  it('registers a skill and resolves SKILL.md instructions', () => {
    const reg = new SkillRegistry({ toolRegistry });
    const skillDir = path.join(SKILLS_DIR, 'code_analysis');
    const raw = {
      id: 'code_analysis',
      name: 'Code Analysis',
      version: '1.0.0',
      instructions: 'SKILL.md',
      tools: ['read_file', 'search_code'],
    };

    const resolved = reg.registerFromDirectory(raw, skillDir);

    expect(resolved.id).toBe('code_analysis');
    expect(resolved.resolvedInstructions).toContain('Code Analysis Skill');
    expect(resolved.resolvedInstructions).toContain('read_file');
    expect(resolved.resolvedTools).toEqual(['read_file', 'search_code']);
  });

  it('get() returns the resolved skill', () => {
    const reg = new SkillRegistry({ toolRegistry });
    const skillDir = path.join(SKILLS_DIR, 'code_analysis');
    reg.registerFromDirectory(
      {
        id: 'code_analysis',
        name: 'Code Analysis',
        version: '1.0.0',
        instructions: 'SKILL.md',
        tools: ['read_file', 'search_code'],
      },
      skillDir
    );

    const skill = reg.get('code_analysis');
    expect(skill).toBeDefined();
    expect(skill!.resolvedInstructions.length).toBeGreaterThan(50);
  });

  it('throws on reference to non-existent tool id', () => {
    const reg = new SkillRegistry({ toolRegistry });
    const skillDir = path.join(SKILLS_DIR, 'code_analysis');

    expect(() =>
      reg.registerFromDirectory(
        {
          id: 'broken_skill',
          name: 'Broken',
          version: '1.0.0',
          instructions: 'SKILL.md',
          tools: ['read_file', 'nonexistent_tool'],
        },
        skillDir
      )
    ).toThrow(/unknown tool.*nonexistent_tool/);
  });

  it('throws when SKILL.md file is missing', () => {
    const reg = new SkillRegistry({ toolRegistry });

    expect(() =>
      reg.registerFromDirectory(
        {
          id: 'missing_md',
          name: 'Missing MD',
          version: '1.0.0',
          instructions: 'NONEXISTENT.md',
          tools: [],
        },
        '/tmp/fake-skill-dir'
      )
    ).toThrow(/was not found/);
  });

  it('supports inline instructions (no .md file)', () => {
    const reg = new SkillRegistry({ toolRegistry });

    const resolved = reg.registerFromDirectory(
      {
        id: 'inline_skill',
        name: 'Inline',
        version: '1.0.0',
        instructions: 'You are a helpful assistant. Use read_file to read files.',
        tools: ['read_file'],
      },
      '/tmp/does-not-matter'
    );

    expect(resolved.resolvedInstructions).toBe(
      'You are a helpful assistant. Use read_file to read files.'
    );
  });

  it('list() returns all resolved skills', () => {
    const reg = new SkillRegistry({ toolRegistry });

    reg.registerFromDirectory(
      { id: 's1', name: 'S1', version: '1.0', instructions: 'Do stuff', tools: [] },
      '/tmp'
    );
    reg.registerFromDirectory(
      { id: 's2', name: 'S2', version: '1.0', instructions: 'Do more', tools: [] },
      '/tmp'
    );

    expect(reg.list()).toHaveLength(2);
    expect(reg.size).toBe(2);
  });
});

// ─── loadSkillsFromDirectory integration ────────────────────────

describe('loadSkillsFromDirectory', () => {
  it('loads all sample skills from registry/skills/', async () => {
    const { PersonaRegistry } = await import('../registries/persona-registry.js');
    const { bootstrapCatalogTools } = await import('../tools/catalog-bootstrap.js');
    const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);

    const toolRegistry = createToolRegistry();
    const reg = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry: reg });

    const result = loadSkillsFromDirectory(SKILLS_DIR, reg);

    // Now 4 skills: code_analysis, file_management, git_operations, task_decomposition
    expect(result.loaded).toBeGreaterThanOrEqual(4);
    expect(result.errors).toHaveLength(0);
    expect(reg.has('code_analysis')).toBe(true);
    expect(reg.has('git_operations')).toBe(true);
    expect(reg.has('file_management')).toBe(true);
    expect(reg.has('task_decomposition')).toBe(true);
  });

  it('resolved instructions contain real markdown content', async () => {
    const { PersonaRegistry } = await import('../registries/persona-registry.js');
    const { bootstrapCatalogTools } = await import('../tools/catalog-bootstrap.js');
    const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);

    const toolRegistry = createToolRegistry();
    const reg = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry: reg });
    loadSkillsFromDirectory(SKILLS_DIR, reg);

    const codeAnalysis = reg.get('code_analysis')!;
    expect(codeAnalysis.resolvedInstructions).toContain('# Code Analysis Skill');
    expect(codeAnalysis.resolvedInstructions).toContain('## Process');

    const gitOps = reg.get('git_operations')!;
    expect(gitOps.resolvedInstructions).toContain('# Git Operations Skill');
  });

  it('throws in strict mode when directory does not exist', () => {
    const toolRegistry = createToolRegistry();
    const reg = new SkillRegistry({ toolRegistry });

    expect(() => loadSkillsFromDirectory('/nonexistent/skills', reg, true)).toThrow(
      /Directory not found/
    );
  });
});
