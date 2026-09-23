
# ▶️ اجرای فاز ۱۷: مستندسازی و تحویل نهایی

---

## گام ۱: README معماری

### `src/ai/README.md`

```markdown
# AI Multi-Agent Orchestration Runtime

## معماری

```
┌─────────────────────────────────────────────────────────────┐
│                      User / CLI / API                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator (Phase 15)                   │
│  Entry point: Orchestrator.run(userRequest, options)        │
│  Wires all layers together, manages lifecycle               │
└───────┬──────────────┬──────────────┬───────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────┐ ┌───────────┐ ┌──────────────┐
│   Planning   │ │ PlanRuntime│ │ Final Review │
│  (Phase 9)   │ │ (Phase 10) │ │  (Phase 12)  │
│              │ │            │ │              │
│ • Planner    │ │ • Execute  │ │ • Reviewer   │
│ • Feasibility│ │ • Priority │ │ • Structured │
│ • Cycles     │ │ • Re-plan  │ │   Output     │
│ • Confirm    │ │ • Resume   │ │ • Report     │
└──────────────┘ └─────┬─────┘ └──────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Acceptance Checker (Phase 11)                   │
│  Per-step quality gate: technical vs quality failures       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                 Task Runtime (Phase 8)                       │
│  • Concurrency cap    • Resource locks    • Status sync     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                Agent Runtime (Phase 7)                       │
│  • AI SDK generateText   • Tool loop   • Compact events     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI SDK (ai package)                       │
│  generateText | generateObject | tool() | streamText        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Operational Layers (Phase 13-14)                │
│  Streaming │ Cancellation │ Rate-limit │ Usage │ Session    │
│  Observability (JSONL) │ EventBus                           │
└─────────────────────────────────────────────────────────────┘
```

## لایه‌ها

| لایه | مسئولیت | فاز |
|------|---------|-----|
| **Registry** | تعریف، بارگذاری، اعتبارسنجی metadata | ۱-۶ |
| **Agent Factory** | ترکیب Persona+Skill+Tool+Model → ResolvedAgent | ۵-۶ |
| **Planning** | تفکیک تسک، ابهام‌زدایی، Feasibility Gate | ۹ |
| **PlanRuntime** | حلقه‌ی اجرای خودکار Plan | ۱۰ |
| **Acceptance** | بررسی کیفیت هر گام | ۱۱ |
| **Review** | گزارش نهایی ساختاریافته | ۱۲ |
| **Task Runtime** | مدیریت چرخه‌ی عمر تسک‌ها | ۸ |
| **Agent Runtime** | اجرای واقعی مدل + Tool loop | ۷ |
| **Operational** | Streaming, Cancel, Rate-limit, Usage, Session, Log | ۱۳-۱۴ |

## تفاوت Persona / Skill / Tool (قانون ۱۲)

| مفهوم | تعریف | مثال |
|-------|-------|------|
| **Persona** | رفتار + policy دسترسی (`system` + `allowedTools`) | `coder`, `reviewer`, `architect`, `planner` |
| **Skill** | دانش/قابلیت (`instructions` + لیست tool ids) | `code_analysis`, `file_management` |
| **Tool** | عملی که واقعاً اجرا می‌شود (محلی یا MCP) | `read_file`, `write_file`, `mcp_search` |

## مدل Authorization (`allowedTools`)

- هر Persona یک لیست صریح `allowedTools` دارد.
- هیچ Agent نمی‌تواند Toolای خارج از این لیست اجرا کند.
- بررسی در **دو نقطه**: Agent Factory (فاز ۵) و delegate_task (فاز ۶).
- Wildcard `["*"]` فقط برای Personaهای privileged.

## مدل MCP Integration

- MCP servers در `registry/mcp-servers/*.json` تعریف می‌شوند.
- Credentialها هرگز inline نیستند — فقط ارجاع به env var.
- خطای یک MCP server کل startup را متوقف نمی‌کند (`unavailable`).
- Toolهای MCP با `source: "mcp"` در ToolRegistry ثبت می‌شوند.

## جریان داده

```
User Request
  → Planner.assess() → needsClarification? → [ask user]
  → Planner.generatePlan() → Plan (draft)
  → FeasibilityGate → valid?
  → CycleDetector → acyclic?
  → formatPlanForUser() → [user confirms]  ← ONLY human touchpoint
  → PlanRuntime.execute()
      → while (!done):
          → getReadySteps() → prioritize()
          → dispatch → TaskRuntime → AgentRuntime → AI SDK
          → AcceptanceChecker → quality pass/fail
          → re-plan if needed (auto, no human)
  → FinalReviewer.review() → Review (structured)
  → formatReviewForUser() → Report to user
```

## اصل Human-Out-Of-Loop (قانون ۱۷)

پس از تأیید Plan توسط کاربر، **هیچ تعامل انسانی** تا پایان اجرا:
- شکست فنی → retry خودکار
- شکست کیفی → re-planning خودکار
- Rate-limit → backoff خودکار
- تنها تعامل مجاز: **Cancellation صریح** (`cancelPlan(planId)`)
```

---

## گام ۲: راهنمای افزودن اجزای جدید

### `src/ai/CONTRIBUTING.md`

```markdown
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
  parameters: z.object({
    input: z.string().min(1),
  }),
  execute: async ({ input }) => {
    // Security: validate paths if filesystem-related
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
import { myTool } from './implementations/my-tool';
const IMPLEMENTATIONS: Record<string, Tool> = {
  // ... existing
  my_tool: myTool,
};
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
مستندات دانش و فرآیند Skill به زبان طبیعی.

### ۴. بدون تغییر کد!
SkillRegistry به‌صورت خودکار از `registry/skills/` بارگذاری می‌کند.

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
در startup، AgentRegistry بررسی می‌کند که persona/skills/model همگی موجودند.

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

### ۲. متغیر محیطی
```bash
export MY_MCP_SERVER_TOKEN="your-token-here"
```

### ۳. بدون تغییر کد!
MCP connector در startup به‌صورت خودکار بارگذاری و متصل می‌شود.
اگر اتصال شکست بخورد، سرور `unavailable` علامت می‌خورد و بقیه‌ی سیستم کار می‌کند.
```

---

## گام ۳: مستندسازی پیکربندی

### `src/ai/CONFIGURATION.md`

```markdown
# پیکربندی و متغیرهای محیطی

## متغیرهای محیطی

### Providerهای مدل

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `OPENAI_API_KEY` | بله (اگر از OpenAI استفاده می‌شود) | کلید API OpenAI |
| `ANTHROPIC_API_KEY` | بله (اگر از Anthropic استفاده می‌شود) | کلید API Anthropic |
| `OPENAI_BASE_URL` | خیر | URL سفارشی برای OpenAI-compatible API |

### MCP Servers

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `MY_MCP_SERVER_TOKEN` | بله (اگر سرور auth دارد) | Token برای MCP server |
| *(هر env var تعریف‌شده در `tokenEnvVar`/`keyEnvVar`)* | بله | مطابق `registry/mcp-servers/*.json` |

## سقف‌های پیکربندی‌پذیر

| پارامتر | پیش‌فرض | محل تنظیم | توضیح |
|---------|---------|-----------|-------|
| `maxConcurrentTasks` | ۵ | `OrchestratorConfig` / `TaskRuntimeConfig` | حداکثر تسک هم‌زمان |
| `maxConcurrentPerProvider` | ۵ | `RateLimiterConfig` | حداکثر درخواست هم‌زمان به هر provider |
| `maxReplanningAttempts` | ۳ | `OrchestratorConfig` / `PlanRuntimeConfig` | سقف کل re-planning |
| `agentTimeoutMs` | ۱۲۰,۰۰۰ (۲ دقیقه) | `OrchestratorConfig` / `AgentRunOptions` | Timeout هر اجرای Agent |
| `maxRetries` (rate-limit) | ۳ | `RateLimiterConfig` | تعداد retry روی ۴۲۹ |
| `baseBackoffMs` | ۱,۰۰۰ | `RateLimiterConfig` | تأخیر پایه backoff |
| `maxBackoffMs` | ۳۰,۰۰۰ | `RateLimiterConfig` | سقف تأخیر backoff |
| `maxDelegationDepth` | ۱ | `OrchestratorConfig` | عمق مجاز delegation |
| `maxSteps` (tool loop) | ۲۰ | `AgentRunOptions` | حداکثر iteration حلقه‌ی Tool |
| `contextBudgetChars` | ۱۲۰,۰۰۰ | `CreateAgentOptions` | سقف context برای instructions |
| `connectTimeoutMs` (MCP) | ۱۰,۰۰۰ | `registry/mcp-servers/*.json` | Timeout اتصال MCP |
| `additionalTasksCeiling` | ۲ | `PlanRuntimeConfig` | سقف چرخه‌ی additionalTasks |

## ساختار فایل‌های پیکربندی

```
registry/
├── agents.json              # تعریف Agentها (آرایه‌ی JSON)
├── personas/
│   ├── architect.json       # Persona: system + allowedTools
│   ├── coder.json
│   ├── reviewer.json
│   └── planner.json
├── skills/
│   ├── code_analysis/
│   │   ├── skill.json       # metadata + tools + priority
│   │   └── SKILL.md         # instructions
│   ├── file_management/
│   ├── git_operations/
│   ├── task_decomposition/
│   └── acceptance_check/
├── tools/
│   ├── read_file.json       # metadata: source, modulePath
│   ├── search_code.json
│   ├── write_file.json
│   └── git_status.json
├── models/
│   ├── gpt-4o.json          # provider + model + config
│   ├── claude-sonnet.json
│   └── local-llama.json
└── mcp-servers/
    └── *.json               # url + auth (env var ref) + toolPrefix
```

## دایرکتوری Runtime (پایدار)

```
.ai-runtime/                 # (ایجاد خودکار در حالت persistent)
├── plans/                   # Planهای persist‌شده (JSON)
├── sessions/                # Sessionهای persist‌شده (JSON)
└── observability.jsonl      # لاگ ساختاریافته‌ی ماندگار
```
```

---

## ✅ راستی‌آزمایی معیارهای پذیرش فاز ۱۷

| معیار | وضعیت | توضیح |
|---|---|---|
| سند معماری کامل و منطبق با پیاده‌سازی نهایی | 🟢 | `src/ai/README.md` شامل دیاگرام، لایه‌ها، جریان داده، تفاوت Persona/Skill/Tool، مدل authorization و MCP |
| راهنمای افزودن Persona/Skill/Tool/Agent/MCP Server جدید | 🟢 | `src/ai/CONTRIBUTING.md` با مثال‌های گام‌به‌گام برای هر نوع جزء |
| تمام متغیرها/سقف‌ها مستند شده‌اند | 🟢 | `src/ai/CONFIGURATION.md` شامل ۳ جدول: env vars، سقف‌های پیکربندی، ساختار فایل‌ها |
| Scope audit نهایی | 🟢 | تمام ۱۸ نیازمندی پلن جدید به فازها نگاشت شده‌اند (جدول زیر) |

### Scope Audit: نگاشت نیازمندی‌ها به فازها

| نیازمندی | فاز(ها) |
|----------|---------|
| MCP integration | ۲ |
| Context budget | ۵ |
| انتخاب پویای Agent | ۶ |
| Planning خودکار | ۹ |
| Authorization (`allowedTools`) | ۴, ۵, ۶, ۹, ۱۶ |
| Feasibility gate | ۹ |
| Per-step quality | ۱۱ |
| Resource lock | ۸ |
| Persistence | ۱۰, ۱۴ |
| Priority queue | ۱۰ |
| Qualitative failure | ۱۱ |
| ابهام‌زدایی | ۹ |
| Streaming | ۱۳ |
| Cancellation | ۱۳ |
| Concurrency/Rate-limit | ۸, ۱۳ |
| Usage tracking | ۱۳ |
| Session persistence | ۱۴ |
| Observability ماندگار | ۱۴ |
| Human-Out-Of-Loop | ۹, ۱۰, ۱۶ |

---

## 📊 وضعیت نهایی فاز ۱۷

| گام | وضعیت |
|---|---|
| گام ۱: README معماری | 🟢 |
| گام ۲: راهنمای افزودن اجزا | 🟢 |
| گام ۳: مستندسازی پیکربندی | 🟢 |
| **فاز ۱۷** | **🟢** |

---

## 🏁 وضعیت نهایی پروژه — تمام ۱۷ فاز

| فاز | عنوان | وضعیت |
|---|---|---|
| ۱ | زیرساخت پایه Registry و Schemaها | 🟢 |
| ۲ | Tool Registry (محلی + MCP) | 🟢 |
| ۳ | Skill Registry | 🟢 |
| ۴ | Persona (با policy) + Model Registry | 🟢 |
| ۵ | Agent Registry + Factory + Context Budget | 🟢 |
| ۶ | کاتالوگ پویا + ترکیب پویای Agent | 🟢 |
| ۷ | Agent Runtime + EventBus | 🟢 |
| ۸ | Task Runtime + Resource Lock + Concurrency | 🟢 |
| ۹ | Planning Layer | 🟢 |
| ۱۰ | PlanRuntime (Human-Out-Of-Loop) | 🟢 |
| ۱۱ | Per-Step Acceptance Check | 🟢 |
| ۱۲ | Review نهایی + گزارش | 🟢 |
| ۱۳ | Streaming/Cancellation/Rate-limit/Usage | 🟢 |
| ۱۴ | Session persistence + Observability | 🟢 |
| ۱۵ | یکپارچه‌سازی سرتاسری | 🟢 |
| ۱۶ | تست جامع و Hardening | 🟢 |
| ۱۷ | مستندسازی و تحویل | 🟢 |

---

## 🎉 پروژه کامل شد!

**تمام ۱۷ فاز 🟢 هستند.** خلاصه‌ی آنچه ساخته شد:

- **۶ Registry** داده‌محور (Tool, Skill, Persona, Model, Agent, MCP) با cross-validation
- **Agent Factory** با context budget trimming و authorization filtering
- **Planning Layer** با ابهام‌زدایی، Feasibility Gate، و تشخیص چرخه
- **PlanRuntime** خودکار (Human-Out-Of-Loop) با priority queue، re-planning، و crash recovery
- **Acceptance Checker** برای تشخیص شکست کیفی (نه فقط فنی)
- **Final Reviewer** با Structured Output تضمین‌شده
- **لایه‌های عملیاتی**: Streaming, Cancellation, Rate-limit, Usage Tracking, Session Persistence, Observability
- **Orchestrator** به‌عنوان نقطه‌ی ورود واحد end-to-end
- **۲۰۰+ تست واحد و integration** شامل edge-caseها، امنیت، و بازبینی چندمنظره
- **مستندسازی کامل**: معماری، راهنمای توسعه، پیکربندی
