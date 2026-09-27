import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAddObservationsTool,
  createCreateEntitiesTool,
  createCreateRelationsTool,
  createDeleteEntitiesTool,
  createDeleteObservationsTool,
  createDeleteRelationsTool,
  createOpenNodesTool,
  createReadGraphTool,
  createSearchNodesTool,
} from '../tools/implementations/memory-tools.js';
import { loadGraph, memoryFilePath, searchNodes } from '../tools/memory/graph.js';

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

interface Graphish {
  success: boolean;
  entities?: Array<{
    name: string;
    entityType: string;
    observations: string[];
  }>;
  relations?: Array<{ from: string; to: string; relationType: string }>;
  counts?: { entities: number; relations: number };
  relatedOutsideResult?: string[];
  notFound?: string[];
  total?: number;
  truncated?: boolean;
  code?: string;
  error?: string;
  memoryFile?: string;
}

describe('Phase 39 — memory: the reference toolset, per project', () => {
  let root: string;
  let other: string;

  const tools = () => ({
    createEntities: executeOf(createCreateEntitiesTool(root)),
    createRelations: executeOf(createCreateRelationsTool(root)),
    addObservations: executeOf(createAddObservationsTool(root)),
    deleteEntities: executeOf(createDeleteEntitiesTool(root)),
    deleteObservations: executeOf(createDeleteObservationsTool(root)),
    deleteRelations: executeOf(createDeleteRelationsTool(root)),
    readGraph: executeOf(createReadGraphTool(root)),
    searchNodes: executeOf(createSearchNodesTool(root)),
    openNodes: executeOf(createOpenNodesTool(root)),
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p39-memory-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'p39-memory-other-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('starts empty and creates entities with their observations', async () => {
    const { readGraph, createEntities } = tools();

    const empty = (await readGraph({})) as unknown as Graphish;
    expect(empty.success).toBe(true);
    expect(empty.entities).toEqual([]);
    expect(empty.memoryFile).toBe('.ai-runtime/memory.json'); // forward slashes on every platform

    const created = (await createEntities({
      entities: [
        {
          name: 'auth-service',
          entityType: 'service',
          observations: ['issues JWTs', 'owns /login'],
        },
        { name: 'ledger', entityType: 'service', observations: [] },
      ],
    })) as {
      success: boolean;
      created: Array<{ name: string }>;
      counts: { entities: number };
    };

    expect(created.success).toBe(true);
    expect(created.created.map((entity) => entity.name)).toEqual(['auth-service', 'ledger']);
    expect(created.counts.entities).toBe(2);

    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.counts).toEqual({ entities: 2, relations: 0 });
    expect(graph.entities?.find((entity) => entity.name === 'auth-service')?.observations).toEqual([
      'issues JWTs',
      'owns /login',
    ]);

    // Persisted as JSON in the project, not in a global file.
    const file = memoryFilePath(root);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).entities).toHaveLength(2);
  });

  it('leaves an existing entity untouched instead of merging or failing', async () => {
    const { createEntities, readGraph } = tools();
    await createEntities({
      entities: [{ name: 'auth', entityType: 'service', observations: ['first'] }],
    });
    const again = (await createEntities({
      entities: [
        { name: 'auth', entityType: 'service', observations: ['second'] },
        { name: 'auth', entityType: 'other', observations: [] }, // duplicate inside the same batch
        { name: 'new-one', entityType: 'service', observations: [] },
      ],
    })) as { created: Array<{ name: string }> };

    expect(again.created.map((entity) => entity.name)).toEqual(['new-one']);
    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.entities?.find((entity) => entity.name === 'auth')?.observations).toEqual([
      'first',
    ]);
  });

  it('creates relations only between existing entities', async () => {
    const { createEntities, createRelations, readGraph } = tools();
    await createEntities({
      entities: [
        { name: 'auth', entityType: 'service', observations: [] },
        { name: 'ledger', entityType: 'service', observations: [] },
      ],
    });

    const created = (await createRelations({
      relations: [{ from: 'auth', to: 'ledger', relationType: 'depends_on' }],
    })) as { success: boolean; created: Array<Record<string, string>> };
    expect(created.created).toEqual([{ from: 'auth', to: 'ledger', relationType: 'depends_on' }]);

    // A duplicate is ignored…
    const duplicate = (await createRelations({
      relations: [
        { from: 'auth', to: 'ledger', relationType: 'depends_on' },
        { from: 'ledger', to: 'auth', relationType: 'reconciles_with' },
      ],
    })) as { created: Array<Record<string, string>> };
    expect(duplicate.created).toEqual([
      { from: 'ledger', to: 'auth', relationType: 'reconciles_with' },
    ]);

    // …and a dangling endpoint is refused, leaving the graph unchanged.
    const dangling = (await createRelations({
      relations: [{ from: 'auth', to: 'ghost', relationType: 'depends_on' }],
    })) as { success: boolean; code: string; error: string };
    expect(dangling.success).toBe(false);
    expect(dangling.code).toBe('ENTITY_NOT_FOUND');
    expect(dangling.error).toContain('ghost');

    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.counts?.relations).toBe(2);
  });

  it('adds observations idempotently and refuses an unknown entity', async () => {
    const { createEntities, addObservations, readGraph } = tools();
    await createEntities({
      entities: [{ name: 'auth', entityType: 'service', observations: ['issues JWTs'] }],
    });

    const added = (await addObservations({
      observations: [
        {
          entityName: 'auth',
          contents: ['issues JWTs', 'rotates keys weekly'],
        },
      ],
    })) as {
      success: boolean;
      added: Array<{ entityName: string; addedObservations: string[] }>;
    };
    expect(added.added[0]!.addedObservations).toEqual(['rotates keys weekly']);

    const missing = (await addObservations({
      observations: [{ entityName: 'nope', contents: ['x'] }],
    })) as { success: boolean; code: string };
    expect(missing.success).toBe(false);
    expect(missing.code).toBe('ENTITY_NOT_FOUND');

    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.entities?.[0]?.observations).toEqual(['issues JWTs', 'rotates keys weekly']);
  });

  it('deletes entities with their relations, reporting what was missing', async () => {
    const { createEntities, createRelations, deleteEntities, readGraph } = tools();
    await createEntities({
      entities: [
        { name: 'auth', entityType: 'service', observations: [] },
        { name: 'ledger', entityType: 'service', observations: [] },
        { name: 'billing', entityType: 'service', observations: [] },
      ],
    });
    await createRelations({
      relations: [
        { from: 'auth', to: 'ledger', relationType: 'depends_on' },
        { from: 'billing', to: 'ledger', relationType: 'depends_on' },
      ],
    });

    const result = (await deleteEntities({
      entityNames: ['auth', 'ghost'],
    })) as {
      success: boolean;
      deleted: string[];
      notFound: string[];
      relationsRemoved: number;
    };
    expect(result.deleted).toEqual(['auth']);
    expect(result.notFound).toEqual(['ghost']);
    expect(result.relationsRemoved).toBe(1);

    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.entities?.map((entity) => entity.name)).toEqual(['ledger', 'billing']);
    expect(graph.counts?.relations).toBe(1);
    // No dangling edge to the deleted entity.
    expect(graph.relatedOutsideResult).toEqual([]);
  });

  it('deletes specific observations and relations', async () => {
    const { createEntities, createRelations, deleteObservations, deleteRelations, readGraph } =
      tools();
    await createEntities({
      entities: [
        {
          name: 'auth',
          entityType: 'service',
          observations: ['one', 'two', 'three'],
        },
        { name: 'ledger', entityType: 'service', observations: [] },
      ],
    });
    await createRelations({
      relations: [{ from: 'auth', to: 'ledger', relationType: 'depends_on' }],
    });

    const observations = (await deleteObservations({
      deletions: [
        { entityName: 'auth', observations: ['two', 'not-there'] },
        { entityName: 'ghost', observations: ['x'] },
      ],
    })) as { deletedCount: number; missingEntities: string[] };
    expect(observations.deletedCount).toBe(1);
    expect(observations.missingEntities).toEqual(['ghost']);

    const relations = (await deleteRelations({
      relations: [{ from: 'auth', to: 'ledger', relationType: 'depends_on' }],
    })) as { deletedCount: number };
    expect(relations.deletedCount).toBe(1);

    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.entities?.[0]?.observations).toEqual(['one', 'three']);
    expect(graph.counts?.relations).toBe(0);
  });

  it('searches name, type and observations, keeping either-side relations', async () => {
    const { createEntities, createRelations, searchNodes: search } = tools();
    await createEntities({
      entities: [
        {
          name: 'auth-service',
          entityType: 'service',
          observations: ['issues JWTs'],
        },
        {
          name: 'ledger',
          entityType: 'service',
          observations: ['owned by payments'],
        },
        { name: 'payments', entityType: 'team', observations: [] },
      ],
    });
    await createRelations({
      relations: [
        { from: 'auth-service', to: 'ledger', relationType: 'depends_on' },
        { from: 'ledger', to: 'payments', relationType: 'owned_by' },
      ],
    });

    const byObservation = (await search({
      query: 'jwt',
    })) as unknown as Graphish;
    expect(byObservation.entities?.map((entity) => entity.name)).toEqual(['auth-service']);
    expect(byObservation.relations).toEqual([
      { from: 'auth-service', to: 'ledger', relationType: 'depends_on' },
    ]);
    // The neighbour the relation points at is named, even though it is not a hit.
    expect(byObservation.relatedOutsideResult).toEqual(['ledger']);

    const byType = (await search({ query: 'team' })) as unknown as Graphish;
    expect(byType.entities?.map((entity) => entity.name)).toEqual(['payments']);

    const nothing = (await search({
      query: 'nothing-matches-this',
    })) as unknown as Graphish;
    expect(nothing.counts).toEqual({ entities: 0, relations: 0 });
  });

  it('opens nodes with their whole neighbourhood', async () => {
    const { createEntities, createRelations, openNodes } = tools();
    await createEntities({
      entities: [
        { name: 'auth', entityType: 'service', observations: [] },
        { name: 'ledger', entityType: 'service', observations: [] },
        { name: 'payments', entityType: 'team', observations: [] },
      ],
    });
    await createRelations({
      relations: [
        { from: 'auth', to: 'ledger', relationType: 'depends_on' },
        { from: 'ledger', to: 'payments', relationType: 'owned_by' },
      ],
    });

    const opened = (await openNodes({
      names: ['ledger', 'ghost'],
    })) as unknown as Graphish;
    expect(opened.entities?.map((entity) => entity.name)).toEqual(['ledger']);
    // Both relations touch `ledger`, so both come back — including the one that
    // reaches `auth`, which was not requested.
    expect(opened.relations).toHaveLength(2);
    expect(opened.notFound).toEqual(['ghost']);
    expect(opened.relatedOutsideResult).toEqual(['auth', 'payments']);
  });

  it('caps a large graph in read_graph and says so', async () => {
    const { createEntities, readGraph } = tools();
    await createEntities({
      entities: Array.from({ length: 12 }, (_, index) => ({
        name: `entity-${index}`,
        entityType: 'thing',
        observations: [],
      })),
    });

    const page = (await readGraph({ maxEntities: 5 })) as unknown as Graphish;
    expect(page.entities).toHaveLength(5);
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(12);
  });

  it("keeps each project's memory separate", async () => {
    const { createEntities } = tools();
    await createEntities({
      entities: [{ name: 'only-here', entityType: 'x', observations: [] }],
    });

    const elsewhere = executeOf(createReadGraphTool(other));
    const graph = (await elsewhere({})) as unknown as Graphish;
    expect(graph.entities).toEqual([]);
    expect(fs.existsSync(memoryFilePath(other))).toBe(false);
  });

  it('refuses to overwrite a corrupt graph and explains why', async () => {
    const file = memoryFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');

    const { readGraph, createEntities } = tools();
    const read = (await readGraph({})) as unknown as Graphish;
    expect(read.success).toBe(false);
    expect(read.code).toBe('GRAPH_CORRUPT');
    expect(read.error).toContain('will not overwrite');

    const write = (await createEntities({
      entities: [{ name: 'x', entityType: 'y', observations: [] }],
    })) as unknown as Graphish;
    expect(write.success).toBe(false);
    expect(write.code).toBe('GRAPH_CORRUPT');
    // The data is still there, untouched.
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json');
  });

  it('survives a graph written by an older shape (missing arrays)', async () => {
    const file = memoryFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entities: [{ name: 'a', entityType: 'x' }] }));

    const { readGraph } = tools();
    const graph = (await readGraph({})) as unknown as Graphish;
    expect(graph.success).toBe(true);
    expect(graph.entities?.[0]).toMatchObject({
      name: 'a',
      entityType: 'x',
      observations: [],
    });
    expect(graph.relations).toEqual([]);
  });

  it('reads the same graph through the shared core (no tool involved)', async () => {
    const { createEntities } = tools();
    await createEntities({
      entities: [{ name: 'auth', entityType: 'service', observations: ['issues JWTs'] }],
    });

    const loaded = loadGraph(root);
    expect(loaded.ok).toBe(true);
    const found = searchNodes(loaded.graph, 'issues');
    expect(found.entities.map((entity) => entity.name)).toEqual(['auth']);
  });
});

// ─── Registry wiring ─────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MEMORY_TOOLS = [
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations',
  'read_graph',
  'search_nodes',
  'open_nodes',
] as const;

describe('Phase 39 — memory registry wiring', () => {
  it('ships one registry entry per memory tool, all on the shared module', () => {
    for (const id of MEMORY_TOOLS) {
      const file = path.join(REPO_ROOT, 'registry', 'tools', `${id}.json`);
      expect(fs.existsSync(file), `${file} is missing`).toBe(true);
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(entry.id).toBe(id);
      expect(entry.category).toBe('memory');
      expect(entry.modulePath).toBe('./implementations/memory-tools');
      expect(entry.source).toBe('local');
    }
  });

  it('gives coder the whole set, and the readers a read/capture subset', () => {
    const toolsOf = (persona: string): string[] =>
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'registry', 'personas', `${persona}.json`), 'utf-8')
      ).allowedTools;

    for (const id of MEMORY_TOOLS) {
      expect(toolsOf('coder'), `coder is missing ${id}`).toContain(id);
    }
    // Reading and capturing memory is open to everyone with a say in the work;
    // erasing it is not (the least-privilege direction the plan calls for).
    for (const persona of ['architect', 'reviewer']) {
      expect(toolsOf(persona)).toContain('read_graph');
      expect(toolsOf(persona)).toContain('search_nodes');
      for (const id of ['delete_entities', 'delete_observations', 'delete_relations']) {
        expect(toolsOf(persona), `${persona} should not have ${id}`).not.toContain(id);
      }
    }
  });

  it('ships the project_memory skill, listing the tools it teaches', () => {
    const dir = path.join(REPO_ROOT, 'registry', 'skills', 'project_memory');
    const skill = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf-8'));

    expect(skill.id).toBe('project_memory');
    expect(skill.priority).toBe(75);
    expect(skill.tools).toEqual(
      expect.arrayContaining(['search_nodes', 'open_nodes', 'read_graph', 'add_observations'])
    );
    const markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(markdown).toContain('<project>/.ai-runtime/memory.json');
    expect(markdown).toContain('ENTITY_NOT_FOUND');
  });
});
