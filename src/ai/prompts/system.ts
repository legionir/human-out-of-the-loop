import type { Persona } from '../schemas/persona.js';
import type { ResolvedSkill } from '../registries/skill-registry.js';

export interface TrimmingRecord {
  skillId: string;
  originalLength: number;
  trimmedLength: number;
  reason: 'context-budget';
}

export interface BuildPromptOptions {
  persona: Persona;
  skills: ResolvedSkill[];
  budgetChars: number;
  allowedToolIds: ReadonlySet<string>;
}

export interface BuildPromptResult {
  systemPrompt: string;
  trimmingLog: TrimmingRecord[];
  contextBudgetExceeded: boolean;
}

/** Remove skill sections that refer to tools unavailable to this agent. */
export function filterSkillInstructions(
  markdown: string,
  allowedTools: ReadonlySet<string>,
  skillToolIds: readonly string[],
): string {
  const disallowed = skillToolIds.filter((id) => !allowedTools.has(id));
  if (disallowed.length === 0) return markdown;
  const patterns = disallowed.map((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
  const sections = markdown.split(/(?=^## )/m);
  const kept = sections.filter((section) => !patterns.some((pattern) => pattern.test(section)));
  const text = kept.join('').trim();
  return text.length > 0 ? text : markdown;
}

/**
 * Assemble the persona and skill instructions into the agent's system prompt.
 * The persona is never trimmed; skill instructions are reduced by priority to
 * respect the model's context budget.
 */
export function buildSystemPrompt(opts: BuildPromptOptions): BuildPromptResult {
  const { persona, skills, budgetChars, allowedToolIds } = opts;
  const trimmingLog: TrimmingRecord[] = [];
  const personaSection = `# Persona: ${persona.name}\n\n${persona.system}`;
  const personaLength = personaSection.length;

  if (personaLength >= budgetChars) {
    for (const skill of skills) {
      trimmingLog.push({
        skillId: skill.id,
        originalLength: skill.resolvedInstructions.length,
        trimmedLength: 0,
        reason: 'context-budget',
      });
    }
    return { systemPrompt: personaSection, trimmingLog, contextBudgetExceeded: true };
  }

  const sortedSkills = [...skills].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  const skillSections = sortedSkills.map((skill) => {
    const instructions = filterSkillInstructions(
      skill.resolvedInstructions,
      allowedToolIds,
      skill.resolvedTools,
    );
    return { skill, text: `\n\n# Skill: ${skill.name}\n\n${instructions}` };
  });

  let totalLength = personaLength;
  for (const section of skillSections) totalLength += section.text.length;
  if (totalLength <= budgetChars) {
    return {
      systemPrompt: personaSection + skillSections.map((section) => section.text).join(''),
      trimmingLog: [],
      contextBudgetExceeded: false,
    };
  }

  let remainingBudget = budgetChars - personaLength;
  const includedSections: string[] = [];
  const byPriorityDesc = [...skillSections].sort(
    (a, b) => (b.skill.priority ?? 50) - (a.skill.priority ?? 50),
  );

  for (const section of byPriorityDesc) {
    if (section.text.length <= remainingBudget) {
      includedSections.push(section.text);
      remainingBudget -= section.text.length;
      continue;
    }

    const header = `\n\n# Skill: ${section.skill.name}\n\n`;
    const availableForContent = remainingBudget - header.length;
    if (availableForContent > 100) {
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
      trimmingLog.push({
        skillId: section.skill.id,
        originalLength: section.skill.resolvedInstructions.length,
        trimmedLength: 0,
        reason: 'context-budget',
      });
    }
  }

  return {
    systemPrompt: personaSection + includedSections.join(''),
    trimmingLog,
    contextBudgetExceeded: trimmingLog.length > 0,
  };
}
