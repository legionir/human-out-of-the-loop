import { z } from 'zod';

/**
 * Skill = دانش/قابلیت (instructions + لیست ابزارهای مرتبط).
 * فیلد `tools` فقط شامل id ابزارهاست — هیچ import مستقیمی به پیاده‌سازی Tool.
 */
export const SkillSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  /** Inline instructions or path to SKILL.md (resolved by SkillRegistry loader) */
  instructions: z.string().min(1),
  /** Array of tool ids that this skill requires (cross-validated against ToolRegistry) */
  tools: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
});

export type Skill = z.infer<typeof SkillSchema>;
