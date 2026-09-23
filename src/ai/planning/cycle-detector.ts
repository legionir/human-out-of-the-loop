import type { Plan } from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface CycleDetectionResult {
  hasCycle: boolean;
  /** The cycle path if one was found (e.g. ["step-1", "step-3", "step-1"]) */
  cyclePath?: string[];
}

// ─── Cycle Detection ─────────────────────────────────────────────

/**
 * Detect circular dependencies in the plan's dependency graph
 * using DFS with coloring (white/gray/black).
 *
 * Returns the cycle path if one exists, making it easy for the
 * Planner to identify and fix the problematic steps.
 */
export function detectCycles(plan: Plan): CycleDetectionResult {
  const adjacency = new Map<string, string[]>();
  for (const step of plan.steps) {
    adjacency.set(step.id, step.dependsOn);
  }

  const WHITE = 0; // unvisited
  const GRAY = 1; // in current DFS path
  const BLACK = 2; // fully processed

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const step of plan.steps) {
    color.set(step.id, WHITE);
    parent.set(step.id, null);
  }

  function dfs(nodeId: string, path: string[]): CycleDetectionResult {
    color.set(nodeId, GRAY);
    path.push(nodeId);

    const neighbors = adjacency.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      // Skip references to non-existent steps (caught by feasibility gate)
      if (!color.has(neighbor)) continue;

      if (color.get(neighbor) === GRAY) {
        // Found a cycle — extract the cycle path
        const cycleStart = path.indexOf(neighbor);
        const cyclePath = path.slice(cycleStart).concat(neighbor);
        return { hasCycle: true, cyclePath };
      }

      if (color.get(neighbor) === WHITE) {
        const result = dfs(neighbor, path);
        if (result.hasCycle) return result;
      }
    }

    path.pop();
    color.set(nodeId, BLACK);
    return { hasCycle: false };
  }

  for (const step of plan.steps) {
    if (color.get(step.id) === WHITE) {
      const result = dfs(step.id, []);
      if (result.hasCycle) return result;
    }
  }

  return { hasCycle: false };
}

/**
 * Compute a topological ordering of plan steps.
 * Returns null if the graph has cycles.
 */
export function topologicalSort(plan: Plan): string[] | null {
  const cycleCheck = detectCycles(plan);
  if (cycleCheck.hasCycle) return null;

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const step of plan.steps) {
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (adjacency.has(dep)) {
        adjacency.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return sorted.length === plan.steps.length ? sorted : null;
}
