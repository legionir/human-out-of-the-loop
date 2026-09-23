import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import type { Persona } from '../schemas/persona.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateText, generateObject } from 'ai';
import { Orchestrator } from '../orchestrator.js';
import { DelegationGuard } from '../runtime/delegation-guard.js';
import { RetryableAgentRuntime } from '../runtime/agent-runtime-retry.js';
import { EventBus } from '../runtime/event-bus.js';

const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DelegationGuard', () => {
  let personaRegistry: PersonaRegistry;

  beforeEach(() => {
    personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(
      path.resolve(__dirname, '../../../registry/personas')
    );
  });

  it('allows planner persona to delegate at depth 0', () => {
    const guard = new DelegationGuard({
      maxDepth: 1,
      personaRegistry,
    });

    personaRegistry.register({
      id: 'main-agent',
      name: 'Main',
      system: 'You are the main agent.',
      allowedTools: ['delegate_task', 'get_agent_status'],
    });

    const result = guard.canDelegate('main-agent', 0);
    expect(result.allowed).toBe(true);
  });

  it('denies delegation at depth >= maxDepth', () => {
    const guard = new DelegationGuard({
      maxDepth: 1,
      personaRegistry,
    });

    personaRegistry.register({
      id: 'delegator',
      name: 'D',
      system: 'S',
      allowedTools: ['delegate_task'],
    });

    const result = guard.canDelegate('delegator', 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds maximum');
  });

  it('denies delegation for personas without delegate_task in allowedTools', () => {
    const guard = new DelegationGuard({
      maxDepth: 2,
      personaRegistry,
    });

    const result = guard.canDelegate('coder', 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not have "delegate_task"');
  });

  it('filterTools removes delegate_task for unauthorized personas', () => {
    const guard = new DelegationGuard({
      maxDepth: 1,
      personaRegistry,
    });

    const { filtered, removed } = guard.filterTools(
      ['read_file', 'delegate_task', 'write_file'],
      'coder',
      0
    );

    expect(filtered).toEqual(['read_file', 'write_file']);
    expect(removed).toEqual(['delegate_task']);
  });

  it('filterTools keeps delegate_task for authorized personas', () => {
    const guard = new DelegationGuard({
      maxDepth: 1,
      personaRegistry,
    });

    personaRegistry.register({
      id: 'boss',
      name: 'Boss',
      system: 'S',
      allowedTools: ['delegate_task', 'read_file'],
    });

    const { filtered, removed } = guard.filterTools(
      ['read_file', 'delegate_task'],
      'boss',
      0
    );

    expect(filtered).toEqual(['read_file', 'delegate_task']);
    expect(removed).toEqual([]);
  });
});

describe('RetryableAgentRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success on first try', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      steps: [],
    } as any);

    const runtime = new RetryableAgentRuntime();
    const mockAgent = {
      agentId: 'test',
      systemPrompt: 'Test',
      tools: {},
      model: {} as LanguageModel,
      persona: { id: 't', name: 'T', system: 'T', allowedTools: [] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
    };

    const result = await runtime.run({
      agent: mockAgent,
      taskId: 't1',
      prompt: 'Test',
      // Phase 19: eventBus is now required (no global fallback)
      eventBus: new EventBus(),
    });

    expect(result.success).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('retries on timeout and succeeds', async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        text: 'Done after retry.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: [],
      } as any);

    const runtime = new RetryableAgentRuntime();
    const mockAgent = {
      agentId: 'test',
      systemPrompt: 'Test',
      tools: {},
      model: {} as LanguageModel,
      persona: { id: 't', name: 'T', system: 'T', allowedTools: [] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
    };

    const result = await runtime.run({
      agent: mockAgent,
      taskId: 't2',
      prompt: 'Test',
      // Phase 19: eventBus is now required (no global fallback)
      eventBus: new EventBus(),
      maxRetries: 1,
    });

    expect(result.success).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('gives up after max retries', async () => {
    mockGenerateText.mockRejectedValue(new Error('ETIMEDOUT'));

    const runtime = new RetryableAgentRuntime();
    const mockAgent = {
      agentId: 'test',
      systemPrompt: 'Test',
      tools: {},
      model: {} as LanguageModel,
      persona: { id: 't', name: 'T', system: 'T', allowedTools: [] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
    };

    const result = await runtime.run({
      agent: mockAgent,
      taskId: 't3',
      prompt: 'Test',
      // Phase 19: eventBus is now required (no global fallback)
      eventBus: new EventBus(),
      maxRetries: 2,
    });

    expect(result.success).toBe(false);
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-recoverable errors', async () => {
    mockGenerateText.mockReset();
    mockGenerateText.mockRejectedValue(new Error('Invalid API key (401)'));

    const runtime = new RetryableAgentRuntime();
    const mockAgent = {
      agentId: 'test',
      systemPrompt: 'Test',
      tools: {},
      model: {} as LanguageModel,
      persona: { id: 't', name: 'T', system: 'T', allowedTools: [] } as Persona,
      skills: [],
      toolWarnings: [],
      trimmingLog: [],
      contextBudgetExceeded: false,
    };

    const result = await runtime.run({
      agent: mockAgent,
      taskId: 't4',
      prompt: 'Test',
      // Phase 19: eventBus is now required (no global fallback)
      eventBus: new EventBus(),
      maxRetries: 2,
    });

    expect(result.success).toBe(false);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});

describe('Orchestrator — integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
    process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes without errors', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
    });

    await orchestrator.initialize();

    expect(orchestrator.personaRegistry.size).toBeGreaterThanOrEqual(4);
    expect(orchestrator.toolRegistry.size).toBeGreaterThanOrEqual(4);
    expect(orchestrator.skillRegistry.size).toBeGreaterThanOrEqual(3);
    expect(orchestrator.agentRegistry.size).toBeGreaterThanOrEqual(4);

    await orchestrator.shutdown();
  });

  it('returns clarification for ambiguous requests', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
    });
    await orchestrator.initialize();

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: false,
        needsClarification: ['What specific files should be analysed?'],
      },
    } as any);

    const result = await orchestrator.run('Do the thing', {
      confirmCallback: async () => ({ confirmed: true }),
    });

    expect(result.review.outcome).toBe('failure');
    expect(result.review.finalSummary).toContain('clarification');
    expect(result.sessionId).toBeDefined();

    await orchestrator.shutdown();
  });

  it('full flow: plan → confirm → execute → review (mock)', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
    });
    await orchestrator.initialize();

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: true,
        needsClarification: [],
        plan: {
          goal: 'Analyse codebase',
          steps: [
            {
              id: 'step-1',
              description: 'Read and analyse the main module',
              dependsOn: [],
              assignedPersona: 'architect',
              assignedSkills: ['code_analysis'],
              assignedTools: ['read_file', 'search_code'],
              claimedResources: [],
              acceptanceCriteria: 'Architecture report produced',
              status: 'pending',
            },
          ],
        },
      },
    } as any);

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        planId: 'test',
        goal: 'Analyse codebase',
        outcome: 'success',
        acceptedFindings: [
          { stepId: 'step-1', title: 'Analysis done', description: 'Report produced', severity: 'info' },
        ],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: 'Codebase analysis completed successfully.',
      },
    } as any);

    const result = await orchestrator.run('Analyse the codebase', {
      confirmCallback: async () => ({ confirmed: true }),
    });

    expect(result.review).toBeDefined();
    expect(result.planId).toBeDefined();
    expect(result.sessionId).toBeDefined();
    expect(result.report).toBeDefined();
    expect(result.report).toContain('FINAL REPORT');

    await orchestrator.shutdown();
  });

  it('handles plan rejection by user', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
    });
    await orchestrator.initialize();

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: true,
        needsClarification: [],
        plan: {
          goal: 'Test',
          steps: [
            {
              id: 's1',
              description: 'Do X',
              dependsOn: [],
              assignedPersona: 'coder',
              assignedSkills: [],
              assignedTools: [],
              claimedResources: [],
              acceptanceCriteria: 'done',
              status: 'pending',
            },
          ],
        },
      },
    } as any);

    const result = await orchestrator.run('Do X', {
      confirmCallback: async () => ({
        confirmed: false,
        feedback: 'Use reviewer instead of coder',
      }),
    });

    expect(result.review.outcome).toBe('cancelled');
    expect(result.report).toContain('cancelled');
    expect(result.report).toContain('reviewer instead of coder');

    await orchestrator.shutdown();
  });
});
