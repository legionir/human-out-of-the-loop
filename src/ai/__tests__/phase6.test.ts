import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { AgentRegistry } from '../registries/agent-registry.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import {
  createDelegateTaskTool,
  checkAuthorization,
  type DelegateTaskDeps,
} from '../tools/implementations/delegate-task.js';
import { createReadFileTool } from '../tools/implementations/read-file.js';
import { createSearchCodeTool } from '../tools/implementations/search-code.js';
import { createWriteFileTool } from '../tools/implementations/write-file.js';
import { createGitStatusTool } from '../tools/implementations/git-status.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

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

interface TestDeps {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
}

function setup(): TestDeps {
  const personaRegistry = new PersonaRegistry();
  personaRegistry.loadFromDirectory(PERSONAS_DIR);

  const toolRegistry = new ToolRegistry();
  for (const d of [
    { id: 'read_file', name: 'R', description: 'R', source: 'local' as const, modulePath: './r' },
    { id: 'search_code', name: 'S', description: 'S', source: 'local' as const, modulePath: './s' },
    { id: 'write_file', name: 'W', description: 'W', source: 'local' as const, modulePath: './w' },
    { id: 'git_status', name: 'G', description: 'G', source: 'local' as const, modulePath: './g' },
  ]) toolRegistry.registerDefinition(d);
  toolRegistry.registerImplementation('read_file', readFileTool);
  toolRegistry.registerImplementation('search_code', searchCodeTool);
  toolRegistry.registerImplementation('write_file', writeFileTool);
  toolRegistry.registerImplementation('git_status', gitStatusTool);
  // Phase 33: register the reference filesystem toolset so skill cross-validation
  // (registry/skills/*) sees the same catalog as production bootstrapTools().
  registerLocalToolFixtures(toolRegistry, TEST_ROOT);

  const skillRegistry = new SkillRegistry({ toolRegistry });
  // Bootstrap catalog tools BEFORE loading skills because task_decomposition depends on them
  bootstrapCatalogTools({
    toolRegistry,
    personaRegistry,
    skillRegistry,
  });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerProvider(createMockProvider('anthropic'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });
  modelRegistry.registerConfig({ id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet' });

  const agentRegistry = new AgentRegistry();
  agentRegistry.loadFromFile(AGENTS_FILE);

  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry, agentRegistry };
}

// ─── Catalog Tools ───────────────────────────────────────────────

describe('Catalog Tools', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = setup();
    bootstrapCatalogTools({
      toolRegistry: deps.toolRegistry,
      personaRegistry: deps.personaRegistry,
      skillRegistry: deps.skillRegistry,
    });
  });

  it('list_personas returns lightweight summaries', async () => {
    const tool = deps.toolRegistry.getImplementation('list_personas')!;
    const execute = (tool as any).execute;
    const result = await execute({});

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(result.personas[0]).toHaveProperty('id');
    expect(result.personas[0]).toHaveProperty('name');
    expect(result.personas[0]).toHaveProperty('allowedTools');
    // Should NOT include the full system prompt
    expect(result.personas[0]).not.toHaveProperty('system');
  });

  it('list_skills returns summaries with tool lists and priority', async () => {
    const tool = deps.toolRegistry.getImplementation('list_skills')!;
    const execute = (tool as any).execute;
    const result = await execute({});

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(3);
    const codeAnalysis = result.skills.find((s: any) => s.id === 'code_analysis');
    expect(codeAnalysis).toBeDefined();
    expect(codeAnalysis.tools).toContain('read_file');
    expect(codeAnalysis.priority).toBeDefined();
    // Should NOT include full instructions
    expect(codeAnalysis).not.toHaveProperty('resolvedInstructions');
  });

  it('list_tools returns all tools with source info', async () => {
    const tool = deps.toolRegistry.getImplementation('list_tools')!;
    const execute = (tool as any).execute;
    const result = await execute({ source: 'all' });

    expect(result.success).toBe(true);
    // 14 filesystem/git tools + 3 catalog = 17
    expect(result.count).toBeGreaterThanOrEqual(17);
    expect(result.tools[0]).toHaveProperty('source');
    expect(result.tools[0]).toHaveProperty('hasImplementation');
  });

  it('list_tools filters by source', async () => {
    const tool = deps.toolRegistry.getImplementation('list_tools')!;
    const execute = (tool as any).execute;
    const result = await execute({ source: 'local' });

    expect(result.success).toBe(true);
    for (const t of result.tools) {
      expect(t.source).toBe('local');
    }
  });
});

// ─── Authorization Gate ──────────────────────────────────────────

describe('checkAuthorization', () => {
  let personaRegistry: PersonaRegistry;

  beforeEach(() => {
    personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
  });

  it('authorizes tools that are in allowedTools', () => {
    const result = checkAuthorization('coder', ['read_file', 'write_file'], personaRegistry);
    expect(result.authorized).toBe(true);
    expect(result.deniedTools).toEqual([]);
    expect(result.allowedTools).toEqual(['read_file', 'write_file']);
  });

  it('denies tools not in allowedTools', () => {
    // reviewer: allowedTools = ["read_file", "search_code"]
    const result = checkAuthorization('reviewer', ['read_file', 'write_file'], personaRegistry);
    expect(result.authorized).toBe(false);
    expect(result.deniedTools).toEqual(['write_file']);
    expect(result.allowedTools).toEqual(['read_file']);
  });

  it('denies all tools for unknown persona', () => {
    const result = checkAuthorization('ghost', ['read_file'], personaRegistry);
    expect(result.authorized).toBe(false);
    expect(result.deniedTools).toEqual(['read_file']);
  });

  it('handles wildcard allowedTools', () => {
    personaRegistry.register({
      id: 'admin',
      name: 'Admin',
      system: 'You are admin.',
      allowedTools: ['*'],
    });
    const result = checkAuthorization('admin', ['read_file', 'write_file', 'anything'], personaRegistry);
    expect(result.authorized).toBe(true);
    expect(result.deniedTools).toEqual([]);
  });
});

// ─── delegate_task — Dynamic mode ────────────────────────────────

describe('delegate_task — dynamic mode', () => {
  let deps: TestDeps;
  let delegateDeps: DelegateTaskDeps;
  let execute: (input: any) => Promise<any>;

  beforeEach(() => {
    deps = setup();
    delegateDeps = {
      personaRegistry: deps.personaRegistry,
      skillRegistry: deps.skillRegistry,
      toolRegistry: deps.toolRegistry,
      modelRegistry: deps.modelRegistry,
      onTaskCreated: vi.fn().mockResolvedValue('task-123'),
    };
    const tool = createDelegateTaskTool(delegateDeps);
    execute = (tool as any).execute;
  });

  it('creates a dynamic agent with valid composition', async () => {
    const result = await execute({
      mode: 'dynamic',
      persona: 'coder',
      skills: ['code_analysis'],
      tools: ['read_file', 'search_code'],
      model: 'gpt-4o',
      prompt: 'Analyse the main module',
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('task-123');
    expect(result.persona).toBe('coder');
    expect(result.skillsUsed).toContain('code_analysis');
    expect(result.toolsGranted).toContain('read_file');
    expect(result.toolsGranted).toContain('search_code');
    expect(result.toolsDenied).toEqual([]);
    expect(delegateDeps.onTaskCreated).toHaveBeenCalledOnce();
  });

  it('rejects dynamic composition with unauthorized tool', async () => {
    // reviewer: allowedTools = ["read_file", "search_code"]
    const result = await execute({
      mode: 'dynamic',
      persona: 'reviewer',
      skills: ['file_management'],
      tools: ['read_file', 'write_file'], // write_file NOT allowed for reviewer
      model: 'gpt-4o',
      prompt: 'Review and fix the code',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('AUTHORIZATION_DENIED');
    expect(result.deniedTools).toContain('write_file');
    expect(result.error).toContain('write_file');
    // Task should NOT have been created
    expect(delegateDeps.onTaskCreated).not.toHaveBeenCalled();
  });

  it('rejects dynamic composition with non-existent persona', async () => {
    const result = await execute({
      mode: 'dynamic',
      persona: 'nonexistent',
      skills: [],
      tools: [],
      model: 'gpt-4o',
      prompt: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PERSONA_NOT_FOUND');
  });

  it('rejects dynamic composition with non-existent skill', async () => {
    const result = await execute({
      mode: 'dynamic',
      persona: 'coder',
      skills: ['nonexistent_skill'],
      tools: [],
      model: 'gpt-4o',
      prompt: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SKILL_NOT_FOUND');
    expect(result.invalidSkill).toBe('nonexistent_skill');
  });

  it('rejects dynamic composition with non-existent model', async () => {
    const result = await execute({
      mode: 'dynamic',
      persona: 'coder',
      skills: [],
      tools: [],
      model: 'nonexistent-model',
      prompt: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('MODEL_NOT_FOUND');
  });

  it('rejects dynamic composition with non-existent tool', async () => {
    const result = await execute({
      mode: 'dynamic',
      persona: 'coder',
      skills: [],
      tools: ['nonexistent_tool'],
      model: 'gpt-4o',
      prompt: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('TOOL_NOT_FOUND');
  });
});

// ─── delegate_task — Static mode ─────────────────────────────────

describe('delegate_task — static mode', () => {
  let deps: TestDeps;
  let execute: (input: any) => Promise<any>;

  beforeEach(() => {
    deps = setup();
    const delegateDeps: DelegateTaskDeps = {
      personaRegistry: deps.personaRegistry,
      skillRegistry: deps.skillRegistry,
      toolRegistry: deps.toolRegistry,
      modelRegistry: deps.modelRegistry,
      onTaskCreated: vi.fn().mockResolvedValue('task-456'),
      resolveAgentId: (id) => deps.agentRegistry.get(id),
    };
    const tool = createDelegateTaskTool(delegateDeps);
    execute = (tool as any).execute;
  });

  it('delegates to a pre-registered agent by id', async () => {
    const result = await execute({
      mode: 'static',
      agentId: 'coder',
      prompt: 'Implement the login module',
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('task-456');
    expect(result.persona).toBe('coder');
  });

  it('returns error for non-existent agent id', async () => {
    const result = await execute({
      mode: 'static',
      agentId: 'nonexistent-agent',
      prompt: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('AGENT_NOT_FOUND');
  });
});
