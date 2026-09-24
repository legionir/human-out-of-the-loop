# پیکربندی و متغیرهای محیطی

## متغیرهای محیطی

### Providerهای مدل

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `OPENAI_API_KEY` | بله (اگر از OpenAI استفاده می‌شود) | کلید API OpenAI |
| `ANTHROPIC_API_KEY` | بله (اگر از Anthropic استفاده می‌شود) | کلید API Anthropic |
| `OPENAI_BASE_URL` | خیر | URL سفارشی برای OpenAI-compatible API |
| `LOCAL_MODEL_BASE_URL` | خیر | URL برای local provider (default: http://localhost:11434/v1) |

### سرور وب (UI)

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `HOTL_PROJECT_ROOT` | خیر | ریشه‌ی پروژه برای سرور (registry + `.ai-runtime`). اگر نباشد: `projectRoot` از global config، وگرنه `process.cwd()` |
| `HOTL_PORT` | خیر | پورت HTTP سرور (پیش‌فرض: ۳۰۰۰) |
| `HOTL_MODEL` | خیر | مدل پیش‌فرض سرور — اولویت از بالا: گزینه‌ی `model` در `createApp()` > `HOTL_MODEL` > `defaultModel` در global config > `gpt-4o`. از UI هم per-run قابل تغییر است (U3) |
| `HOTL_REDACT_KEYS` | خیر | لیست کلیدهای اضافی برای redact شدن در observability (با کاما جدا می‌شود؛ مکمل `redactKeys` در config) |

> ترتیب بارگذاری: `.env` در project root، سپس `.env` در cwd (متغیرهای محیطی واقعی هرگز overwrite نمی‌شوند) + `~/.human-out-of-the-loop/config.json` (کلیدهای `projectRoot`/`defaultModel`) — همان منابع CLI (U1).

### لایه‌های رجیستری (فاز ۲۸)

رجیستری‌ها از دو لایه ادغام می‌شوند (ترتیب از کمترین به بیشترین اولویت):

| لایه | مسیر | نقش |
|---|---|---|
| package (گلوبال) | `registry/` کنار `package.json` — یافتن با پیمایش از خود ماژول (`src/`, `dist/` یا نصب سراسری) | کاتالوگ داخلی: personas، tools، skills، models، mcp-servers، agents.json؛ دستورها را از هر مسیری کارا می‌کند |
| project (لوکال) | `<project-root>/registry` | override و افزودن ورودی؛ **آخر** لود می‌شود |

ورودی با `id` موجود در لایه‌ی پکیج، **جایگزین** می‌شود (نه خطای duplicate) و idهای جدید اضافه می‌شوند. `HOTL_NO_PACKAGE_REGISTRY=1` لایه‌ی گلوبال را غیرفعال می‌کند. لایه‌ای که فقط بعضی زیرپوشه‌ها را دارد مجاز است؛ ورودی نامعتبر (JSON خراب/اسکیمای ناقض) در هر لایه خطای واضح می‌دهد.

### MCP Servers

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `MY_MCP_SERVER_TOKEN` | بله (اگر سرور auth دارد) | Token برای MCP server |
| *(هر env var تعریف‌شده در `tokenEnvVar`/`keyEnvVar`)* | بله | مطابق `registry/mcp-servers/*.json` |
| `TEST_SECRET_TOKEN` | مثال تست | نمونه در hardening-security.test.ts |
| `HOTL_NO_PACKAGE_REGISTRY` | خیر | `1`/`true` = نادیده‌گرفتن رجیستری داخلی پکیج و استفاده‌ی صرف از `<project-root>/registry` (فاز ۲۸) |

**نکته امنیتی:** هیچ credential نباید به صورت inline در `registry/mcp-servers/*.json` قرار گیرد. فقط نام env var (مثل `tokenEnvVar`) ذخیره می‌شود و مقدار واقعی از منبع محیط خوانده می‌شود — پیش‌فرض `process.env` و در صورت تزریق، `McpConnectorOptions.env` / `OrchestratorConfig.env` (فاز ۲۷، CFG-08). `McpConnector.sanitiseError` هر مقدار credential را از پیام خطا حذف و با `***REDACTED***` جایگزین می‌کند.

### تزریق محیط — env injection (فاز ۲۷، CFG-08)

هر جا مقدار محیطی لازم است، یک منبع قابل تزریق از نوع `EnvSource` (`Readonly<Record<string, string | undefined>>`، ماژول `src/ai/env.ts`) پذیرفته می‌شود؛ **حذف پارامتر = رفتار قبلی** (خواندن زنده از `process.env`، بدون snapshot):

| نقطه | نحوه‌ی تزریق | پیش‌فرض |
|---|---|---|
| `Orchestrator` (کل زنجیره) | `new Orchestrator({ projectRoot, env })` — به `ModelRegistry` و bootstrap مربوط به MCP منتقل می‌شود | `process.env` |
| `ModelRegistry` | `new ModelRegistry({ env })` → به `ProviderFactory.create(config, env)` می‌رسد | `process.env` |
| Providerها | `factory.create(config, env)` — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LOCAL_MODEL_BASE_URL` | `process.env` (fallback صریح) |
| `McpConnector` | `new McpConnector({ toolRegistry, env })` — `tokenEnvVar`/`keyEnvVar` از همین منبع | `process.env` |
| `bootstrapMcpServers` | پارامتر چهارم `env` (فقط وقتی connector تزریق نشده باشد) | `process.env` |

**نکته‌ی runtime (فاز ۲۷):** این پکیج ESM است (`"type": "module"`) و `require` در آن تعریف نشده؛ lazy-loaderهای provider با `createRequire(import.meta.url)` بارگذاری می‌شوند (قبلاً `require()` برهنه بود و در `tsx`/CLI/server همه‌ی instantiationها شکست می‌خورد).

کاربرد: اجرای چند Orchestrator با credentialهای متفاوت در یک پروسه (سرور/تست) بدون دست‌کاری `process.env`؛ هر instance فقط env خودش را می‌بیند (`modelRegistry.envSource` قابل بازرسی است). متغیرهای غیر-secret مثل `HOTL_*` همچنان از env پروسه در لایه‌ی CLI/server خوانده می‌شوند.

### بازخورد زنده‌ی اجرا — CLI (فاز ۳۲)

تا قبل از این فاز، یک فراخوانی طولانی مدل هیچ چیزی چاپ نمی‌کرد: کاربر نمی‌توانست «در حال کار» را از «هنگ‌کرده» تشخیص دهد. دو نمایش جدید اضافه شد — خط وضعیت چرخان (پیام‌ها هر ۳ ثانیه عوض می‌شوند، به‌صورت تصادفی از ۱۲ متن درخواستی) و رندر زنده‌ی متن thinking مدل (ایتالیک، بنفش `#a78bfa`، پیش‌وند `💭`، سقف ۴۰۰۰ کاراکتر در هر بلوک). متن thinking فقط نمایشی است و هرگز در plan/observability/گزارش ذخیره نمی‌شود (Law 14).

| متغیر | ضروری | توضیح |
|-------|-------|-------|
| `HOTL_THINKING` / `HOTL_SHOW_THINKING` | خیر | `on`/`off`/`1`/`0`/`true`/`false`/`yes`/`no`. پیش‌فرض `auto`: فقط وقتی stdout یک terminal باشد. `--thinking <auto\|on\|off>` روی محیط اولویت دارد |
| `HOTL_NO_ACTIVITY` | خیر | `1`/`true`/`yes`/`on` = خاموش‌کردن خط وضعیت (حتی در terminal) |
| `HOTL_ACTIVITY` | خیر | `off` هم‌ارز `HOTL_NO_ACTIVITY=1` |
| `HOTL_ACTIVITY_INTERVAL_MS` | خیر | فاصله‌ی تعویض پیام خط وضعیت (پیش‌فرض `3000`؛ کمتر از `250` نادیده گرفته می‌شود) |

**استریم شدن thinking:** وقتی thinking نمایش داده می‌شود، هر نوبت agent با `streamText` اجرا می‌شود تا `reasoning` هم‌زمان با تولید برسد؛ در غیر این صورت مسیر قبلی (`generateText`) دست‌نخورده می‌ماند. ارائه‌دهنده‌هایی که reasoning را در `choices[0].delta.reasoning_content` می‌فرستند (gatewayهای سازگار با OpenAI — که schema چت SDK این فیلد را دور می‌ریزد) با `includeRawChunks` پوشش داده می‌شوند؛ اگر هر دو منبع موجود باشند فقط منبع بومی چاپ می‌شود تا متن دوباره تکرار نشود.

**پروژه در پرامپت پلنر:** هر دو پرامپت پلنر (`assess` و `generatePlan`) یک بلوک `PROJECT CONTEXT` دارند: مسیر مطلق پروژه، پلتفرم، این‌که مسیرها نسبت به همان ریشه‌اند و داخل آن می‌مانند، ورودی‌های سطح اول (اول دایرکتوری‌ها؛ `node_modules`/`dist`/`.git` و مشابه‌ها رد می‌شوند؛ حداکثر ۴۰) و وجود `package.json`. درخواستی که فقط «کدام پروژه/کجا/چه استکی» را کم دارد، صریحاً *CLEAR* است — پس مدل دیگر برای چیزی که CLI می‌داند سؤال توضیحی نمی‌پرسد.

## فیلدهای `OrchestratorConfig` (منبع حقیقت: `OrchestratorConfigSchema` در `src/ai/orchestrator.ts`)

| فیلد | نوع/بازه Zod | پیش‌فرض | پیش‌نیاز | توضیح |
|------|--------------|---------|----------|-------|
| `projectRoot` | `string().min(1)` | — (**الزامی**) | بله | ریشه‌ی workspace؛ همه‌ی tool factoryها و path-security از آن استفاده می‌کنند |
| `persistent` | `boolean` | `false` | خیر | استفاده از storeهای فایل‌محور (`.ai-runtime`) به‌جای حافظه |
| `runtimeDir` | `string` | `<projectRoot>/.ai-runtime` | خیر | مسیر دایرکتوری runtime |
| `maxConcurrentTasks` | `int 1..100` | `5` | خیر | سقف task هم‌زمان در TaskRuntime |
| `maxConcurrentPerProvider` | `int 1..50` | `5` | خیر | سقف درخواست هم‌زمان به هر provider (RateLimiter) |
| `maxReplanningAttempts` | `int 0..10` | `3` | خیر | سقف کل re-planning یک plan |
| `agentTimeoutMs` | `int 1000..600000` | `120000` | خیر | timeout هر اجرای agent (به `AgentRuntime.run` می‌رسد) |
| `maxDelegationDepth` | `int 0..5` | `1` | خیر | عمق مجاز delegation |
| `maxRetries` | `int 0..10` | `3` | خیر | تعداد retry روی rate-limit |
| `baseBackoffMs` | `int ≥100` | `1000` | خیر | تأخیر پایه backoff |
| `maxBackoffMs` | `int ≥1000` | `30000` | خیر | سقف تأخیر backoff |
| `maxSteps` | `int 1..100` | `20` | خیر | سقف iteration حلقه‌ی Tool (U3: واقعاً اعمال می‌شود) |
| `contextBudgetChars` | `int ≥1000` | `120000` | خیر | سقف context برای ترکیب persona+skills |
| `connectTimeoutMs` | `int ≥1000` | `10000` | خیر | timeout اتصال MCP |
| `defaultModelId` | `string` | `'gpt-4o'` | خیر | مدل پیش‌فرض (باید در `registry/models/*.json` باشد) |
| `redactKeys` | `string[].min(1)` | `[]` | خیر | کلیدهای اضافی redact (U1) |
| `maxClarificationRounds` | `int 0..10` | `3` | خیر | سقف round ابهام‌زدایی (C4/U5) |
| `env` | `EnvSource` (اختیاری، `z.custom`) | `process.env` | خیر | منبع محیط per-Orchestrator برای providerها و credentialهای MCP (فاز ۲۷، CFG-08) |
| `onProgress` | callback (خارج از schema، ساختاری) | — | خیر | دریافت `ProgressEvent`ها (فاز ۱۹) |

**اعتبارسنجی:** هر مقدار نامعتبر → `ZodError` در constructor (فاز ۲۲). `RunOverrides` (U3) می‌تواند `modelId`/`agentTimeoutMs`/`maxSteps`/`maxReplanningAttempts` را **برای یک run** جایگزین کند؛ `modelId` نامعتبر → `InvalidModelError` با لیست idهای معتبر، **قبل از هر side-effect**.

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
| `maxSteps` (tool loop) | ۲۰ | `OrchestratorConfig` → `TaskRuntimeConfig` → `AgentRunOptions` (U3 آن را واقعاً wire کرد؛ قبلاً config مرده بود) | حداکثر iteration حلقه‌ی Tool در AgentRuntime |
| `maxClarificationRounds` | ۳ | `OrchestratorConfig` | حداکثر round پرسش‌وپاسخ ابهام‌زدایی (C4/U5)؛ پس از آن run با گزارش failure پایان می‌یابد (۰ = بدون پرسش) |
| `redactKeys` | `[]` | `OrchestratorConfig` (+ `HOTL_REDACT_KEYS`) | کلیدهای اضافی برای redact در observability (U1) |
| `random` (backoff jitter) | `Math.random` | `RateLimiterConfig` | منبع تصادفی jitter؛ تست‌ها تابع deterministic تزریق می‌کنند (QUAL-07، فاز ۲۵) |
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

### نگاشت ۴۲ باگ/بهبود (فازهای ۱۸–۲۶) — Scope Audit نهایی (فاز ۲۵)

مبنای شمارش: بخش ۱ پلن `EXECUTION_PLAN_V2.md` (دسته‌های A–J + K) و برآورد بخش ۵ (۹+۱۰+۱۴+۸+۸ باگ برای فازهای ۱۸–۲۲ + ۳ فیچر در ۲۳/۲۴ = **۴۲+۳**). هر دسته دقیقاً یک فاز/گام دارد:

| دسته | آیتم‌ها | فاز | وضعیت | شواهد |
|------|---------|-----|--------|-------|
| A — Path Security | PATH-01…05, 07, 09 | ۱۸ | ✅ فیکس | tool factoryها `projectRoot` می‌گیرند؛ `realpathSync` در `path-security.ts:49`؛ `workspaceRoot` اجباری (throw)؛ boundary-check در `skill-registry.ts` |
| A — Storage filename | PATH-06 | ۲۲ | ✅ فیکس | filename = `sha256(id).slice(0,16).json` در `plan-store`/`session-store` — تست دو id متمایز روی یک فایل |
| A — Windows case | PATH-08 | ۲۰ | ✅ فیکس | `normaliseCase()` در `path-security.ts:32-34` (lowercase روی `process.platform === 'win32'`) و استفاده در مقایسه‌ی مسیرها (خط ۷۹) |
| B — Config Wiring | CFG-01…07 | ۱۹ (+ فاز ۲۲ برای schema، U3 برای wire کردن `maxSteps`) | ✅ فیکس | یک `bootstrapCatalogTools` (orchestrator:380)؛ `RateLimiter` و `DelegationGuard` config می‌گیرند؛ همه‌ی فیلدهای مستندشده در `OrchestratorConfigSchema` هستند؛ `maxSteps` حالا واقعاً به `stepCountIs` می‌رسد (U3) |
| B — Env injection | CFG-08 | ۲۷ | ✅ فیکس | `EnvSource` تزریق‌پذیر در `src/ai/env.ts`؛ `OrchestratorConfig.env` → `ModelRegistry({env})` → `ProviderFactory.create(config, env)` و `McpConnector({env})`/`bootstrapMcpServers(..., env)`. پیش‌فرض همه‌جا `process.env` است (بدون تغییر رفتار برای فراخوان‌های موجود) و چهار تست CFG-08 در `phase27.test.ts` تزریق، عدم fallback هنگام تزریق، و جداسازی دو Orchestrator را پوشش می‌دهد. مدل credential بدون تغییر: مقدارها هنوز فقط از env می‌آیند (فقط منبع env قابل تعویض شد). |
| C — Singleton | SING-01, SING-02 | ۱۹ | ✅ فیکس | ۰ `?? globalEventBus`؛ `agentRuntime` per-Orchestrator (بدون singleton ماژولی) |
| D — ID Generation | ID-01…06 | ۲۶ | ✅ فیکس | همه به `prefix_randomUUID()`؛ source-scan + تست collision ۵۰۰۰-id در `phase26.test.ts` |
| E — Persistence | PERS-01…03 | ۲۰ | ✅ فیکس | `atomicWriteFileSync` (tmp+uuid+rename) در هر دو store؛ `structuredClone` + snapshot |
| E — File locking | PERS-04 | ۲۷ | ✅ فیکس | `withFileLockSync` در `src/ai/runtime/file-lock.ts` — قفل `O_EXCL` با متادیتای pid/زمان، انتظار محدود (پیش‌فرض ۵s → `FileLockTimeoutError` با holder)، re-entrant، و تصاحب قفل رهاشده (mtime کهنه > ۱۰s یا pid مرده)؛ اعمال روی `FilePlanStore.save/delete` و `FileSessionStore` (نوشتن‌ها + read-modify-write). atomic write فاز ۲۰ همچنان لایه‌ی دوم است |
| F — Leaks | LEAK-01, 02 | ۲۰ | ✅ فیکس | `clearTimeout` در `finally` (mcp-connector، agent-runtime:201) |
| F — MCP dynamic import | LEAK-03 | ۲۰ + **۲۵** | ✅ فیکس | فاز ۲۵: `loadMcpSdk()` memoized — دیگر در هر connect یک `import()` تازه اجرا نمی‌شود (و شکست کش نمی‌شود) |
| G — Correctness | CORR-01…08 | ۲۰ | ✅ فیکس | `parsed.error.issues` در خطا؛ `waitForAll` قبل از `destroy`؛ `task.planId` در aggregator؛ hook صریح acceptance؛ `event.planId` در streaming:169 |
| H — Security Ext | SEC-01, 03…06 | ۲۰ (+۲۲ برای redact/abort) | ✅ ۵/۶ فیکس | regex-guard (nested quantifier + MAX_PATTERN_LENGTH)؛ آستانه‌ی موفقیت MCP؛ substring redaction؛ مسیر نسبی به مدل (بدون `process.cwd()` در implementations) |
| H — Silent skip | SEC-02 | — | ⚠️ **باز** | `search-code.ts:76` فایل‌های غیرقابل‌خواندن را هنوز بی‌صدا رد می‌کند (خطای دسترسی گزارش نمی‌شود) |
| I — Performance | PERF-01…05, 07 | ۲۱ | ✅ ۶/۸ فیکس | O(1) countها؛ `computeTransitiveDependentCounts` memoized؛ fd reuse در logger؛ cache با `stableStringify`؛ early-exit در `search_code` |
| I — Remaining perf | PERF-06, PERF-08 | — | ⚠️ **باز (مستندشده در نتیجهٔ فاز ۲۱)** | `list()` هر بار `readdirSync` + خواندن/parse همه‌ی فایل‌ها (`plan-store.ts:79`, `session-store.ts` مشابه)؛ `EventBus.emit` هر emit یک `Set` جدید برای dedup می‌سازد (`event-bus.ts:124`) — هر دو 🟢 P2 |
| J — Code Quality | QUAL-01…06, 07 | ۲۲ (+ فاز ۲۵ برای QUAL-07) | ✅ فیکس | `any`=۰ و `console.*`=۰ (source-scan دائمی)؛ dead code حذف؛ `abortSignal`→`generateText`؛ zod schema؛ **فاز ۲۵: `RateLimiterConfig.random` تزریق‌پذیر شد** تا تست تأخیرها deterministic باشد |
| K — Features | FEAT-01 | ۲۳ | ✅ فیکس | CLI کامل (C1–C5) — live verify |
| K — Features | FEAT-02, FEAT-03 | ۲۴ (+ U1–U8) | ✅ فیکس | UI وب + REST/SSE (سرور Express، `public/`) — live verify؛ قابلیت‌های تکمیلی UI در `UI_COMPLETION_PLAN.md` |
| — | QUAL-08 (id collision) | ۲۶ | ✅ (ادغام با دسته D) | در پلن به دسته D ارجاع داده شده بود |
| فاز ۲۵ — Docs/Delivery | — | ۲۵ | ✅ | `CHANGELOG.md`، Migration Guide در `src/ai/README.md`، همین سند، `CONTRIBUTING.md`، بخش Web UI در `README.md` |

**نکته‌ی شفافیت:** شمارش «۴۲» در پلن، جمع برآوردی فازها است (۹+۱۰+۱۴+۸+۸+۳) و با تعداد ردیف‌های جدول دسته‌بندی (۶۵ ID پس از تفکیک) یکی نیست؛ این جدول هر دو را پوشش می‌دهد: هر دسته یک فاز/وضعیت دارد و هیچ دسته‌ای بدون فاز نمانده است.

#### جمع‌بندی باقی‌مانده‌ها (بازبینی ۲۰۲۶-۰۹-۲۴ پس از فاز ۲۵)

| مورد | شدت | وضعیت |
|---|---|---|
| PERS-04 — بدون file locking بین‌پروسه‌ای | 🟡 P2 | ✅ بسته‌شده در فاز ۲۷: `withFileLockSync` (قفل `O_EXCL` + stale/pid-dead takeover + تایم‌اوت تایپ‌دار) روی نوشتن storeها؛ تست child-process واقعی در `phase27.test.ts` |
| CFG-08 — `process.env` مستقیم در providerها/MCP (بدون env injection per-Orchestrator) | 🟡 P2 | ✅ بسته‌شده در فاز ۲۷ (`src/ai/env.ts` + `OrchestratorConfig.env`؛ پیش‌فرض `process.env`؛ تست‌های `phase27.test.ts`) |
| SEC-02 — رد بی‌صدای فایل‌های غیرقابل‌خواندن در `search_code` | 🟡 P2 | ✅ بسته‌شده در فاز ۲۷: خروجی `skippedCount` + `skipped[]` (سقف ۲۰) برای فایل/دایرکتوری غیرقابل‌خواندن |
| PERF-06 — `list()` در storeها: `readdirSync` + خواندن همه‌ی فایل‌ها هر بار | 🟢 P2 | ✅ بسته‌شده در فاز ۲۷: ایندکس `idByFile` — فقط فایل‌های جدید parse می‌شوند (۵ فایل → ۵ خواندن در حالت سرد، ۰ خواندن برای listهای بعدی) |
| PERF-08 — `EventBus.emit` با `new Set` در هر emit | 🟢 P2 | ✅ بسته‌شده در فاز ۲۷: fast path بدون allocation + بافر قابل بازاستفاده به‌ازای عمق re-entrancy |
| Open Q5 — کتابخانه‌ی ReDoS | — | ✅ بسته‌شده با راه‌حل جانشین: `safe-regex`/`re2` استفاده نشد؛ `regex-guard.ts` سفارشی (تشخیص nested quantifier) + سقف طول ۲۰۰ به‌جای timeout — بدون dependency native |
| ارتقای UI به Next.js/React (یادداشت فاز ۲۴) | — | 🔵 اختیاری/آینده — UI vanilla عمداً ساده ماند (قابل ارتقا؛ پلن UI کامل شده) |
