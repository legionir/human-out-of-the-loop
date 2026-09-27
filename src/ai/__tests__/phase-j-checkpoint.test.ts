/**
 * J-05 — file-copy checkpoint before a writable step; fail restores the tree;
 * `hootl plans rollback <id>` restores the latest snapshot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import {
  captureCheckpoint,
  restoreCheckpoint,
  listProjectFiles,
  pruneCheckpoints,
  checkpointDir,
} from '../runtime/checkpoint.js';
import { plansRollbackCommand } from '../../cli/commands/plans.js';
import { FilePlanStore } from '../runtime/plan-store.js';
import { createPlan } from '../schemas/plan.js';
import { EventBus } from '../runtime/event-bus.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { TaskRuntime } from '../runtime/task-runtime.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { PlanRuntime } from '../runtime/plan-runtime.js';
import type { Planner } from '../planning/planner.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
import { registerLocalToolFixtures } from './helpers/local-tools-fixture.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as object;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(__dirname, '../../../registry/personas');
const SKILLS_DIR = path.resolve(__dirname, '../../../registry/skills');

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

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listProjectFiles(root)) {
    out[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  }
  return out;
}

describe('J-05 — checkpoint / rollback', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j05-'));
    fs.writeFileSync(path.join(root, 'keep.txt'), 'original\n');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restore puts the working tree back to the captured files', () => {
    captureCheckpoint(root, 'plan_a', 'step-1');
    const before = snapshot(root);
    fs.writeFileSync(path.join(root, 'keep.txt'), 'dirty\n');
    fs.writeFileSync(path.join(root, 'extra.txt'), 'new\n');
    expect(restoreCheckpoint(root, 'plan_a', 'step-1')).toBe(true);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'extra.txt'))).toBe(false);
  });

  it('plans rollback <id> restores the latest checkpoint', async () => {
    const plan = createPlan('goal', [
      {
        id: 'step-1',
        description: 'write',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['write_file'],
        claimedResources: [],
        acceptanceCriteria: 'ok',
      },
    ]);
    captureCheckpoint(root, plan.id!, 'step-1');
    fs.writeFileSync(path.join(root, 'keep.txt'), 'dirty\n');
    const store = new FilePlanStore(path.join(root, '.ai-runtime', 'plans'));
    store.save(plan);
    const code = await plansRollbackCommand(plan.id!, { projectRoot: root });
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('original\n');
  });

  it('a failed writable step restores the pre-step tree', async () => {
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentRuntime });
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry, root);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(createMockProvider('openai'));
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      fs.writeFileSync(path.join(root, 'keep.txt'), 'from-agent\n');
      fs.writeFileSync(path.join(root, 'new-from-step.txt'), 'x\n');
      throw new Error('step blew up');
    });

    const runtime = new PlanRuntime({
      taskRuntime,
      planStore: new MemoryPlanStore(),
      planner: { generatePlan: vi.fn().mockResolvedValue(null) } as unknown as Planner,
      feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
      maxReplanningAttempts: 0,
      defaultModelId: 'gpt-4o',
      projectRoot: root,
    });

    const plan = createPlan('write then fail', [
      {
        id: 'step-1',
        description: 'write',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['write_file'],
        claimedResources: [],
        acceptanceCriteria: 'file written',
      },
    ]);
    await runtime.execute(plan);
    expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(root, 'new-from-step.txt'))).toBe(false);
    taskRuntime.destroy();
  });

  it('does not snapshot a tree over the size limits', () => {
    expect(captureCheckpoint(root, 'plan_big', 'step-1', { maxFiles: 0 })).toBeUndefined();
    expect(fs.existsSync(checkpointDir(root, 'plan_big', 'step-1'))).toBe(false);
    expect(captureCheckpoint(root, 'plan_big', 'step-1', { maxBytes: 1 })).toBeUndefined();
  });

  it('keeps only the newest snapshots of a plan and prunes old plans', () => {
    captureCheckpoint(root, 'plan_k', 's1');
    captureCheckpoint(root, 'plan_k', 's2');
    captureCheckpoint(root, 'plan_k', 's3');
    const left = fs.readdirSync(path.join(root, '.ai-runtime', 'checkpoints', 'plan_k'));
    expect(left.length).toBe(2);
    expect(left).toContain('s3');
    expect(pruneCheckpoints(root, 7, Date.now() + 30 * 86_400_000)).toBe(1);
    expect(fs.existsSync(path.join(root, '.ai-runtime', 'checkpoints', 'plan_k'))).toBe(false);
  });

  it('a failed step does not roll back the work of a concurrent writable step', async () => {
    const eventBus = new EventBus();
    const agentRuntime = new AgentRuntime();
    const taskRuntime = new TaskRuntime({ maxConcurrentTasks: 2, eventBus, agentRuntime });
    const personaRegistry = new PersonaRegistry();
    personaRegistry.loadFromDirectory(PERSONAS_DIR);
    const toolRegistry = new ToolRegistry();
    registerLocalToolFixtures(toolRegistry, root);
    const skillRegistry = new SkillRegistry({ toolRegistry });
    bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
    loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);
    const modelRegistry = new ModelRegistry();
    modelRegistry.registerProvider(createMockProvider('openai'));
    modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation((async (opts: { prompt?: string }) => {
      if (String(opts.prompt).includes('step-ok')) {
        fs.writeFileSync(path.join(root, 'from-ok.txt'), 'kept\n');
        return { text: 'wrote it', steps: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('step blew up');
    }) as never);

    const runtime = new PlanRuntime({
      taskRuntime,
      planStore: new MemoryPlanStore(),
      planner: { generatePlan: vi.fn().mockResolvedValue(null) } as unknown as Planner,
      feasibilityDeps: { personaRegistry, skillRegistry, toolRegistry },
      refs: { personaRegistry, skillRegistry, toolRegistry, modelRegistry },
      maxReplanningAttempts: 0,
      defaultModelId: 'gpt-4o',
      projectRoot: root,
    });
    const step = (id: string) => ({
      id,
      description: id,
      dependsOn: [],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['write_file'],
      claimedResources: [],
      acceptanceCriteria: 'ok',
    });
    const plan = createPlan('two writers', [step('step-ok'), step('step-bad')]);
    await runtime.execute(plan);
    expect(fs.readFileSync(path.join(root, 'from-ok.txt'), 'utf8')).toBe('kept\n');
    expect(plan.steps.find((s) => s.id === 'step-bad')?.resultSummary).toMatch(/Rollback skipped/);
    taskRuntime.destroy();
  });
});

describe('J-05 — restore does not rely on timestamps', () => {
  it('removes a file created after capture even if its mtime predates the capture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-mtime-'));
    fs.writeFileSync(path.join(root, 'keep.txt'), 'original\n');
    captureCheckpoint(root, 'plan_m', 'step-1');
    const extra = path.join(root, 'extra.txt');
    fs.writeFileSync(extra, 'new\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(extra, past, past);
    expect(restoreCheckpoint(root, 'plan_m', 'step-1')).toBe(true);
    expect(fs.existsSync(extra)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('original\n');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('J-05 — restore writes back only what the step changed', () => {
  it('leaves an unchanged file untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-same-'));
    fs.writeFileSync(path.join(root, 'same.txt'), 'same\n');
    fs.writeFileSync(path.join(root, 'edit.txt'), 'before\n');
    captureCheckpoint(root, 'plan_s', 'step-1');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, 'same.txt'), past, past);
    fs.writeFileSync(path.join(root, 'edit.txt'), 'after\n');
    expect(restoreCheckpoint(root, 'plan_s', 'step-1')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'edit.txt'), 'utf8')).toBe('before\n');
    // Not rewritten: its mtime is still the one set above.
    expect(Math.abs(fs.statSync(path.join(root, 'same.txt')).mtimeMs - past.getTime())).toBeLessThan(1000);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
