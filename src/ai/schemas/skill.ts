import { z } from 'zod';

/**
 * Skill = دانش/قابلیت (instructions + لیست ابزارهای مرتبط).
 * فیلد `tools` فقط شامل id ابزارهاست — هیچ import مستقیمی به پیاده‌سازی Tool.
 *
 * `priority` (اختیاری، پیش‌فرض 50): عدد 0-100 که اهمیت این Skill را
 * در ترکیب نهایی Agent تعیین می‌کند.  در زمان trimming بر اساس
 * context budget (فاز ۵ گام ۳)، Skillهای با priority پایین‌تر
 * زودتر خلاصه/حذف می‌شوند.  persona.system همیشه حفظ می‌شود.
 */
export const SkillSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  /** Inline instructions or path to SKILL.md (resolved by SkillRegistry loader) */
  instructions: z.string().min(1),
  /** Array of tool ids that this skill requires (cross-validated against ToolRegistry) */
  tools: z.array(z.string().min(1)).default([]),
  /**
   * Priority 0–100 for context-budget trimming.
   * Higher = more important = trimmed last.
   * Default: 50 (medium priority).
   */
  priority: z.number().int().min(0).max(100).default(50),
  description: z.string().optional(),
});

export type Skill = z.infer<typeof SkillSchema>;
