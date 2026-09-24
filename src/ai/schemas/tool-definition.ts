import { z } from 'zod';

/**
 * ToolDefinition = metadata فقط.
 * پیاده‌سازی واقعی در فاز ۲ (محلی) یا از MCP server (فاز ۲) بارگذاری می‌شود.
 *
 * `source` تمایز اصلی است:
 *   - "local": پیاده‌سازی در `src/ai/tools/implementations/` قرار دارد
 *              و `modulePath` به آن اشاره می‌کند.
 *   - "mcp":   Tool از یک MCP server در startup fetch شده است؛
 *              `mcpServerId` باید تنظیم شود و `modulePath` بی‌ربط است.
 */
export const ToolDefinitionSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1),
    description: z.string().min(1),
    source: z.enum(['local', 'mcp']).default('local'),
    /** Relative module path — required when source="local" */
    modulePath: z.string().optional(),
    /** MCP server id — required when source="mcp" */
    mcpServerId: z.string().optional(),
    /** Optional grouping label (e.g. "filesystem", "git", "control", "catalog") */
    category: z.string().optional(),
  })
  .refine((data) => data.source !== 'local' || !!data.modulePath, {
    message: 'modulePath is required when source="local"',
    path: ['modulePath'],
  })
  .refine((data) => data.source !== 'mcp' || !!data.mcpServerId, {
    message: 'mcpServerId is required when source="mcp"',
    path: ['mcpServerId'],
  });

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
