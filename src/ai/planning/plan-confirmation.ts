import type { Plan } from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface PlanSummary {
  planId: string;
  goal: string;
  totalSteps: number;
  steps: Array<{
    id: string;
    description: string;
    persona: string;
    skills: string[];
    tools: string[];
    dependsOn: string[];
    claimedResources: string[];
    acceptanceCriteria: string;
  }>;
  /** Resources that will be modified across all steps */
  allClaimedResources: string[];
  /** Personas involved */
  personasUsed: string[];
}

export interface ConfirmationResult {
  confirmed: boolean;
  /** If not confirmed, the user's feedback for revision */
  feedback?: string;
}

// ─── Plan Summarizer ─────────────────────────────────────────────

/**
 * Generate a human-readable summary of a Plan for user review.
 * This is displayed before execution begins (Law 17: explicit
 * user confirmation required).
 */
export function summarizePlan(plan: Plan): PlanSummary {
  const allResources = new Set<string>();
  const personasUsed = new Set<string>();

  const steps = plan.steps.map((s) => {
    for (const r of s.claimedResources) allResources.add(r);
    personasUsed.add(s.assignedPersona);

    return {
      id: s.id,
      description: s.description,
      persona: s.assignedPersona,
      skills: s.assignedSkills,
      tools: s.assignedTools,
      dependsOn: s.dependsOn,
      claimedResources: s.claimedResources,
      acceptanceCriteria: s.acceptanceCriteria,
    };
  });

  return {
    planId: plan.id ?? 'unknown',
    goal: plan.goal,
    totalSteps: plan.steps.length,
    steps,
    allClaimedResources: Array.from(allResources),
    personasUsed: Array.from(personasUsed),
  };
}

/**
 * Format a plan summary as a readable text block for the user.
 */
export function formatPlanForUser(summary: PlanSummary): string {
  const lines: string[] = [];

  lines.push(`═══════════════════════════════════════════════════`);
  lines.push(`  EXECUTION PLAN: ${summary.planId}`);
  lines.push(`═══════════════════════════════════════════════════`);
  lines.push(``);
  lines.push(`Goal: ${summary.goal}`);
  lines.push(`Steps: ${summary.totalSteps}`);
  lines.push(`Personas: ${summary.personasUsed.join(', ')}`);
  lines.push(`Resources: ${summary.allClaimedResources.join(', ') || 'none'}`);
  lines.push(``);
  lines.push(`───────────────────────────────────────────────────`);

  for (const step of summary.steps) {
    lines.push(``);
    lines.push(`  [${step.id}] ${step.description}`);
    lines.push(`    Persona:  ${step.persona}`);
    lines.push(`    Skills:   ${step.skills.join(', ') || 'none'}`);
    lines.push(`    Tools:    ${step.tools.join(', ') || 'none'}`);
    if (step.dependsOn.length > 0) {
      lines.push(`    Depends:  ${step.dependsOn.join(', ')}`);
    }
    if (step.claimedResources.length > 0) {
      lines.push(`    Resources: ${step.claimedResources.join(', ')}`);
    }
    lines.push(`    Accept:   ${step.acceptanceCriteria}`);
  }

  lines.push(``);
  lines.push(`═══════════════════════════════════════════════════`);
  lines.push(`  Confirm this plan to begin execution.`);
  lines.push(`  Once confirmed, execution proceeds automatically`);
  lines.push(`  without further human intervention (Law 17).`);
  lines.push(`═══════════════════════════════════════════════════`);

  return lines.join('\n');
}

/**
 * Represents the user's decision on a plan.
 * In a CLI this comes from stdin; in an API from a request body.
 */
export function confirmPlan(
  userResponse: string
): ConfirmationResult {
  const normalized = userResponse.trim().toLowerCase();

  if (['yes', 'y', 'confirm', 'approve', 'ok', 'go', 'start'].includes(normalized)) {
    return { confirmed: true };
  }

  return {
    confirmed: false,
    feedback: userResponse.trim(),
  };
}
