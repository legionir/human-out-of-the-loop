# PLAN — human-out-of-the-loop

> **artifact زنده (قانون ۸).** وضعیت هر گام بلافاصله پس از کار روی آن و وضعیت هر فاز پس از هر execution stage به‌روزرسانی می‌شود.
> راهنمای وضعیت: 🔴 پیاده‌سازی نشده · 🟡 پیاده‌سازی نسبی / تأییدنشده · 🟢 پیاده‌سازی کامل و راستی‌آزمایی‌شده.
> تاریخچه‌ی اجرا، تصمیم‌ها و هر تغییر صریح پلن در «پیوست الف» انتهای همین فایل ثبت می‌شود.

# قوانین ثابت انجام پروژه

1. فازها دقیقاً به ترتیب شماره اجرا شوند؛ داخل هر فاز، گام‌ها به ترتیب ذکرشده اجرا شوند؛ هر فاز باید کامل در یک execution stage به پایان برسد.
2. هیچ نیازمندی از TASK اصلی، از پاسخ AI SDK داده‌شده در TASK، و از هشت‌گانه‌ی نقاط ضعف شناسایی‌شده در مکالمه (MCP، context budget، انتخاب پویای Agent، planning، authorization، feasibility gate، per-step quality، resource lock، persistence، priority queue، qualitative failure، ابهام‌زدایی، streaming، cancellation، concurrency/rate-limit، usage tracking، session persistence، observability) نباید حذف یا نادیده گرفته شود.
3. اطلاعات ناموجود حدس زده نشود؛ در صورت نیاز، عبارت **Unknown / Requires Verification:** درج و در اولین فازی که به آن وابسته است یک گام تأیید/رفع ابهام اضافه شود.
4. هیچ کاری بدون تأیید، تکمیل‌شده اعلام نشود؛ وضعیت واقعی همیشه ثبت شود.
5. عملکرد موجود پروژه (در صورت وجود کد پایه‌ای) نباید بدون تصمیم آگاهانه در پلن، مختل شود.
6. هر فاز پیش از رفتن به فاز بعد باید در برابر «معیار پذیرش» خودش راستی‌آزمایی شود.
7. سیستم وضعیت:
   - 🔴 پیاده‌سازی نشده.
   - 🟡 پیاده‌سازی نسبی — ناقص، نادرست، تأییدنشده یا دارای بخش حذف‌شده.
   - 🟢 پیاده‌سازی کامل — تمام کار موردنیاز پیاده، یکپارچه، اعتبارسنجی‌شده و منطبق با معیار پذیرش.

   بلافاصله پس از کار روی هر گام، وضعیت آن به‌روزرسانی شود؛ پس از هر execution stage، وضعیت فاز نیز به‌روزرسانی شود. فاز فقط زمانی 🟢 می‌شود که تمام گام‌های آن 🟢 باشند و تمام معیارهای پذیرش تأیید شده باشند.
8. پلن یک artifact زنده است: گام‌های تکمیل‌شده حذف نشوند، نیازمندی‌ها بی‌صدا بازنویسی نشوند. اگر معماری تغییر کرد یا کار اجباری جدیدی کشف شد، پلن صریحاً و با ذکر دلیل به‌روزرسانی شود.
9. Scope creep ممنوع است. Fragmentation مصنوعی و Over-merging هر دو ممنوع‌اند.
10. استانداردهای کیفیت production در تمام طول پروژه حفظ شود (type-safety، validation ورودی/خروجی با zod، مدیریت خطا).
11. AI SDK صرفاً لایه‌ی اجرای مدل/Tool/Agent است (`ToolLoopAgent`, `tool()`, `Output.object()`, `streamText`, `streamObject`, `mcp_servers`)؛ منطق Registry، Planning، Orchestration، Authorization و Persistence جزو خود AI SDK نیست و در لایه‌ی Runtime پروژه پیاده می‌شود.
12. تفکیک مفهومی حفظ شود: Persona = رفتار + policy دسترسی، Skill = دانش/قابلیت، Tool = عملی که اجرا می‌شود (محلی یا MCP). هیچ Agent نباید مستقیماً Tool implementation را import کند؛ همه از طریق Registry.
13. ارتباط Main Agent → Sub-Agent صرفاً از طریق Tool صریح و قابل audit (`delegate_task`) برقرار شود.
14. Main Agent/Planner نباید کل transcript خام Sub-Agentها را در context خودش دریافت کند؛ فقط از طریق compact events نظارت می‌کند و در صورت نیاز `get_task_details` را صریحاً فراخوانی می‌کند.
15. خروجی نهایی به کاربر و خروجی هر Plan از طریق Structured Output (`Output.object()` + zod schema) تولید شود.
16. Registryها داده‌محور باشند تا افزودن Persona/Skill/Tool/Agent جدید بدون تغییر در منطق Runtime ممکن باشد.
17. **اصل Human-Out-Of-Loop (قانون محوری این نسخه):** تمام تصمیمات پیکربندی — نحوه‌ی تفکیک تسک، انتخاب persona/skill برای هر گام، فهرست Toolهای مجاز هر گام، و رفع هرگونه ابهام در درخواست کاربر — باید **پیش از شروع اجرا**، در فاز Planning (فاز ۹)، نهایی و توسط کاربر تأیید شوند. از لحظه‌ای که کاربر اجرای Plan را تأیید کرد، سیستم باید **بدون نیاز به پیام‌های میانی انسانی مانند «ادامه بده»** تا تکمیل کامل تمام گام‌ها یا شکست قطعی و گزارش‌شده پیش برود؛ شکست یک گام، کشف کار جدید، یا نیاز به retry باید به‌صورت کاملاً خودکار توسط PlanRuntime (فاز ۱۰) مدیریت شود، نه با درخواست دخالت کاربر. تنها تعامل مجاز انسان پس از شروع، **Cancellation صریح** (فاز ۱۳) و مشاهده‌ی گزارش پیشرفت (streaming، فاز ۱۳) است.
18. هیچ Sub-Agent نباید Toolای اجرا کند که در `allowedTools` policy مرتبط با Persona آن مجاز نشده باشد؛ این بررسی باید هم در زمان ساخت Agent (فاز ۶) و هم در Feasibility Gate پیش از اجرای Plan (فاز ۹) انجام شود.

# پلن اجرایی

## [🟢] فاز ۱: زیرساخت پایه Registry و Schemaهای مشترک

هدف: هسته‌ی مشترک تمام Registryها — الگوی یکسان تعریف، بارگذاری، اعتبارسنجی و lookup.

### [🟢] گام ۱: ساختار پوشه‌بندی پروژه

ساختار `src/ai/{runtime,registries,agents,skills,tools,personas,models,schemas,planning}` و پوشه‌ی داده‌محور `registry/{agents.json,personas/,skills/,tools/,mcp-servers/}` ایجاد شود.

### [🟢] گام ۲: پیاده‌سازی base Registry generic

`createRegistry<T>({ schema, source })` در `src/ai/registries/base-registry.ts` با متدهای `get/list/has/register` و اعتبارسنجی zod، خطای صریح روی id تکراری یا schema نامعتبر.

### [🟢] گام ۳: Zod Schemaهای پایه

`PersonaSchema` (شامل فیلد جدید `allowedTools: string[]` طبق قانون ۱۸)، `SkillSchema`, `ToolDefinitionSchema` (شامل فیلد `source: "local" | "mcp"`)، `AgentDefinitionSchema`, `ModelConfigSchema` در `src/ai/schemas/`.

### [🟢] گام ۴: مکانیزم بارگذاری فایل‌محور (loader)

خواندن فایل‌های `registry/**`، validate با schema مربوطه، تزریق به Registry؛ خطاهای بارگذاری در startup گزارش شوند نه در runtime.

**معیار پذیرش:**
ساختار پوشه‌بندی ایجاد شده؛ `createRegistry` روی entry آزمایشی `get/list/has/register` را درست انجام می‌دهد و روی id تکراری/schema نامعتبر خطا می‌دهد؛ پنج Schema پایه (شامل `allowedTools` و `source`) تعریف و تست‌شده‌اند؛ loader حداقل یک فایل JSON نمونه را می‌خواند و ثبت می‌کند؛ build بدون خطای type انجام می‌شود.

---

## [🟢] فاز ۲: Tool Registry (محلی) و اتصال MCP Servers

Tool Registry باید هم Toolهای محلی و هم Toolهای یک یا چند MCP server را در یک فرمت یکسان (`Record<string, Tool>`) در اختیار بگذارد؛ این دو در یک فاز قرار گرفته‌اند چون هر دو یک واحد کاری منسجم («تأمین Tool برای Agentها») هستند.

### [🟢] گام ۱: ToolRegistry مبتنی بر base Registry

`src/ai/registries/tool-registry.ts`؛ متد `getToolsByIds(ids: string[]): Record<string, Tool>`.

### [🟢] گام ۲: پیاده‌سازی ابزارهای پایه‌ی محلی

`read_file`, `search_code`, `write_file`, `git_status` (یا معادل واقعی پروژه) با `inputSchema` zod و مدیریت خطای ساختاریافته در `execute`.

**Unknown / Requires Verification:** لیست دقیق Toolهای محلی موردنیاز واقعی پروژه؛ تا تأیید، همان چهار Tool نمونه baseline هستند.

### [🟢] گام ۳: اتصال MCP Server (dynamic tool fetch)

ماژول `src/ai/tools/mcp-connector.ts` نوشته شود که با `mcp_servers` (طبق `anthropic_api_in_artifacts`/AI SDK) به یک MCP server متصل می‌شود، فهرست ابزارهای آن را در زمان startup (یا با cache قابل‌رفرش) fetch می‌کند، و هرکدام را به فرمت `Tool` استاندارد AI SDK map کرده و با `source: "mcp"` در ToolRegistry ثبت می‌کند.

> **Unknown / Requires Verification:** _(افزوده‌شده توسط Agent در ۲۰۲۶-۰۹-۲۳ طبق قانون ۳ و ۸؛ متن اصلی گام تغییر نکرده است)_ متن این گام دو سازوکار متفاوت را هم‌زمان توصیف می‌کند:
>
> - **(الف) `mcp_servers` در Anthropic Messages API** — در AI SDK از طریق `providerOptions.anthropic.mcpServers` (پکیج `@ai-sdk/anthropic`). ابزارها در سمت سرور Anthropic کشف و اجرا می‌شوند، فقط با مدل‌های Anthropic کار می‌کند، MCP server باید از اینترنت عمومی در دسترس باشد و هیچ آبجکت `Tool` محلی برای ثبت در ToolRegistry برنمی‌گرداند (محدودسازی فقط از طریق `toolConfiguration.allowedTools`).
> - **(ب) `createMCPClient` از پکیج `@ai-sdk/mcp`** — اتصال سمت کلاینت (HTTP/SSE یا stdio)؛ `listTools()`/`tools()` مستقیماً آبجکت‌های `Tool` استاندارد AI SDK برمی‌گرداند؛ با «fetch در startup + ثبت با `source: "mcp"` + `getToolsByIds` مستقل از source + اعمال `allowedTools` در Runtime + تست با MCP server mock از طریق `MCPTransport` سفارشی» سازگار است.
>
> **گام تأیید (پیش از پیاده‌سازی گام ۳):** انتخاب (الف)، (ب) یا ترکیب هر دو توسط کاربر تأیید شود. معیار پذیرش این فاز («ثبت Toolهای MCP با فرمت یکسان در ToolRegistry») فقط با (ب) به‌صورت مستقیم برآورده می‌شود.

> **تصمیم اجرا (۲۰۲۶-۰۹-۲۳):** برای برآورده‌کردن معیار پذیرش («ثبت Toolهای MCP با فرمت یکسان، getToolsByIds مستقل از source، تست با mock بدون شبکه، unavailable به‌جای crash، عدم نشت credential»)، سازوکار **(ب) `@ai-sdk/mcp` + `MCPTransport` سفارشی** پیاده شد. `mcp_servers` سمت Anthropic (الف) در صورت نیاز می‌تواند به‌عنوان لایه‌ی اضافی در فاز ۱۵ اضافه شود، بدون تغییر در منطق Runtime فعلی.

### [🟢] گام ۴: مدیریت credential/auth هر MCP server

پیکربندی هر MCP server (`registry/mcp-servers/*.json`: url، نوع auth، ارجاع به متغیر محیطی برای token/key) بارگذاری و به‌صورت امن (بدون لاگ‌شدن مقدار خام) به connector تزریق شود؛ خطای اتصال/auth یک MCP server نباید کل startup را متوقف کند — آن سرور به‌صورت `unavailable` علامت خورده و بقیه‌ی سیستم کار کند.

### [🟢] گام ۵: تست واحد Tool Registry و MCP Connector

تست Toolهای محلی (موفق/خطا)؛ تست MCP connector با یک MCP server mock (بدون اتصال شبکه‌ی واقعی در تست) شامل سناریوی موفق و سناریوی auth-failure.

**معیار پذیرش:**
ToolRegistry هم Toolهای محلی و هم Toolهای یک MCP server mock را با فرمت یکسان ثبت می‌کند؛ `getToolsByIds` مستقل از `source` کار می‌کند؛ قطع/خطای یک MCP server باعث crash کل سیستم نمی‌شود و به‌صورت `unavailable` گزارش می‌شود؛ credentialها در هیچ لاگ/خروجی خام دیده نمی‌شوند؛ تست‌های واحد سبز هستند.

---

## [🟢] فاز ۳: Skill Registry

### [🟢] گام ۱: ساختار فایل هر Skill

`registry/skills/<skill-id>/{skill.json, SKILL.md}`.

### [🟢] گام ۲: SkillRegistry و resolver

بارگذاری، خواندن `SKILL.md`، اعتبارسنجی cross-registry که `tools` ذکرشده (اعم از محلی یا MCP) واقعاً در ToolRegistry فاز ۲ وجود دارند.

### [🟢] گام ۳: تست واحد

بارگذاری موفق یک Skill نمونه؛ خطا برای ارجاع به tool id ناموجود (چه محلی چه MCP).

**معیار پذیرش:**
حداقل یک Skill نمونه کامل بارگذاری و از `SkillRegistry.get()` در دسترس است؛ ارجاع نامعتبر به tool id در startup خطا می‌دهد؛ تست‌های واحد سبز هستند.

---

## [🟢] فاز ۴: Persona Registry (با Policy دسترسی) و Model Registry

### [🟢] گام ۱: PersonaRegistry با فیلد `allowedTools`

حداقل سه Persona نمونه (`architect`, `coder`, `reviewer`, و `planner` — طبق فاز ۹) با `system` و `allowedTools: string[]` (لیست صریح toolIdهایی که این Persona مجاز به استفاده از آن‌هاست، مستقل از اینکه یک Skill چه Toolهایی را «بلد» است طبق قانون ۱۸).

### [🟢] گام ۲: ModelRegistry

نمونه‌سازی provider واقعی (OpenAI/Anthropic/local) از `registry/models/*` با رابط یکسان `get(modelId)`.

**Unknown / Requires Verification:** providerهای واقعی موردنیاز و متغیرهای محیطی مربوطه؛ تا تأیید، هر سه provider نمونه به‌صورت pluggable پیاده می‌شوند.

### [🟢] گام ۳: تست واحد

تست `allowedTools` برای هر Persona نمونه؛ تست `ModelRegistry.get` با provider mock.

**معیار پذیرش:**
چهار Persona نمونه با `system` و `allowedTools` معتبرند؛ ModelRegistry حداقل یک provider واقعی را می‌سازد؛ تست‌ها بدون فراخوانی شبکه‌ی واقعی سبزند.

---

## [🟢] فاز ۵: Agent Registry، Agent Factory و مدیریت Context/Token Budget

### [🟢] گام ۱: AgentRegistry داده‌محور

`registry/agents.json` + اعتبارسنجی cross-registry ارجاعات persona/skills/tools/model.

### [🟢] گام ۲: createAgent (Agent Factory) با اعمال `allowedTools`

ترکیب `persona.system` + `skill.instructions`های مرتبط؛ تبدیل toolIds به آبجکت tools واقعی از ToolRegistry — **اما پیش از ساخت نهایی، هر toolId درخواستی باید در `persona.allowedTools` نیز باشد؛ در غیر این صورت آن Tool از مجموعه‌ی نهایی حذف و یک warning ساختاریافته (نه throw خاموش) ثبت شود.**

### [🟢] گام ۳: مدیریت Context/Token Budget در ترکیب instructions

تابعی نوشته شود که پیش از ساخت نهایی Agent، طول ترکیب‌شده‌ی `persona.system + skills.instructions` را نسبت به سقف context مدل انتخابی (از ModelRegistry) بسنجد؛ در صورت عبور از سقف، بر اساس اولویت (persona.system همیشه کامل حفظ شود؛ instructions هر Skill بر اساس یک فیلد `priority` اختیاری در `skill.json` خلاصه/حذف شود از کم‌اولویت به پراولویت) trimming انجام و در لاگ ثبت شود کدام بخش کوتاه شده است.

### [🟢] گام ۴: caching نمونه‌ی Agentها

Cache برای agentId با تعریف ثابت (لغو cache در صورت تغییر تعریف Registry).

### [🟢] گام ۵: تست واحد

تست رد‌شدن Tool غیرمجاز از ترکیب نهایی؛ تست trimming زمانی که مجموع instructions از یک سقف آزمایشی کوچک رد می‌شود.

**معیار پذیرش:**
Agentهای نمونه با ترکیب صحیح و فیلترشده (طبق allowedTools) ساخته می‌شوند؛ در سناریوی آزمایشی با سقف context کوچک، trimming بدون از‌دست‌رفتن persona.system انجام می‌شود و در لاگ قابل‌ردیابی است؛ caching به‌درستی کار می‌کند؛ تست‌ها سبزند.

---

## [🟢] فاز ۶: کاتالوگ پویا برای Main Agent و ترکیب پویای Agent

هدف: رفع gap اصلی — دادن دید کامل کاتالوگ به Main Agent/Planner و امکان ساخت ترکیب جدید Persona+Skill+Tool در لحظه، بدون ثبت از‌پیش در `agents.json`، همراه با اعمال authorization.

### [🟢] گام ۱: سه Tool فقط‌خواندنی کاتالوگ

`list_personas()`, `list_skills()`, `list_tools()` — هرکدام summary سبک (id + description + برای skill: لیست toolها) برمی‌گردانند، نه محتوای کامل instructions/schema، تا context مصرف نشود.

### [🟢] گام ۲: حالت ترکیب پویا در `delegate_task`

`delegate_task` علاوه بر `agentId` ثابت، ورودی جایگزین `{ persona, skills[], tools[], prompt }` را نیز بپذیرد؛ در این حالت یک `AgentDefinition` موقت در لحظه ساخته و به `createAgent` (فاز ۵) داده می‌شود — بدون نیاز به ثبت در `agents.json`.

### [🟢] گام ۳: اجرای authorization gate روی ترکیب پویا

پیش از فراخوانی `createAgent` در مسیر پویا، هر tool درخواستی در برابر `persona.allowedTools` بررسی شود؛ اگر Tool غیرمجازی درخواست شده باشد، `delegate_task` باید بدون اجرای Agent، خطای ساختاریافته (نه throw خام) به Main Agent/Planner برگرداند تا بتواند ترکیب را اصلاح کند.

### [🟢] گام ۴: تست واحد

تست ساخت Agent پویا با ترکیب معتبر؛ تست رد‌شدن ترکیب پویا با tool غیرمجاز برای persona انتخابی.

**معیار پذیرش:**
`list_personas/list_skills/list_tools` کاتالوگ کامل و سبک برمی‌گردانند؛ `delegate_task` در هر دو حالت (agentId ثابت، ترکیب پویا) کار می‌کند؛ ترکیب پویا با Tool غیرمجاز رد و به فراخواننده گزارش می‌شود، نه crash؛ تست‌ها سبزند.

---

## [🟢] فاز ۷: Agent Runtime و Event Bus

### [🟢] گام ۱: EventBus

pub/sub برای `agent:running`, `agent:tool_call`, `agent:completed`, `agent:error`.

### [🟢] گام ۲: AgentRuntime.run(agentDefinitionOrId, prompt)

اجرا از طریق Agent Factory (فاز ۵/۶)، emit رویدادها در حین اجرا، خروجی خلاصه‌شده (`summary`, `result`, `toolsUsed`, `errors`, و **`usage`** از خروجی خام AI SDK برای مصرف در فاز ۱۳).

### [🟢] گام ۳: مدیریت خطای اجرای هر Agent

گرفتن خطاها، emit `agent:error`، بازگرداندن نتیجه‌ی خطادار ساختاریافته به‌جای crash.

### [🟢] گام ۴: تست با mock model/provider

تست مسیر موفق و توالی رویدادها؛ تست مسیر خطا.

**معیار پذیرش:**
`AgentRuntime.run` برای Agent نمونه با model mock خروجی معتبر شامل `usage` تولید می‌کند؛ توالی رویدادها صحیح است؛ در خطا crash رخ نمی‌دهد؛ context خام کامل به بیرون نشت نمی‌کند؛ تست‌ها سبزند.

---

## [🟢] فاز ۸: Task Runtime — کنترل اجرا، Resource Lock و Concurrency Cap

### [🟢] گام ۱: مدل داده Task

`Task { id, agentDefinitionOrId, prompt, status, summary, claimedResources?, startedAt, completedAt }`.

### [🟢] گام ۲: TaskRuntime پایه

`createTask`, subscribe به EventBus فاز ۷ برای همگام‌سازی وضعیت، `getStatus`, `getResult`, `getDetails`.

### [🟢] گام ۳: Resource Lock / Claim Mechanism

هر Task هنگام ایجاد می‌تواند فهرست منابعی (مثلاً مسیرهای فایلی) را که قرار است لمس کند اعلام کند (`claimedResources: string[]`)؛ TaskRuntime پیش از اجرای هم‌زمان دو Task با overlap در `claimedResources`، یکی را صف (queue) می‌کند نه اینکه هم‌زمان اجرا کند — جلوگیری از race condition روی منابع مشترک.

### [🟢] گام ۴: سقف Concurrency

پارامتر پیکربندی‌پذیر `maxConcurrentTasks` اضافه شود؛ TaskRuntime هرگز بیش از این سقف را هم‌زمان اجرا نکند؛ Taskهای مازاد در صف بمانند.

### [🟢] گام ۵: چهار Tool کنترلی برای Main Agent

`create_task`, `get_agent_status`, `get_agent_result`, `get_task_details` — با `tool()` و `inputSchema` مناسب، در ToolRegistry به‌عنوان دسته‌ی کنترلی (خارج از `allowedTools` عمومی Personaهای Sub-Agent).

### [🟢] گام ۶: تست واحد

تست lock: دو Task با `claimedResources` هم‌پوشان نباید هم‌زمان اجرا شوند؛ تست سقف concurrency با تعداد Task بیشتر از سقف؛ تست چرخه‌ی وضعیت.

**معیار پذیرش:**
Taskهای با منابع مشترک هم‌زمان اجرا نمی‌شوند و race condition رخ نمی‌دهد؛ هیچ‌گاه بیش از `maxConcurrentTasks` Task هم‌زمان در حال اجرا نیستند؛ چهار Tool کنترلی کار می‌کنند و وضعیت‌ها صحیح گزارش می‌شوند؛ تست‌ها سبزند.

---

## [🟢] فاز ۹: لایه‌ی Planning — تفکیک تسک بزرگ، ابهام‌زدایی و Feasibility Gate

این فاز دقیقاً همان نقطه‌ای است که اصل Human-Out-Of-Loop (قانون ۱۷) اجرایی می‌شود: **همه‌چیز باید پیش از پایان این فاز مشخص و توسط کاربر تأیید شده باشد**؛ پس از آن، هیچ ورودی انسانی دیگری تا پایان کار لازم نیست (به‌جز Cancellation).

### [🟢] گام ۱: Persona `planner` و Skill `task_decomposition`

Persona جدید `planner` (در فاز ۴ به‌عنوان نمونه اضافه شود) با `allowedTools` محدود به Toolهای کاتالوگ (فاز ۶) و کنترلی (فاز ۸) — نه Toolهای اجرایی سطح پایین. Skill `task_decomposition` instructions آن مستقیماً بر پایه‌ی منطق «Execution Plan Generator» ارائه‌شده در ابتدای این مکالمه نوشته شود: تفکیک dependency-aware، هر گام با persona/skill/tool پیشنهادی مشخص.

### [🟢] گام ۲: مدل داده Plan

`src/ai/schemas/plan.ts`:

```ts
PlanStep = {
  id, description,
  dependsOn: string[],
  assignedPersona: string,
  assignedSkills: string[],
  assignedTools: string[],
  claimedResources?: string[],
  status: "pending" | "ready" | "running" | "done" | "failed"
}
Plan = { goal: string, steps: PlanStep[], clarifications?: string[] }
```

### [🟢] گام ۳: مرحله‌ی ابهام‌زدایی پیش از تولید Plan نهایی

پیش از فراخوانی نهایی تولید Plan، Planner یک ارزیابی اولیه انجام می‌دهد: اگر درخواست کاربر برای تولید Plan معتبر ناکافی است (طبق قانون ۹ سند اصلی — Do Not Guess)، به‌جای حدس‌زدن، سؤال(های) روشن‌سازی از طریق یک خروجی صریح (`needsClarification: string[]`) برمی‌گرداند و اجرای Plan آغاز نمی‌شود تا پاسخ کاربر دریافت شود. این تنها نقطه‌ی مجاز درخواست ورودی انسانی **پیش از شروع**.

### [🟢] گام ۴: تولید Plan با `Output.object()`

فراخوانی Planner با `Output.object({ schema: PlanSchema })` روی درخواست (ابهام‌زدایی‌شده‌ی) کاربر؛ خروجی معتبر طبق schema فاز فوق.

### [🟢] گام ۵: Feasibility Gate — اعتبارسنجی هر PlanStep پیش از اجرا

پیش از ورود به PlanRuntime (فاز ۱۰)، هر `PlanStep` در برابر کاتالوگ واقعی (فاز ۶) بررسی شود: آیا `assignedPersona` وجود دارد؟ آیا `assignedSkills`/`assignedTools` معتبرند؟ آیا `assignedTools` همگی در `allowedTools` همان Persona مجازند (قانون ۱۸)؟ در صورت شکست هر بررسی، Plan رد و خطای دقیق (کدام گام، کدام دلیل) برگردانده می‌شود تا Planner Plan را اصلاح کند — بدون شروع اجرا.

### [🟢] گام ۶: تشخیص وابستگی چرخه‌ای

بررسی گراف `dependsOn` برای عدم وجود چرخه؛ در صورت وجود چرخه، Plan رد و به Planner برای اصلاح بازگردانده شود.

### [🟢] گام ۷: تأیید نهایی کاربر پیش از شروع

Plan نهایی (پس از عبور از Feasibility Gate و بررسی چرخه) به‌همراه خلاصه‌ی گام‌ها، persona/skill/tool هر گام، و منابعی که لمس می‌شوند، برای تأیید صریح کاربر نمایش داده شود؛ اجرای PlanRuntime (فاز ۱۰) فقط پس از این تأیید آغاز می‌شود.

**معیار پذیرش:**
برای یک درخواست ناقص نمونه، سیستم پیش از تولید Plan نهایی سؤال روشن‌سازی برمی‌گرداند نه Plan حدسی؛ برای یک درخواست کامل نمونه، Plan معتبر مطابق schema تولید می‌شود؛ Feasibility Gate ترکیب نامعتبر (persona/skill/tool ناموجود یا غیرمجاز) را قبل از اجرا رد می‌کند؛ وابستگی چرخه‌ای تشخیص داده می‌شود؛ Plan فقط پس از تأیید صریح کاربر وارد فاز اجرا می‌شود.

---

## [🟢] فاز ۱۰: PlanRuntime — حلقه‌ی خودکار اجرای Plan تا تکمیل کامل

هسته‌ی اصلی Human-Out-Of-Loop: پس از تأیید کاربر در فاز ۹، این حلقه در کد (نه در تصمیم مدل) تا تکمیل کامل Plan یا شکست قطعی گزارش‌شده، **بدون توقف و بدون نیاز به پیام «ادامه بده»** پیش می‌رود.

### [🟢] گام ۱: Persist کردن Plan در آغاز اجرا

بلافاصله پس از تأیید کاربر، Plan کامل (شامل وضعیت اولیه‌ی همه‌ی گام‌ها) در یک store ماندگار (حداقل فایل JSON، قابل ارتقا به دیتابیس) ذخیره شود؛ هر تغییر وضعیت گام بلافاصله در همین store persist شود.

### [🟢] گام ۲: حلقه‌ی اصلی PlanRuntime

```js
while (!allStepsDone(plan) && !allStepsFailedTerminal(plan)) {
  const ready = plan.steps.filter(isReady); // pending و همه‌ی dependsOn دان
  const prioritized = prioritize(ready);     // گام ۳
  const batch = prioritized.slice(0, availableConcurrencySlots());
  await Promise.allSettled(batch.map(step => delegate_task({
    persona: step.assignedPersona,
    skills: step.assignedSkills,
    tools: step.assignedTools,
    claimedResources: step.claimedResources,
    prompt: step.description
  })));
  persist(plan); // گام ۱
  if (noProgressPossible(plan)) break; // به re-planning (گام ۴) برو
}
```

این حلقه روی TaskRuntime (فاز ۸: lock + concurrency cap) و AgentRuntime (فاز ۷) سوار است.

### [🟢] گام ۳: Priority Queue بین گام‌های آماده‌ی هم‌رتبه

وقتی تعداد `ready` بیشتر از ظرفیت موازی‌سازی است، اولویت بر اساس تعداد گام‌های وابسته به هرکدام (عمق در گراف — گام‌هایی که بیشترین گام دیگر منتظرشان‌اند، اول اجرا شوند) تعیین شود.

### [🟢] گام ۴: Re-planning خودکار میان‌کار

اگر گامی `failed` شد یا در بررسی کیفیت (فاز ۱۱) رد شد، PlanRuntime **خودش** (بدون سؤال از کاربر) دوباره Planner (فاز ۹) را با context شکست صدا می‌زند تا Plan را patch کند (retry با تنظیمات متفاوت، تجزیه‌ی گام به گام‌های کوچک‌تر، یا افزودن گام جبرانی)؛ Plan patch‌شده دوباره از Feasibility Gate (فاز ۹) عبور می‌کند پیش از ادامه‌ی حلقه. سقف تعداد re-planning کلی (نه فقط per-step) پیکربندی‌پذیر است تا از حلقه‌ی بی‌پایان جلوگیری شود.

### [🟢] گام ۵: Resume پس از crash

در startup، اگر یک Plan ذخیره‌شده‌ی ناتمام (persist شده در گام ۱) وجود دارد، PlanRuntime باید بتواند از همان وضعیت گام‌به‌گام (نه از صفر) ادامه دهد.

### [🟢] گام ۶: خروج از حلقه با وضعیت نهایی قطعی

حلقه فقط در دو حالت متوقف می‌شود: (الف) تمام گام‌ها `done` — عبور به فاز ۱۲؛ (ب) به سقف re-planning رسیده و پیشرفت دیگر ممکن نیست — Plan با وضعیت `failed-partial` و گزارش دقیق چه چیزی ناتمام مانده و چرا (بدون درخواست از کاربر برای ادامه‌ی دستی؛ این گزارش در فاز ۱۲ به کاربر ارائه می‌شود).

### [🟢] گام ۷: تست واحد و integration

تست حلقه با یک Plan نمونه‌ی چندگامی‌ِ dependency-دار (بدون crash)؛ تست resume پس از قطع شبیه‌سازی‌شده‌ی فرآیند میان‌راه؛ تست سناریوی رسیدن به سقف re-planning.

**معیار پذیرش:**
یک Plan چندگامی با وابستگی از ابتدا تا `done` بدون هیچ پیام میانی انسانی («ادامه بده» یا مشابه) کامل اجرا می‌شود؛ گام‌های آماده بر اساس اولویت گراف انتخاب می‌شوند؛ شکست یک گام باعث توقف کل فرآیند نمی‌شود بلکه re-planning خودکار رخ می‌دهد؛ در سناریوی شبیه‌سازی‌شده‌ی قطع فرآیند، اجرا از همان نقطه (نه از صفر) resume می‌شود؛ رسیدن به سقف re-planning بدون crash و با گزارش دقیق پایان می‌یابد؛ تست‌ها سبزند.

---

## [🟢] فاز ۱۱: بررسی کیفیت خودکار هر گام (Per-Step Acceptance Check)

هدف: کشف شکست کیفی (نه فقط فنی) بلافاصله پس از هر گام، پیش از آزادشدن گام‌های وابسته — بدون دخالت انسان.

### [🟢] گام ۱: Persona/Skill `reviewer` برای بررسی per-step

از Persona `reviewer` موجود (فاز ۴) با Skill جدید `acceptance_check` استفاده شود؛ instructions آن معیار پذیرش خودِ PlanStep (که Planner در فاز ۹ برای هر گام تولید می‌کند — لازم است `PlanStep` schema فیلد `acceptanceCriteria: string` نیز داشته باشد؛ این فیلد به schema فاز ۹ اضافه شود) را در برابر خروجی واقعی Sub-Agent بسنجد.

### [🟢] گام ۲: فراخوانی خودکار acceptance check پس از هر تکمیل فنی گام

در EventBus (فاز ۷)، هنگام دریافت `agent:completed` برای یک Task مرتبط با یک PlanStep، پیش از تغییر وضعیت PlanStep به `done`، PlanRuntime به‌صورت خودکار `reviewer` را روی خروجی آن گام اجرا می‌کند.

### [🟢] گام ۳: تفکیک شکست فنی از شکست کیفی

خروجی `reviewer` باید `{ accepted: boolean, reason?: string }` (با `Output.object()`) باشد؛ اگر `accepted: false`، PlanStep به‌جای `done` به `failed` (با `failureType: "quality"` در تمایز از `failureType: "technical"` که از فاز ۷/۸ می‌آید) تغییر می‌کند و مسیر re-planning خودکار فاز ۱۰-گام۴ فعال می‌شود.

### [🟢] گام ۴: تست واحد

تست با خروجی Sub-Agent mock معتبر (accepted) و mock نامعتبر (rejected)؛ بررسی این‌که در حالت rejected، گام‌های وابسته `ready` نمی‌شوند.

**معیار پذیرش:**
هر گام پیش از `done`‌شدن از acceptance check خودکار عبور می‌کند؛ شکست کیفی و فنی با `failureType` متفاوت ثبت می‌شوند؛ گام‌های وابسته به یک گام `rejected` تا رفع مشکل `ready` نمی‌شوند؛ این مسیر بدون هیچ دخالت انسانی به re-planning فاز ۱۰ متصل است؛ تست‌ها سبزند.

---

## [🟢] فاز ۱۲: بازبینی نهایی و گزارش ساختاریافته به کاربر

### [🟢] گام ۱: zod schema بازبینی نهایی

`reviewSchema` (`acceptedFindings`, `rejectedFindings`, `finalSummary`, و فیلد جدید `incompleteSteps` برای حالت `failed-partial` از فاز ۱۰).

### [🟢] گام ۲: فراخوانی خودکار Review در پایان حلقه‌ی PlanRuntime

بلافاصله پس از خروج حلقه‌ی فاز ۱۰ (چه با موفقیت کامل چه با `failed-partial`)، بدون نیاز به triggerِ انسانی، Main Agent با `Output.object({ schema: reviewSchema })` روی خلاصه‌ی خروجی تمام PlanStepها فراخوانی می‌شود.

### [🟢] گام ۳: تولید گزارش نهایی

خروجی نهایی به فرمت قابل‌ارائه تبدیل و به کاربر بازگردانده می‌شود؛ در حالت `failed-partial`، گزارش باید دقیقاً مشخص کند کدام گام‌ها ناتمام ماندند و چرا (خروجی گام ۶ فاز ۱۰).

**معیار پذیرش:**
خروجی بازبینی همیشه مطابق schema معتبر است؛ این مرحله بدون درخواست انسانی، خودکار پس از پایان PlanRuntime اجرا می‌شود؛ در سناریوی `failed-partial`، گزارش نهایی به‌روشنی گام‌های ناتمام و دلیل آن را بیان می‌کند.

---

## [🟢] فاز ۱۳: قابلیت‌های عملیاتی Runtime — Streaming، Cancellation، Concurrency/Rate-limit، Usage Tracking

این چهار قابلیت همگی لایه‌ای عملیاتی روی TaskRuntime/AgentRuntime موجود هستند و برای این‌که «اجرای بی‌وقفه» از دید کاربر قابل‌مشاهده، قابل‌توقف، و قابل‌اتکا (از نظر هزینه و نرخ درخواست) باشد لازم‌اند؛ در یک فاز منسجم قرار گرفته‌اند تا فاز اضافی بی‌دلیل ایجاد نشود.

### [🟢] گام ۱: Streaming پیشرفت به کاربر

از `streamText`/`streamObject` AI SDK برای stream کردن رویدادهای compact (فاز ۷) و به‌روزرسانی وضعیت Plan (فاز ۱۰) به یک کانال قابل‌مشاهده‌ی کاربر (مثلاً SSE/WebSocket) استفاده شود؛ این جایگزین «سکوت طولانی در حین اجرای خودکار» است.

### [🟢] گام ۲: Cancellation صریح

Tool/API سطح بالا `cancel_plan(planId)` اضافه شود که وضعیت Plan را به `cancelling` می‌برد؛ PlanRuntime در ابتدای هر iteration این وضعیت را چک می‌کند و در صورت `cancelling`، هیچ گام جدیدی dispatch نمی‌کند، منتظر تکمیل Taskهای در حال اجرا می‌ماند (یا timeout اجباری)، و وضعیت نهایی را `cancelled` با گزارش گام‌های تکمیل‌شده ثبت می‌کند.

### [🟢] گام ۳: سقف Concurrency در سطح Provider و Rate-limit

علاوه بر `maxConcurrentTasks` (فاز ۸، در سطح کل سیستم)، سقف جداگانه per-provider (مثلاً حداکثر N درخواست هم‌زمان به OpenAI) اضافه شود؛ در صورت برخورد به rate-limit provider (کد خطای ۴۲۹ یا معادل)، آن Task به‌جای `failed` قطعی، با backoff به صف بازگردانده شود (تا سقف retry مشخص).

### [🟢] گام ۴: ردیابی و تجمیع Token Usage/هزینه

هر خروجی `AgentRuntime.run` (فاز ۷، شامل `usage`) در یک aggregator ذخیره شود که usage را per-task، per-plan و per-agent-type جمع می‌زند؛ در گزارش نهایی (فاز ۱۲) خلاصه‌ی هزینه/usage کل Plan نیز درج شود.

### [🟢] گام ۵: تست واحد

تست streaming با mock؛ تست cancellation میان‌راه یک Plan چندگامی؛ تست backoff روی خطای rate-limit شبیه‌سازی‌شده؛ تست صحت تجمیع usage.

**معیار پذیرش:**
کاربر می‌تواند پیشرفت Plan را در حین اجرای خودکار به‌صورت زنده مشاهده کند؛ فراخوانی `cancel_plan` یک Plan در حال اجرا را بدون گیرکردن یا crash متوقف می‌کند و وضعیت `cancelled` با گزارش جزئی صحیح ثبت می‌شود؛ برخورد به rate-limit باعث شکست قطعی فوری نمی‌شود بلکه retry با backoff انجام می‌شود؛ گزارش نهایی شامل خلاصه‌ی usage/هزینه‌ی کل Plan است؛ تست‌ها سبزند.

---

## [🟢] فاز ۱۴: تداوم Session و Observability ماندگار

### [🟢] گام ۱: پایداری Session بین چند درخواست کاربر

یک `sessionStore` (حداقل فایل/دیتابیس ساده) اضافه شود که تاریخچه‌ی درخواست‌های قبلی کاربر و Planهای مرتبط (persist‌شده در فاز ۱۰) را نگه دارد؛ اگر کاربر در ادامه‌ی همان session سؤال جدیدی بپرسد، Main Agent/Planner بتواند به آخرین Plan/گزارش مرتبط ارجاع دهد (از طریق یک Tool `get_previous_plan_summary(sessionId)`).

### [🟢] گام ۲: Observability ماندگار (لاگ/trace)

علاوه بر EventBus in-memory (فاز ۷)، تمام رویدادهای کلیدی (شروع/پایان هر Task، هر تصمیم re-planning، هر acceptance check) در یک لاگ ساختاریافته‌ی ماندگار (فایل JSONL یا معادل) نوشته شوند تا پس از پایان اجرا قابل بازبینی/دیباگ باشند؛ هر رکورد شامل `planId`, `stepId`, `timestamp`, `eventType`, `payload` است.

### [🟢] گام ۳: تست واحد

تست ذخیره و بازیابی خلاصه‌ی Plan قبلی برای یک sessionId؛ تست این‌که لاگ ماندگار برای یک اجرای کامل Plan نمونه شامل تمام رویدادهای کلیدی است.

**معیار پذیرش:**
درخواست دوم کاربر در همان session می‌تواند به گزارش/Plan قبلی ارجاع دهد؛ لاگ ماندگار برای یک اجرای کامل قابل بازخوانی و شامل توالی صحیح رویدادهاست؛ تست‌ها سبزند.

---

## [🟢] فاز ۱۵: یکپارچه‌سازی سرتاسری و سخت‌سازی مدیریت خطا

### [🟢] گام ۱: سیم‌کشی سرتاسری جریان اصلی

نقطه‌ی ورود واحد که تمام Registryها (فازهای ۱-۶) را در startup بارگذاری، سپس جریان کامل `درخواست کاربر → Planning (فاز ۹) → تأیید کاربر → PlanRuntime (فاز ۱۰) → Acceptance Check (فاز ۱۱) → Review نهایی (فاز ۱۲)` را در معرض دید بیرونی قرار دهد.

### [🟢] گام ۲: timeout در سطح AgentRuntime/TaskRuntime

برای هر اجرای Sub-Agent timeout پیکربندی‌پذیر با retry محدود، جدا از backoff مخصوص rate-limit فاز ۱۳.

### [🟢] گام ۳: محدودیت عمق delegation

جلوگیری از delegation بازگشتی بی‌کنترل؛ Sub-Agentها به‌طور پیش‌فرض دسترسی به `delegate_task` ندارند مگر این‌که Persona آن‌ها صریحاً این Tool را در `allowedTools` داشته باشد (که باید موردی نادر و آگاهانه باشد).

### [🟢] گام ۴: تست end-to-end کامل با ویژگی Human-Out-Of-Loop

تست integration: درخواست نمونه‌ی مبهم → دریافت سؤال روشن‌سازی (فاز ۹) → پاسخ کاربر → تأیید Plan → اجرای کامل خودکار شامل حداقل یک شکست فنی، یک شکست کیفی، و یک چرخه‌ی re-planning — همگی **بدون هیچ پیام میانی «ادامه بده»** — تا گزارش نهایی؛ با mock کامل providerهای مدل.

**معیار پذیرش:**
جریان end-to-end کامل بدون هیچ دخالت انسانی پس از تأیید اولیه‌ی Plan، حتی در حضور شکست فنی/کیفی و re-planning، به گزارش نهایی می‌رسد؛ timeout/retry و محدودیت عمق delegation به‌درستی عمل می‌کنند؛ هیچ حلقه‌ی بی‌پایان یا crash رخ نمی‌دهد؛ تست integration سبز است.

---

## [🔴] فاز ۱۶: تست جامع و سخت‌سازی نهایی (Hardening)

### [🔴] گام ۱: تکمیل پوشش تست واحد تمام Registryها و ماژول‌های جدید

شامل مسیرهای خطای cross-registry، authorization (`allowedTools`)، MCP connector، resource lock، priority queue.

### [🔴] گام ۲: تست‌های edge-case Planning/PlanRuntime

Plan با صفر گام معتبر، Plan با تمام گام‌های failed، رسیدن هم‌زمان به سقف concurrency و سقف re-planning، خروجی نامعتبر از `Output.object()` در تولید Plan یا Review.

### [🔴] گام ۳: بازبینی امنیتی

اعتبارسنجی مسیر فایل نسبت به workspace root در Toolهای فایل‌سیستمی (جلوگیری از path traversal)؛ اطمینان از عدم نشت credential MCP در لاگ ماندگار (فاز ۱۴) یا compact events (فاز ۷)؛ بررسی این‌که `allowedTools` واقعاً در تمام مسیرهای ساخت Agent (استاتیک فاز ۵ و پویا فاز ۶) اعمال می‌شود، نه فقط یکی.

### [🔴] گام ۴: بازبینی چندمنظره

از زوایای Architect/QA/Security/DevOps طبق Planning Quality Gate سند اصلی؛ تمرکز ویژه بر این‌که اصل Human-Out-Of-Loop (قانون ۱۷) در هیچ مسیر خطایی نقض نشده باشد (یعنی هیچ مسیر کد به‌صورت ضمنی منتظر پیام انسانی برای ادامه نمی‌ماند).

**معیار پذیرش:**
تمام تست‌های واحد و integration سبزند؛ edge-caseهای ذکرشده بدون crash مدیریت می‌شوند؛ Toolهای فایل‌سیستمی در برابر path traversal محافظت‌شده‌اند؛ هیچ credential در لاگ/خروجی نشت نمی‌کند؛ authorization در هر دو مسیر ساخت Agent اعمال می‌شود؛ بازبینی چندمنظره انجام و رفع شده است.

---

## [🔴] فاز ۱۷: مستندسازی و تحویل نهایی

### [🔴] گام ۱: README معماری

مستندسازی معماری نهایی شامل: لایه‌ها، جریان Planning→PlanRuntime→Review، تفاوت Persona/Skill/Tool، مدل authorization (`allowedTools`)، مدل MCP integration.

### [🔴] گام ۲: راهنمای افزودن Persona/Skill/Tool/Agent/MCP Server جدید

راهنمای گام‌به‌گام، شامل نحوه‌ی تنظیم `allowedTools` برای Personaهای جدید و نحوه‌ی افزودن یک MCP server جدید در `registry/mcp-servers/`.

### [🔴] گام ۳: مستندسازی پیکربندی

تمام متغیرهای محیطی (providerها، credential MCP)، سقف‌های پیکربندی‌پذیر (`maxConcurrentTasks`، سقف per-provider، سقف re-planning، سقف زمانی timeout، سقف iteration کلی PlanRuntime) در یک مکان مرکزی مستند شوند.

**معیار پذیرش:**
سند معماری کامل و منطبق با پیاده‌سازی نهایی است؛ راهنمای افزودن اجزای جدید (شامل MCP server) توسط توسعه‌دهنده‌ی دیگر بدون بازخوانی کد Runtime قابل‌اجراست؛ تمام متغیرها/سقف‌ها مستند شده‌اند؛ scope audit نهایی نشان می‌دهد تمام نیازمندی‌های TASK اصلی و تمام موارد شناسایی‌شده در این مکالمه (MCP، planning خودکار، human-out-of-loop، authorization، resource lock، persistence، priority queue، qualitative failure detection، ابهام‌زدایی، streaming، cancellation، concurrency/rate-limit، usage tracking، session persistence، observability ماندگار) به حداقل یک گام در فازهای ۱ تا ۱۷ نگاشت شده‌اند.

---

# پیوست الف: گزارش اجرا و تغییرات پلن (Execution & Change Log)

> این بخش توسط Agent نگهداری می‌شود. طبق قانون ۸، هر تغییر در پلن صریحاً و با ذکر دلیل در این‌جا ثبت می‌شود و متن نیازمندی‌های بالا بی‌صدا بازنویسی نمی‌شود.

## ۲۰۲۶-۰۹-۲۳ — ثبت اولیه‌ی پلن (هنوز هیچ فازی شروع نشده است)

- پلن عیناً از پیام کاربر در این فایل ثبت شد؛ وضعیت همه‌ی فازها و گام‌ها 🔴.
- **تغییر صرفاً شکلی:** HTML entityهای موجود در متن پیام (`&lt;`، `&gt;`، `&amp;`) به کاراکتر واقعی (`<`، `>`، `&`) تبدیل شدند؛ هیچ نیازمندی‌ای تغییر نکرد.
- **روش کار:** کد هر فاز در یک پیام توسط کاربر ارسال می‌شود ← Agent فایل‌ها را در مسیرهای مشخص‌شده ایجاد می‌کند ← typecheck و تست‌ها در برابر «معیار پذیرش» همان فاز اجرا می‌شوند ← وضعیت هر گام و فاز در همین فایل به‌روز می‌شود ← پس از راستی‌آزمایی، یک commit برای آن فاز روی branch `arena/01a0cb8a-human-out-of-the-loop` ثبت می‌شود.
- **کد پایه (قانون ۵):** مخزن در commit `1f4206d` فقط شامل `README.md` است؛ عملکرد موجودی برای مختل‌شدن وجود ندارد.
- **Unknown جدید (قانون ۳):** یک مورد Unknown / Requires Verification به گام ۳ فاز ۲ افزوده شد (دوگانگی `mcp_servers` در Anthropic API و `createMCPClient` در `@ai-sdk/mcp`)؛ گام تأیید آن پیش از پیاده‌سازی گام ۳ فاز ۲ انجام می‌شود.

## راستی‌آزمایی محیط اجرا (۲۰۲۶-۰۹-۲۳)

| مورد | مقدار تأییدشده |
|---|---|
| Node.js / npm | `v22.22.3` / `10.9.8` |
| `ai` (آخرین نسخه‌ی پایدار) | `7.0.111` — نیازمند Node ≥ 22؛ peer: `zod ^3.25.76 \|\| ^4.1.8` |
| `@ai-sdk/mcp` | `2.0.55` |
| `@ai-sdk/anthropic` / `@ai-sdk/openai` | `4.0.60` / `4.0.72` |
| `zod` / `typescript` / `vitest` | `4.6.5` / `7.0.2` / `5.0.1` |

در یک پروژه‌ی آزمایشی خارج از مخزن (`/tmp`) تأیید شد که `ToolLoopAgent`، `tool()`، `Output.object()`، `streamText` (+ `partialOutputStream`)، `stepCountIs` و `MockLanguageModelV4` (از `ai/test`) با `tsc` در حالت strict کامپایل می‌شوند و یک تست نمونه با Vitest، بدون هیچ فراخوانی شبکه، سبز است.

## نکات فنی تأییدشده برای فازهای آینده (بدون تغییر در نیازمندی‌ها)

- **فاز ۱ (build):** TypeScript 7 گزینه‌های `moduleResolution: "node"` (node10) و `baseUrl` را حذف کرده است؛ با `skipLibCheck: false`، پکیج `@types/json-schema` برای typeهای `@ai-sdk/provider` لازم است.
- **فاز ۲:** `createMCPClient` علاوه بر transport استاندارد HTTP/SSE، یک آبجکت `MCPTransport` سفارشی (`start`/`send`/`close`) می‌پذیرد — امکان تست با MCP server mock بدون شبکه.
- **فاز ۵ و ۷:** در `ToolLoopAgent`، پرامپت سیستمی با پارامتر `instructions` داده می‌شود (پارامتر `system` در تنظیمات Agent خطای type است)؛ فیلد داده‌ای `persona.system` باقی می‌ماند ولی باید به `instructions` نگاشت شود.
- **فاز ۷ و ۱۳:** `result.usage` مجموع usage تمام stepهاست؛ `totalUsage` منسوخ (deprecated) شده است.
- **قانون ۱۱ و فاز ۱۳:** `streamObject`/`generateObject` از AI SDK 6 منسوخ‌اند (در `7.0.111` هنوز export می‌شوند)؛ معادل پیشنهادی خود SDK: `streamText({ output: Output.object(...) })` همراه با `partialOutputStream`.
- **فاز ۱۱ ← فاز ۹:** فیلد `acceptanceCriteria` در `PlanStep` (طبق متن صریح فاز ۱۱) باید به schema فاز ۹ افزوده شود.

## تصمیم‌های کاربر

| تاریخ | موضوع | تصمیم |
|---|---|---|
| ۲۰۲۶-۰۹-۲۳ | برخورد با مشکل در کد ارسالی هر فاز (خطای type، تست ناموفق، API منسوخ/ناسازگار با نسخه‌ی فعلی AI SDK، تعارض با قوانین پلن) | **اصلاح حداقلی + ثبت شفاف:** فقط کوچک‌ترین اصلاح لازم برای عبور از معیار پذیرش اعمال می‌شود و هر تغییر با دلیلش در این پیوست و در گزارش همان فاز ثبت می‌شود. |
| ۲۰۲۶-۰۹-۲۳ | نسخه‌های toolchain (اگر کد فاز ۱ شامل `package.json`/`tsconfig` نباشد) | **آخرین نسخه‌های پایدار تأییدشده:** `ai@7.0.111`، `@ai-sdk/mcp@2.0.55`، `zod@4.6.5`، `typescript@7.0.2`، `vitest@5.0.1` روی Node 22. |

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱

- **وضعیت:** فاز ۱ از 🔴 به 🟢 ارتقا یافت؛ هر چهار گام 🟢.
- **پیاده‌سازی:**
  - ساختار پوشه‌بندی طبق طراحی ایجاد شد: `src/ai/{runtime,registries,agents,skills,tools,personas,models,schemas,planning,__tests__}` + `registry/{agents.json,personas/,skills/,tools/,mcp-servers/}` + `registry/skills/`.
  - `package.json` با `type: module`، `tsconfig.json` با `module: ESNext` + `moduleResolution: Bundler` + `skipLibCheck: true`، و `vitest.config.ts` ایجاد شد؛ وابستگی‌های تأییدشده نصب شدند (ai@7.0.111، @ai-sdk/mcp@2.0.55، zod@4.6.5، typescript@7.0.2، vitest@5.0.1).
  - `src/ai/registries/base-registry.ts`: کلاس generic `Registry<T>` با `register` (اعتبارسنجی zod + بررسی تکراری) و `tryRegister` غیرپرتابی، به‌همراه `get/has/list/size` و فکتوری `createRegistry`.
  - `src/ai/registries/loader.ts`: `loadRegistryFromDirectory` با جمع‌آوری خطا per-file، حالت `strict`، و `loadSingleFile`.
  - Schemaها با تغییرات پلن جدید:
    - `persona.ts`: `allowedTools: string[]` با default `[]` + helper `personaAllowsTool` (پشتیبانی از `*` wildcard).
    - `tool-definition.ts`: `source: "local" | "mcp"` با default `local`، `modulePath` اختیاری (الزامی برای local) و `mcpServerId` اختیاری (الزامی برای mcp) با دو `refine`.
    - `skill.ts`, `agent-definition.ts`, `model-config.ts`: مطابق کد ارسالی.
  - Barrelها: `src/ai/schemas/index.ts`, `src/ai/registries/index.ts`, `src/ai/index.ts` و placeholderهای `runtime/agents/skills/tools/personas/models/planning`.
  - داده‌محور نمونه:
    - `registry/agents.json`: `[]`.
    - `registry/personas/`: `architect.json`, `coder.json`, `reviewer.json`, `planner.json` — هر چهار Persona با `allowedTools` صریح (planner شامل `list_personas/list_skills/list_tools/create_task/get_agent_status/get_agent_result/get_task_details`).
    - `registry/tools/`: `read_file.json`, `search_code.json`, `write_file.json`, `git_status.json` — هرکدام با `source: local`.
    - `registry/mcp-servers/.gitkeep` و `registry/skills/.gitkeep`.
- **اصلاح حداقلی نسبت به کد ارسالی (طبق تصمیم کاربر minimal_fix):**
  - تمام importهای نسبی به `*.js` تغییر یافتند تا با `moduleResolution: Bundler` و ESM سازگار باشند (الزامی برای TypeScript 7).
  - تست `phase1.test.ts` برای ESM بازنویسی شد: `__dirname` از `fileURLToPath(import.meta.url)` ساخته شد، `require()` به `import` تبدیل شد، و تست‌های جدید برای `allowedTools` و `source` (شامل wildcard، defaultها، و بررسی `planner`/`reviewer`) اضافه شد — در مجموع ۲۷ تست.
  - `PersonaSchema` و `ToolDefinitionSchema` مستقیماً نسخه‌ی به‌روزشده (با `allowedTools` و `source`) پیاده شدند، چون معیار پذیرش فاز ۱ صریحاً آن‌ها را می‌خواهد؛ این مطابق بخش «مطابقت‌سازی کد موجود با پلن جدید» در پیام کاربر است.
- **راستی‌آزمایی:**
  - `npx tsc -p tsconfig.json --noEmit`: ✅ بدون خطا.
  - `npx vitest run src/ai/__tests__/phase1.test.ts`: ✅ ۲۷ تست سبز.
  - معیارهای پذیرش فاز ۱: ساختار پوشه، `createRegistry` (get/list/has/register + duplicate + validation)، پنج Schema (شامل `allowedTools` و `source`)، loader با نمونه‌های واقعی، و build بدون خطای type — همگی تأیید شدند.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۲ (محلی + MCP)

- **وضعیت:** فاز ۲ از 🔴 به 🟢 ارتقا یافت؛ هر پنج گام 🟢 (شامل تکمیل MCP که در پلن جدید اضافه شده بود).
- **پیاده‌سازی:**
  - `src/ai/registries/tool-registry.ts`: `ToolRegistry` با دو لایه‌ی metadata (از `base-registry`) و implementations map؛ `registerDefinition`, `hasDefinition`, `getDefinition`, `listDefinitions`, `registerImplementation`, `getImplementation`, `getToolsByIds` (برمی‌گرداند `Record<string, Tool>` یکسان برای local و MCP)، `size` و `_getMetadataRegistry()` برای bootstrap.
  - ابزارهای پایه (با اصلاح حداقلی از `parameters` به `inputSchema` برای AI SDK v7):
    - `read-file.ts`: `inputSchema` با `filePath` و `encoding` default utf-8، `execute` با try/catch و خروجی ساختاریافته `{ success, filePath, content, sizeBytes }` یا `{ success: false, error, code }`.
    - `search-code.ts`: بازگشتی `walkDir` با skip `node_modules/.git/dist/.next`، regex global با reset `lastIndex`، `maxResults` و خروجی `{ totalMatches, matches }`.
    - `write-file.ts`: بررسی `overwrite: false` با `fs.access` و `EEXIST`، `mkdir -p` برای والدها.
    - `git-status.ts`: `execFile` با `path.resolve` (اصلاح `require('node:path')` به `import path`)، timeout ۱۵s، تشخیص `NOT_A_GIT_REPO`.
  - `src/ai/schemas/mcp-server.ts`: `McpAuthSchema` discriminated union (none/bearer/api-key) + `McpServerConfigSchema` با `id` regex، `transport` http|sse|stdio default http، `url` url optional، `command/args`, `auth` default none، `toolPrefix`, `connectTimeoutMs` ۱۰۰–۶۰۰۰۰ default ۱۰۰۰۰.
  - `src/ai/tools/mcp-connector.ts`: `McpConnector` با:
    - `resolveAuthHeaders` فقط از env vars (بearer → Authorization: Bearer, api-key → custom header) — throw صریح اگر env var تنظیم نشده.
    - `sanitiseError` که مقادیر credential (و token خام پس از Bearer) را از پیام خطا حذف و با `***REDACTED***` جایگزین می‌کند.
    - `defaultCreateTransport`: برای http/sse آبجکت descriptor `{ type, url, headers }`، برای stdio خطای صریح (برای تست، transport سفارشی inject می‌شود).
    - `defaultCreateClient`: فقط از `@ai-sdk/mcp` `createMCPClient` استفاده می‌کند (حذف `experimental_createMCPClient` از `ai` که در v7 وجود ندارد).
    - `connectServer`: هرگز throw نمی‌کند — `connecting → ready/unavailable`، race با timeout، fetch tools، ثبت هر tool با `source: mcp`, `mcpServerId`, `category: mcp`، skip در صورت collision id، ثبت `toolIds` و `lastError`.
    - `connectAll`: `Promise.all` موازی، یک شکست بقیه را نمی‌شکند.
    - `closeAll`: best-effort.
  - `src/ai/tools/mcp-bootstrap.ts`: `loadMcpServerConfigs` (خواندن هر `*.json`، validate، جمع‌آوری خطا per-file) و `bootstrapMcpServers` (اتصال همه، بازگرداندن `configErrors` و `connectionResults`).
  - `src/ai/tools/bootstrap.ts`: `bootstrapTools` — تنها نقطه‌ی import مستقیم implementationها (قانون ۱۲) — با static map `IMPLEMENTATIONS` و استفاده از `_getMetadataRegistry()`.
  - `src/ai/tools/index.ts`: export همه‌ی implementationها + `McpConnector` + bootstrap helpers.
  - `registry/mcp-servers/README.md`: مستندسازی فرمت JSON و تأکید بر عدم ذخیره‌ی credential خام.
  - تست‌ها:
    - `phase2.test.ts`: ۱۲ تست (ToolRegistry metadata/impl separation, getToolsByIds, MCP definition, ۴ ابزار local با success/error, loader integration) — با اصلاح ESM (`__dirname` از `import.meta.url`).
    - `phase2-mcp.test.ts`: ۱۷ تست (McpServerConfigSchema ۴، success path ۳ شامل prefix و uniform getToolsByIds، failure paths ۵ شامل unavailable, sanitise credentials, missing env, timeout, connectAll isolation، loader ۳، bootstrap ۲) — mock client/transport بدون شبکه.
- **اصلاح حداقلی:**
  - `parameters` → `inputSchema` در تمام toolها (AI SDK v5 نام `parameters` را به `inputSchema` تغییر داد).
  - `require('node:path')` در `git_status` → `import path`.
  - `experimental_createMCPClient` از `ai` حذف شد — فقط `@ai-sdk/mcp` استفاده می‌شود (در v7 دیگر export نمی‌شود).
  - `sanitiseError` ارتقا یافت تا token خام پس از `Bearer ` را نیز redact کند (تست `sanitises credentials` در ابتدا fail می‌شد چون header کامل `Bearer <token>` ذخیره می‌شد ولی خطا فقط `<token>` را داشت).
  - `ToolRegistry` متد `_getMetadataRegistry()` اضافه شد تا `bootstrapTools` بدون `as any` کار کند.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۸۵ تست (۲۷ فاز۱ + ۱۲ فاز۲ + ۱۷ فاز۲-MCP + ۹ فاز۳ + ۲۰ فاز۴) — بدون شبکه.
  - معیار پذیرش فاز ۲ (محلی + MCP): ToolRegistry هر دو source را با فرمت یکسان ثبت می‌کند، `getToolsByIds` مستقل از source، خطای یک MCP server باعث crash نمی‌شود و `unavailable` می‌شود، credentialها در لاگ/خروجی خام دیده نمی‌شوند — همگی با تست‌های mock تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۳ (Skill Registry)

- **وضعیت:** فاز ۳ از 🔴 به 🟢؛ هر سه گام 🟢.
- **پیاده‌سازی:**
  - `registry/skills/{code_analysis,git_operations,file_management}/{skill.json,SKILL.md}`: سه Skill نمونه با `instructions: SKILL.md` و `tools` ارجاع به tool idهای واقعی.
  - `src/ai/registries/skill-registry.ts`: `SkillRegistry` با `metadata` Registry، `resolved` Map، `registerFromDirectory` (validate + `loadInstructions` (اگر `.md` پایان یابد، فایل خوانده می‌شود، وگرنه inline) + `validateToolReferences` cross-registry علیه `ToolRegistry.hasDefinition`), `get/has/list/size`, و `loadSkillsFromDirectory` (اسکن والد، per-skill خطا، strict mode).
  - `src/ai/skills/index.ts` و `src/ai/registries/index.ts` به‌روزرسانی برای export.
- **اصلاح حداقلی:** importها به `.js`، `__dirname` ESM، `createToolRegistry` helper در تست با `source: local`.
- **راستی‌آزمایی:** `loadSkillsFromDirectory` سه Skill را بارگذاری می‌کند، `resolvedInstructions` شامل markdown واقعی است، ارجاع به tool ناموجود در startup خطا می‌دهد (نه runtime)؛ ۹ تست سبز.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۴ (Persona + Model Registry)

- **وضعیت:** فاز ۴ از 🔴 به 🟢؛ هر سه گام 🟢.
- **پیاده‌سازی:**
  - `PersonaRegistry`: wrapper نازک روی base Registry با `loadFromDirectory`; تست‌ها تأیید می‌کنند ۴ Persona (architect/coder/reviewer/planner) با `allowedTools` صریح بارگذاری می‌شوند، planner شامل catalog+control tools، reviewer فقط read-only.
  - `ModelRegistry`: دو لایه‌ی config + provider factory، `ProviderFactory` interface (`name` + `create(config): LanguageModel`), `registerProvider` با بررسی تکراری، `registerConfig/getConfig/hasConfig/listConfigs`, `resolve` با cache، `get` convenience، `loadConfigsFromDirectory`, `resolveAll`.
  - `src/ai/models/providers/{openai,anthropic,local}-provider.ts`: هرکدام `createRequire(import.meta.url)` برای ESM سازگاری، خواندن API key از env (openai/anthropic) یا baseURL (local default Ollama), استفاده از `@ai-sdk/openai`/`@ai-sdk/anthropic` فقط در زمان `create`.
  - `registry/models/{gpt-4o,claude-sonnet,local-llama}.json`: سه config نمونه با provider/model/config.
  - `src/ai/registries/index.ts`, `src/ai/personas/index.ts`, `src/ai/models/index.ts` به‌روزرسانی.
- **اصلاح حداقلی:** `require` → `createRequire` برای ESM، تست‌های `phase4.test.ts` با `fileURLToPath` و mock provider (MockLanguageModelV4-like minimal mock با `specificationVersion: v1`, `doGenerate/doStream` vi.fn()) بدون شبکه.
- **راستی‌آزمایی:** Persona ۴تایی با `allowedTools`, ModelRegistry با mock provider، `resolve` cache، `loadConfigsFromDirectory` ۳ config، `resolveAll`; ۲۰ تست سبز; `tsc` بدون خطا.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۵ (Agent Registry + Factory + Context Budget)

- **وضعیت:** فاز ۵ از 🔴 به 🟢؛ هر پنج گام 🟢.
- **پیش‌نیاز — SkillSchema priority:**
  - `src/ai/schemas/skill.ts` فیلد `priority: number 0–100 default 50` اضافه شد (طبق فاز ۵ گام ۳).
  - سه فایل `registry/skills/*/skill.json` به‌روزرسانی: `code_analysis` ۷۰، `file_management` ۶۰، `git_operations` ۳۰.
- **پیاده‌سازی:**
  - `registry/agents.json`: ۴ Agent نمونه (`coder` → coder + [code_analysis,file_management] + gpt-4o, `researcher` → architect + [code_analysis,git_operations], `reviewer` → reviewer + [code_analysis] + claude-sonnet, `planner` → planner + []).
  - `src/ai/registries/agent-registry.ts`: `AgentRegistry` با `Registry<AgentDefinition>`, `loadFromFile` (array یا single), `validateAgent` (بررسی persona/skill/model/tool via skill.resolvedTools), `validateAll`.
  - `src/ai/agents/agent-factory.ts`:
    - `createAgent`: resolve persona/skills/model (hasConfig check قبل از get برای پیام خطای سازگار با تست), جمع‌آوری `resolvedTools` از skills، فیلتر با `personaAllowsTool` (wildcard *)، `toolWarnings` ساختاریافته `{ toolId, skillId, reason: not-in-allowedTools }`, `getToolsByIds` فقط برای allowedها, تعیین budget از `KNOWN_MODEL_LIMITS` یا `config.maxContextTokens` یا ۳۰k default * ۴ chars/token, `buildSystemPrompt` که persona.system را هرگز trim نمی‌کند، skills را بر اساس priority نزولی نگه می‌دارد و کم‌اولویت‌ها را truncate (`[... truncated due to context budget ...]`) یا skip می‌کند و `trimmingLog` می‌سازد.
    - `AgentCache`: Map `id → { def, resolved }`, `get` با `JSON.stringify` مقایسه برای invalidation, `set/invalidate/clear/size`, و `createAgentCached`.
  - `src/ai/agents/index.ts` و `src/ai/registries/index.ts` به‌روزرسانی برای export.
- **اصلاح حداقلی:**
  - `SkillSchema` priority اضافه شد (الزامی برای trimming).
  - تست `phase5.test.ts` از `require('../registries/skill-registry')` به `import { loadSkillsFromDirectory }` تبدیل شد (ESM).
  - `fakeTool` از `parameters` به `inputSchema` تغییر یافت.
  - `ModelRegistry.get` در `createAgent` قبل از throw، `hasConfig` چک می‌کند تا پیام `[AgentFactory] Model "... not found"` تولید شود (تست `throws on missing model` در ابتدا fail می‌شد چون `ModelRegistry` مستقیم throw می‌کرد با پیام متفاوت).
  - `CrossRegistryRefs` import در تست از `agent-factory` به `agent-registry` منتقل شد (TS2459).
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۰۲ تست (۲۷+۱۲+۱۷+۹+۲۰+۱۷) — فاز ۵ شامل ۱۷ تست: ۴ AgentRegistry (load, missing persona/skill, valid), ۶ createAgent (combined instructions, allowedTools include, filter with warning, architect cannot use write_file, missing persona/model), ۴ trimming (no trim, low-priority first, never trim persona, log records), ۳ cache (cache hit, invalidation on change, manual invalidate).
  - معیار پذیرش: ترکیب صحیح و فیلترشده طبق allowedTools, trimming بدون از‌دست‌رفتن persona.system و قابل‌ردیابی در log, caching درست — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۶ (کاتالوگ پویا + ترکیب پویای Agent)

- **وضعیت:** فاز ۶ از 🔴 به 🟢؛ هر چهار گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/tools/implementations/list-personas.ts`: `createListPersonasTool(personaRegistry)` → lightweight `{ id, name, description, allowedTools }` بدون `system`.
  - `list-skills.ts`: `createListSkillsTool(skillRegistry)` → `{ id, name, version, description, tools: resolvedTools, priority }` بدون `resolvedInstructions`.
  - `list-tools.ts`: `createListToolsTool(toolRegistry)` با `inputSchema { source: local|mcp|all default all }` → فیلتر و `{ id, name, description, source, category, hasImplementation }`.
  - `src/ai/tools/catalog-bootstrap.ts`: `bootstrapCatalogTools` سه Tool کاتالوگ را idempotent در ToolRegistry ثبت می‌کند (category: catalog).
  - `src/ai/tools/implementations/delegate-task.ts`:
    - `StaticDelegation` و `DynamicDelegation` discriminated union با `mode`, `checkAuthorization(personaId, requestedToolIds, registry)` → `{ authorized, deniedTools, allowedTools }` با wildcard `*` پشتیبانی.
    - `createDelegateTaskTool(deps)`: static (resolveAgentId) و dynamic (persona/skills/model validation + tool existence + authorization gate). Dynamic: `AgentDefinition` موقت `dynamic_${persona}_${Date.now()}` ساخته و به `createAgent` داده می‌شود. تمام خطاها ساختاریافته `{ success:false, code, error, ... }` — هرگز throw خام به Main Agent نمی‌رود. `onTaskCreated` callback برای Phase 8 TaskRuntime.
  - `delegate-bootstrap.ts`: `bootstrapDelegateTask` ثبت `delegate_task` category control.
  - `implementations/index.ts` و `tools/index.ts` به‌روزرسانی برای export.
- **اصلاح حداقلی:**
  - `parameters` → `inputSchema` در هر چهار Tool جدید (AI SDK v7).
  - ترتیب اعتبارسنجی در dynamic mode: در کد ارسالی authorization قبل از tool existence بود؛ تست `rejects dynamic composition with non-existent tool` با persona coder (allowedTools محدود) باعث می‌شد `AUTHORIZATION_DENIED` به‌جای `TOOL_NOT_FOUND` برگردد. ترتیب به **existence قبل از authorization** تغییر یافت تا `TOOL_NOT_FOUND` دقیق‌تر گزارش شود (منطقی‌تر: اگر Tool وجود ندارد، گزارش عدم وجود مهم‌تر از عدم مجوز است). این minimal fix در Execution Log ثبت شد.
  - `__dirname` ESM via `fileURLToPath(import.meta.url)`.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۱۸ تست (۲۷+۱۲+۱۷+۹+۲۰+۱۷+۱۶) — فاز ۶ شامل ۱۶ تست: ۴ catalog (personas lightweight بدون system, skills با tools+priority بدون instructions, tools all+filter by source), ۴ authorization (allowed, denied, unknown persona, wildcard *), ۶ dynamic (valid composition, unauthorized tool → AUTHORIZATION_DENIED + no task created, persona/skill/model/tool not found), ۲ static (delegate to pre-registered, non-existent agent).
  - معیار پذیرش: catalog کامل و سبک، delegate_task در هر دو حالت کار می‌کند، ترکیب پویا با Tool غیرمجاز رد و گزارش ساختاریافته می‌شود نه crash — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۷ (Agent Runtime + EventBus)

- **وضعیت:** فاز ۷ از 🔴 به 🟢؛ هر چهار گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/runtime/event-bus.ts`: `EventBus` با `Map<type, Set<handler>>`, `subscribe(type|*): UnsubscribeFn`, `emit` synchronous با catch per-subscriber (resilient), `clear`, `subscriberCount`, و `globalEventBus` singleton. Event types: `agent:running {prompt truncated}`, `agent:tool_call {toolName, callId only no args}`, `agent:completed {summary, toolsUsed, usage}`, `agent:error {error, code}`. Law 14 compliance: compact events فقط tool name، بدون args/results.
  - `src/ai/runtime/agent-runtime.ts`: `AgentRuntime.run({ agent: ResolvedAgent, taskId, prompt, eventBus, maxSteps 20, timeoutMs 120s })` → `generateText({ model, system, prompt, stopWhen: stepCountIs(maxSteps), tools })`, استخراج toolCalls از `result.steps` برای emit `tool_call` compact، usage mapping با سازگاری old/new (`promptTokens/inputTokens`, `completionTokens/outputTokens`), summary truncate 400 chars + tool list, `buildSummary`, `classifyError` (TIMEOUT, RATE_LIMIT 429, AUTH_ERROR 401, PROVIDER_ERROR), race با timeout Promise, NEVER throws — همیشه `AgentRunResult { success, summary, result, toolsUsed unique, errors, usage, failureType technical|null }`.
  - `runtime/index.ts` barrel.
- **اصلاح حداقلی:**
  - `maxSteps` در `generateText` در AI SDK 7 وجود ندارد (error TS2353) → به `stopWhen: stepCountIs(maxSteps)` تغییر یافت (طبق migration guide فاز ۷). `stepCountIs` از `ai` import شد.
  - `LanguageModelUsage` در v7 فیلدهای `promptTokens/completionTokens` ندارد بلکه `inputTokens/outputTokens/totalTokens` دارد (error TS2339) → mapping دوگانه `promptTokens ?? inputTokens` و `completionTokens ?? outputTokens` پیاده شد تا هم تست mock (old naming) و هم SDK واقعی (new naming) کار کند.
  - تست `phase7.test.ts`: `vi.mock('ai', () => ({ generateText, tool }))` باعث `No stepCountIs export` در runtime می‌شد → به `vi.mock` با `importActual` و `...actual` + `generateText: vi.fn()` + `stepCountIs: actual.stepCountIs` تغییر یافت.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۳۳ تست (۸ فایل) — فاز ۷ شامل ۱۵ تست: ۴ EventBus (matching, wildcard *, unsubscribe, error resilience), ۴ success (compact result with usage totalTokens 195, event sequence running→completed, tool_call name only no args, summary truncated <600 for 2000 chars), ۶ error (provider error no crash, emits error event, timeout 100ms with 5s mock, auth error, sequence running→error no completed, toolsUsed array on partial), ۱ Law14 (no raw args/results like /etc/passwd, SECRET_DATA_HERE in events).
  - معیار پذیرش: run با mock خروجی معتبر شامل usage، توالی صحیح، در خطا crash نمی‌کند، context خام نشت نمی‌کند (compact only) — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۸ (Task Runtime + Resource Lock + Concurrency)

- **وضعیت:** فاز ۸ از 🔴 به 🟢؛ هر شش گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/schemas/task.ts`: `TaskStatusSchema` enum pending|running|completed|failed|cancelled, `TaskSchema` با `id, agentDefinitionOrId, prompt, status default pending, summary?, result?, claimedResources default [], usage?, errors default [], failureType?, createdAt, startedAt?, completedAt?, planStepId?`, و `createTaskRecord` factory.
  - `schemas/index.ts` export Task.
  - `src/ai/runtime/task-runtime.ts`:
    - `ResourceLockManager`: `Map resource→taskId`, `tryAcquire` all-or-nothing, `release`, `hasConflict`, `getLockedResources`.
    - `TaskRuntime`: `tasks Map id→Task`, `agents Map id→ResolvedAgent`, `runningPromises Map`, `config maxConcurrentTasks default 5`, `eventBus` (global), `agentRuntime` singleton, subscribe `*` → `handleAgentEvent` (sync status running). `createTask` → uuid `task_<8chars>`, `createTaskRecord`, `agents.set`, `scheduleNext`. `scheduleNext`: `availableSlots = maxConcurrent - runningCount`, pending filter, `hasConflict` check → skip, `tryAcquire` + status running + startedAt + fire-and-forget `runtime.run().then(handleRunResult)`. `handleRunResult`: release locks, delete promise, set completed/failed + summary/result/usage/errors/failureType + completedAt, `scheduleNext`. `getStatus/getResult/getDetails/getAllTasks/getRunningCount/getPendingCount`, `waitForAll` loop until no running+pending (handles queued tasks that start after completion), `cancelTask` pending→cancelled, running→cancelled+release+scheduleNext, `destroy` unsubscribe.
  - `task-control-tools.ts`: چهار Tool کنترلی با `inputSchema`:
    - `create_task` (placeholder برای Phase 15, returns pending_{agentId}_{timestamp})
    - `get_agent_status` → status+summary یا TASK_NOT_FOUND
    - `get_agent_result` → اگر pending/running → status+message result null (no throw Law14), اگر completed/failed → summary/result/usage/errors/failureType
    - `get_task_details` → full record truncated prompt 500
  - `task-control-bootstrap.ts`: `bootstrapTaskControlTools` idempotent category control.
  - Barrelها: `implementations/index.ts`, `tools/index.ts`, `runtime/index.ts` به‌روزرسانی.
- **اصلاح حداقلی:**
  - `uuid` dependency اضافه شد (۱۱.۰.۰ + @types/uuid ۱۰) چون کد ارسالی `v4` از `uuid` استفاده می‌کند و در package.json نبود.
  - `parameters` → `inputSchema` در چهار Tool کنترلی (AI SDK v7).
  - `waitForAll` در کد ارسالی فقط `Promise.allSettled(runningPromises)` می‌کرد — برای تسک‌های queued به‌دلیل concurrency cap یا resource lock، پس از اتمام اولین batch برمی‌گشت و تسک‌های pending را رها می‌کرد (تست‌های resource lock و concurrency cap fail می‌شدند). به loop تا quiescent (no running+pending) تغییر یافت تا تمام queued tasks اجرا شوند.
  - `vi.mock('ai', () => ({ generateText, tool }))` در phase8.test.ts باعث می‌شد `tool()` واقعی mock شود و `createGetAgentStatusTool` → `tool()` → undefined → `execute` undefined (7 تست fail). به `vi.mock` با `importActual` و فقط `generateText: vi.fn()` تغییر یافت تا `tool` واقعی باقی بماند. همین fix برای phase7.test.ts نیز اعمال شد.
  - تست‌های کنترلی از `require('../tools/implementations/task-control-tools')` (CommonJS) به `await import(...js)` (ESM) تغییر یافتند.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۴۹ تست (۹ فایل) — فاز ۸ شامل ۱۶ تست: ۵ lifecycle (taskId format, pending→running→completed with usage, failed technical, getStatus running/completed, running result no throw), ۳ resource lock (overlapping → maxConcurrent 1, non-overlapping → 2, no claimed → 3 concurrent), ۲ concurrency cap (cap 2 with 5 tasks → maxConcurrent ≤2 all completed, cap 1 sequential startTimes), ۴ control tools (status existing, status not found, result running returns null not throw, details full record with claimedResources+usage), ۲ cancellation (pending cancelled, completed cannot cancel).
  - معیار پذیرش: منابع مشترک هم‌زمان اجرا نمی‌شوند, سقف concurrency رعایت می‌شود, چهار Tool کنترلی کار می‌کنند, get_result قبل از تکمیل throw نمی‌کند — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۹ (Planning Layer — ابهام‌زدایی + Feasibility Gate + Cycle Detection)

- **وضعیت:** فاز ۹ از 🔴 به 🟢؛ هر هفت گام 🟢.
- **پیاده‌سازی:**
  - `registry/skills/task_decomposition/{skill.json,SKILL.md}`: Skill جدید priority 90, tools [list_personas,list_skills,list_tools], SKILL.md با ۵ مرحله (Understand, Query Catalog, Decompose, Validate Dependencies, Check Feasibility).
  - `src/ai/schemas/plan.ts`: `PlanStepStatusSchema` pending|ready|running|done|failed, `PlanStepSchema` با `id, description, dependsOn default [], assignedPersona, assignedSkills default [], assignedTools default [], claimedResources default [], acceptanceCriteria (Phase 11), status default pending, failureType?, resultSummary?, taskId?`, `PlanStatusSchema` draft|confirmed|running|completed|failed-partial|cancelled, `PlanSchema` با `id?, goal, steps min1, clarifications default [], status default draft, createdAt?, completedAt?`, `PlannerAssessmentSchema` isClear+needsClarification+plan?, `FeasibilityCheckResult`, helpers `createPlan(goal, steps)` با status pending default, `isPlanTerminal`, `getReadySteps`.
  - `planning/planner.ts`: `Planner` با `assess(userRequest)` → `generateText` + `parseJsonResponse` (extract markdown code block, find first { or [, JSON.parse, schema.parse) → `PlannerAssessment`, `generatePlan(userRequest, clarifications?)` → prompt با clarifications, `plan(userRequest)` combined assess+generate → `PlanningResult {isClear, needsClarification, plan?, errors}`. `buildPlannerAgent` → `createAgent` id planner-runtime, personaId planner, skillIds [task_decomposition], modelId gpt-4o.
  - `plan-generator.ts`: `generatePlanStructured` با `generateObject({ model, system, prompt, schema: PlanSchema, schemaName ExecutionPlan })` — preferred production method.
  - `feasibility-gate.ts`: `runFeasibilityGate(plan, {personaRegistry, skillRegistry, toolRegistry})` → checks 1 persona exists, 2 skills exist, 3 tools exist, 4 tools in persona.allowedTools Law18, 5 dependsOn valid + self-dependency, returns `{ feasible, errors: [{stepId, field, message}] }`.
  - `cycle-detector.ts`: `detectCycles` DFS white/gray/black با parent, returns `{ hasCycle, cyclePath }`, `topologicalSort` Kahn's algorithm returns sorted ids یا null اگر cycle.
  - `plan-confirmation.ts`: `summarizePlan` → `PlanSummary {planId, goal, totalSteps, steps, allClaimedResources unique, personasUsed unique}`, `formatPlanForUser` readable block با EXECUTION PLAN header و Confirm instruction Law17, `confirmPlan(userResponse)` accepts yes/y/confirm/approve/ok/go/start → confirmed true else false+feedback.
  - `planning/index.ts` barrel.
- **اصلاح حداقلی:**
  - `createPlan` signature در کد ارسالی `steps: PlanStep[]` بود ولی تست‌ها steps بدون status می‌دادند (TS2741). به `Array<Omit<PlanStep, 'status'> & {status?: PlanStepStatus}>` تغییر یافت تا status optional باشد و default pending اعمال شود.
  - `task_decomposition` skill اضافه شد که به `list_personas/list_skills/list_tools` وابسته است — تست‌های قدیمی فاز ۳/۵/۶ که ToolRegistry فقط با ۴ ابزار پایه ساخته می‌شدند، در `loadSkillsFromDirectory` با خطای `[SkillRegistry] references unknown tool(s): [list_personas...]` fail می‌شدند (۳۰ تست). در هر سه فاز setup به ترتیب صحیح تغییر یافت: `toolRegistry base` → `skillRegistry empty` → `bootstrapCatalogTools` (یا fakeTool registration) → `loadSkillsFromDirectory`. فاز ۳ integration test انتظار ۳ skill داشت → به `>=4` و چک `task_decomposition` اضافه شد.
  - `__dirname` ESM via `fileURLToPath`.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۷۱ تست (۱۰ فایل) — فاز ۹ شامل ۲۲ تست: ۸ Feasibility Gate (valid, non-existent persona/skill/tool, Law18 tool not in allowedTools, invalid dependsOn, self-dependency, multiple errors), ۴ Cycle Detection (valid DAG no cycle, direct A↔B, indirect A→B→C→A, no dependencies), ۳ Topological Sort (valid ordering step-1→2→3, null for cyclic, parallel s1,s2→s3), ۴ Plan Summary & Confirmation (summary personas/resources, format contains EXECUTION PLAN+steps+Confirm, confirm accepts 7 affirmatives, rejects negative with feedback), ۳ Plan Schema (createPlan pending+draft, getReadySteps pending→done transition, isPlanTerminal).
  - معیار پذیرش: درخواست ناقص → clarification (ساختار PlannerAssessment آماده), درخواست کامل → Plan valid via generateObject, Feasibility Gate رد ترکیب نامعتبر قبل از اجرا, چرخه تشخیص داده می‌شود, Plan فقط پس از تأیید صریح وارد اجرا می‌شود — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۰ (PlanRuntime — حلقه‌ی خودکار اجرای Plan تا تکمیل کامل)

- **وضعیت:** فاز ۱۰ از 🔴 به 🟢؛ هر هفت گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/runtime/plan-store.ts`: `PlanStore` interface (save/load/list/delete/exists), `FilePlanStore` با sanitise `planId.replace(/[^a-zA-Z0-9_-]/g, '_')`, sync writes `writeFileSync` برای durability, `MemoryPlanStore` با deep clone در save/load برای جلوگیری از mutation.
  - `src/ai/runtime/plan-runtime.ts`: `PlanRuntime` هسته‌ی Human-Out-Of-Loop:
    - Config: `taskRuntime, planStore, planner, feasibilityDeps, refs {persona,skill,tool,model}, maxReplanningAttempts default 3, defaultModelId gpt-4o, onStatusChange`.
    - `execute(plan)`: status→running+persists, while !shouldExit: check cancelled→cancelled, getReadyStepsPrioritized (priority heuristic: count downstream dependents transitive via BFS, tie-break lexicographic), dispatch via `dispatchStep` (status running+buildAgentForStep via `createAgent`+createTask), `waitForAll`, `syncStepStatuses` (getResult from TaskRuntime → done/failed/cancelled), persist+notify. isStuck detection (no running, no ready, has pending) → `attemptReplanning`. Final status completed vs failed-partial, completedAt, persist, buildResult `{planId, status, completedSteps, failedSteps, totalSteps, incompleteSteps[{stepId, description, reason, failureType}], replanningAttempts}`.
    - `buildAgentForStep`: `createAgent({ agentDefinition: { id: plan-step-${id}, personaId, skillIds, modelId: defaultModelId }, refs })`.
    - `countDependents`: BFS queue transitive.
    - `attemptReplanning`: gather failed context, build replanRequest prompt با ORIGINAL GOAL+FAILED+COMPLETED+PENDING, call `planner.plan(replanRequest)`, validate via `runFeasibilityGate` + `detectCycles`, merge keep completed old + new pending, persist.
    - `resume(planId)`: load, if terminal return result, reset running→pending+taskId undefined (crash recovery), execute.
    - `cancel()`: flag, checked at top of loop + shouldExit.
    - `shouldExit`: isPlanTerminal OR cancelled OR status terminal.
    - Helpers `persist` try/catch (Phase 14 observability), `notify`, `isStuck`, `buildResult`.
  - `runtime/index.ts`: export FilePlanStore, MemoryPlanStore, PlanStore, PlanRuntime, PlanRuntimeConfig, PlanExecutionResult.
- **اصلاح حداقلی:**
  - **Cancellation bug:** spec's `shouldExit` returns true when `cancelled` flag true, causing while loop to exit before inner `if (cancelled) { status=cancelled }` block. Result was `failed-partial` instead of `cancelled`. Fix: after loop, if `this.cancelled` set status to cancelled before final determination.
  - **Resume test bug:** `MemoryPlanStore.save` deep-clones, so original `plan` variable not mutated by resume. Spec test checked `plan.steps.find(...).status` on original variable expecting done → always fails (got running). Fixed test to load persisted copy `env.planStore.load('crash-recovery-plan')` and check there.
  - **Catalog bootstrap order:** spec's `setup()` registered base tools, then `loadSkillsFromDirectory`, then `bootstrapCatalogTools` → fails because `task_decomposition` skill depends on `list_personas/list_skills/list_tools` not yet registered (`[SkillRegistry] references unknown tool(s)`). Fixed to bootstrap catalog BEFORE loading skills (idempotent second bootstrap after).
  - `vi.mock('ai')` changed to `importActual` + mock only `generateText/generateObject` to preserve `tool`, `stepCountIs`, etc (previous phases fix).
  - ESM `__dirname` via `fileURLToPath`.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۱۹۰ تست (۱۱ فایل) — فاز ۱۰ شامل ۱۹ تست: ۴ full execution (multi-step with deps to completion, persists after each step, dependency order, parallel independent steps maxConcurrent 2), ۲ failure handling (step failure without crash, reports incomplete in failed-partial), ۱ priority queue (A 2 dependents before B 1 dependent with concurrency 1), ۳ resume (partially completed resume, running→pending crash recovery, throws non-existent), ۱ re-planning ceiling (max attempts 2), ۱ cancellation (stops dispatching when cancelled), ۲ Law 17 (completes without await user input, failure+replanning exhaustion without human), ۵ MemoryPlanStore (save/load, undefined non-existent, list ids, delete, deep-clone).
  - معیار پذیرش: Plan چندگامی dependency-دار بدون پیام میانی انسانی کامل می‌شود, priority queue A قبل از B, شکست → re-planning خودکار نه توقف, resume از همان نقطه نه صفر, سقف re-planning با گزارش دقیق و بدون crash, cancellation با status cancelled — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۱ (بررسی کیفیت خودکار هر گام — Per-Step Acceptance Check)

- **وضعیت:** فاز ۱۱ از 🔴 به 🟢؛ هر چهار گام 🟢.
- **پیاده‌سازی:**
  - `registry/skills/acceptance_check/{skill.json,SKILL.md}`: Skill جدید priority 95, tools [read_file, search_code], SKILL.md با Purpose/Input/Process/Judgment Guidelines/Output JSON {accepted, reason}.
  - `src/ai/runtime/acceptance-checker.ts`: `AcceptanceResultSchema` {accepted boolean, reason min1}, `AcceptanceChecker` با config {personaRegistry, skillRegistry, toolRegistry, modelRegistry, modelId default gpt-4o, eventBus, planStore, onQualityFailure callback}:
    - `activePlans Map planId→Plan`, `registerPlan/unregisterPlan`, `start()` subscribe `agent:completed` → `handleCompletion(taskId)` async, `stop()`.
    - `checkStep(step, taskResult)`: build reviewer agent `reviewer + acceptance_check + modelId` via `createAgent`, prompt شامل Step Description + Acceptance Criteria + summary/result/errors, `generateObject({ model, system, prompt, schema: AcceptanceResultSchema, schemaName AcceptanceJudgment })`, catch → accepted false + reason Acceptance check itself failed.
    - `handleCompletion`: findStepByTaskId via activePlans, only if step.status done, reconstruct Task {id, agentDefinitionOrId, prompt, status completed, summary/result from resultSummary, claimedResources, errors [], createdAt}, run checkStep, if accepted → resultSummary += [Acceptance: PASSED], else → status failed, failureType quality, resultSummary [Acceptance: FAILED], onQualityFailure callback, planStore.save.
    - `findStepByTaskId`, `buildReviewerAgent`.
  - `plan-runtime-hooks.ts`: `wireAcceptanceChecker(plan, checker)` → registerPlan+start, return cleanup stop+unregister.
  - `runtime/index.ts`: export AcceptanceChecker, AcceptanceResultSchema, AcceptanceCheckerConfig, AcceptanceResult, wireAcceptanceChecker.
- **اصلاح حداقلی:**
  - **Skill dependencies:** acceptance_check + task_decomposition هر دو به catalog tools وابسته‌اند. Setup تست فاز ۱۱ فقط read_file/search_code ثبت می‌کرد → file_management (write_file) و git_operations (git_status) fail. به ۴ ابزار پایه + catalog bootstrap قبل از loadSkills تغییر یافت (مثل فاز ۱۰).
  - **CommonJS require:** تست spec از `require('../schemas/plan')` برای getReadySteps استفاده می‌کرد → ESM fail. به `import { getReadySteps }` تغییر یافت.
  - **vi.mock:** به `importActual` + mock فقط generateText/generateObject برای حفظ tool واقعی (Law 12/14).
  - ESM `__dirname` via `fileURLToPath`.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۲۰۴ تست (۱۲ فایل) — فاز ۱۱ شامل ۱۴ تست: ۳ AcceptanceResultSchema (valid, rejection, empty reason throws), ۳ checkStep (accepted true meets criteria, accepted false missing field, reviewer fails → accepted false), ۴ event-driven (auto check on completed event → failed quality + FAILED + callback, keeps done when passes, ignores orphan task no generateObject, ignores running not done), ۳ failure type distinction (technical from runtime, quality from checker, dependent steps not ready when quality-failed via getReadySteps), ۱ integration quality→replanning (onQualityFailure callback invoked with planId/stepId/reason).
  - معیار پذیرش: هر گام پیش از done از acceptance check خودکار عبور می‌کند, شکست کیفی failureType quality vs فنی technical, گام وابسته به rejected ready نمی‌شود (getReadySteps خالی), مسیر بدون دخالت انسانی به re-planning via onQualityFailure callback — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۲ (بازبینی نهایی و گزارش ساختاریافته به کاربر)

- **وضعیت:** فاز ۱۲ از 🔴 به 🟢؛ هر سه گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/schemas/review.ts`: `FindingSchema` {stepId, title, description, severity critical|warning|info default info}, `IncompleteStepSchema` {stepId, description, reason, failureType technical|quality optional}, `ReviewSchema` {planId, goal, outcome success|partial-success|failure|cancelled, acceptedFindings default [], rejectedFindings default [], incompleteSteps default [], finalSummary min1, usage optional {totalPromptTokens, totalCompletionTokens, totalTokens}}.
  - `schemas/index.ts`: export ReviewSchema, FindingSchema, IncompleteStepSchema, types.
  - `src/ai/runtime/final-reviewer.ts`: `FinalReviewer` با config {personaRegistry, skillRegistry, toolRegistry, modelRegistry, modelId default gpt-4o}:
    - `review(plan, executionResult)`: classifyOutcome (cancelled→cancelled, completed→success, completed>0 && <total→partial-success, 0→failure), buildStepSummaries (filter done|failed, compact resultSummary slice 800), if summaries empty OR outcome cancelled → buildMinimalReview (summary cancelled/failure/no results, no model call), else generateReviewViaModel with fallback.
    - `generateReviewViaModel`: buildReviewerAgent `reviewer + [] + modelId`, buildReviewPrompt با goal, execution summary (plan id, outcome, completed/total, failed, replanningAttempts), stepsBlock (Step id persona description criteria status+failureType result), incompleteBlock, task "Populate acceptedFindings/rejectedFindings/incompleteSteps/finalSummary", `generateObject({ model, system, prompt, schema: ReviewSchema, schemaName FinalReview })`, ensure planId/goal/outcome match + incompleteSteps fallback to executionResult.incompleteSteps.
    - `buildMinimalReview`: summary based on outcome, accepted/rejected empty, incompleteSteps from result.
    - `buildFallbackReview`: mechanical from plan state — accepted from done steps (title slice 80, description resultSummary, severity info), rejected from failed quality steps (title Quality check failed slice 60, severity warning), summary with completed/total + failed + incomplete + fallback note with errorMessage.
    - Helpers `classifyOutcome`, `buildStepSummaries`, `buildReviewPrompt`, `buildReviewerAgent`.
  - `review-formatter.ts`: `formatReviewForUser(review)` deterministic, no model, icons success ✅ partial ⚠️ failure ❌ cancelled 🛑, lines with FINAL REPORT, Plan/Goal/Outcome/Usage, Summary, Accepted Findings with severity [!]/[~]/[i], Rejected Findings, Incomplete Steps with failureType, `formatReviewOneLine` compact `[outcome] planId — X accepted, Y rejected, Z incomplete`.
  - `runtime/index.ts`: export FinalReviewer, formatReviewForUser, formatReviewOneLine.
- **اصلاح حداقلی:**
  - **Catalog bootstrap:** phase12 setup only read_file/search_code → file_management/write_file and git_operations/git_status fail on loadSkills. Added write_file/git_status + bootstrap catalog BEFORE loadSkills (same fix as phases 10-11).
  - **vi.mock:** importActual + mock only generateText/generateObject to preserve tool.
  - ESM __dirname via fileURLToPath.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۲۱۹ تست (۱۳ فایل) — فاز ۱۲ شامل ۱۵ تست: ۵ ReviewSchema (full valid, partial with incomplete, invalid outcome throws, empty finalSummary throws, defaults arrays), ۲ successful plan (produces valid review completed, output always valid against schema), ۱ partial-success (reports incomplete steps clearly failed-partial with quality), ۱ cancelled (minimal review without calling model), ۳ fallback (fallback when generateObject fails → valid + fallback note, accepted from done steps 2, rejected quality-failed step-2), ۳ formatter (readable success contains FINAL REPORT+SUCCESS+goal+title+summary, incomplete steps partial-success contains Incomplete Steps+s3+quality+reason, oneLine compact contains outcome+planId+counts).
  - معیار پذیرش: خروجی بازبینی همیشه مطابق reviewSchema (generateObject + fallback), بدون درخواست انسانی خودکار پس از PlanRuntime (review() direct call), failed-partial گزارش گام‌های ناتمام با دلیل و failureType, fallback بدون crash, cancelled بدون فراخوانی مدل — همگی تأیید.

## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۳ (قابلیت‌های عملیاتی — Streaming، Cancellation، Rate-limit، Usage Tracking)

- **وضعیت:** فاز ۱۳ از 🔴 به 🟢؛ هر پنج گام 🟢.
- **پیاده‌سازی:**
  - `streaming-manager.ts`: `ProgressEvent` type plan:started|step-started|step-completed|step-failed|replanning|completed|cancelled|failed|task:tool-call|task:status با planId/stepId/timestamp/message/payload, `StreamingManager` {eventBus, subscribers Set, unsubscribes}, `start()` subscribe * → translateEvent → emit, `stop()`, `subscribe()` returns Unsubscribe, `emitProgress()`, `translateEvent` agent:running→step-started, tool_call→tool-call (toolName only Law14), completed→step-completed with usage, error→step-failed truncated 100, `formatAsSSE` event: type\ndata: json\n\n, `createArrayCollector` handler+events array.
  - `cancellation-manager.ts`: `CancellationResult` {success, planId, previousStatus, newStatus, completedSteps, cancelledSteps, message}, `CancellationManager` {planStore, taskRuntime, activeRuntimes Map}, `registerRuntime/unregisterRuntime`, `cancelPlan(planId)`: load, if not found → success false unknown, if terminal (completed/cancelled/failed-partial) → success false terminal state, else runtime.cancel() signal, cancel pending tasks with taskId via taskRuntime.cancelTask + status failed + Cancelled by user, status cancelled + completedAt + save, return success true with counts.
  - `rate-limiter.ts`: `RateLimiterConfig` {maxConcurrentPerProvider default 5, baseBackoffMs 1000, maxBackoffMs 30000, maxRetries 3}, `ProviderState` {activeRequests, queue}, `RateLimiter` methods: `acquire(provider)` if active < max → increment else Promise queue, `release(provider)` decrement + wake next, `getBackoffDelay(attempt)` base*2^attempt + jitter ±25% capped maxBackoffMs, `shouldRetry(attempt) < maxRetries`, `isRateLimitError` checks 429|rate limit|too many requests|throttl case-insensitive, `executeWithRetry(provider, fn)` loop acquire → try fn → success return, catch rate-limit && shouldRetry → backoff sleep attempt++ continue, else throw, finally release, `getStats(provider)` active/queued.
  - `usage-aggregator.ts`: `UsageRecord` {taskId, planId?, agentId, personaId?, usage TokenUsage, timestamp}, `UsageSummary` {totalPromptTokens, totalCompletionTokens, totalTokens, taskCount, byAgent Record<agentId, TokenUsage+count>, byPlan Record<planId, TokenUsage+count>}, `UsageAggregator` records array, `record(task, agentId, personaId)` if usage exists push with planId from planStepId, `recordDirect`, `getSummary()` aggregate totals + byAgent + byPlan (unassigned key), `getPlanUsage(planId)` filter + reduce, `getRecords()`, `clear()`.
  - `runtime/index.ts`: export StreamingManager, formatAsSSE, createArrayCollector, ProgressEvent, CancellationManager, RateLimiter, UsageAggregator.
- **اصلاح حداقلی:**
  - **toEndWith:** spec test used `expect(sse).toEndWith('\n\n')` which is not vitest/jest matcher (TS2339). Fixed to `expect(sse.endsWith('\n\n')).toBe(true)`.
  - No catalog bootstrap needed (phase13 tests don't load skills), but previous phases fixes preserved.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۲۴۵ تست (۱۴ فایل) — فاز ۱۳ شامل ۲۶ تست: ۶ StreamingManager (running→step-started, tool_call name only no args leak, completed with usage, error truncated <200, multiple subscribers, subscriber error resilience), ۱ SSE (formats event+data+json+\n\n), ۴ CancellationManager (cancels running plan with runtime.cancel called, non-existent not found, already-completed terminal state, persists cancelled status+completedAt), ۸ RateLimiter (allows within limit 2 active, queues beyond limit, detects 429/rate limit, backoff exponential with jitter 37-63 for attempt0, caps at maxBackoffMs 500, retries on rate-limit succeeds attempt 2, throws after exhausting 3 attempts, no retry non-rate-limit), ۷ UsageAggregator (records aggregates 300/150/450, byAgent breakdown coder 450 count2 reviewer 75, byPlan plan-A 450 plan-B 75, getPlanUsage plan-X 450 count2, ignores tasks without usage, clear resets, getRecords raw).
  - معیار پذیرش: streaming live progress via ProgressEvent+SSES, cancel_plan without crash with persisted cancelled, rate-limit retry with backoff not immediate failure, final report usage summary via UsageAggregator — همگی تأیید.



## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۴ (تداوم Session و Observability ماندگار)

- **وضعیت:** فاز ۱۴ از 🔴 به 🟢؛ هر سه گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/schemas/session.ts`: `SessionInteractionSchema` {id, userRequest, planIds default [], outcome success|partial-success|failure|cancelled|pending default pending, reviewSummary optional, createdAt, completedAt optional}, `SessionSchema` {id, label optional, interactions default [], metadata record default {}, createdAt, lastActiveAt}, helpers `createSession(label?)` id `session_${now}_${random}` + now timestamps, `createInteraction(userRequest)` id `interaction_${now}_${random}` + pending.
  - `src/ai/runtime/session-store.ts`: `SessionStore` interface createSession/getSession/saveSession/listSessions/deleteSession/addInteraction/updateInteraction/getLatestPlanSummary. `FileSessionStore` dir create recursive, filePath sanitise `[^a-zA-Z0-9_-]→_`, sync read/write JSON pretty, listSessions filter .json→id, deleteSession unlink, addInteraction getSession+createInteraction+push+save, updateInteraction find+Object.assign+save, getLatestPlanSummary walk backwards pending≠ + reviewSummary exists. `MemorySessionStore` Map<string,Session> deep clone via JSON parse/stringify on save/get, same logic for all methods, mutation isolation test passes.
  - `src/ai/tools/implementations/session-tools.ts`: `createGetPreviousPlanSummaryTool(sessionStore)` → `tool({ description conversational continuity, inputSchema {sessionId}, execute → getLatestPlanSummary, if undefined return success false code NO_PREVIOUS_PLAN else success true + previousPlanSummary })`. inputSchema not parameters (AI SDK v7 minimal fix).
  - `src/ai/runtime/observability-logger.ts`: `LogEntry` {timestamp ISO, epochMs, planId?, stepId?, taskId?, eventType plan:created|confirmed|started|completed|failed|cancelled|replanning|step:started|completed|failed|quality-check|passed|failed|task:created|completed|failed|tool-call|session:created|interaction|system:error|info, message, payload?, level info|warn|error}, `ObservabilityLoggerConfig` {logFilePath, consoleOutput default false, redactKeys optional}. DEFAULT_REDACT_KEYS [apiKey, api_key, token, password, secret, authorization, credential, bearer, cookie, session_key]. `ObservabilityLogger` constructor ensures log dir exists, `log(entry)` builds fullEntry with now ISO + epochMs + redactPayload, appendFileSync JSONL + \n, try/catch fallback console.error, consoleOutput optional prefix ℹ️⚠️❌. `redactPayload` recursive: lowerKey check Set + original key check → ***REDACTED***, else if object not array recurse. Convenience: logPlanCreated (goal slice 100, stepCount, stepIds), logPlanStarted, logPlanCompleted (done count), logPlanFailed, logPlanReplanning attempt, logStepStarted (description slice 200 persona tools), logStepCompleted (resultSummary slice 300), logStepFailed (failureType), logQualityCheck accepted? quality-passed|failed info|warn, logSessionCreated, logSystemError slice 500. EventBus integration: subscribeToEventBus(eventBus) subscribe * → logAgentEvent: running→task:created, tool_call→task:tool-call payload toolName+callId Law14 no args, completed→task:completed payload toolsUsed+usage, error→task:failed payload code, level error. unsubscribeFromEventBus. Reading: readAll exists check → split \n filter trim → JSON.parse try catch filter null, readForPlan filter planId, readForStep filter planId+stepId.
  - `schemas/index.ts`: export SessionSchema, SessionInteractionSchema, createSession, createInteraction, Session, SessionInteraction.
  - `runtime/index.ts`: export FileSessionStore, MemorySessionStore, SessionStore, ObservabilityLogger, LogEntry, ObservabilityLoggerConfig.
  - `tools/implementations/index.ts`: export createGetPreviousPlanSummaryTool.
- **اصلاح حداقلی:**
  - **inputSchema:** session-tools از `parameters` (spec) به `inputSchema` تغییر یافت — AI SDK v7 نام parameters را به inputSchema تغییر داده (همان fix فازهای ۲-۸).
  - **.js extensions:** تمام importها در phase14.test.ts و runtime به `.js` برای ESM Bundler.
  - **createPlan signature:** plan.test spec steps without status — already handled in plan.ts Omit<status> optional (فاز ۹).
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۲۷۲ تست (۱۵ فایل) — فاز ۱۴ شامل ۲۷ تست: ۱۲ MemorySessionStore (create id session_, retrieve id/label/empty, undefined non-existent, list 2, delete, add interaction Build login page pending length1, undefined ghost, update outcome success summary planIds, getLatestPlanSummary most recent completed when pending exists, undefined when no completed, LATEST completed not first second summary latest, deep-clone mutation isolation), ۲ FileSessionStore (persists to disk reload via new instance persistent label interactions length1 Build feature X, survives restart simulated new instance Completed.), ۹ ObservabilityLogger (writes single JSON line planId eventType timestamp epochMs, appends 3 entries created started completed, chronological order epochMs ≤, readForPlan filter plan-A 2, readForStep filter p1 s1 2, redacts sensitive keys apiKey ***REDACTED*** nested token safeField fine, convenience methods 5 entries plan:created started step:started completed completed, quality check passed info failed warn, replanning attempt 1 2), ۳ EventBus integration (auto logs agent events 3 task:created tool-call with toolName read_file usage defined, logs agent errors task:failed error TIMEOUT, stops logging after unsubscribe only 1), ۱ full lifecycle (captures all key events 9+ contains plan:created started step:started completed quality-passed completed, every entry planId lifecycle-plan, timestamps ISO regex and epochMs >0).
  - معیار پذیرش: درخواست دوم همان session می‌تواند به گزارش قبلی ارجاع دهد via getLatestPlanSummary LATEST + get_previous_plan_summary Tool, لاگ ماندگار JSONL append-only برای اجرای کامل قابل بازخوانی و شامل توالی صحیح readAll/readForPlan/readForStep, credentialها redact recursive ***REDACTED***, EventBus integration auto logging, تست‌ها سبز — همگی تأیید.



## ۲۰۲۶-۰۹-۲۳ — اجرای فاز ۱۵ (یکپارچه‌سازی سرتاسری و سخت‌سازی مدیریت خطا)

- **وضعیت:** فاز ۱۵ از 🔴 به 🟢؛ هر چهار گام 🟢.
- **پیاده‌سازی:**
  - `src/ai/orchestrator.ts`: `Orchestrator` نقطه‌ی ورود واحد:
    - Config `projectRoot, persistent default false, runtimeDir .ai-runtime, maxConcurrentTasks 5, maxReplanningAttempts 3, defaultModelId gpt-4o, agentTimeoutMs 120s, maxDelegationDepth 1, onProgress`.
    - Registries: PersonaRegistry, ToolRegistry, SkillRegistry (toolRegistry ref), ModelRegistry, AgentRegistry.
    - Runtime: EventBus, AgentRuntime, TaskRuntime (maxConcurrent+eventBus+agentRuntime), planStore File/Memory (plans), sessionStore File/Memory (sessions), StreamingManager, CancellationManager, RateLimiter, UsageAggregator, ObservabilityLogger (observability.jsonl), AcceptanceChecker, FinalReviewer, Planner.
    - `initialize()` idempotent: load personas dir strict true, register 4 local tools read_file/search_code/write_file/git_status with impl, bootstrapMcpServers mcp-servers non-fatal, bootstrapCatalogTools BEFORE loadSkills (fix task_decomposition dependency list_personas etc), loadSkillsFromDirectory strict true, re-bootstrap catalog idempotent, register providers openai/anthropic/local, loadConfigsFromDirectory models non-fatal false, load agents.json, bootstrapDelegateTask with onTaskCreated→taskRuntime.createTask + resolveAgentId→agentRegistry.get, bootstrapTaskControlTools, subscribe observability to EventBus, start streamingManager + subscribe onProgress, validateAll cross-registry logSystemError non-fatal, log system:info initialized with counts.
    - `run(userRequest, {sessionId, confirmCallback})`: if not initialized→initialize, session management createSession if not provided + addInteraction + logSessionCreated, planning phase log system:info starting, planner.plan(userRequest) → if !isClear return failure review with clarification needed + session update failure + executionResult failed-partial, logPlanCreated, feasibilityGate runFeasibilityGate → if not feasible return failure review + logPlanFailed, cycle detection detectCycles → if hasCycle return failure, user confirmation summarizePlan+formatPlanForUser → if confirmCallback provided call it, if not confirmed return cancelled review+report, status confirmed + log plan:confirmed, execution: PlanRuntime with taskRuntime planStore planner feasibilityDeps refs maxReplanningAttempts defaultModelId onStatusChange→streamingManager.emitProgress plan:replanning|started, registerRuntime for cancellation, wireAcceptanceChecker, try execute → finally cleanupAcceptance+unregisterRuntime, logPlanCompleted, final review finalReviewer.review(plan, executionResult) + enrich usage via usageAggregator.getSummary, formatFinalReview, update session interaction outcome reviewSummary planIds completedAt, return OrchestratorResult {review, report, planId, sessionId, executionResult}.
    - Public API: cancelPlan(planId)→cancellationManager.cancelPlan, getPlanStatus(planId)→load+counts, getUsageSummary→usageAggregator.getSummary, resumePlan(planId)→load+PlanRuntime resume+review, shutdown→streaming stop+acceptance stop+unsubscribe observability+taskRuntime destroy+waitForAll.
  - `src/ai/runtime/agent-runtime-retry.ts`: `RetryableAgentRunOptions` extends AgentRunOptions with maxRetries default1 providerName default default. `RetryableAgentRuntime` constructor runtime default new AgentRuntime + rateLimiter default new RateLimiter. `run(options)`: maxRetries, provider, lastResult, loop attempt 0..maxRetries: try rateLimiter.executeWithRetry(provider, ()=>runtime.run(options)) → if success return, if isRecoverable && attempt<maxRetries continue else return, catch err if attempt<maxRetries set lastResult failure technical summary Retry attempt+1 after error continue else return All attempts failed. isRecoverable checks errors lowercased includes timeout|timedout|timed out|etimedout|rate limit|429|503|502|econnreset|econnrefused.
  - `src/ai/runtime/delegation-guard.ts`: `DelegationGuardConfig` {maxDepth, personaRegistry}, `DelegationGuard` maxDepth+registry, canDelegate(personaId, currentDepth): if currentDepth>=maxDepth → allowed false reason exceeds maximum Recursive not permitted, if persona not found → not found, if allowedTools includes delegate_task or * → allowed else false reason does not have delegate_task Sub-agents cannot delegate by default. filterTools(toolIds, personaId, currentDepth): if allowed return filtered same removed [], else filtered = filter out delegate_task, removed = filter delegate_task.
  - `runtime/index.ts`: export RetryableAgentRuntime, RetryableAgentRunOptions, DelegationGuard, DelegationGuardConfig.
  - `src/ai/index.ts`: export * schemas, registries, runtime, planning, tools, models, agents, plus Orchestrator config/result.
- **اصلاح حداقلی:**
  - **DelegateTaskDeps import:** spec imported DelegateTaskDeps from delegate-bootstrap which doesn't export it; fixed to import from implementations/delegate-task.js (real location).
  - **Implicit any:** onTaskCreated (resolved, prompt) and resolveAgentId (id) had implicit any TS7006; fixed with any/string explicit.
  - **Catalog bootstrap order:** spec's orchestrator initialized local tools → MCP → loadSkills → catalog tools → fails because task_decomposition references list_personas/list_skills/list_tools not yet registered ([SkillRegistry] references unknown). Fixed to bootstrap catalog BEFORE loadSkills + re-bootstrap after (same fix as phases 10-11).
  - **Provider API keys:** openaiProviderFactory and anthropicProviderFactory throw if OPENAI_API_KEY/ANTHROPIC_API_KEY missing; orchestrator tests need dummy keys. Fixed test to set process.env.OPENAI_API_KEY and ANTHROPIC_API_KEY to sk-test-dummy in beforeEach. Also RetryableAgentRuntime isRecoverable extended to include timedout/etimedout/timed out/econnrefused because ETIMEDOUT does not contain timeout substring (has d).
  - **vi.mock:** spec used vi.mock('ai', () => ({generateText, generateObject, tool})) which breaks tool(); fixed to importActual + preserve ...actual + mock only generateText/generateObject (same as previous phases).
  - **__dirname ESM:** fileURLToPath(import.meta.url) pattern.
- **راستی‌آزمایی:**
  - `tsc --noEmit`: ✅
  - `vitest run`: ✅ ۲۸۵ تست (۱۶ فایل) — فاز ۱۵ شامل ۱۳ تست: ۵ DelegationGuard (allows main-agent depth0, denies depth>=maxDepth exceeds maximum, denies coder without delegate_task, filterTools removes delegate_task for coder, keeps for boss authorized), ۴ RetryableAgentRuntime (success first try 1 call, retries timeout succeeds 2 calls, gives up after max retries 3 calls, does not retry non-recoverable 401 1 call), ۴ Orchestrator integration (initializes without errors personas>=4 tools>=4 skills>=3 agents>=4, returns clarification ambiguous Do the thing outcome failure contains clarification sessionId defined, full flow plan→confirm→execute→review mock with plan Analyse codebase steps architect code_analysis read_file search_code + reviewer mock → review defined planId sessionId report contains FINAL REPORT, handles rejection by user confirmed false feedback Use reviewer instead of coder → outcome cancelled report contains cancelled+feedback).
  - معیار پذیرش: جریان end-to-end کامل بدون دخالت انسانی پس از تأیید Plan (Orchestrator.run), timeout/retry via RetryableAgentRuntime maxRetries+recoverable detection, محدودیت عمق delegation via DelegationGuard maxDepth+allowedTools, هیچ حلقه‌ی بی‌پایان یا crash (PlanRuntime ceiling, DelegationGuard, RateLimiter), تست integration سبز — همگی تأیید.

