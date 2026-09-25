import { createHash } from 'node:crypto';
import { buildEnvironmentContext } from '../environment-context.js';
import type { Tool, LanguageModel } from 'ai';
import type { AgentRegistry, CrossRegistryRefs } from '../registries/agent-registry.js';
import type { AgentDefinition } from '../schemas/agent-definition.js';
import type { Persona } from '../schemas/persona.js';
import { personaAllowsTool } from '../schemas/persona.js';
import type { ResolvedSkill } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import type { DelegationGuard } from '../runtime/delegation-guard.js';

// ─── Types ────────────────────────────────────────────────────────

export interface TrimmingRecord {
  skillId: string;
  originalLength: number;
  trimmedLength: number;
  reason: 'context-budget';
}

export interface ToolFilterWarning {
  toolId: string;
  skillId: string;
  reason: 'not-in-allowedTools';
}

export interface ResolvedAgent {
  /** The original agent definition (or dynamic spec) */
  agentId: string;
  /** Combined system prompt: persona.system + skill instructions */
  systemPrompt: string;
  /** Filtered tools — only those in persona.allowedTools */
  tools: Record<string, Tool>;
  /** The LanguageModel instance */
  model: LanguageModel;
  /** Persona used */
  persona: Persona;
  /** Skills included (after trimming) */
  skills: ResolvedSkill[];
  /** Warnings about tools that were filtered out */
  toolWarnings: ToolFilterWarning[];
  /** Log of any trimming that occurred */
  trimmingLog: TrimmingRecord[];
  /** Whether the system prompt was trimmed due to context budget */
  contextBudgetExceeded: boolean;
}

export interface CreateAgentOptions {
  agentDefinition: AgentDefinition;
  refs: CrossRegistryRefs;
  /**
   * Maximum context budget in characters (rough approximation:
   * 1 token ≈ 4 chars for English).  If not provided, defaults
   * to the model's known limit or 120_000 chars (~30k tokens).
   */
  contextBudgetChars?: number;
  /** Current delegation depth (default: 0) */
  delegationDepth?: number;
  /** Delegation guard instance */
  delegationGuard?: DelegationGuard;
}

// ─── Constants ────────────────────────────────────────────────────

/** Rough chars-per-token ratio for English text */
const CHARS_PER_TOKEN = 4;

/** Default context budget: ~30k tokens */
const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;

/**
 * Known model context limits (in tokens).
 * This is a fallback — in production, ModelConfig should carry this.
 */
const KNOWN_MODEL_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-sonnet': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'local-llama': 8_192,
};

// ─── Agent Factory ───────────────────────────────────────────────

/**
 * Creates a fully-resolved agent from an AgentDefinition by:
 *
 * 1. Looking up persona, skills, and model from their registries.
 * 2. Collecting all tool ids required by the skills.
 * 3. **Filtering tools** against `persona.allowedTools` (Law 18):
 *    any tool not in the whitelist is removed and a warning logged.
 * 4. **Combining instructions**: persona.system + skill instructions.
 * 5. **Checking context budget**: if the combined text exceeds the
 *    model's limit, low-priority skill instructions are trimmed
 *    first.  persona.system is NEVER trimmed.
 * 6. Returning a `ResolvedAgent` ready for execution.
 *
 * This function does NOT instantiate a ToolLoopAgent — that happens
 * in Phase 7 (Agent Runtime).  The output is a pure data structure
 * that the runtime can consume.
 */
export function createAgent(options: CreateAgentOptions): ResolvedAgent {
  const { agentDefinition: def, refs, delegationDepth = 0, delegationGuard } = options;

  // ── 1. Resolve references ───────────────────────────────────

  const persona = refs.personaRegistry.get(def.personaId);
  if (!persona) {
    throw new Error(
      `[AgentFactory] Persona "${def.personaId}" not found for agent "${def.id}".`
    );
  }

  const skills: ResolvedSkill[] = [];
  for (const skillId of def.skillIds) {
    const skill = refs.skillRegistry.get(skillId);
    if (!skill) {
      throw new Error(
        `[AgentFactory] Skill "${skillId}" not found for agent "${def.id}".`
      );
    }
    skills.push(skill);
  }

  if (!refs.modelRegistry.hasConfig(def.modelId)) {
    throw new Error(
      `[AgentFactory] Model "${def.modelId}" not found for agent "${def.id}".`
    );
  }
  const model = refs.modelRegistry.get(def.modelId);

  // ── 2. Collect and filter tools ─────────────────────────────

  const toolWarnings: ToolFilterWarning[] = [];
  let requestedToolIds = new Set<string>();

  for (const skill of skills) {
    for (const toolId of skill.resolvedTools) {
      requestedToolIds.add(toolId);
    }
  }

  // Tools declared directly on the agent definition (plan steps pass
  // PlanStep.assignedTools here) are requested as well; they still have
  // to survive the persona allow-list filter below.
  for (const toolId of def.toolIds ?? []) {
    requestedToolIds.add(toolId);
  }

  // Apply DelegationGuard if provided
  if (delegationGuard) {
    const { filtered, removed } = delegationGuard.filterTools(
      Array.from(requestedToolIds),
      def.personaId,
      delegationDepth
    );
    requestedToolIds = new Set(filtered);
    for (const r of removed) {
      toolWarnings.push({ toolId: r, skillId: 'delegation-guard', reason: 'not-in-allowedTools' });
    }
  }

  const allowedToolIds = new Set<string>();
  for (const toolId of requestedToolIds) {
    // Find which skill requested this tool for warning context
    const requestingSkill =
      skills.find((s) => s.resolvedTools.includes(toolId)) ??
      ((def.toolIds ?? []).includes(toolId) ? { id: 'agent-definition' } : undefined);
    if (personaAllowsTool(persona, toolId)) {
      allowedToolIds.add(toolId);
    } else {
      toolWarnings.push({
        toolId,
        skillId: requestingSkill?.id ?? 'unknown',
        reason: 'not-in-allowedTools',
      });
    }
  }

  // Build the tools record from allowed ids only
  const tools: Record<string, Tool> = {};
  if (allowedToolIds.size > 0) {
    const resolved = refs.toolRegistry.getToolsByIds(Array.from(allowedToolIds));
    Object.assign(tools, resolved);
  }

  // ── 3. Determine context budget ─────────────────────────────

  const modelTokenLimit =
    KNOWN_MODEL_LIMITS[def.modelId] ??
    (refs.modelRegistry.getConfig(def.modelId)?.config?.maxContextTokens as number) ??
    30_000;

  const budgetChars = options.contextBudgetChars ?? modelTokenLimit * CHARS_PER_TOKEN;

  // ── 4. Combine instructions with budget awareness ───────────

  const { systemPrompt, trimmingLog, contextBudgetExceeded } = buildSystemPrompt({
    persona,
    skills,
    budgetChars,
  });

  // Phase 36: the agent (not only the planner) is told which machine it is on.
  // The planner writes plan text; the agent writes the actual commands and
  // file contents, so it is the one that must not emit `sed -i` on macOS or
  // `rm -rf` on Windows.  Appended after trimming on purpose: the persona and
  // the skills stay within budget, and this block is small and never trimmed.
  const systemPromptWithEnvironment = `${systemPrompt}\n\n${buildEnvironmentContext()}`;

  return {
    agentId: def.id,
    systemPrompt: systemPromptWithEnvironment,
    tools,
    model,
    persona,
    skills,
    toolWarnings,
    trimmingLog,
    contextBudgetExceeded,
  };
}

// ─── Instruction builder with trimming ───────────────────────────

interface BuildPromptOptions {
  persona: Persona;
  skills: ResolvedSkill[];
  budgetChars: number;
}

interface BuildPromptResult {
  systemPrompt: string;
  trimmingLog: TrimmingRecord[];
  contextBudgetExceeded: boolean;
}

/**
 * Build the combined system prompt from persona + skills.
 *
 * Trimming strategy (when over budget):
 *   1. persona.system is NEVER trimmed (always included in full).
 *   2. Skills are sorted by priority ascending (lowest first).
 *   3. Lowest-priority skills are truncated/removed one by one
 *      until the total fits within the budget.
 *   4. If even persona.system alone exceeds the budget, it is
 *      included as-is (we never silently drop the persona) and
 *      a flag is set.
 */
function buildSystemPrompt(opts: BuildPromptOptions): BuildPromptResult {
  const { persona, skills, budgetChars } = opts;
  const trimmingLog: TrimmingRecord[] = [];

  const personaSection = `# Persona: ${persona.name}\n\n${persona.system}`;
  const personaLength = personaSection.length;

  // If persona alone exceeds budget, include it anyway (never trim persona)
  if (personaLength >= budgetChars) {
    return {
      systemPrompt: personaSection,
      trimmingLog: [],
      contextBudgetExceeded: true,
    };
  }

  // Sort skills by priority ascending (lowest priority = trimmed first)
  const sortedSkills = [...skills].sort(
    (a, b) => (a.priority ?? 50) - (b.priority ?? 50)
  );

  // Calculate total length
  const skillSections = sortedSkills.map((skill) => ({
    skill,
    text: `\n\n# Skill: ${skill.name}\n\n${skill.resolvedInstructions}`,
  }));

  let totalLength = personaLength;
  for (const s of skillSections) {
    totalLength += s.text.length;
  }

  // If within budget, no trimming needed
  if (totalLength <= budgetChars) {
    const fullPrompt = personaSection + skillSections.map((s) => s.text).join('');
    return {
      systemPrompt: fullPrompt,
      trimmingLog: [],
      contextBudgetExceeded: false,
    };
  }

  // ── Trimming loop ───────────────────────────────────────────
  // Remove lowest-priority skills one by one until we fit

  let remainingBudget = budgetChars - personaLength;
  const includedSections: string[] = [];

  // Process from highest priority to lowest (include high-priority first)
  const byPriorityDesc = [...skillSections].sort(
    (a, b) => (b.skill.priority ?? 50) - (a.skill.priority ?? 50)
  );

  for (const section of byPriorityDesc) {
    if (section.text.length <= remainingBudget) {
      includedSections.push(section.text);
      remainingBudget -= section.text.length;
    } else {
      // Try truncating this skill's instructions
      const header = `\n\n# Skill: ${section.skill.name}\n\n`;
      const availableForContent = remainingBudget - header.length;

      if (availableForContent > 100) {
        // Truncate with an ellipsis marker
        const truncated =
          section.skill.resolvedInstructions.slice(0, availableForContent - 50) +
          '\n\n[... instructions truncated due to context budget ...]';
        const truncatedText = header + truncated;
        includedSections.push(truncatedText);
        remainingBudget -= truncatedText.length;

        trimmingLog.push({
          skillId: section.skill.id,
          originalLength: section.skill.resolvedInstructions.length,
          trimmedLength: truncated.length,
          reason: 'context-budget',
        });
      } else {
        // Not enough room even for a truncated version — skip entirely
        trimmingLog.push({
          skillId: section.skill.id,
          originalLength: section.skill.resolvedInstructions.length,
          trimmedLength: 0,
          reason: 'context-budget',
        });
      }
    }
  }

  const finalPrompt = personaSection + includedSections.join('');

  return {
    systemPrompt: finalPrompt,
    trimmingLog,
    contextBudgetExceeded: trimmingLog.length > 0,
  };
}

// ─── Agent Cache ──────────────────────────────────────────────────

/**
 * Phase 21 (PERF-02): canonical (key-sorted) serialization.
 * `JSON.stringify` alone is order-sensitive — two definitions with
 * the same fields in different key orders would hash differently.
 * Sorting keys recursively makes the hash depend only on CONTENT.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** Phase 21 (PERF-02): sha256 of the canonical form — cheap to store, fast to compare. */
export function hashAgentDefinition(def: AgentDefinition): string {
  return createHash('sha256').update(stableStringify(def)).digest('hex');
}

/**
 * Simple cache for resolved agents.  Keyed by a hash of the
 * agent definition so that changes to the underlying registries
 * (e.g. a new skill version) invalidate the cache.
 *
 * Phase 21 (PERF-02): the hit check used to be
 * `JSON.stringify(cached.def) !== JSON.stringify(currentDef)` — an
 * O(size) serialization of BOTH objects on every lookup.  Now each
 * `set` stores a sha256 of the canonical form and a `get` compares a
 * precomputed 64-char hash (one hash of the incoming def, constant
 * work regardless of def size).
 */
export class AgentCache {
  private readonly cache = new Map<string, { hash: string; resolved: ResolvedAgent }>();

  /**
   * Get a cached agent if the definition hasn't changed.
   * Returns undefined on cache miss or definition mismatch.
   */
  get(id: string, currentDef: AgentDefinition): ResolvedAgent | undefined {
    const cached = this.cache.get(id);
    if (!cached) return undefined;

    if (cached.hash !== hashAgentDefinition(currentDef)) {
      this.cache.delete(id);
      return undefined;
    }

    return cached.resolved;
  }

  set(id: string, def: AgentDefinition, resolved: ResolvedAgent): void {
    this.cache.set(id, { hash: hashAgentDefinition(def), resolved });
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Cached version of createAgent.  Returns the cached ResolvedAgent
 * if the definition hasn't changed; otherwise creates a new one.
 */
export function createAgentCached(
  options: CreateAgentOptions,
  cache: AgentCache
): ResolvedAgent {
  const def = options.agentDefinition;
  const cached = cache.get(def.id, def);
  if (cached) return cached;

  const resolved = createAgent(options);
  cache.set(def.id, def, resolved);
  return resolved;
}
