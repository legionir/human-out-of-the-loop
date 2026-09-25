import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ToolDefinitionSchema } from '../schemas/tool-definition.js';
import { createRegistry } from '../registries/base-registry.js';
import { loadRegistryFromDirectory } from '../registries/loader.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// We import the actual tools to verify they integrate correctly
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

function createPopulatedRegistry(): ToolRegistry {
  const reg = new ToolRegistry();

  // Register metadata
  const defs = [
    {
      id: 'read_file',
      name: 'Read File',
      description: 'Reads a file',
      source: 'local' as const,
      modulePath: './read-file',
      category: 'fs',
    },
    {
      id: 'search_code',
      name: 'Search Code',
      description: 'Searches code',
      source: 'local' as const,
      modulePath: './search-code',
      category: 'fs',
    },
    {
      id: 'write_file',
      name: 'Write File',
      description: 'Writes a file',
      source: 'local' as const,
      modulePath: './write-file',
      category: 'fs',
    },
    {
      id: 'git_status',
      name: 'Git Status',
      description: 'Git status',
      source: 'local' as const,
      modulePath: './git-status',
      category: 'git',
    },
  ];
  for (const d of defs) reg.registerDefinition(d);

  // Register implementations
  reg.registerImplementation('read_file', readFileTool);
  reg.registerImplementation('search_code', searchCodeTool);
  reg.registerImplementation('write_file', writeFileTool);
  reg.registerImplementation('git_status', gitStatusTool);

  return reg;
}

// ─── ToolRegistry unit tests ────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers metadata and implementation separately', () => {
    const reg = new ToolRegistry();
    reg.registerDefinition({
      id: 'test_tool',
      name: 'Test',
      description: 'A test tool',
      source: 'local',
      modulePath: './test',
    });
    expect(reg.hasDefinition('test_tool')).toBe(true);
    expect(reg.getImplementation('test_tool')).toBeUndefined();

    // Now bind implementation
    reg.registerImplementation('test_tool', readFileTool); // reuse for test
    expect(reg.getImplementation('test_tool')).toBeDefined();
  });

  it('throws when registering implementation for unknown id', () => {
    const reg = new ToolRegistry();
    expect(() => reg.registerImplementation('nonexistent', readFileTool)).toThrow(
      /unknown tool id/
    );
  });

  it('getToolsByIds returns correct Record<string, Tool>', () => {
    const reg = createPopulatedRegistry();
    const tools = reg.getToolsByIds(['read_file', 'git_status']);

    expect(Object.keys(tools)).toEqual(['read_file', 'git_status']);
    expect(tools['read_file']).toBe(readFileTool);
    expect(tools['git_status']).toBe(gitStatusTool);
  });

  it('getToolsByIds throws on missing implementation', () => {
    const reg = new ToolRegistry();
    reg.registerDefinition({
      id: 'orphan',
      name: 'Orphan',
      description: 'No impl',
      source: 'local',
      modulePath: './orphan',
    });
    expect(() => reg.getToolsByIds(['orphan'])).toThrow(/no registered implementation/);
  });

  it('size reflects only tools with both metadata AND implementation', () => {
    const reg = createPopulatedRegistry();
    expect(reg.size).toBe(4);
  });

  it('registers a metadata-only MCP tool definition', () => {
    const reg = new ToolRegistry();
    reg.registerDefinition({
      id: 'mcp_search',
      name: 'MCP Search',
      description: 'Search via MCP',
      source: 'mcp',
      mcpServerId: 'external-search-server',
    });
    const def = reg.getDefinition('mcp_search');
    expect(def).toBeDefined();
    expect(def!.source).toBe('mcp');
    expect(def!.mcpServerId).toBe('external-search-server');
  });
});

// ─── Individual tool execution tests ────────────────────────────

describe('read_file tool', () => {
  it('returns structured error for non-existent file', async () => {
    // Access the execute function from the AI SDK tool object
    const execute = (readFileTool as unknown as { execute: (args: unknown) => Promise<unknown> })
      .execute;
    const result = (await execute({
      filePath: '/nonexistent/file.txt',
      encoding: 'utf-8',
    })) as { success: boolean; error?: string; code?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.code).toBeDefined();
  });

  it('reads an existing file successfully', async () => {
    const execute = (readFileTool as unknown as { execute: (args: unknown) => Promise<unknown> })
      .execute;
    // Read this test file itself
    const testFile = path.relative(process.cwd(), __filename);
    const result = (await execute({ filePath: testFile, encoding: 'utf-8' })) as {
      success: boolean;
      content?: string;
      sizeBytes?: number;
    };
    expect(result.success).toBe(true);
    expect(result.content).toContain('read_file tool');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });
});

describe('write_file tool', () => {
  it('returns structured error when overwrite=false and file exists', async () => {
    const execute = (writeFileTool as unknown as { execute: (args: unknown) => Promise<unknown> })
      .execute;
    const testFile = path.relative(process.cwd(), __filename);
    const result = (await execute({
      filePath: testFile,
      content: 'test',
      overwrite: false,
    })) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('EEXIST');
  });
});

describe('search_code tool', () => {
  it('returns structured result with matches', async () => {
    const execute = (searchCodeTool as unknown as { execute: (args: unknown) => Promise<unknown> })
      .execute;
    const result = (await execute({
      pattern: 'describe',
      directory: path.relative(process.cwd(), path.dirname(__filename)),
      fileExtension: '.ts',
      maxResults: 5,
    })) as { success: boolean; totalMatches: number; matches: unknown[] };
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.matches.length).toBeLessThanOrEqual(5);
  });
});

describe('git_status tool', () => {
  it('returns success or structured error (not a crash)', async () => {
    const execute = (gitStatusTool as unknown as { execute: (args: unknown) => Promise<unknown> })
      .execute;
    const result = (await execute({ directory: '.', short: true })) as {
      success: boolean;
      error?: string;
    };
    // Either success (if in a git repo) or structured failure
    expect(result).toHaveProperty('success');
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});

// ─── Loader integration ─────────────────────────────────────────

describe('Tool loader integration', () => {
  it('loads every tool definition from registry/tools/', () => {
    const reg = new ToolRegistry();
    const baseReg = createRegistry({ schema: ToolDefinitionSchema, label: 'Tool' });
    const dir = path.resolve(__dirname, '../../../registry/tools');
    const result = loadRegistryFromDirectory({
      directory: dir,
      registry: baseReg,
      schema: ToolDefinitionSchema,
    });
    // 4 original filesystem/git tools + phases 33-35's filesystem set.
    expect(result.loaded).toBe(16);
    expect(result.errors).toHaveLength(0);
    expect(baseReg.has('read_file')).toBe(true);
    expect(baseReg.has('search_code')).toBe(true);
    expect(baseReg.has('write_file')).toBe(true);
    expect(baseReg.has('git_status')).toBe(true);
    expect(baseReg.has('edit_file')).toBe(true);
    expect(baseReg.has('directory_tree')).toBe(true);
    expect(baseReg.has('read_media_file')).toBe(true);
    expect(baseReg.has('list_directory_with_sizes')).toBe(true);
    expect(baseReg.has('write_multiple_files')).toBe(true);
  });
});
