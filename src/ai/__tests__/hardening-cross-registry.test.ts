import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry';
import { ToolRegistry } from '../registries/tool-registry';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry';
import { AgentRegistry } from '../registries/agent-registry';
import { createAgent } from '../agents/agent-factory';
import { personaAllowsTool } from '../schemas/persona';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap';
import { readFileTool } from '../tools/implementations/read-file';
import { searchCodeTool } from '../tools/implementations/search-code';
import { writeFileTool } from '../tools/implementations/write-file';
import { gitStatusTool } from '../tools/implementations/git-status';

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

interface FullRefs {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
}

function setupFull(): FullRefs {
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

  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry, false);
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerProvider(createMockProvider('anthropic'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });
  modelRegistry.registerConfig({ id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet' });

  const agentRegistry = new AgentRegistry();
  agentRegistry.loadFromFile(AGENTS_FILE);

  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry, agentRegistry };
}

// ─── Cross-registry error paths ──────────────────────────────────

describe('Cross-registry validation — exhaustive error paths', () => {
  let refs: FullRefs;

  beforeEach(() => {
    refs = setupFull();
  });

  it('AgentRegistry.validateAll catches missing model reference', () => {
    refs.agentRegistry.register({
      id: 'bad-model-agent',
      name: 'Bad',
      personaId: 'coder',
      skillIds: [],
      modelId: 'nonexistent-model-xyz',
    });

    const { valid, results } = refs.agentRegistry.validateAll({
      personaRegistry: refs.personaRegistry,
      skillRegistry: refs.skillRegistry,
      toolRegistry: refs.toolRegistry,
      modelRegistry: refs.modelRegistry,
    });

    expect(valid).toBe(false);
    const bad = results.find((r) => r.agentId === 'bad-model-agent')!;
    expect(bad.errors.some((e) => e.includes('nonexistent-model-xyz'))).toBe(true);
  });

  it('AgentRegistry.validateAll catches missing skill in agent definition', () => {
    refs.agentRegistry.register({
      id: 'bad-skill-agent',
      name: 'Bad',
      personaId: 'coder',
      skillIds: ['nonexistent_skill_xyz'],
      modelId: 'gpt-4o',
    });

    const { valid, results } = refs.agentRegistry.validateAll({
      personaRegistry: refs.personaRegistry,
      skillRegistry: refs.skillRegistry,
      toolRegistry: refs.toolRegistry,
      modelRegistry: refs.modelRegistry,
    });

    expect(valid).toBe(false);
    const bad = results.find((r) => r.agentId === 'bad-skill-agent')!;
    expect(bad.errors.some((e) => e.includes('nonexistent_skill_xyz'))).toBe(true);
  });

  it('SkillRegistry rejects skill referencing MCP tool that does not exist', () => {
    expect(() =>
      refs.skillRegistry.registerFromDirectory(
        {
          id: 'mcp-dependent',
          name: 'MCP Dep',
          version: '1.0',
          instructions: 'Use the mcp_search tool',
          tools: ['mcp_nonexistent_tool'],
        },
        '/tmp'
      )
    ).toThrow(/unknown tool.*mcp_nonexistent_tool/);
  });

  it('createAgent throws when skill references tool not in ToolRegistry at runtime', () => {
    const skillReg = new SkillRegistry({ toolRegistry: refs.toolRegistry });
    const badSkill = {
      id: 'orphan-skill',
      name: 'Orphan',
      version: '1.0',
      instructions: 'Do stuff',
      resolvedInstructions: 'Do stuff',
      resolvedTools: ['deleted_tool'],
      tools: ['deleted_tool'],
      priority: 50,
    };

    (skillReg as any).resolved.set('orphan-skill', badSkill);

    // Register a persona that allows deleted_tool so that getToolsByIds is invoked
    refs.personaRegistry.register({
      id: 'test-allower',
      name: 'Test Allower',
      system: 'Allows deleted_tool',
      allowedTools: ['deleted_tool', '*'],
    });

    expect(() =>
      createAgent({
        agentDefinition: {
          id: 'test',
          name: 'Test',
          personaId: 'test-allower',
          skillIds: ['orphan-skill'],
          modelId: 'gpt-4o',
        },
        refs: {
          personaRegistry: refs.personaRegistry,
          skillRegistry: skillReg,
          toolRegistry: refs.toolRegistry,
          modelRegistry: refs.modelRegistry,
        },
      })
    ).toThrow();
  });
});

// ─── Authorization (allowedTools) — both paths ──────────────────

describe('Authorization — allowedTools enforced in ALL agent creation paths', () => {
  let refs: FullRefs;

  beforeEach(() => {
    refs = setupFull();
  });

  it('STATIC path: createAgent filters tools not in persona.allowedTools', () => {
    const agent = createAgent({
      agentDefinition: {
        id: 'restricted-static',
        name: 'Restricted',
        personaId: 'reviewer',
        skillIds: ['file_management'],
        modelId: 'gpt-4o',
      },
      refs: {
        personaRegistry: refs.personaRegistry,
        skillRegistry: refs.skillRegistry,
        toolRegistry: refs.toolRegistry,
        modelRegistry: refs.modelRegistry,
      },
    });

    expect(Object.keys(agent.tools)).not.toContain('write_file');
    expect(agent.toolWarnings.some((w) => w.toolId === 'write_file')).toBe(true);
  });

  it('DYNAMIC path: delegate_task authorization gate rejects unauthorized tools', async () => {
    const { checkAuthorization } = await import('../tools/implementations/delegate-task');

    const result = checkAuthorization(
      'architect',
      ['read_file', 'write_file', 'git_status'],
      refs.personaRegistry
    );

    expect(result.authorized).toBe(false);
    expect(result.deniedTools).toContain('write_file');
    expect(result.allowedTools).toContain('read_file');
    expect(result.allowedTools).toContain('git_status');
  });

  it('Wildcard persona (*) bypasses allowedTools check', () => {
    refs.personaRegistry.register({
      id: 'superadmin',
      name: 'Super Admin',
      system: 'You have full access.',
      allowedTools: ['*'],
    });

    expect(personaAllowsTool(refs.personaRegistry.get('superadmin')!, 'any_tool')).toBe(true);
    expect(personaAllowsTool(refs.personaRegistry.get('superadmin')!, 'write_file')).toBe(true);
  });

  it('Empty allowedTools means no tools permitted', () => {
    refs.personaRegistry.register({
      id: 'observer',
      name: 'Observer',
      system: 'You only observe.',
      allowedTools: [],
    });

    expect(personaAllowsTool(refs.personaRegistry.get('observer')!, 'read_file')).toBe(false);
  });
});

// ─── MCP connector edge cases ────────────────────────────────────

describe('MCP Connector — additional edge cases', () => {
  it('ToolRegistry.getToolsByIds works uniformly for local and MCP tools', () => {
    const reg = new ToolRegistry();

    reg.registerDefinition({
      id: 'local_t',
      name: 'Local',
      description: 'Local tool',
      source: 'local',
      modulePath: './local',
    });
    reg.registerImplementation('local_t', readFileTool);

    reg.registerDefinition({
      id: 'mcp_t',
      name: 'MCP',
      description: 'MCP tool',
      source: 'mcp',
      mcpServerId: 'test-server',
    });
    reg.registerImplementation('mcp_t', searchCodeTool);

    const tools = reg.getToolsByIds(['local_t', 'mcp_t']);
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools['local_t']).toBe(readFileTool);
    expect(tools['mcp_t']).toBe(searchCodeTool);
  });
});
