import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry, type ProviderFactory } from '../registries/model-registry.js';
import { runFeasibilityGate, type FeasibilityGateDeps } from '../planning/feasibility-gate.js';
import { detectCycles, topologicalSort } from '../planning/cycle-detector.js';
import {
  summarizePlan,
  formatPlanForUser,
  confirmPlan,
} from '../planning/plan-confirmation.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import { bootstrapCatalogTools } from '../tools/catalog-bootstrap.js';
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

interface TestDeps extends FeasibilityGateDeps {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
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

  // Bootstrap catalog tools BEFORE loading skills, because task_decomposition skill depends on them
  const skillRegistry = new SkillRegistry({ toolRegistry });
  bootstrapCatalogTools({ toolRegistry, personaRegistry, skillRegistry });
  loadSkillsFromDirectory(SKILLS_DIR, skillRegistry);

  const modelRegistry = new ModelRegistry();
  modelRegistry.registerProvider(createMockProvider('openai'));
  modelRegistry.registerConfig({ id: 'gpt-4o', provider: 'openai', model: 'gpt-4o' });

  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

// ─── Helper: create a valid plan ─────────────────────────────────

function createValidPlan(): Plan {
  return createPlan('Refactor the auth module', [
    {
      id: 'step-1',
      description: 'Analyse current auth module structure',
      dependsOn: [],
      assignedPersona: 'architect',
      assignedSkills: ['code_analysis'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: ['src/auth/'],
      acceptanceCriteria: 'Architecture report with dependency graph is produced',
      status: 'pending',
    },
    {
      id: 'step-2',
      description: 'Implement new auth service',
      dependsOn: ['step-1'],
      assignedPersona: 'coder',
      assignedSkills: ['file_management'],
      assignedTools: ['read_file', 'write_file', 'search_code'],
      claimedResources: ['src/auth/service.ts'],
      acceptanceCriteria: 'New auth service passes all existing tests',
      status: 'pending',
    },
    {
      id: 'step-3',
      description: 'Review the new implementation',
      dependsOn: ['step-2'],
      assignedPersona: 'reviewer',
      assignedSkills: ['code_analysis'],
      assignedTools: ['read_file', 'search_code'],
      claimedResources: [],
      acceptanceCriteria: 'No critical or warning findings in the review',
      status: 'pending',
    },
  ]);
}

// ─── Feasibility Gate tests ──────────────────────────────────────

describe('Feasibility Gate', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = setup();
  });

  it('passes a valid plan', () => {
    const plan = createValidPlan();
    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects plan with non-existent persona', () => {
    const plan = createValidPlan();
    plan.steps[0].assignedPersona = 'nonexistent-persona';

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.field === 'assignedPersona')).toBe(true);
    expect(result.errors[0].stepId).toBe('step-1');
  });

  it('rejects plan with non-existent skill', () => {
    const plan = createValidPlan();
    plan.steps[0].assignedSkills = ['nonexistent-skill'];

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.field === 'assignedSkills')).toBe(true);
  });

  it('rejects plan with non-existent tool', () => {
    const plan = createValidPlan();
    plan.steps[0].assignedTools = ['nonexistent_tool'];

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.field === 'assignedTools')).toBe(true);
  });

  it('rejects plan with tool not in persona.allowedTools (Law 18)', () => {
    const plan = createValidPlan();
    // reviewer: allowedTools = ["read_file", "search_code"]
    // Try to give reviewer write_file
    plan.steps[2].assignedPersona = 'reviewer';
    plan.steps[2].assignedTools = ['read_file', 'write_file'];

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    const authError = result.errors.find(
      (e) => e.stepId === 'step-3' && e.message.includes('write_file')
    );
    expect(authError).toBeDefined();
    expect(authError!.message).toContain('allowedTools');
  });

  it('rejects plan with invalid dependsOn reference', () => {
    const plan = createValidPlan();
    plan.steps[1].dependsOn = ['nonexistent-step'];

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.field === 'dependsOn')).toBe(true);
  });

  it('rejects plan with self-dependency', () => {
    const plan = createValidPlan();
    plan.steps[0].dependsOn = ['step-1']; // depends on itself

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.message.includes('itself'))).toBe(true);
  });

  it('reports multiple errors across different steps', () => {
    const plan = createValidPlan();
    plan.steps[0].assignedPersona = 'ghost';
    plan.steps[1].assignedTools = ['magic_tool'];
    plan.steps[2].dependsOn = ['step-99'];

    const result = runFeasibilityGate(plan, deps);

    expect(result.feasible).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    const stepIds = new Set(result.errors.map((e) => e.stepId));
    expect(stepIds.has('step-1')).toBe(true);
    expect(stepIds.has('step-2')).toBe(true);
    expect(stepIds.has('step-3')).toBe(true);
  });
});

// ─── Cycle Detection tests ───────────────────────────────────────

describe('Cycle Detection', () => {
  it('detects no cycle in a valid DAG', () => {
    const plan = createValidPlan();
    const result = detectCycles(plan);

    expect(result.hasCycle).toBe(false);
    expect(result.cyclePath).toBeUndefined();
  });

  it('detects a direct cycle (A → B → A)', () => {
    const plan = createPlan('Cyclic', [
      {
        id: 'A',
        description: 'Step A',
        dependsOn: ['B'],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
      {
        id: 'B',
        description: 'Step B',
        dependsOn: ['A'],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);

    const result = detectCycles(plan);

    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toBeDefined();
    expect(result.cyclePath!.length).toBeGreaterThanOrEqual(3); // A → B → A
  });

  it('detects an indirect cycle (A → B → C → A)', () => {
    const plan = createPlan('Indirect cycle', [
      { id: 'A', description: 'A', dependsOn: ['C'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'B', description: 'B', dependsOn: ['A'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'C', description: 'C', dependsOn: ['B'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    const result = detectCycles(plan);

    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toBeDefined();
  });

  it('handles a plan with no dependencies', () => {
    const plan = createPlan('Independent', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 's2', description: 'S2', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(detectCycles(plan).hasCycle).toBe(false);
  });
});

// ─── Topological Sort tests ──────────────────────────────────────

describe('Topological Sort', () => {
  it('returns valid ordering for a DAG', () => {
    const plan = createValidPlan();
    const sorted = topologicalSort(plan);

    expect(sorted).not.toBeNull();
    expect(sorted).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('returns null for a cyclic graph', () => {
    const plan = createPlan('Cycle', [
      { id: 'A', description: 'A', dependsOn: ['B'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 'B', description: 'B', dependsOn: ['A'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    expect(topologicalSort(plan)).toBeNull();
  });

  it('handles parallel independent steps', () => {
    const plan = createPlan('Parallel', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 's2', description: 'S2', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
      { id: 's3', description: 'S3', dependsOn: ['s1', 's2'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done', status: 'pending' },
    ]);

    const sorted = topologicalSort(plan);
    expect(sorted).not.toBeNull();
    expect(sorted!.indexOf('s3')).toBeGreaterThan(sorted!.indexOf('s1'));
    expect(sorted!.indexOf('s3')).toBeGreaterThan(sorted!.indexOf('s2'));
  });
});

// ─── Plan Summary & Confirmation tests ───────────────────────────

describe('Plan Summary & Confirmation', () => {
  it('summarizePlan produces correct summary', () => {
    const plan = createValidPlan();
    const summary = summarizePlan(plan);

    expect(summary.totalSteps).toBe(3);
    expect(summary.goal).toBe('Refactor the auth module');
    expect(summary.personasUsed).toContain('architect');
    expect(summary.personasUsed).toContain('coder');
    expect(summary.personasUsed).toContain('reviewer');
    expect(summary.allClaimedResources).toContain('src/auth/');
    expect(summary.allClaimedResources).toContain('src/auth/service.ts');
  });

  it('formatPlanForUser produces readable output', () => {
    const plan = createValidPlan();
    const summary = summarizePlan(plan);
    const formatted = formatPlanForUser(summary);

    expect(formatted).toContain('EXECUTION PLAN');
    expect(formatted).toContain('Refactor the auth module');
    expect(formatted).toContain('[step-1]');
    expect(formatted).toContain('[step-2]');
    expect(formatted).toContain('[step-3]');
    expect(formatted).toContain('Confirm this plan');
  });

  it('confirmPlan accepts various affirmative responses', () => {
    for (const response of ['yes', 'y', 'confirm', 'approve', 'ok', 'go', 'start']) {
      const result = confirmPlan(response);
      expect(result.confirmed).toBe(true);
    }
  });

  it('confirmPlan rejects negative/ambiguous responses with feedback', () => {
    const result = confirmPlan('No, change step 2 to use reviewer instead');
    expect(result.confirmed).toBe(false);
    expect(result.feedback).toContain('change step 2');
  });
});

// ─── Plan Schema tests ──────────────────────────────────────────

describe('Plan Schema', () => {
  it('createPlan sets all steps to pending', () => {
    const plan = createPlan('Test', [
      { id: 's1', description: 'S1', dependsOn: [], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'done' },
    ]);

    expect(plan.status).toBe('draft');
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.createdAt).toBeDefined();
  });

  it('getReadySteps returns steps with all deps done', async () => {
    const { getReadySteps } = await import('../schemas/plan.js');
    const plan = createValidPlan();

    // Initially only step-1 is ready (no deps)
    const ready1 = getReadySteps(plan);
    expect(ready1).toHaveLength(1);
    expect(ready1[0].id).toBe('step-1');

    // Mark step-1 as done
    plan.steps[0].status = 'done';
    const ready2 = getReadySteps(plan);
    expect(ready2).toHaveLength(1);
    expect(ready2[0].id).toBe('step-2');
  });

  it('isPlanTerminal returns true when all steps done/failed', async () => {
    const { isPlanTerminal } = await import('../schemas/plan.js');
    const plan = createValidPlan();

    expect(isPlanTerminal(plan)).toBe(false);

    plan.steps[0].status = 'done';
    plan.steps[1].status = 'failed';
    plan.steps[2].status = 'done';

    expect(isPlanTerminal(plan)).toBe(true);
  });
});
