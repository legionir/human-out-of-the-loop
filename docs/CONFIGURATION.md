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
| `HOTL_HOST` | خیر | آدرس bind سرور وب (پیش‌فرض: `127.0.0.1`). bind غیر-loopback بدون توکن در استارت رد می‌شود |
| `HOTL_SERVER_TOKEN` | بله اگر host غیر-loopback باشد | توکن Bearer برای همهٔ `/api/*` (چند توکن با کاما). معادل `--token`. بدون توکن روی loopback، auth خاموش است |
| `HOTL_RUN_TTL_MS` | خیر | مهلت انتظار clarification/confirmation (پیش‌فرض ۳۰ دقیقه؛ `0` = خاموش). پس از TTL ران `cancelled` می‌شود |
| `HOTL_MODEL` | خیر | مدل پیش‌فرض سرور — اولویت از بالا: گزینه‌ی `model` در `createApp()` > `HOTL_MODEL` > `defaultModel` در global config > `gpt-4o`. از UI هم per-run قابل تغییر است (U3) |
| `HOTL_REDACT_KEYS` | خیر | لیست کلیدهای اضافی برای redact شدن در observability (با کاما جدا می‌شود؛ مکمل `redactKeys` در config) |
| `HOTL_MAX_SSE_CONNECTIONS` | خیر | سقف اتصال SSE هم‌زمان در یک پروسه (F-10) |

> ترتیب بارگذاری: `.env` در project root، سپس `.env` در cwd (متغیرهای محیطی واقعی هرگز overwrite نمی‌شوند) + `~/.human-out-of-the-loop/config.json` (کلیدهای `projectRoot`/`defaultModel`/`defaultMode`) — همان منابع CLI (U1).

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
| `HOTL_TOOL_LOG` | خیر | `0`/`off` = خاموش‌کردن لاگ فراخوانی ابزار در CLI؛ پیش‌فرض روشن. `--tool-log <auto\|on\|off>` روی محیط اولویت دارد |
| `HOTL_NO_ACTIVITY` | خیر | `1`/`true`/`yes`/`on` = خاموش‌کردن خط وضعیت (حتی در terminal) |
| `HOTL_ACTIVITY` | خیر | `off` هم‌ارز `HOTL_NO_ACTIVITY=1` |
| `HOTL_ACTIVITY_INTERVAL_MS` | خیر | فاصله‌ی تعویض پیام خط وضعیت (پیش‌فرض `3000`؛ کمتر از `250` نادیده گرفته می‌شود) |
| `HOTL_NO_SPLASH` | خیر | `1`/`true`/`yes` = رد صفحهٔ شروع REPL (هم‌ارز `--no-splash`) |
| `HOTL_API_KEY` | خیر | کلید endpoint سفارشی وقتی `HOTL_BASE_URL` / `HOTL_MODEL` یک مدل `custom` می‌سازند |
| `HOTL_BASE_URL` | خیر | URL سازگار با OpenAI؛ به‌تنهایی `defaultModel` سراسری را عوض نمی‌کند (B-22) — همراه `HOTL_MODEL` |
| `HOTL_API_STYLE` | خیر | `chat` (Chat Completions) یا `responses`؛ پیش‌فرض برای base URL سفارشی: `chat` |
| `HOTL_FETCH_ALLOW_PRIVATE` | خیر | `1`/`true` = اجازهٔ fetch به آدرس‌های خصوصی (loopback / RFC1918)؛ پیش‌فرض رد |
| `HOTL_ALLOWED_COMMANDS` | خیر | لیست باینری‌های مجاز برای `run_command` (با کاما). مکمل `.ai-runtime/commands.json` |
| `HOTL_TEST_COMMAND` | خیر | argv دستور تست پروژه برای `run_tests` / حلقهٔ خودتأییدی (جدا با فاصله) |
| `HOTL_PLAN_EXAMPLES` | خیر | `0`/`false`/`off` = خاموش‌کردن نمونه‌های پلن موفق در پرامپت پلن‌ساز |
| `HOTL_MODE` | خیر | حالت پیش‌فرض اجرا: `auto` (پیش‌فرض؛ سؤال جواب داده می‌شود، کار واقعی پلن می‌شود) \| `chat` (هرگز پلن نکن) \| `plan` (هرگز جواب نده). ترتیب: پیشوند `@chat`/`@plan` در خود درخواست > `--mode` > `HOTL_MODE` > `defaultMode` در global config > `auto`. مقدار نامعتبر = خطای مصرف (exit 2) با نام منبع |

**استریم شدن thinking:** وقتی thinking نمایش داده می‌شود، هر نوبت agent با `streamText` اجرا می‌شود تا `reasoning` هم‌زمان با تولید برسد؛ در غیر این صورت مسیر قبلی (`generateText`) دست‌نخورده می‌ماند. ارائه‌دهنده‌هایی که reasoning را در `choices[0].delta.reasoning_content` می‌فرستند (gatewayهای سازگار با OpenAI — که schema چت SDK این فیلد را دور می‌ریزد) با `includeRawChunks` پوشش داده می‌شوند؛ اگر هر دو منبع موجود باشند فقط منبع بومی چاپ می‌شود تا متن دوباره تکرار نشود.

**پروژه در پرامپت پلنر:** هر دو پرامپت پلنر (`assess` و `generatePlan`) یک بلوک `PROJECT CONTEXT` دارند: مسیر مطلق پروژه، پلتفرم، این‌که مسیرها نسبت به همان ریشه‌اند و داخل آن می‌مانند، ورودی‌های سطح اول (اول دایرکتوری‌ها؛ `node_modules`/`dist`/`.git` و مشابه‌ها رد می‌شوند؛ حداکثر ۴۰) و وجود `package.json`. درخواستی که فقط «کدام پروژه/کجا/چه استکی» را کم دارد، صریحاً *CLEAR* است — پس مدل دیگر برای چیزی که CLI می‌داند سؤال توضیحی نمی‌پرسد.
**تضمین سؤال توضیحی (v27.16.1):** اگر پلنر بگوید درخواست روشن نیست، لیست سؤال‌ها هرگز خالی به کاربر نمی‌رسد. پاسخ مدل با هر یک از کلیدهای `needsClarification` / `clarificationQuestions` / `questions` خوانده، ادغام، trim و بی‌تکرار (حساسیت‌ناپذیر به بزرگی/کوچکی حروف) می‌شود؛ و اگر هیچ سؤالی نرسیده باشد، پلنر خودش یک سؤال از چیزهایی که می‌داند می‌سازد: ریشه‌ی پروژه و ورودی‌های سطح اول آن — پس هرگز نمی‌پرسد «کدام پروژه؟» و هرگز تیتر خالی `⚠️ Clarification needed:` چاپ نمی‌شود. پرامپت هم صریحاً همان نام فیلد را می‌خواهد: «۱ تا ۵ سؤال مشخص و پاسخ‌دادنی در آرایه‌ی `needsClarification` — هرگز لیست خالی». رأی روشن (`isClear: true`) دست‌نخورده عبور می‌کند و سؤالی اضافه نمی‌شود.
**حالت‌های اجرا (v27.17.0):** هر درخواست لزوماً پلن نمی‌شود. `auto` (پیش‌فرض) سه سرنوشت دارد: سؤال/سلام/توضیح → **پاسخ** (`💬 Answer`) با persona جدید `chat` و فقط ابزارهای خواندنی (می‌خواند، می‌جوید، git را می‌بیند؛ هرگز نمی‌نویسد) و بدون هیچ پلنی؛ کار واقعی → **پلن** (مثل قبل، با تأیید و اجرا)؛ درخواست مبهم → **سؤال**. انتخاب حالت: `@chat`/`@plan` در ابتدای درخواست (فقط این سه کلمه که بعدشان فاصله باشد؛ `@aur/auto` دست‌نخورده می‌ماند)، `--mode auto\|chat\|plan`، `HOTL_MODE`، `defaultMode` در global config، و در REPL دستور `/mode` و `/chat <متن>`. پاسخ چت هم در Journal ثبت می‌شود (هر فراخوانی ابزار با `agentId: "chat-runtime"`) و هم در `hootl usage` شمرده می‌شود. در HTTP: `POST /api/run { mode }` (مقدار نامعتبر → 400) و اجرای چت `done` با `outcome: "success"`، گزارش = پاسخ، و **بدون** `planId`؛ `POST /api/preview` هم `{ ok, answer }` برمی‌گرداند.
**زبان پاسخ (v27.17.0):** زبان درخواست از روی خط نوشتاری تشخیص داده می‌شود (فارسی، عربی‑خط، روسی، یونانی، عبری، هندی، بنگالی، تایلندی، ژاپنی، کره‌ای، چینی) و همان در پرامپت‌ها نام برده می‌شود: ارزیابی، تولید پلن، پرامپت پاسخ چت، system prompt هر agent (persona + env)، داوری پذیرش و بازبینی نهایی. اگر متن به خط عربی باشد ولی حرف ویژه‌ی فارسی (پ چ ژ گ ی ک) نداشته باشد — مثل «خواندن» — runtime حدس نمی‌زند: می‌گوید «به همان زبان درخواست بنویس» تا مدل خودش انتخاب کند. تنها متنی که خودِ کد می‌نویسد (سؤال fallback در حالت مبهم) برای فارسی قالب فارسی دارد. برچسب‌های خود CLI (مثل `🛑 Planning failed:` یا `Usage:`) انگلیسی می‌مانند — آن‌ها متن مدل نیستند.




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
│   ├── reasoning/           # زنجیرهٔ استدلال ماندگار (فاز ۳۸)
│   ├── project_memory/      # گراف دانش پروژه (فاز ۳۹)
│   ├── web_research/        # خواندن وب و ارجاع به کد (فاز ۴۰)
│   ├── task_decomposition/
│   └── acceptance_check/
├── tools/                   # ۴۵ ابزار محلی (فاز ۳۳–۴۲: پورت کامل سرورهای مرجع)
│   ├── read_file.json       # id, name, description, source: local, modulePath, category
│   ├── search_code.json     #   جستجوی VS Code-style: pattern محتوا + pathPattern مسیر
│   ├── write_file.json
│   ├── git_status.json
│   ├── edit_file.json       # ویرایش خطی + diff (dryRun)
│   ├── read_multiple_files.json
│   ├── write_multiple_files.json  # scaffold دسته‌ای + وضعیت هر فایل + dryRun
│   ├── list_directory.json  # [DIR]/[FILE]؛ symlink هرگز دنبال نمی‌شود
│   ├── list_directory_with_sizes.json  # اندازه هر فایل + sortBy: name|size + مجموع
│   ├── read_media_file.json # تصویر/صدا → base64 + پیوست به فراخوانی مدل (maxBytes)
│   ├── directory_tree.json  # درخت JSON با excludePatterns و maxDepth
│   ├── move_file.json       # مقصد موجود → خطا (بدون overwrite)
│   ├── get_file_info.json
│   ├── create_directory.json
│   ├── search_files.json    # گلوب editor-style: نام در هر عمق + حذف خودکار node_modules/dist + ابعاد و شمارش‌ها
│   ├── list_allowed_directories.json
│   ├── get_current_time.json  # ساعت حالا در هر منطقهٔ IANA + DST + offset ماشین
│   ├── convert_time.json      # تبدیل HH:MM بین یک یا چند منطقه (درست در مرز DST)
│   ├── sequentialthinking.json # زنجیرهٔ استدلال شماره‌دار/شاخه‌دار، ماندگار در thinking/
│   ├── create_entities.json   # حافظهٔ پروژه (فاز ۳۹): موجودیت با نام/نوع/observations
│   ├── create_relations.json  # رابطه بین دو موجودیت موجود (وگرنه ENTITY_NOT_FOUND)
│   ├── add_observations.json  # افزودن fact به موجودیت موجود (بدون تکرار)
│   ├── delete_entities.json   # حذف موجودیت + آبشار relationهای وابسته
│   ├── delete_observations.json
│   ├── delete_relations.json
│   ├── read_graph.json        # کل گراف با صفحه‌بندی (پیش‌فرض ۲۰۰ موجودیت) + total/truncated
│   ├── search_nodes.json      # جست‌وجوی case-insensitive در نام/نوع/observations (سقف ۱۰۰)
│   ├── open_nodes.json        # موجودیت‌های نام‌دار + همهٔ رابطه‌های مرتبط (حتی بیرون از نتیجه)
│   ├── fetch.json             # URL → Markdown (صفحه‌بندی، raw)، robots و مسدودسازی آدرس‌های خصوصی
│   ├── git_diff.json          # کار درخت کاری / index (staged) / مقایسه با یک ref (فاز ۴۱)
│   ├── git_log.json           # تاریخچهٔ پارس‌شده با فیلتر path/author/since/until
│   ├── git_show.json          # یک revision: متادیتا + patch (path و statOnly)
│   ├── git_branch_list.json   # برنچ‌ها به‌صورت داده + contains/notContains
│   ├── git_remote_list.json   # fetch/push URL هر remote (بدون شبکه)
│   ├── git_add.json           # stage کردن مسیرها (داخل workspace، بعد از --) — فاز ۴۲
│   ├── git_commit.json        # commit از index یا paths؛ پیام الزامی، هویت فقط خوانده می‌شود
│   ├── git_create_branch.json # branch جدید با اعتبارسنجی خود git (بدون نیاز به تأیید)
│   ├── git_checkout.json      # سوییچ branch/ref؛ discardChanges نیازمند confirmDestructive
│   ├── git_reset.json         # پیش‌فرض unstage (امن)؛ hard فقط با تأیید و روی branch غیرمحافظت‌شده
│   ├── git_push.json          # origin + branch جاری؛ بدون هیچ گزینهٔ force، برنچ محافظت‌شده رد می‌شود
│   ├── git_stash.json         # push/list/pop/apply + drop/clear با تأیید
│   ├── git_pr_create.json     # PR با gh یا REST (GITHUB_TOKEN/GH_TOKEN)
│   ├── git_pr_list.json       # لیست PRها با فیلتر state/base/head
│   ├── git_pr_view.json       # یک PR: وضعیت، نویسنده، branchها، URL، body
│   └── git_pr_comment.json    # کامنت روی PR
├── models/
│   ├── gpt-4o.json          # id, provider, model, config { baseURL?, maxContextTokens? }
│   ├── claude-sonnet.json
│   └── local-llama.json
└── mcp-servers/
    ├── example.json         # id, name, transport http|sse|stdio, url, auth, toolPrefix, connectTimeoutMs
    └── README.md
```

### زمان و استدلال (فاز ۳۸)

سه ابزار از سرورهای مرجع `time` و `sequentialthinking`:

```json
{ "timezone": "Asia/Tehran", "date": "2026-07-01" }          // get_current_time
{ "sourceTimeZone": "Asia/Tehran", "time": "09:30",          // convert_time
  "targetTimeZones": ["Europe/Berlin", "Asia/Tokyo"] }
{ "thought": "…", "thoughtNumber": 1, "totalThoughts": 3,    // sequentialthinking
  "nextThoughtNeeded": true, "sessionId": "release-window" }
```

نکات: منطقهٔ ناشناس با پیشنهاد رد می‌شود (`INVALID_TIMEZONE`)؛ تبدیل برای «روز هدف»
محاسبه می‌شود پس در مرز تغییر ساعت درست است؛ زنجیرهٔ استدلال در
`<project>/.ai-runtime/thinking/<sessionId>.json` (نوشتن اتمیک) ذخیره می‌شود و سقفش
۵۰ گام / ۲۵۶KB است (`THINKING_LIMIT`). ساعت محلی هم در بلوک ENVIRONMENT می‌آید.

### حافظهٔ پروژه (فاز ۳۹)

نُه ابزار سرور مرجع `memory` — حافظهٔ ماندگار بین runها، **برای هر پروژه** در
`<project>/.ai-runtime/memory.json`:

```json
{ "entities": [{ "name": "auth-service", "entityType": "service",
                 "observations": ["توکن‌ها را با rotation صادر می‌کند"] }],
  "relations": [{ "from": "auth-service", "to": "billing-service",
                  "relationType": "depends_on" }] }
```

```jsonc
// create_entities
{ "entities": [{ "name": "auth-service", "entityType": "service", "observations": ["…"] }] }
// create_relations  (هر دو سر رابطه باید موجود باشند)
{ "relations": [{ "from": "auth-service", "to": "billing-service", "relationType": "depends_on" }] }
// add_observations
{ "observations": [{ "entityName": "auth-service", "contents": ["…"] }] }
// search_nodes / open_nodes / read_graph
{ "query": "auth" }      { "names": ["auth-service"] }      {}
```

نکات: نام موجود دست‌نخورده می‌ماند (نه ادغام، نه خطا) و fact تازه با
`add_observations` می‌آید؛ observation تکراری نادیده گرفته می‌شود؛ رابطه به
موجودیت ناموجود با `ENTITY_NOT_FOUND` رد می‌شود؛ حذف موجودیت، relationهای وابسته را
آبشاری حذف می‌کند و `deleted`/`notFound` را برمی‌گرداند. هر نوشتن از lock فایل و
temp+rename رد می‌شود (دو پروسه حافظه را خراب نمی‌کنند)، فایل خراب با `GRAPH_CORRUPT`
گزارش می‌شود و **بازنویسی نمی‌شود**، و هر نتیجه `memoryFile` را نام می‌برد. خواندن‌ها
صفحه‌بندی می‌شوند (`read_graph` ۲۰۰، `search_nodes` ۱۰۰) با `total`/`truncated` و نام
همسایه‌هایی که بیرون صفحه ماندند. `delete_*` فقط در persona `coder` مجاز است؛
`architect` و `reviewer` می‌خوانند و ثبت می‌کنند. هر نوشتن خودکار در Journal می‌آید.

### خواندن مخزن Git (فاز ۴۱)

شش ابزار **فقط-خواندنی** روی یک هستهٔ مشترک (`src/ai/tools/git/`): اجرای git با
`spawn` و آرایهٔ آرگومان (بدون shell)، محیط ثابت
(`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `SSH_ASKPASS=echo`, `GIT_PAGER=cat`,
`GIT_OPTIONAL_LOCKS=0`)، سقف خروجی ۲۵۶KB با kill کردن فرزند، و رد کردن هر مقدار
کاربری که با `-` شروع شود (`BAD_ARGUMENT`) + قرار دادن مسیرها بعد از `--`.

```jsonc
// git_status — سازگار با قبل + porcelain v1/v2 + branch
{ "directory": ".", "porcelain": "v2", "branch": true, "path": "src/app.ts" }
// git_diff — هر سه ابزار مرجع در یکی
{ "directory": "." }                          // درخت کاری (git_diff_unstaged)
{ "directory": ".", "staged": true }          // index (git_diff_staged)
{ "directory": ".", "target": "HEAD~1" }      // یک ref (git_diff)
{ "directory": ".", "statOnly": true }        // فقط diffstat
// git_log / git_show / git_branch_list / git_remote_list
{ "maxCount": 20, "path": "src/app.ts", "author": "a@b.c", "since": "2 weeks ago", "format": "json" }
{ "revision": "HEAD~1", "path": "src/app.ts", "statOnly": false }
{ "all": true, "contains": "abc123" }         { "verbose": true }
```

خروجی‌ها پارس‌شده‌اند: `entries`/`counts` (status)، `files` با تعداد `+`/`-` (diff)،
`entries` با sha/نویسنده/تاریخ/والدها/refs (log)، `commit` + `show` (show)،
`branches` با `current`/`upstream`/`ahead`/`behind` (branch_list)، و `remotes` با
`fetchUrl`/`pushUrl`. کدها: `NOT_A_REPO`، `PATH_TRAVERSAL_BLOCKED`، `BAD_ARGUMENT`،
`TIMEOUT`، `OUTPUT_TOO_LARGE`، `GIT_MISSING`، `GIT_FAILED`. مخزن بدون commit →
لاگ خالی (نه خطا).

### عرضهٔ خود سیستم به‌عنوان MCP server (فاز ۴۳)

`hootl serve --mcp` همان ۴۵ ابزار محلی را به هر کلاینت MCP می‌دهد — با **همان**
مسیر اجرا: sandbox پروژه، اعتبارسنجی zod، نتیجهٔ ساخت‌یافته (`{success:false,code}`)
و ثبت خودکار در Journal با `agentId: "mcp"`.

```bash
hootl serve --mcp --project-root /path/to/project        # stdio (پیش‌فرض؛ همان چیزی که کلاینت‌ها spawn می‌کنند)
hootl serve --mcp --read-only                            # فقط ابزارهای غیرنوشتنی
hootl serve --mcp --allow-tools read_file,git_status     # باریک‌تر
hootl serve --mcp --http --port 3300 --token <t>         # HTTP فقط روی 127.0.0.1
```

```jsonc
// config یک کلاینت MCP
{ "mcpServers": { "human-out-of-the-loop": {
    "command": "hootl",
    "args": ["serve", "--mcp", "--project-root", "/path/to/project", "--read-only"] } } }
```

- **stdio**: فقط stdout حامل پروتکل است؛ بنر روی stderr می‌رود و پیام‌ها به ترتیب
  پاسخ داده می‌شوند. **HTTP**: فقط `127.0.0.1` و bearer token اجباری
  (`--token` یا `HOTL_MCP_TOKEN`) — بدون توکن بالا نمی‌آید؛ `GET /health` تنها مسیر
  بدون توکن است و فقط «بالا هستم» می‌گوید.
- **متدها**: `initialize` (نسخهٔ 2025-06-18، با عقب‌گرد به 2025-03-26/2024-11-05)،
  `ping`، `tools/list`، `tools/call`، `resources/list`، `resources/read`،
  `prompts/list` (خالی) و `notifications/initialized` (بی‌پاسخ، چون notification است).
  کدها: `-32700`، `-32600`، `-32601` (متد یا ابزار ناشناس)، `-32602`، `-32002`.
- **JSON Schema ابزارها** از همان `inputSchema` زد ساخته می‌شود (`z.toJSONSchema`) —
  یک منبع حقیقت؛ متن `describe()` هم به کلاینت می‌رسد. ابزارهای فقط‌خواندنی
  `readOnlyHint` می‌گیرند.
- **فیلترها**: `--read-only` (لیست سفید: `read_*`، `list_*`، `search_*`، `get_*`،
  پنج git read، `fetch`، زمان، خواندن‌های memory — `sequentialthinking` نیست چون
  فایل می‌نویسد)، `--allow-tools a,b`، `--prefix m` (نام‌ها `m_<id>`). فیلترها هم روی
  `tools/list` و هم روی `tools/call` اعمال می‌شوند.
- **منابع فقط‌خواندنی**: `plan://{id}`، `journal://{YYYY-MM-DD}`، `memory://graph` —
  هر URI قبل از جست‌وجو اعتبارسنجی می‌شود، پس خواندن منبع به خواندن فایل بیرون از
  `.ai-runtime` تبدیل نمی‌شود.

### نوشتن در مخزن Git و Pull Request (فاز ۴۲)

یازده ابزار نوشتنی روی همان هسته، با مدل امنیتی §۶.۱:

- **برنچ‌های محافظت‌شده** (`main`، `master`، قابل تغییر با `HOTL_PROTECTED_BRANCHES`):
  نه push، نه `reset --hard`، نه `commit --amend` → کد `PROTECTED_BRANCH`. ساختن
  برنچ *از* `main` و ایستادن روی آن آزاد است؛ محافظت روی بازنویسی است.
- **هیچ کار برگشت‌ناپذیری بدون `confirmDestructive: true`**: `reset --hard`،
  checkout با `discardChanges`، `stash drop/clear`، `commit --amend`. پیام رد شدن
  **نام تمام فایل‌هایی که از دست می‌روند** را می‌آورد.
- **هیچ گزینهٔ force در هیچ schema وجود ندارد** (`--force`, `--force-with-lease`,
  `--mirror`, `--no-verify`)؛ push رد‌شده یعنی fetch/merge یا پرسیدن از کاربر.
- **هر نوشتن `before`/`after` برمی‌گرداند** (HEAD، short sha، branch، porcelain) به
  همراه `changed`/`headChanged`/`branchChanged`؛ نتیجهٔ همان اجرا هم در Journal است.

```jsonc
// branch و checkout
{ "name": "feature/login", "base": "main", "checkout": true }
{ "branch": "main", "discardChanges": true, "confirmDestructive": true }  // دور ریختن تغییرات
// stage و commit
{ "files": ["src/app.ts"] }                    // یا ["."] برای همه
{ "message": "feat: …", "paths": ["src/app.ts"] }   // stage + commit در یک فراخوانی
{ "message": "fixup", "amend": true, "confirmDestructive": true }
// reset / push / stash
{ "mode": "mixed" }                             // پیش‌فرض: فقط unstage (بی‌خطر)
{ "mode": "hard", "confirmDestructive": true }  // دور ریختن تغییرات؛ روی main ممنوع
{ "remote": "origin", "setUpstream": true }     // پیش‌فرض: origin و برنچ جاری
{ "action": "push", "includeUntracked": true, "message": "wip" }
{ "action": "pop" }                             { "action": "drop", "confirmDestructive": true }
// pull request — بک‌اند: اول gh، بعد REST با GITHUB_TOKEN/GH_TOKEN، وگرنه PR_UNAVAILABLE
{ "title": "feat: …", "body": "…", "base": "main", "draft": false }
{ "state": "open", "limit": 10 }                { "number": 42 }        { "number": 42, "body": "…" }
```

مالک/نام مخزن از URL همان remote خوانده می‌شود (`https`، `git@host:owner/repo`،
`ssh://`؛ برای GitHub Enterprise آدرس API می‌شود `https://<host>/api/v3`). توکن فقط
در همان فراخوانی از محیط خوانده می‌شود و در نتیجه یا Journal نمی‌آید. کدهای تازه:
`PROTECTED_BRANCH`، `CONFIRM_REQUIRED`، `NOTHING_TO_COMMIT`، `MISSING_IDENTITY`،
`NOTHING_TO_STASH`، `PR_UNAVAILABLE`، `NOT_GITHUB_REMOTE`، `PR_NOT_FOUND`، `PR_FAILED`.

### خواندن وب (فاز ۴۰)

یک ابزار `fetch` با پارامترهای مرجع (`url`, `maxLength`, `startIndex`, `raw`) و سه
افزودهٔ عمدی (`respectRobots`, `allowPrivate` + سقف‌ها و بدون هیچ اعتبارنامه‌ای):

```json
{ "url": "https://vitejs.dev/guide/", "maxLength": 5000, "startIndex": 0,
  "raw": false, "respectRobots": true, "allowPrivate": false }
```

خروجی: Markdown (سرتیتر/لینک مطلق/لیست/کد/جدول/نقل‌قول)، `title`، `status`،
`contentType`، `redirects`، `totalChars`/`truncated`/`nextStartIndex`، و `robots`
(وضعیت + قاعدهٔ تصمیم). `text/html` تبدیل می‌شود؛ `application/json` و `text/*`
دست‌نخورده؛ بقیه فقط متادیتا. محدودیت‌ها: ۱۰ ثانیه در هر درخواست، حداکثر ۵ ریدایرکت،
۲ مگابایت خواندن از شبکه (قطع stream در سقف)، ۱۰۰٬۰۰۰ کاراکتر بازگشتی.

نکات امنیتی (تفاوت عمدی با مرجع): آدرس‌های loopback/private/link-local/CGNAT
به‌صورت پیش‌فرض رد می‌شوند (`BLOCKED_PRIVATE_ADDRESS`) — بررسی روی IP *حل‌شده* و روی
**هر hop ریدایرکت** انجام می‌شود؛ `allowPrivate: true` برای عبور آگاهانه (و در خروجی
`privateAllowed: true` گزارش می‌شود). robots.txt پیش‌فرض رعایت می‌شود (کش ۱۰ دقیقه‌ای
برای هر میزبان؛ ۴۰۱/۴۰۳ و robots غیرقابل‌خواندن → امتناع)، `respectRobots: false` برای
عبور آگاهانه. هیچ هدر احراز هویتی ارسال نمی‌شود (فقط User-Agent خودمان و `Accept`).
کدها: `INVALID_URL`, `BLOCKED_PROTOCOL`, `BLOCKED_PRIVATE_ADDRESS`, `DNS_FAILED`,
`ROBOTS_FORBIDDEN`, `ROBOTS_UNAVAILABLE`, `TIMEOUT`, `TOO_MANY_REDIRECTS`,
`TOO_LARGE`, `HTTP_ERROR`.

### Journal (فاز ۳۷)

هر اجرای ابزار و هر گذار plan/step به‌صورت خودکار در
`<project-root>/.ai-runtime/journal/YYYY-MM-DD.jsonl` ثبت می‌شود — یک خط JSON به‌ازای
هر کنش، با آرگومان‌ها، خلاصه، فایل‌های نوشته‌شده (path/bytes/sha256)، مدت، نتیجه و
`taskId`/`agentId`/`planId`/`planStepId`. نقطهٔ اتصال یکی است: `AgentRuntime` ابزارها
را پیش از تحویل به `generateText`/`streamText` می‌پیچد، پس ابزارهای local، MCP و
`delegate_task` همه پوشش داده می‌شوند و ابزار جدید هیچ کدی برای Journal نیاز ندارد.

```jsonc
// config (OrchestratorConfigSchema)
"journal": {
  "enabled": true,            // HOTL_JOURNAL=0 برای خاموش‌کردن در یک پروسه
  "includeResults": "summary",// none | summary | full  (HOTL_JOURNAL_RESULTS)
  "maxEntryBytes": 8192,      // سقف هر خط؛ بزرگ‌تر → خلاصه + preview
  "retentionDays": 30         // rotation روزانه + هرس فایل‌های قدیمی
}
```

```bash
human-out-of-the-loop journal --failed --since 24h
human-out-of-the-loop journal --tool write_file --json
human-out-of-the-loop journal --stats
```

redaction دوطرفه است: هم با نام کلید (`apiKey`, `token`, …) و هم با مقادیر واقعی
رازهای همین پروسه. تفاوت با `observability.jsonl`: آن لاگ **آرگومان/نتیجهٔ ابزار را
ذخیره نمی‌کند**؛ Journal همان ترنسکریپت است.

### بلوک ENVIRONMENT (فاز ۳۶)

System prompt هر Agent و بلوک `PROJECT CONTEXT` پلنر با یک لیست کوتاه از واقعیت‌های
ماشین پر می‌شود (`src/ai/environment-context.ts`) تا مدل دستور/مسیر را حدس نزند:

```text
ENVIRONMENT (the machine this runtime runs on — commands and paths must match it):
- platform: linux — Debian GNU/Linux 12 (x64), node v22.22.3
- default shell: /bin/bash (POSIX sh syntax)
- path separator: "/" — build paths with node:path (path.join('src', 'index.ts') → 'src/index.ts'); a hard-coded "\" only works on Windows and a hard-coded "/" only on POSIX
- line endings: LF is normal here; do not rewrite a file's endings just because they differ
- POSIX commands (ls, cat, grep, sed, chmod, rm -rf) are available; Windows commands (dir, type, findstr, copy) are not
- GNU userland (grep -P, sed -i, find -printf) is available; the filesystem is case-sensitive
```

روی macOS همین بلوک `BSD userland` و `sed -i ''` و NFD را یادآوری می‌کند و روی
ویندوز `cmd/PowerShell`، `dir/type/findstr`، خط‌پایان CRLF و نام‌های رزرو
(`CON`, `NUL`, …) را. `collectEnvironmentFacts(env, platform)` تزریق‌پذیر است، پس
هر سه شاخه از یک CI لینوکسی تست می‌شوند.

### نمونه‌ها

**`registry/personas/coder.json`:**
```json
{
  "id": "coder",
  "name": "Coder",
  "system": "You are a skilled software engineer...",
  "allowedTools": [
    "read_file", "write_file", "edit_file", "read_multiple_files",
    "write_multiple_files", "list_directory", "directory_tree", "move_file",
    "get_file_info", "create_directory", "search_code", "search_files",
    "list_allowed_directories", "git_status",
    "read_media_file", "list_directory_with_sizes"
  ],
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
  "tools": [
    "read_file", "read_multiple_files", "write_multiple_files", "edit_file",
    "write_file", "move_file", "create_directory", "list_directory",
    "directory_tree", "get_file_info", "search_code", "search_files",
    "list_allowed_directories", "read_media_file", "list_directory_with_sizes"
  ],
  "priority": 60,
  "description": "Reads, writes, edits, moves and searches files"
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
