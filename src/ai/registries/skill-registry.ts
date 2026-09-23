import fs from 'node:fs';
import path from 'node:path';
import { createRegistry, Registry } from './base-registry.js';
import { SkillSchema, type Skill } from '../schemas/skill.js';
import type { ToolRegistry } from './tool-registry.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A fully-resolved Skill: instructions loaded from SKILL.md and
 * tool references cross-validated against the ToolRegistry.
 */
export interface ResolvedSkill extends Skill {
  /** The actual markdown content loaded from SKILL.md */
  resolvedInstructions: string;
  /** Verified list of tool ids (all confirmed present in ToolRegistry) */
  resolvedTools: string[];
}

export interface SkillRegistryOptions {
  /** Reference to the ToolRegistry for cross-validation of tool ids */
  toolRegistry: ToolRegistry;
}

// ─── SkillRegistry ───────────────────────────────────────────────

/**
 * Extends the generic base Registry with:
 *   1. SKILL.md loading — replaces the `instructions` placeholder
 *      with actual markdown content.
 *   2. Cross-registry validation — ensures every tool id referenced
 *      by a skill actually exists in the ToolRegistry.
 *
 * Law 12 compliance: Skills reference tools by *id* only, never by
 * direct import.  The resolver checks existence but does not pull
 * in the implementation.
 */
export class SkillRegistry {
  private readonly metadata: Registry<Skill>;
  private readonly resolved = new Map<string, ResolvedSkill>();
  private readonly toolRegistry: ToolRegistry;

  constructor(options: SkillRegistryOptions) {
    this.metadata = createRegistry<Skill>({
      schema: SkillSchema,
      label: 'SkillRegistry',
    });
    this.toolRegistry = options.toolRegistry;
  }

  // ── Registration ──────────────────────────────────────────────

  /**
   * Register a skill from its raw JSON data AND the directory
   * containing its SKILL.md file.
   *
   * @param raw       Parsed JSON matching SkillSchema
   * @param skillDir  Absolute path to the skill's directory
   *                  (e.g. `registry/skills/code_analysis/`)
   */
  registerFromDirectory(raw: unknown, skillDir: string): ResolvedSkill {
    // 1. Validate metadata
    const skill = this.metadata.register(raw);

    // 2. Resolve instructions from SKILL.md
    const resolvedInstructions = this.loadInstructions(skill, skillDir);

    // 3. Cross-validate tool references
    this.validateToolReferences(skill);

    // 4. Store resolved skill
    const resolved: ResolvedSkill = {
      ...skill,
      resolvedInstructions,
      resolvedTools: [...skill.tools],
    };
    this.resolved.set(skill.id, resolved);

    return resolved;
  }

  // ── Queries ───────────────────────────────────────────────────

  get(id: string): ResolvedSkill | undefined {
    return this.resolved.get(id);
  }

  has(id: string): boolean {
    return this.resolved.has(id);
  }

  list(): ReadonlyArray<ResolvedSkill> {
    return Array.from(this.resolved.values());
  }

  get size(): number {
    return this.resolved.size;
  }

  // ── Internal helpers ──────────────────────────────────────────

  /**
   * If `skill.instructions` equals "SKILL.md" (or ends with ".md"),
   * read the file from `skillDir`.  Otherwise treat the value as
   * inline instructions.
   */
  private loadInstructions(skill: Skill, skillDir: string): string {
    const instr = skill.instructions.trim();

    // Case 1: reference to a markdown file
    if (instr.endsWith('.md')) {
      const mdPath = path.resolve(skillDir, instr);
      if (!fs.existsSync(mdPath)) {
        throw new Error(
          `[SkillRegistry] Skill "${skill.id}" references instructions file ` +
            `"${instr}" but it was not found at ${mdPath}`
        );
      }
      return fs.readFileSync(mdPath, 'utf-8').trim();
    }

    // Case 2: inline instructions
    return instr;
  }

  /**
   * Verify that every tool id in `skill.tools` exists in the
   * ToolRegistry.  Throws at startup (not at runtime) if any
   * reference is broken.
   */
  private validateToolReferences(skill: Skill): void {
    const missing: string[] = [];
    for (const toolId of skill.tools) {
      if (!this.toolRegistry.hasDefinition(toolId)) {
        missing.push(toolId);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `[SkillRegistry] Skill "${skill.id}" references unknown tool(s): ` +
          `[${missing.join(', ')}]. ` +
          `Available tools: [${this.toolRegistry.listDefinitions().map((d) => d.id).join(', ')}]`
      );
    }
  }
}

// ─── Directory loader ────────────────────────────────────────────

/**
 * Scans a parent directory (e.g. `registry/skills/`) for sub-
 * directories, each containing a `skill.json` and optionally a
 * `SKILL.md`.  Registers every valid skill into the SkillRegistry.
 *
 * @param skillsDir   Path to the parent directory (e.g. `registry/skills/`)
 * @param registry    The SkillRegistry to populate
 * @param strict      If true, throws on any error (default: true for startup)
 */
export function loadSkillsFromDirectory(
  skillsDir: string,
  registry: SkillRegistry,
  strict = true
): { loaded: number; errors: Array<{ skill: string; error: string }> } {
  const result = { loaded: 0, errors: [] as Array<{ skill: string; error: string }> };

  if (!fs.existsSync(skillsDir)) {
    result.errors.push({ skill: skillsDir, error: 'Directory does not exist' });
    if (strict) throw new Error(`[loadSkills] Directory not found: ${skillsDir}`);
    return result;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const jsonPath = path.join(skillDir, 'skill.json');

    if (!fs.existsSync(jsonPath)) {
      result.errors.push({
        skill: entry.name,
        error: `No skill.json found in ${skillDir}`,
      });
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      registry.registerFromDirectory(raw, skillDir);
      result.loaded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ skill: entry.name, error: message });
    }
  }

  if (strict && result.errors.length > 0) {
    const summary = result.errors.map((e) => `  • ${e.skill}: ${e.error}`).join('\n');
    throw new Error(`[loadSkills] ${result.errors.length} error(s):\n${summary}`);
  }

  return result;
}
