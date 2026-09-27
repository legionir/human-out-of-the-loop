import { tool, type Tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import {
  addObservations,
  createEntities,
  createRelations,
  deleteEntities,
  deleteObservations,
  deleteRelations,
  danglingRelationTargets,
  loadGraph,
  memoryFilePath,
  mutateGraph,
  openNodes,
  searchNodes,
  type MemoryEntity,
  type MemoryGraph,
  type MemoryRelation,
} from '../memory/graph.js';

/**
 * Phase 39 — the memory toolset, ported from the reference `memory` server.
 *
 * Nine tools, same names and same semantics (see `../memory/graph.ts` for the
 * rules and the two deliberate differences: the graph is per project, and every
 * write is atomic + locked).
 *
 * What it is for: a run that discovers *why* something is the way it is — a
 * constraint, a decision, the name of the service that owns a queue — should
 * not lose it when the process exits. `memory` is the project's long-term
 * store; the Journal (phase 37) is the log of what happened, and the two are
 * complementary: the Journal is append-only history, memory is current state.
 *
 * Every write is also journalled automatically, so the graph has an audit
 * trail for free.
 */

const entitySchema = z.object({
  name: z.string().min(1).describe('Unique entity name, e.g. "auth-service"'),
  entityType: z
    .string()
    .min(1)
    .describe('What kind of thing it is, e.g. "service", "decision", "person"'),
  observations: z.array(z.string()).default([]).describe('Facts about it, one per entry'),
});

const relationSchema = z.object({
  from: z.string().min(1).describe('Source entity name (must already exist)'),
  to: z.string().min(1).describe('Target entity name (must already exist)'),
  relationType: z.string().min(1).describe('Active verb, e.g. "depends_on", "owned_by"'),
});

interface MemoryOutcome {
  success: boolean;
  /** Entity/relation payloads for the tools that return one. */
  entities?: MemoryEntity[];
  relations?: MemoryRelation[];
  created?: MemoryEntity[] | MemoryRelation[];
  added?: Array<{ entityName: string; addedObservations: string[] }>;
  deleted?: string[];
  notFound?: string[];
  deletedCount?: number;
  relationsRemoved?: number;
  missingEntities?: string[];
  /** `read_graph` / `search_nodes` / `open_nodes`. */
  graph?: MemoryGraph;
  counts?: { entities: number; relations: number };
  /** Names a returned relation points at but the result does not contain. */
  relatedOutsideResult?: string[];
  truncated?: boolean;
  total?: number;
  offset?: number;
  memoryFile?: string;
  error?: string;
  code?: string;
}

/** Every tool reports where the memory lives — the model should know. */
function withFile(projectRoot: string, outcome: MemoryOutcome): MemoryOutcome {
  return {
    ...outcome,
    memoryFile:
      path.relative(projectRoot, memoryFilePath(projectRoot)) || memoryFilePath(projectRoot),
  };
}

/** Entities of a graph as the tool result shape (entities are the payload). */
function graphOutcome(
  projectRoot: string,
  graph: MemoryGraph,
  extra: Partial<MemoryOutcome> = {}
): MemoryOutcome {
  return withFile(projectRoot, {
    success: true,
    entities: graph.entities,
    relations: graph.relations,
    counts: {
      entities: graph.entities.length,
      relations: graph.relations.length,
    },
    relatedOutsideResult: danglingRelationTargets(graph),
    ...extra,
  });
}

export function createCreateEntitiesTool(projectRoot: string): Tool {
  return tool({
    description:
      'Creates entities in the project memory. Names that already exist are left untouched (their ' +
      'observations are preserved) — use add_observations to extend one. Returns only what was created.',
    inputSchema: z.object({ entities: z.array(entitySchema).min(1) }),
    execute: async ({ entities }) => {
      const outcome = mutateGraph(projectRoot, (graph) => ({
        result: createEntities(graph, entities),
      }));
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const created = outcome.result as MemoryEntity[];
      return withFile(projectRoot, {
        success: true,
        created,
        counts: { entities: created.length, relations: 0 },
        ...(created.length < entities.length ? { total: entities.length, truncated: false } : {}),
      });
    },
  });
}

export function createCreateRelationsTool(projectRoot: string): Tool {
  return tool({
    description:
      'Creates relations between existing entities (both endpoints must already exist). Duplicate ' +
      'relations are ignored, and a relation pointing at a missing entity is refused.',
    inputSchema: z.object({ relations: z.array(relationSchema).min(1) }),
    execute: async ({ relations }) => {
      const outcome = mutateGraph(projectRoot, (graph) => {
        const result = createRelations(graph, relations);
        return 'error' in result ? { error: result.error } : { result: result.created };
      });
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const created = outcome.result as MemoryRelation[];
      return withFile(projectRoot, {
        success: true,
        created,
        counts: { entities: 0, relations: created.length },
      });
    },
  });
}

export function createAddObservationsTool(projectRoot: string): Tool {
  return tool({
    description:
      'Adds observations (facts) to existing entities. Duplicates are skipped, so re-running is safe.',
    inputSchema: z.object({
      observations: z
        .array(
          z.object({
            entityName: z.string().min(1),
            contents: z.array(z.string()).min(1),
          })
        )
        .min(1),
    }),
    execute: async ({ observations }) => {
      const outcome = mutateGraph(projectRoot, (graph) => {
        const result = addObservations(graph, observations);
        return 'error' in result ? { error: result.error } : { result: result.added };
      });
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const added = outcome.result as Array<{
        entityName: string;
        addedObservations: string[];
      }>;
      return withFile(projectRoot, { success: true, added });
    },
  });
}

export function createDeleteEntitiesTool(projectRoot: string): Tool {
  return tool({
    description:
      'Deletes entities by name, together with every relation that touches them. Names that do not ' +
      'exist are reported in `notFound` instead of failing.',
    inputSchema: z.object({ entityNames: z.array(z.string().min(1)).min(1) }),
    execute: async ({ entityNames }) => {
      const outcome = mutateGraph(projectRoot, (graph) => ({
        result: deleteEntities(graph, entityNames),
      }));
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const result = outcome.result as MemoryOutcome;
      return withFile(projectRoot, { ...result, success: true });
    },
  });
}

export function createDeleteObservationsTool(projectRoot: string): Tool {
  return tool({
    description:
      'Removes specific observations from entities; a missing entity is reported, not fatal.',
    inputSchema: z.object({
      deletions: z
        .array(
          z.object({
            entityName: z.string().min(1),
            observations: z.array(z.string()).min(1),
          })
        )
        .min(1),
    }),
    execute: async ({ deletions }) => {
      const outcome = mutateGraph(projectRoot, (graph) => ({
        result: deleteObservations(graph, deletions),
      }));
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const result = outcome.result as MemoryOutcome;
      return withFile(projectRoot, { ...result, success: true });
    },
  });
}

export function createDeleteRelationsTool(projectRoot: string): Tool {
  return tool({
    description:
      'Deletes relations (from + to + relationType); returns how many were actually removed.',
    inputSchema: z.object({ relations: z.array(relationSchema).min(1) }),
    execute: async ({ relations }) => {
      const outcome = mutateGraph(projectRoot, (graph) => ({
        result: deleteRelations(graph, relations),
      }));
      if (!outcome.ok)
        return withFile(projectRoot, {
          success: false,
          error: outcome.error,
          code: outcome.code,
        });
      const result = outcome.result as MemoryOutcome;
      return withFile(projectRoot, { ...result, success: true });
    },
  });
}

export function createReadGraphTool(projectRoot: string): Tool {
  return tool({
    description:
      'Reads the whole memory graph (entities with their observations, and the relations between ' +
      'them). Use search_nodes instead when you know what you are looking for.',
    inputSchema: z.object({
      maxEntities: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe('Ceiling on returned entities; `total` still reports the true count'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Skip this many entities (pagination)'),
    }),
    execute: async ({ maxEntities, offset }) => {
      const loaded = loadGraph(projectRoot);
      if (!loaded.ok)
        return withFile(projectRoot, {
          success: false,
          error: loaded.error,
          code: loaded.code,
        });

      const start = offset ?? 0;
      const entities = loaded.graph.entities.slice(start, start + (maxEntities ?? 200));
      const names = new Set(entities.map((entity) => entity.name));
      const truncated = start + entities.length < loaded.graph.entities.length;
      const graph: MemoryGraph = {
        entities,
        // A relation is kept when both ends are in the page, so the returned
        // graph never claims a neighbour the caller cannot see.
        relations: loaded.graph.relations.filter(
          (relation) => names.has(relation.from) && names.has(relation.to)
        ),
      };
      return graphOutcome(projectRoot, graph, {
        truncated,
        total: loaded.graph.entities.length,
        offset: start,
      });
    },
  });
}

export function createSearchNodesTool(projectRoot: string): Tool {
  return tool({
    description:
      'Searches memory for entities whose name, type or observations contain the query ' +
      '(case-insensitive), and returns their relations — so a match shows what it is connected to.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Word or phrase to look for'),
      maxEntities: z.number().int().min(1).max(2000).default(100),
    }),
    execute: async ({ query, maxEntities }) => {
      const loaded = loadGraph(projectRoot);
      if (!loaded.ok)
        return withFile(projectRoot, {
          success: false,
          error: loaded.error,
          code: loaded.code,
        });

      const found = searchNodes(loaded.graph, query);
      const entities = found.entities.slice(0, maxEntities);
      const names = new Set(entities.map((entity) => entity.name));
      const graph: MemoryGraph = {
        entities,
        relations: found.relations.filter(
          (relation) => names.has(relation.from) || names.has(relation.to)
        ),
      };
      return graphOutcome(projectRoot, graph, {
        truncated: found.entities.length > entities.length,
        total: found.entities.length,
      });
    },
  });
}

export function createOpenNodesTool(projectRoot: string): Tool {
  return tool({
    description:
      'Opens specific entities by name, with every relation that touches them — including relations ' +
      'to entities not in the result (their names are listed in `relatedOutsideResult`).',
    inputSchema: z.object({ names: z.array(z.string().min(1)).min(1) }),
    execute: async ({ names }) => {
      const loaded = loadGraph(projectRoot);
      if (!loaded.ok)
        return withFile(projectRoot, {
          success: false,
          error: loaded.error,
          code: loaded.code,
        });

      const graph = openNodes(loaded.graph, names);
      const missing = names.filter(
        (name) => !graph.entities.some((entity) => entity.name === name)
      );
      return graphOutcome(projectRoot, graph, {
        ...(missing.length > 0 ? { notFound: missing } : {}),
      });
    },
  });
}
