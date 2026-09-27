import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../runtime/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../runtime/file-lock.js';

/**
 * Phase 39 — the memory knowledge graph, ported from the reference `memory`
 * server but stored per project instead of in one global file.
 *
 * The reference keeps `<MEMORY_FILE_PATH>` (default `memory.json` next to the
 * package) and every client shares it.  Here the graph lives in
 * `<project>/.ai-runtime/memory.json`: "what did we decide about *this*
 * project" is the question a coding agent actually asks, and a shared file
 * would leak one repository's facts into another's context.
 *
 * Semantics are the reference's, kept exactly:
 *   - `createEntities` **ignores** names that already exist (and duplicates
 *     inside the same batch), returning only what was really created;
 *   - `createRelations` refuses a relation whose endpoint does not exist
 *     (`ENTITY_NOT_FOUND`) — the graph never grows a dangling edge;
 *   - `addObservations` merges, skipping observations already present;
 *   - deleting an entity deletes its relations too, and reports what was not
 *     found instead of failing;
 *   - search matches name, type *and* observations, case-insensitively, and
 *     keeps relations where **either** endpoint matched, so a hit's
 *     neighbourhood is visible.
 *
 * Two things are added, because this file is written by a long-running process:
 *   - writes go through `atomicWriteFileSync` + the runtime's file lock, so two
 *     concurrent agents (or two processes) cannot interleave and lose an update;
 *   - a corrupt file is reported (`GRAPH_CORRUPT`) with its path, and **is not
 *     overwritten** — memory is data, and silently replacing it would be data
 *     loss.
 */

export interface MemoryEntity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface MemoryRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface MemoryGraph {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
}

export interface MemoryWriteResult {
  ok: boolean;
  /** Machine-readable failure: ENTITY_NOT_FOUND | GRAPH_CORRUPT | LOCK_TIMEOUT | … */
  code?: string;
  error?: string;
}

export const EMPTY_GRAPH: MemoryGraph = { entities: [], relations: [] };

/** `<project>/.ai-runtime/memory.json` — the project's long-term memory. */
export function memoryFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'memory.json');
}

/** Read the graph.  A missing file is an empty graph; a corrupt one is an error. */
export function loadGraph(projectRoot: string): { graph: MemoryGraph } & MemoryWriteResult {
  const file = memoryFilePath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, graph: structuredClone(EMPTY_GRAPH) };
    }
    return {
      ok: false,
      graph: structuredClone(EMPTY_GRAPH),
      code: 'GRAPH_UNREADABLE',
      error: String(err),
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MemoryGraph>;
    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
    const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
    return {
      ok: true,
      graph: {
        entities: entities.map((entity) => ({
          name: String(entity.name),
          entityType: String(entity.entityType ?? 'unknown'),
          observations: Array.isArray(entity.observations) ? entity.observations.map(String) : [],
        })),
        relations: relations.map((relation) => ({
          from: String(relation.from),
          to: String(relation.to),
          relationType: String(relation.relationType ?? 'related_to'),
        })),
      },
    };
  } catch (err) {
    return {
      ok: false,
      graph: structuredClone(EMPTY_GRAPH),
      code: 'GRAPH_CORRUPT',
      error: `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or delete it — this tool will not overwrite it.`,
    };
  }
}

/**
 * Run `mutate` under the file lock and persist its result.
 *
 * The lock is what makes concurrent writers safe: two agents that both read the
 * graph, add an entity and write it back would otherwise lose one of the two.
 */
export function mutateGraph(
  projectRoot: string,
  mutate: (graph: MemoryGraph) => { result: unknown } | { error: MemoryWriteResult }
): { ok: boolean; code?: string; error?: string; result?: unknown } {
  const file = memoryFilePath(projectRoot);
  // The lock is a SIDECAR file (`memory.json.lock`): taking the lock must never
  // touch — or worse, delete — the data file itself.
  try {
    return withFileLockSync(lockPathFor(file), () => {
      const loaded = loadGraph(projectRoot);
      if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };

      const outcome = mutate(loaded.graph);
      if ('error' in outcome) return outcome.error;

      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, JSON.stringify(loaded.graph, null, 2));
      return { ok: true, result: outcome.result };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: /lock/i.test(message) ? 'LOCK_TIMEOUT' : 'WRITE_FAILED',
      error: `Could not update ${file}: ${message}`,
    };
  }
}

// ─── Operations (reference semantics) ──────────────────────────────

export function createEntities(graph: MemoryGraph, entities: MemoryEntity[]): MemoryEntity[] {
  const created: MemoryEntity[] = [];
  for (const entity of entities) {
    const exists =
      graph.entities.some((existing) => existing.name === entity.name) ||
      created.some((candidate) => candidate.name === entity.name);
    if (exists) continue;
    const record: MemoryEntity = {
      name: entity.name,
      entityType: entity.entityType,
      observations: [...entity.observations],
    };
    graph.entities.push(record);
    created.push(record);
  }
  return created;
}

export function createRelations(
  graph: MemoryGraph,
  relations: MemoryRelation[]
): { created: MemoryRelation[] } | { error: MemoryWriteResult } {
  const names = new Set(graph.entities.map((entity) => entity.name));
  for (const relation of relations) {
    if (!names.has(relation.from)) {
      return {
        error: {
          ok: false,
          code: 'ENTITY_NOT_FOUND',
          error: `Entity "${relation.from}" does not exist — create it before relating it.`,
        },
      };
    }
    if (!names.has(relation.to)) {
      return {
        error: {
          ok: false,
          code: 'ENTITY_NOT_FOUND',
          error: `Entity "${relation.to}" does not exist — create it before relating it.`,
        },
      };
    }
  }

  const same = (a: MemoryRelation, b: MemoryRelation): boolean =>
    a.from === b.from && a.to === b.to && a.relationType === b.relationType;
  const created: MemoryRelation[] = [];
  for (const relation of relations) {
    const exists =
      graph.relations.some((existing) => same(existing, relation)) ||
      created.some((candidate) => same(candidate, relation));
    if (exists) continue;
    graph.relations.push({ ...relation });
    created.push({ ...relation });
  }
  return { created };
}

export function addObservations(
  graph: MemoryGraph,
  additions: Array<{ entityName: string; contents: string[] }>
):
  | { added: Array<{ entityName: string; addedObservations: string[] }> }
  | { error: MemoryWriteResult } {
  const added: Array<{ entityName: string; addedObservations: string[] }> = [];
  for (const addition of additions) {
    const entity = graph.entities.find((candidate) => candidate.name === addition.entityName);
    if (!entity) {
      return {
        error: {
          ok: false,
          code: 'ENTITY_NOT_FOUND',
          error: `Entity "${addition.entityName}" does not exist — create it first (create_entities).`,
        },
      };
    }
    const fresh = addition.contents.filter((content) => !entity.observations.includes(content));
    entity.observations.push(...fresh);
    added.push({ entityName: addition.entityName, addedObservations: fresh });
  }
  return { added };
}

export function deleteEntities(
  graph: MemoryGraph,
  names: string[]
): { deleted: string[]; notFound: string[]; relationsRemoved: number } {
  const present = new Set(graph.entities.map((entity) => entity.name));
  const deleted = names.filter((name) => present.has(name));
  const notFound = names.filter((name) => !present.has(name));
  const before = graph.relations.length;
  graph.entities = graph.entities.filter((entity) => !names.includes(entity.name));
  // The reference removes the relations of a deleted entity as well; dangling
  // edges would make `open_nodes` report a neighbour that no longer exists.
  graph.relations = graph.relations.filter(
    (relation) => !names.includes(relation.from) && !names.includes(relation.to)
  );
  return {
    deleted,
    notFound,
    relationsRemoved: before - graph.relations.length,
  };
}

export function deleteObservations(
  graph: MemoryGraph,
  deletions: Array<{ entityName: string; observations: string[] }>
): { deletedCount: number; missingEntities: string[] } {
  let deletedCount = 0;
  const missingEntities: string[] = [];
  for (const deletion of deletions) {
    const entity = graph.entities.find((candidate) => candidate.name === deletion.entityName);
    if (!entity) {
      missingEntities.push(deletion.entityName);
      continue;
    }
    const before = entity.observations.length;
    entity.observations = entity.observations.filter(
      (observation) => !deletion.observations.includes(observation)
    );
    deletedCount += before - entity.observations.length;
  }
  return { deletedCount, missingEntities };
}

export function deleteRelations(
  graph: MemoryGraph,
  relations: MemoryRelation[]
): { deletedCount: number } {
  const same = (a: MemoryRelation, b: MemoryRelation): boolean =>
    a.from === b.from && a.to === b.to && a.relationType === b.relationType;
  const before = graph.relations.length;
  graph.relations = graph.relations.filter(
    (existing) => !relations.some((candidate) => same(existing, candidate))
  );
  return { deletedCount: before - graph.relations.length };
}

/**
 * Search name, type and observations (case-insensitive), keeping the relations
 * where either endpoint matched — the reference's rule, and the reason a search
 * for "auth" shows you what the auth module touches.
 */
export function searchNodes(graph: MemoryGraph, query: string): MemoryGraph {
  const needle = query.toLowerCase();
  const entities = graph.entities.filter(
    (entity) =>
      entity.name.toLowerCase().includes(needle) ||
      entity.entityType.toLowerCase().includes(needle) ||
      entity.observations.some((observation) => observation.toLowerCase().includes(needle))
  );
  const names = new Set(entities.map((entity) => entity.name));
  return {
    entities,
    relations: graph.relations.filter(
      (relation) => names.has(relation.from) || names.has(relation.to)
    ),
  };
}

export function openNodes(graph: MemoryGraph, names: string[]): MemoryGraph {
  const wanted = new Set(names);
  const entities = graph.entities.filter((entity) => wanted.has(entity.name));
  const present = new Set(entities.map((entity) => entity.name));
  return {
    entities,
    relations: graph.relations.filter(
      (relation) => present.has(relation.from) || present.has(relation.to)
    ),
  };
}

/** Entities the query did not name but that a returned relation points at. */
export function danglingRelationTargets(graph: MemoryGraph): string[] {
  const known = new Set(graph.entities.map((entity) => entity.name));
  const unknown = new Set<string>();
  for (const relation of graph.relations) {
    if (!known.has(relation.from)) unknown.add(relation.from);
    if (!known.has(relation.to)) unknown.add(relation.to);
  }
  return [...unknown].sort();
}
