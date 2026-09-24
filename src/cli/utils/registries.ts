/**
 * C1 (CLI completion): lightweight registry introspection.
 *
 * Reads `registry/{personas,skills,models,tools}/*.json` directly and
 * validates each file with the SAME zod schemas the runtime registries
 * use — no MCP bootstrap, no LLM, no Orchestrator (sub-second).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ModelConfigSchema,
  PersonaSchema,
  SkillSchema,
  ToolDefinitionSchema,
  type ModelConfig,
  type Persona,
  type Skill,
  type ToolDefinition,
} from '../../ai/schemas/index.js';

export interface RegistryFileError {
  file: string;
  error: string;
}

export interface LoadedRegistries {
  personas: Persona[];
  skills: Skill[];
  models: ModelConfig[];
  tools: ToolDefinition[];
  /** Per-file parse/validation failures (listed, not fatal). */
  errors: RegistryFileError[];
}

type ZodLike = { parse(value: unknown): unknown };

function loadJsonDir<T>(
  dir: string,
  schema: ZodLike,
  errors: RegistryFileError[],
): T[] {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return []; // no such directory → simply nothing registered
  }
  const items: T[] = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      items.push(schema.parse(JSON.parse(raw)) as T);
    } catch (e) {
      errors.push({
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return items;
}

/**
 * Skills use a directory-per-skill layout (`<skills>/<id>/skill.json`,
 * mirroring SkillRegistry.loadSkillsFromDirectory); a flat
 * `<skills>/<id>.json` file is accepted as well.
 */
function loadSkillDir(dir: string, schema: ZodLike, errors: RegistryFileError[]): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items: Skill[] = [];
  const parseFile = (file: string, label: string): void => {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      items.push(schema.parse(JSON.parse(raw)) as Skill);
    } catch (e) {
      errors.push({ file: label, error: e instanceof Error ? e.message : String(e) });
    }
  };
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      const jsonPath = path.join(dir, entry.name, 'skill.json');
      if (!fs.existsSync(jsonPath)) {
        errors.push({ file: entry.name, error: 'No skill.json found in skill directory' });
        continue;
      }
      parseFile(jsonPath, entry.name);
    } else if (entry.name.endsWith('.json')) {
      parseFile(path.join(dir, entry.name), entry.name);
    }
  }
  return items;
}

/**
 * Load all four registries from `<projectRoot>/registry`.
 * Missing subdirectories are fine (empty list); invalid files are
 * collected in `errors` so the caller can report them.
 */
export function loadRegistries(projectRoot: string): LoadedRegistries {
  const base = path.join(projectRoot, 'registry');
  const errors: RegistryFileError[] = [];
  return {
    personas: loadJsonDir<Persona>(path.join(base, 'personas'), PersonaSchema, errors),
    skills: loadSkillDir(path.join(base, 'skills'), SkillSchema, errors),
    models: loadJsonDir<ModelConfig>(path.join(base, 'models'), ModelConfigSchema, errors),
    tools: loadJsonDir<ToolDefinition>(path.join(base, 'tools'), ToolDefinitionSchema, errors),
    errors,
  };
}
