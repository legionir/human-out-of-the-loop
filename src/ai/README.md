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

## Migration Guide — از نسخه‌ی ۱۷ به ۲۵/۲۶

این پروژه تغییرات breaking را **آگاهانه** مجاز کرده است (تصمیم کاربر، ۲۰۲۶-۰۹-۲۳). لیست کامل در `CHANGELOG.md`؛ خلاصه‌ی مهاجرت:

| تغییر breaking | کاری که باید بکنید |
|---|---|
| **`projectRoot` الزامی** — tool factoryها آن را می‌گیرند (`createReadFileTool(projectRoot)`) و `validateWorkspacePath` بدون آن throw می‌کند (قبلاً `process.cwd()` fallback) | `projectRoot` را به Orchestrator / `--project-root` / `HOTL_PROJECT_ROOT` بدهید |
| **IDها UUID-based شدند** (`plan_<uuid>`, `session_<uuid>`, `interaction_<uuid>`, `dynamic_*`, `pending_*`) — قبلاً `plan_${Date.now()}` | کد شما نباید به قالب id وابسته باشد؛ برای شروع تمیز: `rm -rf .ai-runtime`. داده‌های قدیمی روی disk خوانده می‌شوند (id از بدنه‌ی JSON و filename = `sha256(id)`) |
| **`globalEventBus` حذف شد** — EventBus فقط تزریق می‌شود | `new TaskRuntime({ eventBus })`؛ Orchestrator خودش این کار را می‌کند |
| **`OrchestratorConfig` با Zod اعتبارسنجی می‌شود** — مقدار نامعتبر `ZodError` می‌دهد | مقدار را داخل بازه بگذارید (جدول در `CONFIGURATION.md`) |
| **`maxSteps` / `--max-steps` حالا واقعاً اعمال می‌شوند** (U3) — قبلاً config مرده بود | اگر روی مقدار قبلی رفتار می‌خواهید: `maxSteps: 20` |
| **`Review.usage` الزامی است** (`emptyReviewUsage` = صفرها) | خواننده‌ها نیازی به optional check ندارند؛ سازنده‌ها باید مقدار بدهند |
| **`isPlanTerminal` سطح-plan** — `completed`/`failed-partial`/`cancelled` بدون بررسی stepها terminal هستند | `resumePlan` را فقط برای planهای non-terminal صدا بزنید (plan `draft` عمداً resume نمی‌شود) |
| **filenameهای store = `sha256(id)`** — دیگر `a/b` و `a_b` تصادم ندارند | نیازی به کار نیست؛ `list()` همان idهای اصلی را برمی‌گرداند |
| **پیکربندی سرور/CLI یکسان شد** (U1) — سرور `~/.human-out-of-the-loop/config.json` و `.env` پروژه را می‌خواند | برای پین‌کردن مدل: `HOTL_MODEL` یا گزینه‌ی `model` سرور |

**APIهای جدید (additive، بدون شکستن):** `Orchestrator.previewPlan()` (feasibility/cycles/needsClarification را هم برمی‌گرداند)، `Orchestrator.run(request, { runOverrides })`، `InvalidModelError`، `clarificationCallback` (C4)، `TaskRuntime.cancelTask` (abort واقعی)، `RateLimiterConfig.random` (تزریق randomness برای تست‌های deterministic)، `redactKeys`/`maxClarificationRounds` در config.

**وضعیت فعلی:** ۲۷ فاز (۱۸–۲۶) + پلن‌های CLI (C1–C5) و UI (U1–U8) کامل؛ ۵۲۷ تست در ۳۶ فایل + `tsc` سبز. مسیرهای اجرا: CLI (`src/cli.ts`) و سرور وب (`src/server.ts` → `public/`) — هر دو روی همان runtime.

## اصل Human-Out-Of-Loop (قانون ۱۷)

پس از تأیید Plan توسط کاربر، **هیچ تعامل انسانی** تا پایان اجرا:
- شکست فنی → retry خودکار
- شکست کیفی → re-planning خودکار
- Rate-limit → backoff خودکار
- تنها تعامل مجاز: **Cancellation صریح** (`cancelPlan(planId)`)
