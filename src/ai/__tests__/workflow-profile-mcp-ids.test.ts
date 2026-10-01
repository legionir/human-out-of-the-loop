import { describe, expect, it } from 'vitest';
import { ToolDefinitionSchema } from '../schemas/tool-definition.js';

function tool(id: string, source: 'local' | 'mcp') {
  return {
    id,
    name: 'Example',
    description: 'Tool used to exercise source-aware id validation',
    source,
    ...(source === 'local' ? { modulePath: './example.js' } : { mcpServerId: 'server' }),
  };
}

describe('source-aware tool identifier validation', () => {
  it('preserves MCP ids exactly, including case, punctuation, and Unicode', () => {
    const id = 'MCP:Ä/tool.v2';
    const parsed = ToolDefinitionSchema.parse(tool(id, 'mcp'));
    expect(parsed.id).toBe(id);
    expect(ToolDefinitionSchema.safeParse(tool('MCP:Ä/tool.v2', 'mcp')).success).toBe(true);
    expect(ToolDefinitionSchema.safeParse(tool('mcp:ä/tool.v2', 'mcp')).success).toBe(true);
  });

  it('enforces the 256-byte MCP limit using UTF-8 byte length', () => {
    expect(ToolDefinitionSchema.safeParse(tool('a'.repeat(256), 'mcp')).success).toBe(true);
    expect(ToolDefinitionSchema.safeParse(tool('a'.repeat(257), 'mcp')).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse(tool('é'.repeat(128), 'mcp')).success).toBe(true);
    expect(ToolDefinitionSchema.safeParse(tool('é'.repeat(129), 'mcp')).success).toBe(false);
  });

  it('rejects empty and control-character MCP ids without normalization', () => {
    expect(ToolDefinitionSchema.safeParse(tool('', 'mcp')).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse(tool('safe\u0000unsafe', 'mcp')).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse(tool('tab\tname', 'mcp')).success).toBe(false);
  });

  it('keeps the pre-existing restricted convention for local tool ids', () => {
    expect(ToolDefinitionSchema.safeParse(tool('local_tool-1', 'local')).success).toBe(true);
    expect(ToolDefinitionSchema.safeParse(tool('Local:tool', 'local')).success).toBe(false);
  });
});
