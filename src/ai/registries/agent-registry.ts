import fs from 'node:fs';
import { createRegistry, Registry } from './base-registry.js';
import { AgentDefinitionSchema, type AgentDefinition } from '../schemas/agent-definition.js';
import type { PersonaRegistry } from './persona-registry.js';
import type { SkillRegistry } from './skill-registry.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ModelRegistry } from './model-registry.js';

// ─── Types ────────────────────────────────────────────────────────

export interface CrossRegistryRefs {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
}

export interface AgentValidationResult {
  agentId: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── AgentRegistry ───────────────────────────────────────────────

/**
 * Data-driven registry for Agent definitions.
 *
 * Each AgentDefinition is a pure composition reference:
 *   personaId → PersonaRegistry
 *   skillIds  → SkillRegistry
 *   modelId   → ModelRegistry
 *
 * Cross-registry validation ensures all references resolve at
 * startup, not at runtime.  This prevents an Agent from being
 * constructed only to fail because a Skill or Persona was renamed.
 *
 * Law 16 compliance: agents are loaded from `registry/agents.json`,
 * so adding a new agent requires no code changes.
 */
export class AgentRegistry {
  private readonly registry: Registry<AgentDefinition>;

  constructor() {
    this.registry = createRegistry<AgentDefinition>({
      schema: AgentDefinitionSchema,
      label: 'AgentRegistry',
    });
  }

  // ── CRUD ──────────────────────────────────────────────────────

  register(raw: unknown): AgentDefinition {
    return this.registry.register(raw);
  }

  get(id: string): AgentDefinition | undefined {
    return this.registry.get(id);
  }

  has(id: string): boolean {
    return this.registry.has(id);
  }

  list(): ReadonlyArray<AgentDefinition> {
    return this.registry.list();
  }

  get size(): number {
    return this.registry.size;
  }

  // ── Bulk loading ──────────────────────────────────────────────

  /**
   * Load agent definitions from a JSON file.
   * The file should contain a JSON array of AgentDefinition objects.
   */
  loadFromFile(filePath: string): { loaded: number; errors: string[] } {
    const result = { loaded: 0, errors: [] as string[] };

    if (!fs.existsSync(filePath)) {
      result.errors.push(`File not found: ${filePath}`);
      return result;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const items = Array.isArray(raw) ? raw : [raw];

      for (const item of items) {
        try {
          this.register(item);
          result.loaded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(msg);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${filePath}: ${msg}`);
    }

    return result;
  }

  // ── Cross-registry validation ─────────────────────────────────

  /**
   * Validate a single agent definition against all four registries.
   * Returns detailed errors and warnings without throwing.
   */
  validateAgent(agentId: string, refs: CrossRegistryRefs): AgentValidationResult {
    const result: AgentValidationResult = {
      agentId,
      valid: true,
      errors: [],
      warnings: [],
    };

    const def = this.registry.get(agentId);
    if (!def) {
      result.valid = false;
      result.errors.push(`Agent "${agentId}" not found in AgentRegistry.`);
      return result;
    }

    // 1. Persona
    if (!refs.personaRegistry.has(def.personaId)) {
      result.valid = false;
      result.errors.push(
        `Agent "${agentId}" references persona "${def.personaId}" which does not exist.`
      );
    }

    // 2. Skills
    for (const skillId of def.skillIds) {
      if (!refs.skillRegistry.has(skillId)) {
        result.valid = false;
        result.errors.push(
          `Agent "${agentId}" references skill "${skillId}" which does not exist.`
        );
      }
    }

    // 3. Model
    if (!refs.modelRegistry.hasConfig(def.modelId)) {
      result.valid = false;
      result.errors.push(
        `Agent "${agentId}" references model "${def.modelId}" which does not exist.`
      );
    }

    // 4. Tools (via skills) — check that skill tools exist in ToolRegistry
    for (const skillId of def.skillIds) {
      const skill = refs.skillRegistry.get(skillId);
      if (skill) {
        for (const toolId of skill.resolvedTools) {
          if (!refs.toolRegistry.hasDefinition(toolId)) {
            result.valid = false;
            result.errors.push(
              `Agent "${agentId}" → skill "${skillId}" references tool "${toolId}" which does not exist in ToolRegistry.`
            );
          }
        }
      }
    }

    return result;
  }

  /**
   * Validate ALL registered agents.  Useful at startup.
   */
  validateAll(refs: CrossRegistryRefs): { valid: boolean; results: AgentValidationResult[] } {
    const results = this.list().map((def) => this.validateAgent(def.id, refs));
    const allValid = results.every((r) => r.valid);
    return { valid: allValid, results };
  }
}
