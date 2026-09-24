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
  registryLayersFor,
  type RegistryLayer,
} from '../../ai/registries/layout.js';
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
  /**
   * Phase 28: the registry layers that were read, lowest precedence
   * first (package → project).
   */
  layers: RegistryLayer[];
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
 * Load all four registries from the active layers (package, then project).
 *
 * Phase 28: the packaged registry ships the built-in catalog, so these
 * commands work from ANY directory; a project registry with entries of the
 * same id overrides the packaged defaults (project wins).  Missing
 * subdirectories are fine (empty list); invalid files are collected in
 * `errors` so the caller can report them.
 */
export function loadRegistries(projectRoot: string): LoadedRegistries {
  const layers = registryLayersFor(projectRoot);
  const errors: RegistryFileError[] = [];

  const merge = <T extends { id: string }>(items: T[]): T[] => {
    const byId = new Map<string, T>();
    for (const item of items) byId.set(item.id, item); // later layer wins
    return Array.from(byId.values());
  };

  const personas: Persona[] = [];
  const skills: Skill[] = [];
  const models: ModelConfig[] = [];
  const tools: ToolDefinition[] = [];

  for (const layer of layers) {
    personas.push(
      ...loadJsonDir<Persona>(path.join(layer.dir, 'personas'), PersonaSchema, errors),
    );
    skills.push(...loadSkillDir(path.join(layer.dir, 'skills'), SkillSchema, errors));
    models.push(
      ...loadJsonDir<ModelConfig>(path.join(layer.dir, 'models'), ModelConfigSchema, errors),
    );
    tools.push(
      ...loadJsonDir<ToolDefinition>(path.join(layer.dir, 'tools'), ToolDefinitionSchema, errors),
    );
  }

  return {
    personas: merge(personas),
    skills: merge(skills),
    models: merge(models),
    tools: merge(tools),
    errors,
    layers,
  };
}
