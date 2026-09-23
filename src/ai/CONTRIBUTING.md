# راهنمای افزودن Persona / Skill / Tool / Agent / MCP Server جدید

## افزودن Tool جدید

### ۱. پیاده‌سازی
فایل جدید در `src/ai/tools/implementations/my-tool.ts`:
```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { validateWorkspacePath } from './path-security';

export const myTool = tool({
  description: 'Description of what this tool does.',
  inputSchema: z.object({
    input: z.string().min(1),
  }),
  execute: async ({ input }) => {
    // Security: validate paths if filesystem-related
    const validation = validateWorkspacePath(input);
    if (!validation.safe) {
      return { success: false, error: validation.reason, code: 'PATH_TRAVERSAL_BLOCKED' };
    }
    // Return structured result: { success, ... } or { success: false, error, code }
    return { success: true, result: '...' };
  },
});
```

### ۲. ثبت metadata
فایل `registry/tools/my_tool.json`:
```json
{
  "id": "my_tool",
  "name": "My Tool",
  "description": "Description",
  "source": "local",
  "modulePath": "./implementations/my-tool",
  "category": "custom"
}
```

### ۳. اتصال در bootstrap
در `src/ai/tools/bootstrap.ts` به `IMPLEMENTATIONS` map اضافه کنید:
```typescript
import { myTool } from './implementations/my-tool.js';
const IMPLEMENTATIONS: Record<string, Tool> = {
  // ... existing
  my_tool: myTool,
};
```
و در `src/ai/registries/tool-registry.ts` متد `getMetadataRegistry()` برای دسترسی type-safe موجود است.

همچنین در `src/ai/orchestrator.ts`، ابزارهای پایه به صورت مستقیم ثبت می‌شوند:
```typescript
toolRegistry.registerDefinition({ id: 'my_tool', name: 'My Tool', description: '...', source: 'local', modulePath: './my-tool', category: 'custom' });
toolRegistry.registerImplementation('my_tool', myTool);
```

### ۴. مجوز دسترسی
Tool id را به `allowedTools` Personaهای مجاز در `registry/personas/*.json` اضافه کنید.

---

## افزودن Skill جدید

### ۱. ساختار فایل
```
registry/skills/my_skill/
├── skill.json
└── SKILL.md
```

### ۲. `skill.json`
```json
{
  "id": "my_skill",
  "name": "My Skill",
  "version": "1.0.0",
  "instructions": "SKILL.md",
  "tools": ["read_file", "my_tool"],
  "priority": 60,
  "description": "What this skill enables"
}
```

### ۳. `SKILL.md`
مستندات دانش و فرآیند Skill به زبان طبیعی. مثال:
```markdown
# My Skill

## Purpose
What this skill enables...

## Process
1. Step one...
2. Step two...

## Tools
- read_file: for reading...
- my_tool: for custom operation...
```

### ۴. بدون تغییر کد!
SkillRegistry به‌صورت خودکار از `registry/skills/` بارگذاری می‌کند. کافیست `bootstrapCatalogTools` قبل از `loadSkillsFromDirectory` صدا زده شود (همانطور که در Orchestrator انجام می‌شود).

---

## افزودن Persona جدید

### ۱. فایل `registry/personas/my_persona.json`
```json
{
  "id": "my_persona",
  "name": "My Persona",
  "system": "You are a ... Describe behavior, constraints, and style.",
  "allowedTools": ["read_file", "search_code", "my_tool"],
  "description": "Role description"
}
```

### ۲. `allowedTools`
فقط Toolهایی را لیست کنید که این Persona **واقعاً** نیاز دارد.
از `["*"]` فقط برای Personaهای admin استفاده کنید.
- Empty `[]` → هیچ ابزاری مجاز نیست (observer)
- `["*"]` → همه ابزارها مجاز (superadmin)
- لیست صریح → فقط ابزارهای ذکر شده

بررسی در دو نقطه انجام می‌شود:
- **STATIC**: `createAgent` فیلتر می‌کند و `toolWarnings` ثبت می‌کند
- **DYNAMIC**: `checkAuthorization` در `delegate_task` رد می‌کند

### ۳. بدون تغییر کد!
PersonaRegistry به‌صورت خودکار بارگذاری می‌کند.

---

## افزودن Agent جدید

### ۱. ویرایش `registry/agents.json`
یک entry جدید به آرایه اضافه کنید:
```json
{
  "id": "my_agent",
  "name": "My Agent",
  "personaId": "my_persona",
  "skillIds": ["my_skill", "code_analysis"],
  "modelId": "gpt-4o",
  "description": "What this agent does"
}
```

### ۲. Cross-registry validation
در startup، `AgentRegistry.validateAll()` بررسی می‌کند که persona/skills/model همگی موجودند و toolهای مورد نیاز skillها در ToolRegistry وجود دارند. خطاها به صورت `unavailable` لاگ می‌شوند نه crash.

### ۳. Context Budget
AgentFactory به صورت خودکار `persona.system` + `skill.instructions` را با توجه به `modelId` و `contextBudgetChars` ترکیب و در صورت نیاز trim می‌کند (low-priority skills اول).

---

## افزودن MCP Server جدید

### ۱. فایل `registry/mcp-servers/my_server.json`
```json
{
  "id": "my_mcp_server",
  "name": "My MCP Server",
  "transport": "http",
  "url": "https://mcp.example.com",
  "auth": {
    "type": "bearer",
    "tokenEnvVar": "MY_MCP_SERVER_TOKEN"
  },
  "toolPrefix": "ext_",
  "connectTimeoutMs": 10000
}
```

انواع auth:
- `none`: بدون احراز هویت
- `bearer`: `{ "type": "bearer", "tokenEnvVar": "TOKEN_ENV" }`
- `api-key`: `{ "type": "api-key", "keyEnvVar": "KEY_ENV", "headerName": "X-API-Key" }`

### ۲. متغیر محیطی
```bash
export MY_MCP_SERVER_TOKEN="your-token-here"
```

### ۳. بدون تغییر کد!
MCP connector در startup به‌صورت خودکار بارگذاری و متصل می‌شود:
- `bootstrapMcpServers()` در `Orchestrator.initialize()`
- اگر اتصال شکست بخورد، سرور `unavailable` علامت می‌خورد و بقیه‌ی سیستم کار می‌کند
- Credentialها هرگز در لاگ نشت نمی‌کنند (`sanitiseError` → `***REDACTED***`)
- Toolهای MCP با `source: "mcp"` و `mcpServerId` ثبت می‌شوند و `getToolsByIds` یکسان برای local و MCP کار می‌کند

### ۴. تست
برای تست بدون شبکه واقعی:
```typescript
const connector = new McpConnector({
  toolRegistry,
  createClient: async () => ({ tools: async () => ({ my_tool: mockTool }), close: async () => {} }),
  createTransport: () => ({}),
});
await connector.connectServer(config);
```

---

## نکات امنیتی (فاز ۱۶)

- همیشه `validateWorkspacePath` را برای Toolهای فایل‌سیستمی استفاده کنید (جلوگیری از `../../etc/passwd`)
- Credentialها را هرگز inline در JSON قرار ندهید — فقط `tokenEnvVar` / `keyEnvVar`
- `allowedTools` را در هر دو مسیر static و dynamic تست کنید
- `ObservabilityLogger` به صورت خودکار `apiKey`, `token`, `password`, `secret`, `authorization` را به `***REDACTED***` تبدیل می‌کند
