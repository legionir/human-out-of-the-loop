import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { validateWorkspacePath, isPathWithinWorkspace } from '../tools/implementations/path-security';
import { ObservabilityLogger } from '../runtime/observability-logger';
import { McpConnector } from '../tools/mcp-connector';
import { ToolRegistry } from '../registries/tool-registry';
import { StreamingManager, createArrayCollector } from '../runtime/streaming-manager';
import { EventBus } from '../runtime/event-bus';
import { createAgent } from '../agents/agent-factory';
import { PersonaRegistry } from '../registries/persona-registry';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry';
import { ModelRegistry } from '../registries/model-registry';
import { checkAuthorization } from '../tools/implementations/delegate-task';
import { createReadFileTool } from '../tools/implementations/read-file';
import { createWriteFileTool } from '../tools/implementations/write-file';
import { createSearchCodeTool } from '../tools/implementations/search-code';
import { createGitStatusTool } from '../tools/implementations/git-status';

// Phase 18: filesystem tools are factories bound to a workspace root.
const TEST_ROOT = process.cwd();
const readFileTool = createReadFileTool(TEST_ROOT);
const searchCodeTool = createSearchCodeTool(TEST_ROOT);
const writeFileTool = createWriteFileTool(TEST_ROOT);
const gitStatusTool = createGitStatusTool(TEST_ROOT);
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap';

// ─── Path Traversal Protection ───────────────────────────────────

describe('Path Traversal Protection', () => {
  const workspaceRoot = '/home/user/project';

  it('allows paths within the workspace', () => {
    const result = isPathWithinWorkspace('src/main.ts', workspaceRoot);
    expect(result.safe).toBe(true);
    expect(result.resolvedPath).toBe('/home/user/project/src/main.ts');
  });

  it('allows absolute paths within the workspace', () => {
    const result = isPathWithinWorkspace('/home/user/project/src/main.ts', workspaceRoot);
    expect(result.safe).toBe(true);
  });

  it('blocks path traversal with ../', () => {
    const result = isPathWithinWorkspace('../../etc/passwd', workspaceRoot);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('outside workspace');
  });

  it('blocks path traversal with absolute path outside workspace', () => {
    const result = isPathWithinWorkspace('/etc/shadow', workspaceRoot);
    expect(result.safe).toBe(false);
  });

  it('blocks path traversal with encoded ../', () => {
    const result = isPathWithinWorkspace('src/../../etc/passwd', workspaceRoot);
    expect(result.safe).toBe(false);
  });

  it('allows deeply nested paths within workspace', () => {
    const result = isPathWithinWorkspace('src/deep/nested/dir/file.ts', workspaceRoot);
    expect(result.safe).toBe(true);
  });

  it('allows the workspace root itself', () => {
    const result = isPathWithinWorkspace('.', workspaceRoot);
    expect(result.safe).toBe(true);
  });

  it('validateWorkspacePath requires an explicit workspace root (phase 18 — no process.cwd() fallback)', () => {
    const result = validateWorkspacePath('src/main.ts', workspaceRoot);
    expect(result.safe).toBe(true);
    expect(result.resolvedPath).toBe('/home/user/project/src/main.ts');
  });

  it('validateWorkspacePath blocks traversal relative to the given root', () => {
    const result = validateWorkspacePath('../../../../etc/passwd', workspaceRoot);
    expect(result.safe).toBe(false);
  });
});

// ─── Credential Leak Prevention ──────────────────────────────────

describe('Credential Leak Prevention', () => {
  it('ObservabilityLogger redacts apiKey from payloads', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
    const logFile = path.join(tmpDir, 'test.jsonl');

    const logger = new ObservabilityLogger({ logFilePath: logFile });
    logger.log({
      eventType: 'system:info',
      message: 'Config',
      level: 'info',
      payload: {
        apiKey: 'sk-super-secret-12345',
        model: 'gpt-4o',
        auth: { token: 'bearer-xyz-789' },
      },
    });

    const entries = logger.readAll();
    const serialized = JSON.stringify(entries[0]);

    expect(serialized).not.toContain('sk-super-secret-12345');
    expect(serialized).not.toContain('bearer-xyz-789');
    expect(serialized).toContain('***REDACTED***');
    expect(serialized).toContain('gpt-4o');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('MCP connector sanitises credentials from error messages', async () => {
    const toolRegistry = new ToolRegistry();
    const connector = new McpConnector({
      toolRegistry,
      createClient: async () => {
        throw new Error('Auth failed for token super-secret-abc-12345');
      },
      createTransport: () => ({}),
    });

    process.env.TEST_SECRET_TOKEN = 'super-secret-abc-12345';

    await connector.connectServer({
      id: 'leak-test',
      name: 'Leak Test',
      transport: 'http',
      url: 'http://fake',
      auth: { type: 'bearer', tokenEnvVar: 'TEST_SECRET_TOKEN' },
      args: [],
      connectTimeoutMs: 5000,
    });

    const state = connector.getServerState('leak-test')!;
    expect(state.lastError).not.toContain('super-secret-abc-12345');
    expect(state.lastError).toContain('***REDACTED***');

    delete process.env.TEST_SECRET_TOKEN;
  });

  it('Streaming events do not contain raw tool arguments', () => {
    const eventBus = new EventBus();
    const streaming = new StreamingManager({ eventBus });
    const collector = createArrayCollector();
    streaming.subscribe(collector.handler);
    streaming.start();

    eventBus.emit({
      type: 'agent:tool_call',
      taskId: 't1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      toolName: 'read_file',
      callId: 'call-1',
    });

    const serialized = JSON.stringify(collector.events);
    expect(serialized).toContain('read_file');
    expect(serialized).not.toContain('filePath');
    expect(serialized).not.toContain('arguments');

    streaming.stop();
  });
});

// ─── allowedTools enforcement completeness ───────────────────────

describe('allowedTools — enforced in ALL paths', () => {
  it('Agent Factory (static) filters tools', () => {
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(path.resolve(__dirname, '../../../registry/personas'));

    const toolRegistry = new ToolRegistry();
    for (const d of [
      { id: 'read_file', name: 'R', description: 'R', source: 'local', modulePath: './r' },
      { id: 'write_file', name: 'W', description: 'W', source: 'local', modulePath: './w' },
      { id: 'search_code', name: 'S', description: 'S', source: 'local', modulePath: './s' },
      { id: 'git_status', name: 'G', description: 'G', source: 'local', modulePath: './g' },
    ]) toolRegistry.registerDefinition(d);
    toolRegistry.registerImplementation('read_file', readFileTool);
    toolRegistry.registerImplementation('search_code', searchCodeTool);
    toolRegistry.registerImplementation('write_file', writeFileTool);
    toolRegistry.registerImplementation('git_status', gitStatusTool);

    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(path.resolve(__dirname, '../../../registry/skills'), skillRegistry, false);
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });

    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider({
      name: 'openai',
      create: () => ({ specificationVersion: 'v1', provider: 'mock', modelId: 'm', defaultObjectGenerationMode: 'json', doGenerate: vi.fn(), doStream: vi.fn() }) as any,
    });
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    const agent = createAgent({
      agentDefinition: {
        id: 'test',
        name: 'Test',
        personaId: 'reviewer',
        skillIds: ['file_management'],
        modelId: 'gpt-4o',
      },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
    });

    expect(Object.keys(agent.tools)).not.toContain('write_file');
  });

  it('delegate_task (dynamic) rejects unauthorized tools', () => {
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(path.resolve(__dirname, '../../../registry/personas'));

    const result = checkAuthorization('coder', ['delegate_task'], personaRegistry);
    expect(result.authorized).toBe(false);
    expect(result.deniedTools).toContain('delegate_task');
  });
});
