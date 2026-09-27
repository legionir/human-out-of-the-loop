/**
 * J-09 — delete_file (sandbox + journal), paginated read_graph, GET /api/runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { createDeleteFileTool } from '../tools/implementations/delete-file.js';
import { createCreateEntitiesTool, createReadGraphTool } from '../tools/implementations/memory-tools.js';
import { isReadOnlyTool } from '../tools/read-only.js';
import { JournalWriter, journalFileFor, withJournal, type JournalEntry } from '../runtime/journal.js';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as object;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { createApp, type CreatedServer } from '../../server.js';
import type { Plan } from '../schemas/plan.js';

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);
process.env.OPENAI_API_KEY ??= 'test-key-openai';
process.env.ANTHROPIC_API_KEY ??= 'test-key-anthropic';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

function validPlan(): Plan {
  return {
    id: 'plan_j09',
    goal: 'noop',
    steps: [
      {
        id: 'step-1',
        description: 'read',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: ['file_management'],
        assignedTools: ['read_file'],
        claimedResources: [],
        acceptanceCriteria: 'ok',
        status: 'pending',
      },
    ],
    clarifications: [],
    status: 'draft',
  };
}

describe('J-09 — extras', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j09-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('delete_file refuses traversal, directories, and protected paths; journals a delete', async () => {
    expect(isReadOnlyTool('delete_file')).toBe(false);
    fs.writeFileSync(path.join(root, 'gone.txt'), 'x');
    fs.mkdirSync(path.join(root, 'dir'));
    const del = executeOf(createDeleteFileTool(root));
    expect((await del({ filePath: '../outside.txt' })).success).toBe(false);
    expect((await del({ filePath: 'dir' })).code).toBe('IS_DIRECTORY');
    fs.mkdirSync(path.join(root, '.ai-runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-runtime', 'secret.txt'), 'nope');
    expect((await del({ filePath: '.ai-runtime/secret.txt' })).success).toBe(false);

    const runtimeDir = path.join(root, '.ai-runtime');
    const writer = new JournalWriter({ runtimeDir, includeResults: 'full' });
    try {
      const wrapped = withJournal({ delete_file: createDeleteFileTool(root) } as Record<string, unknown>, {}, writer);
      const result = await executeOf(wrapped.delete_file)({ filePath: 'gone.txt' });
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false);
      const lines = fs
        .readFileSync(journalFileFor(runtimeDir, new Date()), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEntry);
      expect(lines.some((entry) => entry.tool === 'delete_file')).toBe(true);
    } finally {
      writer.close();
    }
  });

  it('read_graph paginates with offset and reports truncated/total', async () => {
    const create = executeOf(createCreateEntitiesTool(root));
    await create({
      entities: [
        { name: 'a', entityType: 'svc', observations: ['1'] },
        { name: 'b', entityType: 'svc', observations: ['2'] },
        { name: 'c', entityType: 'svc', observations: ['3'] },
      ],
    });
    const read = executeOf(createReadGraphTool(root));
    const page = (await read({ maxEntities: 1, offset: 1 })) as {
      entities: Array<{ name: string }>;
      truncated: boolean;
      total: number;
      offset: number;
    };
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.entities).toHaveLength(1);
    expect(page.entities[0]?.name).toBe('b');
    expect(page.truncated).toBe(true);
  });
});

describe('J-09 — GET /api/runs', () => {
  let projectRoot: string;
  let created: CreatedServer;
  let app: Express;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-j09-api-'));
    fs.cpSync(REGISTRY_SRC, path.join(projectRoot, 'registry'), { recursive: true });
    mockGenerateObject.mockReset();
    mockGenerateText.mockReset();
    mockGenerateObject.mockImplementation(async (opts: unknown) => {
      const schemaName = (opts as { schemaName?: string } | undefined)?.schemaName;
      if (schemaName === 'PlannerAssessment') {
        return { object: { isClear: true, needsClarification: [], plan: validPlan() } } as never;
      }
      if (schemaName === 'ExecutionPlan') {
        return { object: validPlan() } as never;
      }
      return { object: { accepted: true, reason: 'ok' } } as never;
    });
    created = createApp({ projectRoot, persistent: true, model: 'gpt-4o' });
    app = created.app;
  });

  afterEach(async () => {
    await created.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('lists in-flight runs', async () => {
    const posted = await request(app)
      .post('/api/run')
      .send({ message: 'noop', confirm: false })
      .expect(202);
    const runId = posted.body.runId as string;
    const list = await request(app).get('/api/runs').expect(200);
    expect(Array.isArray(list.body.runs)).toBe(true);
    expect(list.body.runs.some((run: { runId: string }) => run.runId === runId)).toBe(true);
  });
});
