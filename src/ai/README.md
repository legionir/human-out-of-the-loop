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
