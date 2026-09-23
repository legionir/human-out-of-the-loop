# پیکربندی و متغیرهای محیطی

## متغیرهای محیطی

### Providerهای مدل

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `OPENAI_API_KEY` | بله (اگر از OpenAI استفاده می‌شود) | کلید API OpenAI |
| `ANTHROPIC_API_KEY` | بله (اگر از Anthropic استفاده می‌شود) | کلید API Anthropic |
| `OPENAI_BASE_URL` | خیر | URL سفارشی برای OpenAI-compatible API |
| `LOCAL_MODEL_BASE_URL` | خیر | URL برای local provider (default: http://localhost:11434/v1) |

### MCP Servers

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `MY_MCP_SERVER_TOKEN` | بله (اگر سرور auth دارد) | Token برای MCP server |
| *(هر env var تعریف‌شده در `tokenEnvVar`/`keyEnvVar`)* | بله | مطابق `registry/mcp-servers/*.json` |
| `TEST_SECRET_TOKEN` | مثال تست | نمونه در hardening-security.test.ts |

**نکته امنیتی:** هیچ credential نباید به صورت inline در `registry/mcp-servers/*.json` قرار گیرد. فقط نام env var (مثل `tokenEnvVar`) ذخیره می‌شود و مقدار واقعی از `process.env` خوانده می‌شود. `McpConnector.sanitiseError` هر مقدار credential را از پیام خطا حذف و با `***REDACTED***` جایگزین می‌کند.

## سقف‌های پیکربندی‌پذیر

| پارامتر | پیش‌فرض | محل تنظیم | توضیح |
|---------|---------|-----------|-------|
| `maxConcurrentTasks` | ۵ | `OrchestratorConfig` / `TaskRuntimeConfig` | حداکثر تسک هم‌زمان در TaskRuntime |
| `maxConcurrentPerProvider` | ۵ | `RateLimiterConfig` | حداکثر درخواست هم‌زمان به هر provider (OpenAI, Anthropic, etc) |
| `maxReplanningAttempts` | ۳ | `OrchestratorConfig` / `PlanRuntimeConfig` | سقف کل re-planning در PlanRuntime (جلوگیری از حلقه بی‌پایان) |
| `agentTimeoutMs` | ۱۲۰,۰۰۰ (۲ دقیقه) | `OrchestratorConfig` / `AgentRunOptions` | Timeout هر اجرای Agent در AgentRuntime |
| `maxRetries` (rate-limit) | ۳ | `RateLimiterConfig` | تعداد retry روی خطای ۴۲۹ rate-limit |
| `baseBackoffMs` | ۱,۰۰۰ | `RateLimiterConfig` | تأخیر پایه backoff (exponential: base * 2^attempt + jitter) |
| `maxBackoffMs` | ۳۰,۰۰۰ | `RateLimiterConfig` | سقف تأخیر backoff |
| `maxDelegationDepth` | ۱ | `OrchestratorConfig` | عمق مجاز delegation (0 = فقط Main Agent, 1 = یک سطح) |
| `maxSteps` (tool loop) | ۲۰ | `AgentRunOptions` | حداکثر iteration حلقه‌ی Tool در AgentRuntime |
| `contextBudgetChars` | ۱۲۰,۰۰۰ (~۳۰k tokens) | `CreateAgentOptions` | سقف context برای ترکیب persona.system + skill.instructions |
| `connectTimeoutMs` (MCP) | ۱۰,۰۰۰ | `registry/mcp-servers/*.json` | Timeout اتصال به هر MCP server |
| `additionalTasksCeiling` | ۲ | `PlanRuntimeConfig` | سقف چرخه‌ی additionalTasks (جلوگیری از رشد بی‌رویه) |

### فرمول Backoff

```
delay = min(baseBackoffMs * 2^attempt + jitter(±25%), maxBackoffMs)
```

- `isRateLimitError` تشخیص می‌دهد: `429`, `rate limit`, `too many requests`, `throttl` (case-insensitive)
- `isRecoverable` در `RetryableAgentRuntime`: `timeout`, `timedout`, `timed out`, `etimedout`, `rate limit`, `429`, `503`, `502`, `econnreset`, `econnrefused`

## ساختار فایل‌های پیکربندی

```
registry/
├── agents.json              # تعریف Agentها (آرایه‌ی JSON)
│   └── [{ id, name, personaId, skillIds, modelId, description }]
├── personas/
│   ├── architect.json       # Persona: id, name, system, allowedTools, description
│   ├── coder.json
│   ├── reviewer.json
│   └── planner.json
├── skills/
│   ├── code_analysis/
│   │   ├── skill.json       # id, name, version, instructions, tools, priority, description
│   │   └── SKILL.md         # instructions واقعی (markdown)
│   ├── file_management/
│   ├── git_operations/
│   ├── task_decomposition/
│   └── acceptance_check/
├── tools/
│   ├── read_file.json       # id, name, description, source: local, modulePath, category
│   ├── search_code.json
│   ├── write_file.json
│   └── git_status.json
├── models/
│   ├── gpt-4o.json          # id, provider, model, config { baseURL?, maxContextTokens? }
│   ├── claude-sonnet.json
│   └── local-llama.json
└── mcp-servers/
    ├── example.json         # id, name, transport http|sse|stdio, url, auth, toolPrefix, connectTimeoutMs
    └── README.md
```

### نمونه‌ها

**`registry/personas/coder.json`:**
```json
{
  "id": "coder",
  "name": "Coder",
  "system": "You are a skilled software engineer...",
  "allowedTools": ["read_file", "write_file", "search_code", "git_status"],
  "description": "Implements features and fixes bugs"
}
```

**`registry/skills/file_management/skill.json`:**
```json
{
  "id": "file_management",
  "name": "File Management",
  "version": "1.0.0",
  "instructions": "SKILL.md",
  "tools": ["read_file", "write_file", "search_code"],
  "priority": 60,
  "description": "Reads, writes, and searches files"
}
```

**`registry/tools/read_file.json`:**
```json
{
  "id": "read_file",
  "name": "Read File",
  "description": "Reads file contents",
  "source": "local",
  "modulePath": "./read-file",
  "category": "filesystem"
}
```

**`registry/models/gpt-4o.json`:**
```json
{
  "id": "gpt-4o",
  "provider": "openai",
  "model": "gpt-4o",
  "config": {
    "maxContextTokens": 128000
  }
}
```

**`registry/mcp-servers/my_server.json`:**
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

**`registry/agents.json`:**
```json
[
  {
    "id": "coder",
    "name": "Coder Agent",
    "personaId": "coder",
    "skillIds": ["code_analysis", "file_management"],
    "modelId": "gpt-4o"
  }
]
```

## دایرکتوری Runtime (پایدار)

```
.ai-runtime/                 # (ایجاد خودکار در حالت persistent=true)
├── plans/                   # Planهای persist‌شده (JSON) — FilePlanStore
│   └── {planId}.json
├── sessions/                # Sessionهای persist‌شده (JSON) — FileSessionStore
│   └── {sessionId}.json
└── observability.jsonl      # لاگ ساختاریافته‌ی ماندگار — ObservabilityLogger (JSONL)
```

- `OrchestratorConfig.persistent = false` (default) → `MemoryPlanStore` + `MemorySessionStore` (in-memory, برای dev/test)
- `persistent = true` → `FilePlanStore` + `FileSessionStore` در `runtimeDir` (default `.ai-runtime/`)
- `ObservabilityLogger` همیشه append-only JSONL می‌نویسد با `timestamp` ISO + `epochMs` + `planId`/`stepId`/`taskId`/`eventType`/`payload`/`level`
- Credentialها به صورت خودکار redact می‌شوند: `apiKey`, `api_key`, `token`, `password`, `secret`, `authorization`, `credential`, `bearer`, `cookie`, `session_key` → `***REDACTED***`

## جریان پیکربندی در Orchestrator

```typescript
const orchestrator = new Orchestrator({
  projectRoot: '/path/to/project',
  persistent: true,                    // File-based stores
  runtimeDir: './.ai-runtime',          // Custom runtime dir
  maxConcurrentTasks: 5,                // TaskRuntime concurrency
  maxReplanningAttempts: 3,             // PlanRuntime ceiling
  defaultModelId: 'gpt-4o',             // Default model
  agentTimeoutMs: 120_000,              // 2 min timeout
  maxDelegationDepth: 1,                // No recursive delegation
  onProgress: (event) => console.log(event), // Streaming callback
});

await orchestrator.initialize(); // Loads all registries + validates cross-refs + resolveAll models

const result = await orchestrator.run('Build a login page', {
  sessionId: 'optional-existing-session',
  confirmCallback: createCliConfirmCallback(), // REQUIRED — Law 17
});

console.log(result.report); // FINAL REPORT
await orchestrator.shutdown();
```

## Scope Audit — نگاشت نیازمندی‌ها به فازها

| نیازمندی | فاز(ها) | توضیح |
|----------|---------|-------|
| MCP integration | ۲ | ToolRegistry local+MCP uniform + McpConnector + bootstrap + credential env |
| Context budget | ۵ | AgentFactory buildSystemPrompt with priority trimming + budget chars |
| انتخاب پویای Agent | ۶ | delegate_task dynamic mode persona/skills/tools/model |
| Planning خودکار | ۹ | Planner assess/generatePlan + PlanSchema + generateObject |
| Authorization (`allowedTools`) | ۴, ۵, ۶, ۹, ۱۶ | PersonaSchema allowedTools + Factory filter + delegate_task checkAuthorization + Feasibility Gate + hardening tests |
| Feasibility gate | ۹ | runFeasibilityGate checks persona/skill/tool existence + allowedTools + dependsOn |
| Per-step quality | ۱۱ | AcceptanceChecker reviewer + acceptance_check skill + quality vs technical failureType |
| Resource lock | ۸ | ResourceLockManager claimedResources overlap → queue |
| Persistence | ۱۰, ۱۴ | FilePlanStore + MemoryPlanStore + SessionStore + resume |
| Priority queue | ۱۰ | PlanRuntime getReadyStepsPrioritized by downstream dependents count |
| Qualitative failure | ۱۱ | failureType quality distinct from technical, triggers re-planning |
| ابهام‌زدایی | ۹ | Planner.assess() → needsClarification, ONLY pre-execution human input |
| Streaming | ۱۳ | StreamingManager + ProgressEvent + SSE + EventBus translation |
| Cancellation | ۱۳ | CancellationManager cancelPlan + cancelling transitional + PlanRuntime cancel flag |
| Concurrency/Rate-limit | ۸, ۱۳ | maxConcurrentTasks + ResourceLock + RateLimiter per-provider + backoff + 429 retry |
| Usage tracking | ۱۳ | UsageAggregator per-task/per-plan/per-agent + EventBus subscribe + final report |
| Session persistence | ۱۴ | FileSessionStore + MemorySessionStore + get_previous_plan_summary Tool |
| Observability ماندگار | ۱۴ | ObservabilityLogger JSONL append-only + redact + EventBus integration |
| Human-Out-Of-Loop | ۹, ۱۰, ۱۶ | Planning confirmation ONLY touchpoint, PlanRuntime auto loop without human, hardening Law 17 checks |

تمام ۱۸ نیازمندی به حداقل یک فاز نگاشت شده‌اند ✅
