import type { PersonaRegistry } from '../registries/persona-registry.js';

// ─── Types ────────────────────────────────────────────────────────

export interface DelegationGuardConfig {
  /** Maximum allowed delegation depth (default: 1) */
  maxDepth: number;
  /** PersonaRegistry for checking allowedTools */
  personaRegistry: PersonaRegistry;
}

// ─── DelegationGuard ─────────────────────────────────────────────

/**
 * Prevents uncontrolled recursive delegation.
 *
 * Rules:
 *   1. Sub-agents do NOT have access to `delegate_task` by default.
 *   2. Only personas that explicitly include `delegate_task` in
 *      their `allowedTools` can delegate.
 *   3. Even for those personas, the delegation depth is capped
 *      at `maxDepth` (default: 1 = only the Main Agent can delegate).
 *
 * This guard is checked at two points:
 *   - Agent Factory (Phase 5): when building the agent's tool set.
 *   - delegate_task tool (Phase 6): at execution time.
 */
export class DelegationGuard {
  private readonly maxDepth: number;
  private readonly personaRegistry: PersonaRegistry;

  constructor(config: DelegationGuardConfig) {
    this.maxDepth = config.maxDepth;
    this.personaRegistry = config.personaRegistry;
  }

  /**
   * Check if a persona is allowed to delegate at the given depth.
   */
  canDelegate(personaId: string, currentDepth: number): {
    allowed: boolean;
    reason?: string;
  } {
    if (currentDepth >= this.maxDepth) {
      return {
        allowed: false,
        reason:
          `Delegation depth ${currentDepth} exceeds maximum ${this.maxDepth}. ` +
          `Recursive delegation is not permitted.`,
      };
    }

    const persona = this.personaRegistry.get(personaId);
    if (!persona) {
      return {
        allowed: false,
        reason: `Persona "${personaId}" not found.`,
      };
    }

    const hasDelegateTool =
      persona.allowedTools.includes('delegate_task') ||
      persona.allowedTools.includes('*');

    if (!hasDelegateTool) {
      return {
        allowed: false,
        reason:
          `Persona "${personaId}" does not have "delegate_task" in its ` +
          `allowedTools. Sub-agents cannot delegate by default.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Filter `delegate_task` out of a tool list if the persona
   * is not allowed to delegate at the current depth.
   */
  filterTools(
    toolIds: string[],
    personaId: string,
    currentDepth: number
  ): { filtered: string[]; removed: string[] } {
    const check = this.canDelegate(personaId, currentDepth);

    if (check.allowed) {
      return { filtered: toolIds, removed: [] };
    }

    const filtered = toolIds.filter((id) => id !== 'delegate_task');
    const removed = toolIds.filter((id) => id === 'delegate_task');

    return { filtered, removed };
  }
}
