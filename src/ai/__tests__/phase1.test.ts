import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../registries/base-registry.js';
import {
  PersonaSchema,
  personaAllowsTool,
  SkillSchema,
  ToolDefinitionSchema,
  AgentDefinitionSchema,
  ModelConfigSchema,
} from '../schemas/index.js';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Base Registry ───────────────────────────────────────────────
describe('createRegistry (base)', () => {
  const TestSchema = z.object({
    id: z.string(),
    value: z.number(),
  });

  it('registers and retrieves an entry', () => {
    const reg = createRegistry({ schema: TestSchema, label: 'Test' });
    reg.register({ id: 'a', value: 1 });
    expect(reg.get('a')).toEqual({ id: 'a', value: 1 });
    expect(reg.has('a')).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it('throws on duplicate id', () => {
    const reg = createRegistry({ schema: TestSchema, label: 'Test' });
    reg.register({ id: 'a', value: 1 });
    expect(() => reg.register({ id: 'a', value: 2 })).toThrow(/Duplicate id/);
  });

  it('throws on invalid schema', () => {
    const reg = createRegistry({ schema: TestSchema, label: 'Test' });
    expect(() => reg.register({ id: 'a', value: 'not-a-number' as unknown as number })).toThrow(
      /Validation failed/
    );
  });

  it('tryRegister returns error result instead of throwing', () => {
    const reg = createRegistry({ schema: TestSchema, label: 'Test' });
    const result = reg.tryRegister({ id: 'a', value: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('validation');
    }
  });

  it('tryRegister returns duplicate reason on duplicate', () => {
    const reg = createRegistry({ schema: TestSchema, label: 'Test' });
    reg.register({ id: 'dup', value: 1 });
    const result = reg.tryRegister({ id: 'dup', value: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('duplicate');
    }
  });
});

// ─── Schemas ─────────────────────────────────────────────────────
describe('Zod Schemas', () => {
  it('PersonaSchema accepts valid data', () => {
    const data = { id: 'architect', name: 'Architect', system: 'You design systems.' };
    const parsed = PersonaSchema.parse(data);
    expect(parsed.id).toEqual('architect');
    expect(parsed.allowedTools).toEqual([]);
  });

  it('PersonaSchema rejects empty system', () => {
    expect(() => PersonaSchema.parse({ id: 'x', name: 'X', system: '' })).toThrow();
  });

  it('SkillSchema accepts valid data with tools', () => {
    const data = {
      id: 'code_analysis',
      name: 'Code Analysis',
      version: '1.0.0',
      instructions: 'Analyse code for bugs.',
      tools: ['read_file', 'search_code'],
    };
    expect(SkillSchema.parse(data).tools).toEqual(['read_file', 'search_code']);
  });

  it('ToolDefinitionSchema rejects missing modulePath when source local', () => {
    expect(() =>
      ToolDefinitionSchema.parse({ id: 't', name: 'T', description: 'D', source: 'local' })
    ).toThrow(/modulePath is required/);
  });

  it('ToolDefinitionSchema accepts valid local', () => {
    const data = {
      id: 't',
      name: 'T',
      description: 'D',
      source: 'local' as const,
      modulePath: './t',
    };
    const parsed = ToolDefinitionSchema.parse(data);
    expect(parsed.source).toBe('local');
  });

  it('AgentDefinitionSchema accepts valid refs', () => {
    const data = {
      id: 'coder',
      name: 'Coder',
      personaId: 'coder-persona',
      skillIds: ['code_analysis'],
      modelId: 'gpt-4o',
    };
    expect(AgentDefinitionSchema.parse(data)).toMatchObject(data);
  });

  it('ModelConfigSchema accepts valid config', () => {
    const data = {
      id: 'gpt-4o',
      provider: 'openai',
      model: 'gpt-4o',
      config: { temperature: 0.2 },
    };
    expect(ModelConfigSchema.parse(data).config?.temperature).toBe(0.2);
  });
});

describe('Zod Schemas — updated fields (allowedTools & source)', () => {
  it('PersonaSchema requires allowedTools array (default empty)', () => {
    const parsed = PersonaSchema.parse({
      id: 'x',
      name: 'X',
      system: 'You are X.',
    });
    expect(parsed.allowedTools).toEqual([]);
  });

  it('PersonaSchema accepts explicit allowedTools', () => {
    const parsed = PersonaSchema.parse({
      id: 'x',
      name: 'X',
      system: 'You are X.',
      allowedTools: ['read_file', 'search_code'],
    });
    expect(parsed.allowedTools).toEqual(['read_file', 'search_code']);
  });

  it('personaAllowsTool respects wildcard', () => {
    const persona = { id: 'a', name: 'A', system: 's', allowedTools: ['*'] };
    expect(personaAllowsTool(persona, 'anything')).toBe(true);
  });

  it('personaAllowsTool rejects unlisted tool', () => {
    const persona = { id: 'a', name: 'A', system: 's', allowedTools: ['read_file'] };
    expect(personaAllowsTool(persona, 'write_file')).toBe(false);
    expect(personaAllowsTool(persona, 'read_file')).toBe(true);
  });

  it('ToolDefinitionSchema defaults source to "local"', () => {
    const parsed = ToolDefinitionSchema.parse({
      id: 't',
      name: 'T',
      description: 'D',
      modulePath: './t',
    });
    expect(parsed.source).toBe('local');
  });

  it('ToolDefinitionSchema requires modulePath when source="local"', () => {
    expect(() =>
      ToolDefinitionSchema.parse({
        id: 't',
        name: 'T',
        description: 'D',
        source: 'local',
      })
    ).toThrow(/modulePath is required/);
  });

  it('ToolDefinitionSchema requires mcpServerId when source="mcp"', () => {
    expect(() =>
      ToolDefinitionSchema.parse({
        id: 't',
        name: 'T',
        description: 'D',
        source: 'mcp',
      })
    ).toThrow(/mcpServerId is required/);
  });

  it('ToolDefinitionSchema accepts MCP tool with mcpServerId', () => {
    const parsed = ToolDefinitionSchema.parse({
      id: 'mcp_tool',
      name: 'MCP Tool',
      description: 'From MCP server',
      source: 'mcp',
      mcpServerId: 'my-mcp-server',
    });
    expect(parsed.source).toBe('mcp');
    expect(parsed.mcpServerId).toBe('my-mcp-server');
  });
});

// ─── Loader ──────────────────────────────────────────────────────
describe('loadRegistryFromDirectory', () => {
  it('loads valid JSON files from registry/personas/', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    const dir = path.resolve(__dirname, '../../../registry/personas');
    const result = loadRegistryFromDirectory({
      directory: dir,
      registry: reg,
      schema: PersonaSchema,
    });
    expect(result.loaded).toBeGreaterThanOrEqual(4);
    expect(result.errors).toHaveLength(0);
    expect(reg.has('coder')).toBe(true);
    expect(reg.has('architect')).toBe(true);
    expect(reg.has('reviewer')).toBe(true);
    expect(reg.has('planner')).toBe(true);
  });

  it('loads valid JSON files from registry/tools/', () => {
    const reg = createRegistry({ schema: ToolDefinitionSchema, label: 'Tool' });
    const dir = path.resolve(__dirname, '../../../registry/tools');
    const result = loadRegistryFromDirectory({
      directory: dir,
      registry: reg,
      schema: ToolDefinitionSchema,
    });
    expect(result.loaded).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
    expect(reg.has('read_file')).toBe(true);
  });

  it('reports error for non-existent directory without throwing', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    const result = loadRegistryFromDirectory({
      directory: '/nonexistent/path',
      registry: reg,
      schema: PersonaSchema,
    });
    expect(result.loaded).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('throws in strict mode on errors', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    expect(() =>
      loadRegistryFromDirectory({
        directory: '/nonexistent/path',
        registry: reg,
        schema: PersonaSchema,
        strict: true,
      })
    ).toThrow();
  });

  it('every loaded persona has allowedTools defined', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    const dir = path.resolve(__dirname, '../../../registry/personas');
    loadRegistryFromDirectory({ directory: dir, registry: reg, schema: PersonaSchema });
    for (const persona of reg.list()) {
      expect(persona.allowedTools).toBeDefined();
      expect(Array.isArray(persona.allowedTools)).toBe(true);
    }
  });

  it('planner persona has catalog + control tools in allowedTools', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    const dir = path.resolve(__dirname, '../../../registry/personas');
    loadRegistryFromDirectory({ directory: dir, registry: reg, schema: PersonaSchema });
    const planner = reg.get('planner')!;
    expect(planner.allowedTools).toContain('list_personas');
    expect(planner.allowedTools).toContain('list_skills');
    expect(planner.allowedTools).toContain('list_tools');
    expect(planner.allowedTools).toContain('create_task');
  });

  it('reviewer persona has read-only tools only', () => {
    const reg = createRegistry({ schema: PersonaSchema, label: 'Persona' });
    const dir = path.resolve(__dirname, '../../../registry/personas');
    loadRegistryFromDirectory({ directory: dir, registry: reg, schema: PersonaSchema });
    const reviewer = reg.get('reviewer')!;
    expect(reviewer.allowedTools).toContain('read_file');
    expect(reviewer.allowedTools).not.toContain('write_file');
  });
});
