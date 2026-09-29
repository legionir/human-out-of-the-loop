import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PersonaSchema } from '../schemas/persona.js';
import { SkillSchema } from '../schemas/skill.js';

const registry = path.resolve(process.cwd(), 'registry');
const imported = JSON.parse(
  fs.readFileSync(path.join(registry, 'persona-library/import-report.json'), 'utf8'),
) as { mappings: Array<{ id: string }>; personas: number; skills: number };

describe('imported Persona/Skill library', () => {
  it('conforms to HOOTL registry schemas and has no dangling tool references', () => {
    const toolsDir = path.join(registry, 'tools');
    const toolIds = new Set(
      fs.readdirSync(toolsDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(fs.readFileSync(path.join(toolsDir, file), 'utf8')).id as string),
    );
    const ids = imported.mappings.map(({ id }) => id);

    expect(imported.personas).toBe(218);
    expect(imported.skills).toBe(218);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      const persona = PersonaSchema.parse(
        JSON.parse(fs.readFileSync(path.join(registry, 'personas', `${id}.json`), 'utf8')),
      );
      const skillDir = path.join(registry, 'skills', id);
      const skill = SkillSchema.parse(
        JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf8')),
      );
      const instructionsPath = path.join(skillDir, skill.instructions);
      const instructions = fs.readFileSync(instructionsPath, 'utf8');

      expect(persona.id).toBe(id);
      expect(skill.id).toBe(id);
      expect(persona.allowedTools).not.toContain('*');
      expect(persona.allowedTools).toEqual(skill.tools);
      for (const toolId of [...persona.allowedTools, ...skill.tools]) {
        expect(toolIds.has(toolId), `${id} references unknown tool ${toolId}`).toBe(true);
      }
      expect(instructions).toContain(`source: "../../personas/${id}.json"`);
      expect(instructions).not.toMatch(/\]\((?!\.\.\/personas\/)[^)]*(?:prompts|references)\//);
    }
  });
});
