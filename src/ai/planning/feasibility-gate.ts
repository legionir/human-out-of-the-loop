import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { personaAllowsTool } from '../schemas/persona.js';
import type { Plan, FeasibilityCheckResult } from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface FeasibilityGateDeps {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
}

// ─── Feasibility Gate ────────────────────────────────────────────

/**
 * Validates every step of a Plan against the real catalog before
 * execution begins.
 *
 * Checks performed per step:
 *   1. `assignedPersona` exists in PersonaRegistry.
 *   2. All `assignedSkills` exist in SkillRegistry.
 *   3. All `assignedTools` exist in ToolRegistry.
 *   4. All `assignedTools` are in the persona's `allowedTools` (Law 18).
 *   5. All `dependsOn` references point to valid step ids in the plan.
 *
 * If ANY check fails, the plan is rejected with detailed errors
 * so the Planner can revise it — execution does NOT start.
 */
export function runFeasibilityGate(
  plan: Plan,
  deps: FeasibilityGateDeps
): FeasibilityCheckResult {
  const errors: FeasibilityCheckResult['errors'] = [];
  const stepIds = new Set(plan.steps.map((s) => s.id));

  // 0. Duplicate step ids (R1-08): a plan with two steps sharing an id makes
  // dependsOn/lookup ambiguous, so reject before any per-step check.
  const seenIds = new Set<string>();
  for (const step of plan.steps) {
    if (seenIds.has(step.id)) {
      errors.push({
        stepId: step.id,
        field: 'id',
        message: `Duplicate step id "${step.id}" in plan.`,
      });
    }
    seenIds.add(step.id);
  }

  for (const step of plan.steps) {
    // 1. Persona exists
    const persona = deps.personaRegistry.get(step.assignedPersona);
    if (!persona) {
      errors.push({
        stepId: step.id,
        field: 'assignedPersona',
        message: `Persona "${step.assignedPersona}" does not exist in PersonaRegistry.`,
      });
    }

    // 2. Skills exist
    for (const skillId of step.assignedSkills) {
      if (!deps.skillRegistry.has(skillId)) {
        errors.push({
          stepId: step.id,
          field: 'assignedSkills',
          message: `Skill "${skillId}" does not exist in SkillRegistry.`,
        });
      }
    }

    // 3. Tools exist in ToolRegistry
    for (const toolId of step.assignedTools) {
      if (!deps.toolRegistry.hasDefinition(toolId)) {
        errors.push({
          stepId: step.id,
          field: 'assignedTools',
          message: `Tool "${toolId}" does not exist in ToolRegistry.`,
        });
      }
    }

    // 4. Tools are in persona.allowedTools (Law 18)
    if (persona) {
      for (const toolId of step.assignedTools) {
        if (!personaAllowsTool(persona, toolId)) {
          errors.push({
            stepId: step.id,
            field: 'assignedTools',
            message:
              `Tool "${toolId}" is not in persona "${step.assignedPersona}"'s ` +
              `allowedTools [${persona.allowedTools.join(', ')}].`,
          });
        }
      }
    }

    // 5. dependsOn references are valid
    for (const depId of step.dependsOn) {
      if (!stepIds.has(depId)) {
        errors.push({
          stepId: step.id,
          field: 'dependsOn',
          message: `dependsOn references "${depId}" which is not a valid step id in this plan.`,
        });
      }
      if (depId === step.id) {
        errors.push({
          stepId: step.id,
          field: 'dependsOn',
          message: `Step cannot depend on itself.`,
        });
      }
    }
  }

  return {
    feasible: errors.length === 0,
    errors,
  };
}
