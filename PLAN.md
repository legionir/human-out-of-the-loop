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

## [🔴] فاز ۶: کاتالوگ پویا برای Main Agent و ترکیب پویای Agent

هدف: رفع gap اصلی — دادن دید کامل کاتالوگ به Main Agent/Planner و امکان ساخت ترکیب جدید Persona+Skill+Tool در لحظه، بدون ثبت از‌پیش در `agents.json`، همراه با اعمال authorization.

### [🔴] گام ۱: سه Tool فقط‌خواندنی کاتالوگ

`list_personas()`, `list_skills()`, `list_tools()` — هرکدام summary سبک (id + description + برای skill: لیست toolها) برمی‌گردانند، نه محتوای کامل instructions/schema، تا context مصرف نشود.

### [🔴] گام ۲: حالت ترکیب پویا در `delegate_task`

`delegate_task` علاوه بر `agentId` ثابت، ورودی جایگزین `{ persona, skills[], tools[], prompt }` را نیز بپذیرد؛ در این حالت یک `AgentDefinition` موقت در لحظه ساخته و به `createAgent` (فاز ۵) داده می‌شود — بدون نیاز به ثبت در `agents.json`.

### [🔴] گام ۳: اجرای authorization gate روی ترکیب پویا

پیش از فراخوانی `createAgent` در مسیر پویا، هر tool درخواستی در برابر `persona.allowedTools` بررسی شود؛ اگر Tool غیرمجازی درخواست شده باشد، `delegate_task` باید بدون اجرای Agent، خطای ساختاریافته (نه throw خام) به Main Agent/Planner برگرداند تا بتواند ترکیب را اصلاح کند.

### [🔴] گام ۴: تست واحد

تست ساخت Agent پویا با ترکیب معتبر؛ تست رد‌شدن ترکیب پویا با tool غیرمجاز برای persona انتخابی.

**معیار پذیرش:**
`list_personas/list_skills/list_tools` کاتالوگ کامل و سبک برمی‌گردانند؛ `delegate_task` در هر دو حالت (agentId ثابت، ترکیب پویا) کار می‌کند؛ ترکیب پویا با Tool غیرمجاز رد و به فراخواننده گزارش می‌شود، نه crash؛ تست‌ها سبزند.

---

## [🔴] فاز ۷: Agent Runtime و Event Bus

### [🔴] گام ۱: EventBus

pub/sub برای `agent:running`, `agent:tool_call`, `agent:completed`, `agent:error`.

### [🔴] گام ۲: AgentRuntime.run(agentDefinitionOrId, prompt)

اجرا از طریق Agent Factory (فاز ۵/۶)، emit رویدادها در حین اجرا، خروجی خلاصه‌شده (`summary`, `result`, `toolsUsed`, `errors`, و **`usage`** از خروجی خام AI SDK برای مصرف در فاز ۱۳).

### [🔴] گام ۳: مدیریت خطای اجرای هر Agent

گرفتن خطاها، emit `agent:error`، بازگرداندن نتیجه‌ی خطادار ساختاریافته به‌جای crash.

### [🔴] گام ۴: تست با mock model/provider

تست مسیر موفق و توالی رویدادها؛ تست مسیر خطا.

**معیار پذیرش:**
`AgentRuntime.run` برای Agent نمونه با model mock خروجی معتبر شامل `usage` تولید می‌کند؛ توالی رویدادها صحیح است؛ در خطا crash رخ نمی‌دهد؛ context خام کامل به بیرون نشت نمی‌کند؛ تست‌ها سبزند.

---

## [🔴] فاز ۸: Task Runtime — کنترل اجرا، Resource Lock و Concurrency Cap

### [🔴] گام ۱: مدل داده Task

`Task { id, agentDefinitionOrId, prompt, status, summary, claimedResources?, startedAt, completedAt }`.

### [🔴] گام ۲: TaskRuntime پایه

`createTask`, subscribe به EventBus فاز ۷ برای همگام‌سازی وضعیت، `getStatus`, `getResult`, `getDetails`.

### [🔴] گام ۳: Resource Lock / Claim Mechanism

هر Task هنگام ایجاد می‌تواند فهرست منابعی (مثلاً مسیرهای فایلی) را که قرار است لمس کند اعلام کند (`claimedResources: string[]`)؛ TaskRuntime پیش از اجرای هم‌زمان دو Task با overlap در `claimedResources`، یکی را صف (queue) می‌کند نه اینکه هم‌زمان اجرا کند — جلوگیری از race condition روی منابع مشترک.

### [🔴] گام ۴: سقف Concurrency

پارامتر پیکربندی‌پذیر `maxConcurrentTasks` اضافه شود؛ TaskRuntime هرگز بیش از این سقف را هم‌زمان اجرا نکند؛ Taskهای مازاد در صف بمانند.

### [🔴] گام ۵: چهار Tool کنترلی برای Main Agent

`create_task`, `get_agent_status`, `get_agent_result`, `get_task_details` — با `tool()` و `inputSchema` مناسب، در ToolRegistry به‌عنوان دسته‌ی کنترلی (خارج از `allowedTools` عمومی Personaهای Sub-Agent).

### [🔴] گام ۶: تست واحد

تست lock: دو Task با `claimedResources` هم‌پوشان نباید هم‌زمان اجرا شوند؛ تست سقف concurrency با تعداد Task بیشتر از سقف؛ تست چرخه‌ی وضعیت.

**معیار پذیرش:**
Taskهای با منابع مشترک هم‌زمان اجرا نمی‌شوند و race condition رخ نمی‌دهد؛ هیچ‌گاه بیش از `maxConcurrentTasks` Task هم‌زمان در حال اجرا نیستند؛ چهار Tool کنترلی کار می‌کنند و وضعیت‌ها صحیح گزارش می‌شوند؛ تست‌ها سبزند.

---

## [🔴] فاز ۹: لایه‌ی Planning — تفکیک تسک بزرگ، ابهام‌زدایی و Feasibility Gate

این فاز دقیقاً همان نقطه‌ای است که اصل Human-Out-Of-Loop (قانون ۱۷) اجرایی می‌شود: **همه‌چیز باید پیش از پایان این فاز مشخص و توسط کاربر تأیید شده باشد**؛ پس از آن، هیچ ورودی انسانی دیگری تا پایان کار لازم نیست (به‌جز Cancellation).

### [🔴] گام ۱: Persona `planner` و Skill `task_decomposition`

Persona جدید `planner` (در فاز ۴ به‌عنوان نمونه اضافه شود) با `allowedTools` محدود به Toolهای کاتالوگ (فاز ۶) و کنترلی (فاز ۸) — نه Toolهای اجرایی سطح پایین. Skill `task_decomposition` instructions آن مستقیماً بر پایه‌ی منطق «Execution Plan Generator» ارائه‌شده در ابتدای این مکالمه نوشته شود: تفکیک dependency-aware، هر گام با persona/skill/tool پیشنهادی مشخص.

### [🔴] گام ۲: مدل داده Plan

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

### [🔴] گام ۳: مرحله‌ی ابهام‌زدایی پیش از تولید Plan نهایی

پیش از فراخوانی نهایی تولید Plan، Planner یک ارزیابی اولیه انجام می‌دهد: اگر درخواست کاربر برای تولید Plan معتبر ناکافی است (طبق قانون ۹ سند اصلی — Do Not Guess)، به‌جای حدس‌زدن، سؤال(های) روشن‌سازی از طریق یک خروجی صریح (`needsClarification: string[]`) برمی‌گرداند و اجرای Plan آغاز نمی‌شود تا پاسخ کاربر دریافت شود. این تنها نقطه‌ی مجاز درخواست ورودی انسانی **پیش از شروع**.

### [🔴] گام ۴: تولید Plan با `Output.object()`

فراخوانی Planner با `Output.object({ schema: PlanSchema })` روی درخواست (ابهام‌زدایی‌شده‌ی) کاربر؛ خروجی معتبر طبق schema فاز فوق.

### [🔴] گام ۵: Feasibility Gate — اعتبارسنجی هر PlanStep پیش از اجرا

پیش از ورود به PlanRuntime (فاز ۱۰)، هر `PlanStep` در برابر کاتالوگ واقعی (فاز ۶) بررسی شود: آیا `assignedPersona` وجود دارد؟ آیا `assignedSkills`/`assignedTools` معتبرند؟ آیا `assignedTools` همگی در `allowedTools` همان Persona مجازند (قانون ۱۸)؟ در صورت شکست هر بررسی، Plan رد و خطای دقیق (کدام گام، کدام دلیل) برگردانده می‌شود تا Planner Plan را اصلاح کند — بدون شروع اجرا.

### [🔴] گام ۶: تشخیص وابستگی چرخه‌ای

بررسی گراف `dependsOn` برای عدم وجود چرخه؛ در صورت وجود چرخه، Plan رد و به Planner برای اصلاح بازگردانده شود.

### [🔴] گام ۷: تأیید نهایی کاربر پیش از شروع

Plan نهایی (پس از عبور از Feasibility Gate و بررسی چرخه) به‌همراه خلاصه‌ی گام‌ها، persona/skill/tool هر گام، و منابعی که لمس می‌شوند، برای تأیید صریح کاربر نمایش داده شود؛ اجرای PlanRuntime (فاز ۱۰) فقط پس از این تأیید آغاز می‌شود.

**معیار پذیرش:**
برای یک درخواست ناقص نمونه، سیستم پیش از تولید Plan نهایی سؤال روشن‌سازی برمی‌گرداند نه Plan حدسی؛ برای یک درخواست کامل نمونه، Plan معتبر مطابق schema تولید می‌شود؛ Feasibility Gate ترکیب نامعتبر (persona/skill/tool ناموجود یا غیرمجاز) را قبل از اجرا رد می‌کند؛ وابستگی چرخه‌ای تشخیص داده می‌شود؛ Plan فقط پس از تأیید صریح کاربر وارد فاز اجرا می‌شود.

---

## [🔴] فاز ۱۰: PlanRuntime — حلقه‌ی خودکار اجرای Plan تا تکمیل کامل

هسته‌ی اصلی Human-Out-Of-Loop: پس از تأیید کاربر در فاز ۹، این حلقه در کد (نه در تصمیم مدل) تا تکمیل کامل Plan یا شکست قطعی گزارش‌شده، **بدون توقف و بدون نیاز به پیام «ادامه بده»** پیش می‌رود.

### [🔴] گام ۱: Persist کردن Plan در آغاز اجرا

بلافاصله پس از تأیید کاربر، Plan کامل (شامل وضعیت اولیه‌ی همه‌ی گام‌ها) در یک store ماندگار (حداقل فایل JSON، قابل ارتقا به دیتابیس) ذخیره شود؛ هر تغییر وضعیت گام بلافاصله در همین store persist شود.

### [🔴] گام ۲: حلقه‌ی اصلی PlanRuntime

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

### [🔴] گام ۳: Priority Queue بین گام‌های آماده‌ی هم‌رتبه

وقتی تعداد `ready` بیشتر از ظرفیت موازی‌سازی است، اولویت بر اساس تعداد گام‌های وابسته به هرکدام (عمق در گراف — گام‌هایی که بیشترین گام دیگر منتظرشان‌اند، اول اجرا شوند) تعیین شود.

### [🔴] گام ۴: Re-planning خودکار میان‌کار

اگر گامی `failed` شد یا در بررسی کیفیت (فاز ۱۱) رد شد، PlanRuntime **خودش** (بدون سؤال از کاربر) دوباره Planner (فاز ۹) را با context شکست صدا می‌زند تا Plan را patch کند (retry با تنظیمات متفاوت، تجزیه‌ی گام به گام‌های کوچک‌تر، یا افزودن گام جبرانی)؛ Plan patch‌شده دوباره از Feasibility Gate (فاز ۹) عبور می‌کند پیش از ادامه‌ی حلقه. سقف تعداد re-planning کلی (نه فقط per-step) پیکربندی‌پذیر است تا از حلقه‌ی بی‌پایان جلوگیری شود.

### [🔴] گام ۵: Resume پس از crash

در startup، اگر یک Plan ذخیره‌شده‌ی ناتمام (persist شده در گام ۱) وجود دارد، PlanRuntime باید بتواند از همان وضعیت گام‌به‌گام (نه از صفر) ادامه دهد.

### [🔴] گام ۶: خروج از حلقه با وضعیت نهایی قطعی

حلقه فقط در دو حالت متوقف می‌شود: (الف) تمام گام‌ها `done` — عبور به فاز ۱۲؛ (ب) به سقف re-planning رسیده و پیشرفت دیگر ممکن نیست — Plan با وضعیت `failed-partial` و گزارش دقیق چه چیزی ناتمام مانده و چرا (بدون درخواست از کاربر برای ادامه‌ی دستی؛ این گزارش در فاز ۱۲ به کاربر ارائه می‌شود).

### [🔴] گام ۷: تست واحد و integration

تست حلقه با یک Plan نمونه‌ی چندگامی‌ِ dependency-دار (بدون crash)؛ تست resume پس از قطع شبیه‌سازی‌شده‌ی فرآیند میان‌راه؛ تست سناریوی رسیدن به سقف re-planning.

**معیار پذیرش:**
یک Plan چندگامی با وابستگی از ابتدا تا `done` بدون هیچ پیام میانی انسانی («ادامه بده» یا مشابه) کامل اجرا می‌شود؛ گام‌های آماده بر اساس اولویت گراف انتخاب می‌شوند؛ شکست یک گام باعث توقف کل فرآیند نمی‌شود بلکه re-planning خودکار رخ می‌دهد؛ در سناریوی شبیه‌سازی‌شده‌ی قطع فرآیند، اجرا از همان نقطه (نه از صفر) resume می‌شود؛ رسیدن به سقف re-planning بدون crash و با گزارش دقیق پایان می‌یابد؛ تست‌ها سبزند.

---

## [🔴] فاز ۱۱: بررسی کیفیت خودکار هر گام (Per-Step Acceptance Check)

هدف: کشف شکست کیفی (نه فقط فنی) بلافاصله پس از هر گام، پیش از آزادشدن گام‌های وابسته — بدون دخالت انسان.

### [🔴] گام ۱: Persona/Skill `reviewer` برای بررسی per-step

از Persona `reviewer` موجود (فاز ۴) با Skill جدید `acceptance_check` استفاده شود؛ instructions آن معیار پذیرش خودِ PlanStep (که Planner در فاز ۹ برای هر گام تولید می‌کند — لازم است `PlanStep` schema فیلد `acceptanceCriteria: string` نیز داشته باشد؛ این فیلد به schema فاز ۹ اضافه شود) را در برابر خروجی واقعی Sub-Agent بسنجد.

### [🔴] گام ۲: فراخوانی خودکار acceptance check پس از هر تکمیل فنی گام

در EventBus (فاز ۷)، هنگام دریافت `agent:completed` برای یک Task مرتبط با یک PlanStep، پیش از تغییر وضعیت PlanStep به `done`، PlanRuntime به‌صورت خودکار `reviewer` را روی خروجی آن گام اجرا می‌کند.

### [🔴] گام ۳: تفکیک شکست فنی از شکست کیفی

خروجی `reviewer` باید `{ accepted: boolean, reason?: string }` (با `Output.object()`) باشد؛ اگر `accepted: false`، PlanStep به‌جای `done` به `failed` (با `failureType: "quality"` در تمایز از `failureType: "technical"` که از فاز ۷/۸ می‌آید) تغییر می‌کند و مسیر re-planning خودکار فاز ۱۰-گام۴ فعال می‌شود.

### [🔴] گام ۴: تست واحد

تست با خروجی Sub-Agent mock معتبر (accepted) و mock نامعتبر (rejected)؛ بررسی این‌که در حالت rejected، گام‌های وابسته `ready` نمی‌شوند.

**معیار پذیرش:**
هر گام پیش از `done`‌شدن از acceptance check خودکار عبور می‌کند؛ شکست کیفی و فنی با `failureType` متفاوت ثبت می‌شوند؛ گام‌های وابسته به یک گام `rejected` تا رفع مشکل `ready` نمی‌شوند؛ این مسیر بدون هیچ دخالت انسانی به re-planning فاز ۱۰ متصل است؛ تست‌ها سبزند.

---

## [🔴] فاز ۱۲: بازبینی نهایی و گزارش ساختاریافته به کاربر

### [🔴] گام ۱: zod schema بازبینی نهایی

`reviewSchema` (`acceptedFindings`, `rejectedFindings`, `finalSummary`, و فیلد جدید `incompleteSteps` برای حالت `failed-partial` از فاز ۱۰).

### [🔴] گام ۲: فراخوانی خودکار Review در پایان حلقه‌ی PlanRuntime

بلافاصله پس از خروج حلقه‌ی فاز ۱۰ (چه با موفقیت کامل چه با `failed-partial`)، بدون نیاز به triggerِ انسانی، Main Agent با `Output.object({ schema: reviewSchema })` روی خلاصه‌ی خروجی تمام PlanStepها فراخوانی می‌شود.

### [🔴] گام ۳: تولید گزارش نهایی

خروجی نهایی به فرمت قابل‌ارائه تبدیل و به کاربر بازگردانده می‌شود؛ در حالت `failed-partial`، گزارش باید دقیقاً مشخص کند کدام گام‌ها ناتمام ماندند و چرا (خروجی گام ۶ فاز ۱۰).

**معیار پذیرش:**
خروجی بازبینی همیشه مطابق schema معتبر است؛ این مرحله بدون درخواست انسانی، خودکار پس از پایان PlanRuntime اجرا می‌شود؛ در سناریوی `failed-partial`، گزارش نهایی به‌روشنی گام‌های ناتمام و دلیل آن را بیان می‌کند.

---

## [🔴] فاز ۱۳: قابلیت‌های عملیاتی Runtime — Streaming، Cancellation، Concurrency/Rate-limit، Usage Tracking

این چهار قابلیت همگی لایه‌ای عملیاتی روی TaskRuntime/AgentRuntime موجود هستند و برای این‌که «اجرای بی‌وقفه» از دید کاربر قابل‌مشاهده، قابل‌توقف، و قابل‌اتکا (از نظر هزینه و نرخ درخواست) باشد لازم‌اند؛ در یک فاز منسجم قرار گرفته‌اند تا فاز اضافی بی‌دلیل ایجاد نشود.

### [🔴] گام ۱: Streaming پیشرفت به کاربر

از `streamText`/`streamObject` AI SDK برای stream کردن رویدادهای compact (فاز ۷) و به‌روزرسانی وضعیت Plan (فاز ۱۰) به یک کانال قابل‌مشاهده‌ی کاربر (مثلاً SSE/WebSocket) استفاده شود؛ این جایگزین «سکوت طولانی در حین اجرای خودکار» است.

### [🔴] گام ۲: Cancellation صریح

Tool/API سطح بالا `cancel_plan(planId)` اضافه شود که وضعیت Plan را به `cancelling` می‌برد؛ PlanRuntime در ابتدای هر iteration این وضعیت را چک می‌کند و در صورت `cancelling`، هیچ گام جدیدی dispatch نمی‌کند، منتظر تکمیل Taskهای در حال اجرا می‌ماند (یا timeout اجباری)، و وضعیت نهایی را `cancelled` با گزارش گام‌های تکمیل‌شده ثبت می‌کند.

### [🔴] گام ۳: سقف Concurrency در سطح Provider و Rate-limit

علاوه بر `maxConcurrentTasks` (فاز ۸، در سطح کل سیستم)، سقف جداگانه per-provider (مثلاً حداکثر N درخواست هم‌زمان به OpenAI) اضافه شود؛ در صورت برخورد به rate-limit provider (کد خطای ۴۲۹ یا معادل)، آن Task به‌جای `failed` قطعی، با backoff به صف بازگردانده شود (تا سقف retry مشخص).

### [🔴] گام ۴: ردیابی و تجمیع Token Usage/هزینه

هر خروجی `AgentRuntime.run` (فاز ۷، شامل `usage`) در یک aggregator ذخیره شود که usage را per-task، per-plan و per-agent-type جمع می‌زند؛ در گزارش نهایی (فاز ۱۲) خلاصه‌ی هزینه/usage کل Plan نیز درج شود.

### [🔴] گام ۵: تست واحد

تست streaming با mock؛ تست cancellation میان‌راه یک Plan چندگامی؛ تست backoff روی خطای rate-limit شبیه‌سازی‌شده؛ تست صحت تجمیع usage.

**معیار پذیرش:**
کاربر می‌تواند پیشرفت Plan را در حین اجرای خودکار به‌صورت زنده مشاهده کند؛ فراخوانی `cancel_plan` یک Plan در حال اجرا را بدون گیرکردن یا crash متوقف می‌کند و وضعیت `cancelled` با گزارش جزئی صحیح ثبت می‌شود؛ برخورد به rate-limit باعث شکست قطعی فوری نمی‌شود بلکه retry با backoff انجام می‌شود؛ گزارش نهایی شامل خلاصه‌ی usage/هزینه‌ی کل Plan است؛ تست‌ها سبزند.

---

## [🔴] فاز ۱۴: تداوم Session و Observability ماندگار

### [🔴] گام ۱: پایداری Session بین چند درخواست کاربر

یک `sessionStore` (حداقل فایل/دیتابیس ساده) اضافه شود که تاریخچه‌ی درخواست‌های قبلی کاربر و Planهای مرتبط (persist‌شده در فاز ۱۰) را نگه دارد؛ اگر کاربر در ادامه‌ی همان session سؤال جدیدی بپرسد، Main Agent/Planner بتواند به آخرین Plan/گزارش مرتبط ارجاع دهد (از طریق یک Tool `get_previous_plan_summary(sessionId)`).

### [🔴] گام ۲: Observability ماندگار (لاگ/trace)

علاوه بر EventBus in-memory (فاز ۷)، تمام رویدادهای کلیدی (شروع/پایان هر Task، هر تصمیم re-planning، هر acceptance check) در یک لاگ ساختاریافته‌ی ماندگار (فایل JSONL یا معادل) نوشته شوند تا پس از پایان اجرا قابل بازبینی/دیباگ باشند؛ هر رکورد شامل `planId`, `stepId`, `timestamp`, `eventType`, `payload` است.

### [🔴] گام ۳: تست واحد

تست ذخیره و بازیابی خلاصه‌ی Plan قبلی برای یک sessionId؛ تست این‌که لاگ ماندگار برای یک اجرای کامل Plan نمونه شامل تمام رویدادهای کلیدی است.

**معیار پذیرش:**
درخواست دوم کاربر در همان session می‌تواند به گزارش/Plan قبلی ارجاع دهد؛ لاگ ماندگار برای یک اجرای کامل قابل بازخوانی و شامل توالی صحیح رویدادهاست؛ تست‌ها سبزند.

---

## [🔴] فاز ۱۵: یکپارچه‌سازی سرتاسری و سخت‌سازی مدیریت خطا

### [🔴] گام ۱: سیم‌کشی سرتاسری جریان اصلی

نقطه‌ی ورود واحد که تمام Registryها (فازهای ۱-۶) را در startup بارگذاری، سپس جریان کامل `درخواست کاربر → Planning (فاز ۹) → تأیید کاربر → PlanRuntime (فاز ۱۰) → Acceptance Check (فاز ۱۱) → Review نهایی (فاز ۱۲)` را در معرض دید بیرونی قرار دهد.

### [🔴] گام ۲: timeout در سطح AgentRuntime/TaskRuntime

برای هر اجرای Sub-Agent timeout پیکربندی‌پذیر با retry محدود، جدا از backoff مخصوص rate-limit فاز ۱۳.

### [🔴] گام ۳: محدودیت عمق delegation

جلوگیری از delegation بازگشتی بی‌کنترل؛ Sub-Agentها به‌طور پیش‌فرض دسترسی به `delegate_task` ندارند مگر این‌که Persona آن‌ها صریحاً این Tool را در `allowedTools` داشته باشد (که باید موردی نادر و آگاهانه باشد).

### [🔴] گام ۴: تست end-to-end کامل با ویژگی Human-Out-Of-Loop

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
