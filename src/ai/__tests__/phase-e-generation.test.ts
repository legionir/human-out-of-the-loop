import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import type { Persona } from '../schemas/persona.js';

const mockGenerateText = vi.mocked(generateText);

function makeAgent(over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    agentId: 'test-agent',
    systemPrompt: 'sys',
    tools: {},
    model: { specificationVersion: 'v1' } as unknown as LanguageModel,
    persona: { id: 'coder', name: 'Coder', system: 'x', allowedTools: ['*'] } as Persona,
    skills: [],
    toolWarnings: [],
    trimmingLog: [],
    contextBudgetExceeded: false,
    delegationDepth: 0,
    generationSettings: { temperature: 0.15, maxOutputTokens: 1024 },
    ...over,
  };
}

describe('E-03 — AgentRuntime forwards generation settings', () => {
  afterEach(() => mockGenerateText.mockReset());

  it('passes temperature and maxOutputTokens to generateText', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'ok',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      steps: [],
    } as never);

    const runtime = new AgentRuntime();
    await runtime.run({
      agent: makeAgent(),
      prompt: 'hello',
      eventBus: new EventBus(),
      taskId: 't1',
    });

    const arg = mockGenerateText.mock.calls[0]?.[0] as {
      temperature?: number;
      maxOutputTokens?: number;
    };
    expect(arg.temperature).toBe(0.15);
    expect(arg.maxOutputTokens).toBe(1024);
  });
});
