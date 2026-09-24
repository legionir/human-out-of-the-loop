# راهنمای افزودن Persona / Skill / Tool / Agent / MCP Server جدید

## افزودن Tool جدید

### ۱. پیاده‌سازی (factory pattern — فاز ۱۸)

ابزارهای filesystem باید **به `projectRoot` مقید** باشند (PATH-01…09): به‌جای export یک tool آماده، یک **factory** بنویسید که root را تزریق می‌کند. الگوی مرجع: `src/ai/tools/implementations/read-file.ts`.

فایل جدید `src/ai/tools/implementations/my-tool.ts`:
```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { validateWorkspacePath } from './path-security.js';

const inputSchema = z.object({ path: z.string().min(1) });

/**
 * Factory: the workspace root is INJECTED — never `process.cwd()`
 * (PATH-01/PATH-09).  Results must not leak absolute host paths (SEC-05):
 * return a path relative to `projectRoot`.
 */
export function createMyTool(projectRoot: string) {
  return tool({
    description: 'What this tool does.',
    inputSchema,
    execute: async ({ path: filePath }) => {
      const validation = validateWorkspacePath(filePath, projectRoot);
      if (!validation.safe) {
        return { success: false as const, error: validation.reason, code: 'PATH_TRAVERSAL_BLOCKED' };
      }
      // ... do the work; always return a structured result
      return { success: true as const, result: '...' };
    },
  });
}
```

نکات الزامی:
- toolهای غیر-filesystem (بدون دسترسی به دیسک) می‌توانند بدون factory ساخته شوند — ولی هر ابزاری که مسیر می‌گیرد **باید** factory باشد.
- هرگز مسیر مطلق میزبان را به مدل برنگردانید (SEC-05/SEC-06).
- ورودی‌ها را با Zod اعتبارسنجی کنید (`ToolDefinitionSchema` + `inputSchema`).

### ۲. ثبت metadata (data-driven — Law 16)

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
هیچ تغییری در runtime لازم نیست — `bootstrapTools()` خودش `registry/tools/*.json` را می‌خواند (CFG-01).

### ۳. اتصال implementation در bootstrap

`src/ai/tools/bootstrap.ts` تنها جایی است که implementationها import می‌شوند (Law 12 — Agentها هرگز Tool را مستقیم import نمی‌کنند):

```typescript
import { createMyTool } from './implementations/my-tool.js';

const implementations: Record<string, Tool> = {
  read_file: createReadFileTool(projectRoot),
  // ...
  my_tool: createMyTool(projectRoot),   // ← root تزریق می‌شود
};
```
اگر metadata داشته باشید ولی implementation نداشته باشید، bootstrap با خطای صریح fail می‌کند (`has metadata but no implementation`).

### ۴. مجوز دسترسی (Law 18)

Tool id را به `allowedTools` Personaهای مجاز در `registry/personas/*.json` اضافه کنید؛ در غیر این صورت Factory آن را از agent حذف می‌کند (warning) و Feasibility Gate پلن را رد می‌کند.

### ۵. تست

- تست واحد در `src/ai/__tests__/` (شامل یک case path-traversal که باید `PATH_TRAVERSAL_BLOCKED` برگرداند).
- تست‌های source-scan فاز ۲۲ (`phase22.test.ts`) بررسی می‌کنند که در runtime صفر `console.*` و `any` کم باشد — کد جدید نباید آن‌ها را نقض کند.

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

---

## افزودن CLI command جدید

CLI فقط یک لایه‌ی نازک روی Orchestrator است (`src/cli.ts` → `src/cli/commands/*.ts`).

### ۱. ماژول command را بنویسید

`src/cli/commands/my-command.ts`:
```typescript
import path from 'node:path';
import { prepareCliEnvironment } from '../utils/config.js';
import { out, color, err } from '../utils/output.js';

export interface MyCommandOptions {
  projectRoot?: string;
  json?: boolean;
}

export async function myCommand(opts: MyCommandOptions): Promise<number> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);      // .env + global config (U1)
  const orchestrator = new Orchestrator({ projectRoot, persistent: true });
  await orchestrator.initialize();
  try {
    // از APIهای موجود Orchestrator استفاده کنید (بدون منطق تکراری)
    out(opts.json ? JSON.stringify(result) : color.info('…'));
    return 0;                               // exit code
  } finally {
    await orchestrator.shutdown();          // همیشه: unsubscribe + waitForAll
  }
}
```

### ۲. در `src/cli.ts` ثبت کنید

```typescript
program
  .command('my-command')
  .description('What it does')
  .option('--project-root <dir>', 'workspace root')
  .option('--json', 'machine-readable output')
  .action(async (opts) => process.exitCode = await myCommand(opts));
```

### ۳. قواعد

- **خروجی کاربر** فقط از طریق `src/cli/utils/output.ts` (`out`/`err`/`color`) — نه `console.*` (تست source-scan فاز ۲۲). لاگ observability از `ObservabilityLogger` در runtime می‌آید.
- **خروجی ماشینی** با `--json` (مثل `models`/`usage`) برای اسکریپت‌ها.
- **exit code**: `0` موفق، `1` خطای اجرا/کاربر — هرگز `process.exit()` مستقیم بدون بازگشت مقدار.
- پرچم‌های per-run (`--model`, `--timeout-ms`, `--max-steps`, `--max-replans`) باید به `runOverrides` (`Orchestrator.run`) نگاشت شوند، نه به config سراسری — همان قراردادی که سرور وب U3 استفاده می‌کند.
- تست: `src/cli/__tests__/cli.test.ts` را ببینید (الگوی `withIsolatedHome` + tmp project root).

## افزودن endpoint جدید به وب سرور (UI)

1. route را در `src/server/routes/*.ts` بسازید (الگو: `registry.ts`, `usage.ts`) و در `src/server.ts` mount کنید — middleware lazy-init تضمین می‌کند orchestrator آماده است.
2. اگر endpoint داده‌ی حساس دارد: هرگز credential/مسیر مطلق/prompt کامل را برنگردانید (`server/types.ts` + یادداشت‌های Law 14).
3. خطاها را با status درست برگردانید (`400` ورودی نامعتبر، `404` نبود منبع، `409` state نامناسب).
4. UI در `public/app.js` (بدون build step) + استایل در `public/style.css`؛ از `textContent` برای متن مدل استفاده کنید (نه `innerHTML`).
5. تست e2e با supertest الگوی `src/server/__tests__/u*.test.ts` (mock ماژول `ai`)، و در نهایت README (جدول endpointها) را به‌روز کنید.
