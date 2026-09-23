import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel, Tool } from 'ai';
import { AgentRegistry } from '../registries/agent-registry.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createAgent, createAgentCached, AgentCache } from '../agents/agent-factory.js';
import type { CrossRegistryRefs } from '../registries/agent-registry.js';
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

// ─── Test infrastructure ─────────────────────────────────────────

const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');
const AGENTS_FILE = path.resolve(__dirname, '../../../registry/agents.json');

function fakeTool(name: string): Tool {
  return {
    description: `Fake ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] } as never,
    execute: async () => ({ ok: true }),
  } as unknown as Tool;
}

function createMockProvider(name: string): ProviderFactory {
  return {
    name,
    create: (config) =>
      ({
        specificationVersion: 'v1',
        provider: name,
        modelId: config.model,
        defaultObjectGenerationMode: 'json',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      }) as unknown as LanguageModel,
  };
}

interface TestRefs extends CrossRegistryRefs {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
}

function setupRegistries(): TestRefs {
  // Persona
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);

  // Tool
  const toolRegistry = new ToolRegistry();
  const toolDefs = [
    { id: 'read_file', name: 'Read', description: 'Read', source: 'local', modulePath: './r' },
    { id: 'search_code', name: 'Search', description: 'Search', source: 'local', modulePath: './s' },
    { id: 'write_file', name: 'Write', description: 'Write', source: 'local', modulePath: './w' },
    { id: 'git_status', name: 'Git', description: 'Git', source: 'local', modulePath: './g' },
  ];
  for (const d of toolDefs) toolRegistry.registerDefinition(d);
  toolRegistry.registerImplementation('read_file', readFileTool);
  toolRegistry.registerImplementation('search_code', searchCodeTool);
  toolRegistry.registerImplementation('write_file', writeFileTool);
  toolRegistry.registerImplementation('git_status', gitStatusTool);

  // Skill — bootstrap catalog tools first because task_decomposition depends on them
  const skillRegistry = new SkillRegistry({ toolRegistry });
  // inline bootstrap to avoid import cycle issues
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
      toolRegistry.registerImplementation(id, fakeTool(id));
    }
  }
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);

  // Model
  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerProvider(createMockProvider('anthropic'));
  modelRegistry.registerProvider(createMockProvider('local'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });
  modelRegistry.registerConfig({
    id: 'claude-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet',
  });

  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

// ─── AgentRegistry tests ────────────────────────────────────────

describe('AgentRegistry', () => {
  it('loads agents from registry/agents.json', () => {
    const reg = new AgentRegistry();
    const result = reg.loadFromFile(AGENTS_FILE);
    expect(result.loaded).toBeGreaterThanOrEqual(4);
    expect(result.errors).toHaveLength(0);
    expect(reg.has('coder')).toBe(true);
    expect(reg.has('researcher')).toBe(true);
    expect(reg.has('reviewer')).toBe(true);
    expect(reg.has('planner')).toBe(true);
  });

  it('validateAll detects missing persona reference', () => {
    const refs = setupRegistries();
    const reg = new AgentRegistry();
    reg.register({
      id: 'broken',
      name: 'Broken',
      personaId: 'nonexistent-persona',
      skillIds: [],
      modelId: 'gpt-4o',
    });

    const { valid, results } = reg.validateAll(refs);
    expect(valid).toBe(false);
    const broken = results.find((r) => r.agentId === 'broken')!;
    expect(broken.errors.some((e) => e.includes('nonexistent-persona'))).toBe(true);
  });

  it('validateAll detects missing skill reference', () => {
    const refs = setupRegistries();
    const reg = new AgentRegistry();
    reg.register({
      id: 'bad-skill',
      name: 'Bad',
      personaId: 'coder',
      skillIds: ['nonexistent-skill'],
      modelId: 'gpt-4o',
    });

    const { valid } = reg.validateAll(refs);
    expect(valid).toBe(false);
  });

  it('validateAll passes for valid agents', () => {
    const refs = setupRegistries();
    const reg = new AgentRegistry();
    reg.loadFromFile(AGENTS_FILE);

    const { valid, results } = reg.validateAll(refs);
    // All four agents in agents.json should be valid
    const errors = results.filter((r) => !r.valid);
    expect(errors).toHaveLength(0);
    expect(valid).toBe(true);
  });
});

// ─── createAgent tests ──────────────────────────────────────────

describe('createAgent', () => {
  let refs: TestRefs;

  beforeEach(() => {
    refs = setupRegistries();
  });

  it('creates a resolved agent with combined instructions', () => {
    const def = {
      id: 'coder',
      name: 'Coder',
      personaId: 'coder',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({ agentDefinition: def, refs });

    expect(agent.agentId).toBe('coder');
    expect(agent.systemPrompt).toContain('Persona: Software Engineer');
    expect(agent.systemPrompt).toContain('Skill: Code Analysis');
    expect(agent.systemPrompt).toContain('Code Analysis Skill');
  });

  it('includes only tools that are in persona.allowedTools', () => {
    // reviewer persona has allowedTools: ["read_file", "search_code"]
    // code_analysis skill needs: ["read_file", "search_code"]
    // So all tools should pass
    const def = {
      id: 'reviewer',
      name: 'Reviewer',
      personaId: 'reviewer',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({ agentDefinition: def, refs });

    expect(Object.keys(agent.tools)).toContain('read_file');
    expect(Object.keys(agent.tools)).toContain('search_code');
    expect(agent.toolWarnings).toHaveLength(0);
  });

  it('filters out tools NOT in persona.allowedTools and logs warnings', () => {
    // reviewer persona: allowedTools = ["read_file", "search_code"]
    // file_management skill needs: ["read_file", "write_file", "search_code"]
    // "write_file" should be filtered out
    const def = {
      id: 'restricted',
      name: 'Restricted',
      personaId: 'reviewer',
      skillIds: ['file_management'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({ agentDefinition: def, refs });

    expect(Object.keys(agent.tools)).toContain('read_file');
    expect(Object.keys(agent.tools)).toContain('search_code');
    expect(Object.keys(agent.tools)).not.toContain('write_file');

    expect(agent.toolWarnings).toHaveLength(1);
    expect(agent.toolWarnings[0].toolId).toBe('write_file');
    expect(agent.toolWarnings[0].skillId).toBe('file_management');
    expect(agent.toolWarnings[0].reason).toBe('not-in-allowedTools');
  });

  it('architect persona cannot use write_file even if skill requires it', () => {
    // architect: allowedTools = ["read_file", "search_code", "git_status"]
    // file_management needs: ["read_file", "write_file", "search_code"]
    const def = {
      id: 'arch-agent',
      name: 'Arch',
      personaId: 'architect',
      skillIds: ['file_management'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({ agentDefinition: def, refs });

    expect(Object.keys(agent.tools)).not.toContain('write_file');
    expect(agent.toolWarnings.some((w) => w.toolId === 'write_file')).toBe(true);
  });

  it('throws on missing persona', () => {
    expect(() =>
      createAgent({
        agentDefinition: {
          id: 'x',
          name: 'X',
          personaId: 'ghost',
          skillIds: [],
          modelId: 'gpt-4o',
        },
        refs,
      })
    ).toThrow(/Persona "ghost" not found/);
  });

  it('throws on missing model', () => {
    expect(() =>
      createAgent({
        agentDefinition: {
          id: 'x',
          name: 'X',
          personaId: 'coder',
          skillIds: [],
          modelId: 'nonexistent-model',
        },
        refs,
      })
    ).toThrow(/Model "nonexistent-model" not found/);
  });
});

// ─── Context Budget / Trimming tests ────────────────────────────

describe('Context Budget trimming', () => {
  let refs: TestRefs;

  beforeEach(() => {
    refs = setupRegistries();
  });

  it('does not trim when within budget', () => {
    const def = {
      id: 'coder',
      name: 'Coder',
      personaId: 'coder',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({
      agentDefinition: def,
      refs,
      contextBudgetChars: 100_000, // large budget
    });

    expect(agent.contextBudgetExceeded).toBe(false);
    expect(agent.trimmingLog).toHaveLength(0);
    expect(agent.systemPrompt).toContain('Code Analysis Skill');
  });

  it('trims low-priority skills first when over budget', () => {
    const def = {
      id: 'multi',
      name: 'Multi',
      personaId: 'coder',
      skillIds: ['code_analysis', 'git_operations', 'file_management'],
      modelId: 'gpt-4o',
    };

    // Use a very small budget to force trimming
    const agent = createAgent({
      agentDefinition: def,
      refs,
      contextBudgetChars: 500, // extremely small
    });

    expect(agent.contextBudgetExceeded).toBe(true);
    expect(agent.trimmingLog.length).toBeGreaterThan(0);

    // Persona system must ALWAYS be present
    expect(agent.systemPrompt).toContain('Persona: Software Engineer');
    expect(agent.systemPrompt).toContain('expert full-stack');
  });

  it('never trims persona.system even with tiny budget', () => {
    const def = {
      id: 'tiny',
      name: 'Tiny',
      personaId: 'coder',
      skillIds: ['code_analysis', 'file_management'],
      modelId: 'gpt-4o',
    };

    // Budget smaller than persona.system alone
    const personaSystem = refs.personaRegistry.get('coder')!.system;
    const tinyBudget = Math.floor(personaSystem.length * 0.5);

    const agent = createAgent({
      agentDefinition: def,
      refs,
      contextBudgetChars: tinyBudget,
    });

    // Persona is included in full even though it exceeds budget
    expect(agent.systemPrompt).toContain(personaSystem);
    expect(agent.contextBudgetExceeded).toBe(true);
  });

  it('trimming log records which skills were affected', () => {
    const def = {
      id: 'trim-test',
      name: 'Trim',
      personaId: 'coder',
      skillIds: ['code_analysis', 'git_operations', 'file_management'],
      modelId: 'gpt-4o',
    };

    const agent = createAgent({
      agentDefinition: def,
      refs,
      contextBudgetChars: 800,
    });

    if (agent.trimmingLog.length > 0) {
      for (const record of agent.trimmingLog) {
        expect(record.skillId).toBeDefined();
        expect(record.originalLength).toBeGreaterThan(0);
        expect(record.trimmedLength).toBeLessThan(record.originalLength);
        expect(record.reason).toBe('context-budget');
      }
    }
  });
});

// ─── Agent Cache tests ──────────────────────────────────────────

describe('AgentCache', () => {
  let refs: TestRefs;

  beforeEach(() => {
    refs = setupRegistries();
  });

  it('caches and returns the same resolved agent on second call', () => {
    const cache = new AgentCache();
    const def = {
      id: 'cached-agent',
      name: 'Cached',
      personaId: 'coder',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };

    const first = createAgentCached({ agentDefinition: def, refs }, cache);
    const second = createAgentCached({ agentDefinition: def, refs }, cache);

    expect(first).toBe(second); // Same reference
    expect(cache.size).toBe(1);
  });

  it('invalidates cache when definition changes', () => {
    const cache = new AgentCache();
    const def1 = {
      id: 'evolving',
      name: 'V1',
      personaId: 'coder',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };

    const first = createAgentCached({ agentDefinition: def1, refs }, cache);

    // Change the definition (add a skill)
    const def2 = {
      ...def1,
      skillIds: ['code_analysis', 'git_operations'],
    };

    const second = createAgentCached({ agentDefinition: def2, refs }, cache);

    expect(first).not.toBe(second);
    expect(second.skills.length).toBeGreaterThan(first.skills.length);
  });

  it('manual invalidate forces re-creation', () => {
    const cache = new AgentCache();
    const def = {
      id: 'manual',
      name: 'M',
      personaId: 'coder',
      skillIds: [],
      modelId: 'gpt-4o',
    };

    createAgentCached({ agentDefinition: def, refs }, cache);
    expect(cache.size).toBe(1);

    cache.invalidate('manual');
    expect(cache.size).toBe(0);
  });
});
