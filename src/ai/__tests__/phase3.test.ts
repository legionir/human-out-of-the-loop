import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { readFileTool } from '../tools/implementations/read-file.js';
import { searchCodeTool } from '../tools/implementations/search-code.js';
import { writeFileTool } from '../tools/implementations/write-file.js';
import { gitStatusTool } from '../tools/implementations/git-status.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ─────────────────────────────────────────────────────

const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');

/**
 * Creates a ToolRegistry pre-populated with the four baseline tools
 * so that SkillRegistry cross-validation passes.
 */
function createToolRegistry(): ToolRegistry {
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

  return reg;
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
  it('loads all three sample skills from registry/skills/', () => {
    const toolRegistry = createToolRegistry();
    const reg = new SkillRegistry({ toolRegistry });

    const result = loadSkillsFromDirectory(SKILLS_DIR, reg);

    expect(result.loaded).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(reg.has('code_analysis')).toBe(true);
    expect(reg.has('git_operations')).toBe(true);
    expect(reg.has('file_management')).toBe(true);
  });

  it('resolved instructions contain real markdown content', () => {
    const toolRegistry = createToolRegistry();
    const reg = new SkillRegistry({ toolRegistry });
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
