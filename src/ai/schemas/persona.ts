import { z } from 'zod';

/**
 * Persona = رفتار (system prompt) + policy دسترسی (allowedTools).
 * هیچ ارجاعی به Tool implementation ندارد — صرفاً هویت، لحن، و policy مجاز‌بودن.
 *
 * `allowedTools` طبق قانون ۱۸: هیچ Agent نباید Toolای اجرا کند که در این لیست
 * نیست، حتی اگر Skill مرتبط آن Tool را «بلد» باشد.  این فیلد در Agent Factory
 * (فاز ۵) و در Feasibility Gate (فاز ۹) بررسی می‌شود.
 */
export const PersonaSchema = z.object({
  id: z
    .string()
    .min(1, 'Persona id must not be empty')
    .regex(/^[a-z0-9_-]+$/, 'Persona id must be lowercase alphanumeric with _ or -'),
  name: z.string().min(1, 'Persona name must not be empty'),
  system: z.string().min(1, 'System prompt must not be empty'),
  /**
   * Whitelist of tool ids this persona is permitted to invoke.
   * Empty array = persona may not use any tools.
   * Use ["*"] to allow all tools (reserved for privileged personas only).
   */
  allowedTools: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
});

export type Persona = z.infer<typeof PersonaSchema>;

/**
 * Convenience helper: checks whether a persona is permitted to use a tool id.
 * Handles the "*" wildcard.
 */
export function personaAllowsTool(persona: Persona, toolId: string): boolean {
  if (persona.allowedTools.includes('*')) return true;
  return persona.allowedTools.includes(toolId);
}
