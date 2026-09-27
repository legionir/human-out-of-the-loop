/**
 * K-07 — shutdown waits for in-flight tasks, but cancelling them unblocks
 * waitForAll (the live SIGKILL path cannot be caught; this covers the
 * cooperative half of REL-004).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { createAgent } from '../agents/agent-factory.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as object;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

const PERSONAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../registry/personas');

function mockProvider(name: string): ProviderFactory {
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

describe('K-07 — waitForAll after cancel (shutdown order)', () => {
  let taskRuntime: TaskRuntime | undefined;

  afterEach(() => {
    taskRuntime?.destroy();
  });

  it('cancel unblocks waitForAll so shutdown can finish', async () => {
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation((opts: { abortSignal?: AbortSignal }) => {
      const signal = opts?.abortSignal;
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      }) as never;
    });

    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    taskRuntime = new TaskRuntime({
      maxConcurrentTasks: 1,
      eventBus,
      agentRuntime,
      agentTimeoutMs: 60_000,
    });

    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(mockProvider('openai'));
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    const agent = createAgent({
      agentDefinition: {
        id: 'k07',
        name: 'k07',
        personaId: 'coder',
        skillIds: [],
        toolIds: ['read_file'],
        modelId: 'gpt-4o',
      },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
    });

    const taskId = taskRuntime.createTask({ agent, prompt: 'hang' });
    const waiting = taskRuntime.waitForAll();
    await new Promise((r) => setTimeout(r, 30));
    taskRuntime.cancelTask(taskId);
    await Promise.race([
      waiting,
      new Promise((_, reject) => setTimeout(() => reject(new Error('waitForAll hung')), 2000)),
    ]);
  });
});
