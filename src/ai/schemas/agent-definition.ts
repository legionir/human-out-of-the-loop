import { z } from 'zod';

/**
 * AgentDefinition = ترکیب composition-based از persona + skills + model.
 * هیچ منطق اجرایی ندارد — صرفاً ارجاع به idهای سایر Registryها.
 */
export const AgentDefinitionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  /** Reference to PersonaRegistry */
  personaId: z.string().min(1),
  /** References to SkillRegistry */
  skillIds: z.array(z.string().min(1)).default([]),
  /**
   * Extra tool ids granted to this agent on top of the ones its skills
   * already request (used for plan steps: PlanStep.assignedTools).
   * Each id is still filtered against persona.allowedTools.
   */
  toolIds: z.array(z.string().min(1)).optional(),
  /** Reference to ModelRegistry */
  modelId: z.string().min(1),
  description: z.string().optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
