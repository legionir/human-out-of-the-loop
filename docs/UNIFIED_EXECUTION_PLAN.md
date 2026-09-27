# پلن اجرایی واحد و ردیابی‌شده (UNIFIED EXECUTION PLAN)

**شناسه سند:** `docs/UNIFIED_EXECUTION_PLAN.md`
**تاریخ تألیف:** 2026-09-26
**مبنای کد:** شاخه `worktree-review-execution-plan` / `arena/01a0e249-human-out-of-the-loop`، HEAD = `720c267` (A–G 🟢؛ H در همین فاز)
**جایگاه:** این سند، **تنها مرجع ردیابی و اجرا** برای رفع همهٔ نواقص و باگ‌های شناسایی‌شده است. هر موردی که در هر سند منبع ثبت شده، یا اینجا یک ردیف دارد یا صراحتاً به یک ردیف ادغام شده — **هیچ موردی حذف نشده است** (اثبات کامل تطبیق در §۴).

---

## §۱ — منابع ادغام‌شده (۵ سند)

| # | سند منبع | محتوا | وضعیت |
|---|---|---|---|
| S1 | `docs/REVIEW_EXECUTION_PLAN.md` (834 خط) | ماتریس ۱۴۵ یافته R0–R11 + فازهای R8 (قابلیت جدید) | ۲۱ مورد 🟢 رفع‌شده، ۱۲۴ باز |
| S2 | `docs/FORENSIC_AUDIT_REPORT.md` (891 خط) | ممیزی فارنزیک ۱۹بخشی: SEC/BUG/ARCH/REL/CONF/DEBT/POT/TEST | ۱۳ تأییدشده + ۵ POTENTIAL/UNVERIFIED |
| S3 | `audit/` (workspace ممیزی integration) | ۶۵ EP، ۶۰ WF، ۵ ENT، ۱۰ BND، یافته‌های F-0001..F-0011 | حکم: SUBSTANTIALLY VERIFIED WITH OPEN ITEMS |
| S4 | `docs/READINESS_AUDIT.md` (514 خط) | ۱۰ محور readiness P1–P10 + CI | همه 🟢 جز P1 ⛔ (کلید واقعی) و P8 🟡 (windows-leg) |
| S5 | `audit/unknowns.md` + Appendix B فارنزیک | ۴ + ۵ مورد UNKNOWN/UNVERIFIED | برای بستن، ورودی بیرونی/آزمون لازم دارد |

**قانون طلایی این سند:** هر یافته یک **ردیف واحد** با ID پایدار دارد. IDهای قدیمی در ستون «منبع» حفظ شده‌اند تا هیچ ردپایی گم نشود. رفع = نوشتن تست fail-سپس-pass + رفع + `tsc`/`vitest` سبز + تیک 🟢 در همین جدول + کامیت جدا.

---

## §۲ — وضعیت کلی در یک نگاه

| فاز | دامنه | تعداد ردیف باز | بحرانی (P0) |
|---|---|---|---|
| A | امنیت — سرور وب و گیت اعتماد | ۰ 🟢 | ۰ |
| B | صحت ارکستراسیون، state، پیکربندی و registry | ۰ 🟢 | ۰ |
| C | صحت runtime، تسک و ایجنت | ۰ 🟢 | ۰ |
| D | صحت ابزارها و journal | ۰ 🟢 | ۰ |
| E | context، prompt و مدل | ۰ 🟢 | ۰ |
| F | کارایی و مصرف توکن | ۰ 🟢 | ۰ |
| G | CLI، REPL و سرور | ۰ 🟢 | ۰ |
| H | رابط وب ↔ سرور (UI) | ۰ 🟢 | ۰ |
| I | تست، CI و مستندات | ۰ 🟢 | ۰ |
| J | قابلیت‌های جدید | ۰ 🟢 | ۰ |
| K | راستی‌آزمایی بیرونی (نیازمند ورودی کاربر/محیط) | ۹ | ۱ |
| | **جمع ردیف‌های باز** | **۹** | **۱** |

---

## §۳ — دستور کار (ردیف‌های قابل اجرا)

اولویت: P0 = پیش از هر دیپلوی/اشتراک‌گذاری · P1 = بلوک‌کننده کیفیت · P2 = مهم · P3 = بهبود.
ستون «رفع/تست» خلاصه فنی است؛ شرح کامل، معیار پذیرش و محل دقیق در سند منبع (ستون آخر) آمده است.

### فاز A — امنیت: سرور وب و گیت اعتماد 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.4)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **A-01** 🟢 | P0 | سرور وب بدون auth روی 0.0.0.0 | bind پیش‌فرض 127.0.0.1؛ token middleware مشابه `serve --http` (`transports.ts:169-174` الگو)؛ `HOTL_SERVER_TOKEN`/`--token`؛ بدون توکن و host≠loopback → refuse startup. تست: درخواست بدون توکن → 401 روی همهٔ routeها | S2:SEC-001؛ S3:F-0003/0004/0005/0006/0008/0009؛ S1:غیردامنه(سرور) |
| **A-02** 🟢 | P0 | گیت اعتماد R0-08 نیمه‌پیاده — `--trust-project` وجود ندارد | سیم‌کشی پرچم در `run`/`repl`/`serve` + persist با `trust.ts` و `GlobalCliConfig.trustedProjects`. تست: پروژهٔ غیرمطمئن → mcp-servers لایهٔ پروژه spawn نشود؛ پس از پرچم → اجرا | S1:R0-08(بخش سیم‌کشی)؛ S2:CONF-001,ARCH-002,DEBT-002 |
| **A-03** 🟢 | P0 | دورزدن گیت اعتماد در ۳ مسیر introspection | `collectMcpTools` (`registry.ts:150`)، `mcpTestCommand` (`mcp.ts:87`)، `POST /api/mcp/:id/test` (`routes/registry.ts:110`) همگی با همان فیلتر `trustedProject`. تست برای هر ۳ مسیر | S2:SEC-003؛ S3:WF-0021..27(W1.3),WF-0038..45(W1.3) |
| **A-04** 🟢 | P0 | اجرا در مرحلهٔ پلن‌سازی قابل لغو نیست | `POST /api/runs/:runId/cancel` + `AbortSignal` تا planner. تست: لغو حین planning → هیچ فراخوانی LLM بعدی | S1:R11-10؛ S3:WF-0002 |
| **A-05** 🟢 | P0 | ران‌های رهاشده (clarification/confirmation) هرگز timeout نمی‌شوند | TTL قابل پیکربندی (پیش‌فرض ۳۰ دقیقه → `confirmed:false`) + cleanup resolver در cancel. تست: TTL → run `cancelled`، interaction بسته | S1:R6-03؛ S3:F-0002؛ S1:R6-04(map رشد) ادغام شد |
| **A-06** 🟢 | P1 | schema MCP فیلد `env` ندارد؛ تناقض کامنت | افزودن `env: Record<string,string>` (از EnvSource) به `McpServerConfigSchema` و پاس‌دادن به `createStdioTransport`؛ یا پاکسازی کامنت‌ها. تست: env سفارشی به فرزند برسد | S2:SEC-002 |
| **A-07** 🟢 | P1 | قید scheme/url و tokenEnvVar در schema MCP | zod refine: scheme فقط http/https برای http-transport؛ `tokenEnvVar` الگوی نام متغیر. تست: `file://` و env-var نامعتبر رد شود | S2:POT-004 |
| **A-08** 🟢 | P2 | ownership فقط با دانستن UUID | مدل مالکیت حداقلی: session/plan bound به توکن/کلاینت در سرور (پس از A-01)؛ یا صراحتاً پذیرفته‌شده و مستند. تست: کلاینت A روی run کلاینت B (پس از auth) 403 بگیرد | S3:F-0004/0007(SEC-001 propagation) |

**معیار پذیرش فاز:** همهٔ endpointها تست 401/404/403 دارند؛ سه مسیر probe با گیت اعتماد؛ `tsc`/`vitest` سبز.

### فاز B — صحت ارکستراسیون و پایداری state 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.5)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **B-01** 🟢 | P0 | resume روی پلن running مراحل را دوباره اجرا می‌کند | مجموعه in-process پلن‌های فعال + فایل قفل مالکیت (pid/heartbeat)؛ رد resume با 409. تست: resume هم‌زمان → 409؛ پس از مرگ مالک → مجاز | S1:R6-02 |
| **B-02** 🟢 | P0 | `resumePlan` interaction اشتباه را می‌بندد | اول تطبیق `planIds.includes(planId)` سپس goal؛ هرگز interaction پلن دیگر بسته نشود. تست سناریوی I1/I2 | S1:R9-01 |
| **B-03** 🟢 | P0 | storeها فایل را بدون اعتبارسنجی بارگذاری می‌کنند | `PlanSchema.safeParse`/`SessionSchema.safeParse` در هر دو store؛ فایل خراب → رد + هشدار. تست: یک فایل خراب + یک سالم → فهرست سالم با هشدار، API 200 | S1:R9-03 |
| **B-04** 🟢 | P0 | id تکراری مراحل پذیرفته می‌شود | feasibility gate: duplicate step id → خطا. تست | S1:R1-08 |
| **B-05** 🟢 | P0 | ادغام re-plan لبه‌های وابستگی را پاک می‌کند | شناسهٔ صریح جایگزین در schema/prompt پلن‌ساز (replacesStepId) + redirect لبه‌ها؛ بدون جایگزین → رد re-plan. تست merge + e2e | S1:R1-03 |
| **B-06** 🟢 | P1 | interaction برای همیشه pending (پلن پایان‌یافته/لغوشده/draft) | مرحلهٔ reconcile در `initialize` و `plans resume`؛ draft رها → cancelled. تست kill میان ذخیرهٔ پلن و interaction | S1:R9-02 |
| **B-07** 🟢 | P1 | خروج feasibility/cycle/رد تأیید interaction را به‌روز نمی‌کند؛ feedback دور ریخته | به‌روزرسانی interaction در هر ۳ مسیر؛ feedback متنی → re-plan تا سقف دورها. تست هر ۳ مسیر | S1:R1-11 |
| **B-08** 🟢 | P1 | persist وضعیت `done` داوری‌نشده را ذخیره می‌کند | ذخیره فقط پس از داوری؛ resume داوری‌نشده‌ها را داوری کند. تست crash شبیه‌سازی‌شده | S1:R1-12 |
| **B-09** 🟢 | P1 | به‌روزرسانی وضعیت پلن میان پروسه‌ها بازنویسی متقابل | `PlanStore.update(id, fn)` با قفل دور خواندن-تغییر-نوشتن. تست cancel هم‌زمان با ذخیرهٔ نهایی | S1:R9-08 |
| **B-10** 🟢 | P1 | شکست ذخیرهٔ پلن کاملاً بی‌صدا | `logSystemError` + `persistenceDegraded` در review + سقف خطای پیاپی. تست: save که throw کند → لاگ + هشدار گزارش | S1:R9-09؛ S2:REL-001؛ S3:WF cards REL |
| **B-11** 🟢 | P1 | storeهای فایل قالب قدیمی (pre-hash) در list دیده می‌شوند ولی load/delete نمی‌شوند | مهاجرت یک‌باره به نام hash در `list()`. تست: پلن قدیمی → list/load/resume/delete کار کند | S1:R9-04 |
| **B-12** 🟢 | P2 | خاموش‌شدن سرور وب state ناتمام می‌گذارد | بستن listener؛ resolve منتظرها به‌عنوان لغو؛ لغو runtime فعال + ذخیره؛ سیگنال دوم = خروج سخت. تست SIGTERM حین اجرا → پلن cancelled + interaction بسته | S1:R9-10 |
| **B-13** 🟢 | P2 | `hootl run`/REPL به SIGTERM و SIGHUP واکنش ندارند | هدایت به مسیر اولین Ctrl-C با مهلت. تست `kill -TERM` → پلن cancelled، بدون child زنده | S1:R9-11 |
| **B-14** 🟢 | P2 | نتیجهٔ مرحلهٔ تمام‌شده تا پایان موج ذخیره نمی‌شود | ذخیرهٔ فوری نتیجهٔ هر تسک + تطبیق resume با `task:completed` در log. تست crash پس از A حین B → A دوباره اجرا نشود | S1:R9-07 |
| **B-15** 🟢 | P3 | نوبت‌های قبلی session به پلن‌ساز/chat نمی‌رسند | تزریق بلوک محدود N تعامل آخر در prompt ارزیابی/پلن/پاسخ. تست: prompt goal دوم خلاصهٔ اول را دارد | S1:R9-05 |
| **B-16** 🟢 | P1 | ورودی‌های نامعتبر registry بی‌صدا رد می‌شوند (errors و connectionResults دور ریخته؛ resolveAll هرگز throw نمی‌کند) | `initialize` با نام فایل reject؛ نبود کلید مدل پیش‌فرض پیش از هر فراخوانی پولی گزارش شود. تست: فایل خراب models/agents/mcp-servers | S1:R10-01 |
| **B-17** 🟢 | P1 | id تکراری داخل یک لایه بی‌صدا به آخرین فایل می‌رسد | خطای تکراری داخل هر لایه (نه فقط بین‌لایه‌ای). تست هر دو حالت HOTL_NO_PACKAGE_REGISTRY | S1:R10-02 |
| **B-18** 🟢 | P1 | `allowedTools` در persona اعتبارسنجی نمی‌شود | id ناشناخته (غیر `*` یا پیشوند mcp:) → خطا یا هشدار آشکار در شروع. تست: `["read-file","write_fiel"]` | S1:R10-03 |
| **B-19** 🟢 | P1 | قطع یک سرور MCP کل runtime را از شروع بازمی‌دارد | حذف ابزارهای MCP آن skill با هشدار + درج خطای اتصال MCP در پیام. تست: سرور قطع → شروع با هشدار، بقیهٔ skillها کار کنند | S1:R10-04 |
| **B-20** 🟢 | P1 | فرمان‌های فهرست CLI با بارگذاری اجرا تفاوت دارند (+ ناهمخوانی لایه‌بندی `/api/mcp`) | loader مشترک CLI/runtime؛ یکسان‌سازی لایه‌بندی سرور. تست مقایسه‌ای: خروجی `models/personas/skills/tools` == آنچه `initialize` بارگذاری می‌کند | S1:R10-05؛ S2:API-001؛ S3:API-001 |
| **B-21** 🟢 | P1 | برخورد slug مدل بی‌صدا مدل دیگری را انتخاب می‌کند | hash پسوند در برخورد slug با provider/model متفاوت؛ نام خالی → `InvalidModelError` (exit 2). تست جدول‌محور ۶ نمونه | S1:R10-06 |
| **B-22** 🟢 | P1 | `HOTL_BASE_URL` به‌تنهایی `defaultModel` سراسری را کنار می‌زند | اولویت: بدون `HOTL_MODEL`، defaultModel سراسری برنده. تست | S1:R10-07 |

**معیار پذیرش فاز:** هیچ state ناسازگار در سناریوهای kill/cancel/resume هم‌زمان؛ همهٔ تست‌های جهت‌دار (بدون رفع fail) در repo.

### فاز C — صحت runtime، تسک و ایجنت 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.6)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **C-01** 🟢 | P0 | timeout/cancel قفل را آزاد می‌کند در حالی که ابزار هنوز اجراست | نگه‌داشتن قفل/اسلات تا settle شدن `executionPromise`؛ `abortSignal` به ابزارهای fs/git/fetch. تست: تسک B با منبع مشترک پس از پایان واقعی A شروع شود | S1:R2-01 |
| **C-02** 🟢 | P0 | خطای provider وسط استریم موفقیت گزارش می‌شود | part نوع `error` در `pipeThoughts` → failure؛ `finishReason==='error'` → failure. تست: step 2 خطای 502 → `success:false` | S1:R2-02 |
| **C-03** 🟢 | P0 | لغو پلن هیچ تسکی را لغو نمی‌کند | `cancelTask` برای مراحل running؛ لغو آبشاری فرزندان؛ رد `runAcceptanceChecks` پس از cancel. تست: AbortSignal فعال، هیچ داوری پس از cancel | S1:R2-03؛ S2:REL-002 (notify گم) ادغام در همین رفع |
| **C-04** 🟢 | P0 | retry و rate limiter به‌کل بی‌اثرند (dead wiring) | وصل `RetryableAgentRuntime` به TaskRuntime/answerRun یا حذف؛ retry فقط در سطح فراخوانی مدل برای 429/5xx/شبکه با تشخیص status code. تست: 429 → retry با backoff بدون اجرای دوبارهٔ ابزارها؛ per-provider concurrency | S1:R2-09؛ S2:ARCH-001؛ S3:WF-0001(W) |
| **C-05** 🟢 | P1 | عمق تفویض همیشه ۰ و persona اشتباه | ساخت `delegate_task` به ازای ایجنت با depth+1؛ بررسی persona فراخواننده. تست: تفویض دوم با depth:1 رد شود | S1:R2-04 |
| **C-06** 🟢 | P1 | توکن اجراهای شکست‌خورده شمرده نمی‌شود | جمع usage در `onStepFinish` + گزارش جزئی در خطا. تست: timeout در step 2 → usage step 1 ثبت | S1:R2-05 |
| **C-07** 🟢 | P1 | تسک‌های تفویض‌شده planId ندارند و نتیجه به والد برنمی‌گردد | planId والد به فرزند؛ نتیجهٔ فرزند در خروجی `delegate_task`. تست: usage فرزند در bucket پلن والد | S1:R2-06 |
| **C-08** 🟢 | P1 | `waitForAll` حلقهٔ داغ + سراسری | cleanup در `.finally`؛ `waitFor(planId)`. تست: run reject → بازگشت < ۱ ثانیه؛ دو پلن مستقل | S1:R2-07 |
| **C-09** 🟢 | P1 | mapهای TaskRuntime هرگز پاک نمی‌شوند | آزادسازی `agents`/`taskOverrides` پس از پایان پلن؛ TTL/سقف رکورد. تست: اندازهٔ map پس از ۱۰۰ تسک | S1:R2-08 |
| **C-10** 🟢 | P1 | race شکستن قفل کهنه؛ `sleepSync` مسدودکننده | شکستن با rename اتمیک + بررسی مالکیت؛ نسخهٔ async قفل برای سرور. تست: دو waiter → دقیقاً یکی | S1:R2-10 |
| **C-11** 🟢 | P2 | Journal بسته نمی‌شود؛ retention/rotation ندارد | `journal.close()` در shutdown؛ prune دوره‌ای؛ rotation سایز‌محور `observability.jsonl`؛ cleanup stale temp/lock در initialize؛ retention plans/sessions. تست: fd باز نماند؛ rotate بالای سقف | S1:R2-11 |
| **C-12** 🟢 | P1 | رویدادهای `agent:tool_call` پس از پایان اجرا | ارسال هنگام شروع ابزار؛ در timeout، ابزارهای اجراشده در `toolsUsed`. تست | S1:R2-12 |
| **C-13** 🟢 | P1 | همهٔ نوبت‌های chat یک task id مشترک | `chat:${interactionId}`. تست: دو نوبت = دو task؛ chat kill‌شده reconcile شود | S1:R9-12 |
| **C-14** 🟢 | P2 | `review.usage` ناقص در ۳ مسیر | usage دورهای clarification + answer + `withStructuredRetry` تلاش اول. تست هر ۳ مسیر | S1:R1-13 |

### فاز D — صحت ابزارها 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.7)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **D-01** 🟢 | P1 | `edit_file` تطابق چندگانه → فقط اولی | بیش از یک تطابق → `AMBIGUOUS_MATCH` با تعداد؛ فایل دست‌نخورده. تست | S1:R3-01 |
| **D-02** 🟢 | P1 | `edit_file` tab→space | حفظ tab. تست Makefile | S1:R3-02 |
| **D-03** 🟢 | P1 | `edit_file` CRLF→LF | بقیهٔ خطوط بایت‌به‌بایت ثابت. تست | S1:R3-03 |
| **D-04** 🟢 | P1 | `oldText` خالی درج در اولین خط خالی | `.min(1)` در schema → رد. تست | S1:R3-04 |
| **D-05** 🟢 | P1 | `edit_file` فایل غیر UTF-8 را خراب می‌کند | `TextDecoder(fatal:true)` → `ENCODING_UNSUPPORTED`؛ گزینهٔ base64 برای `write_file`. تست Latin-1 دست‌نخورده | S1:R3-14 |
| **D-06** 🟢 | P1 | اتصال MCP ممکن است برای همیشه گیر کند؛ نشت فرزند | `client.tools()` داخل race timeout؛ بستن client در catch؛ علامت ابزارهای سرور مرده. تست: سرور بی‌پاسخ → بازگشت بعد از `connectTimeoutMs` + kill | S1:R3-05 |
| **D-07** 🟢 | P1 | git timeout hookها را نیمه‌کاره kill نمی‌کند | spawn `detached` + kill گروه؛ settle روی `'exit'`؛ timeout پیکربندی commit ~120s. تست: hook `sleep 60`، timeout 1s → بازگشت ~1.5s، بدون process زنده | S1:R3-09 |
| **D-08** 🟢 | P1 | `gitEnv` متغیرهای لازم را حذف می‌کند | allowlist: `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, `HTTP(S)_PROXY`, `NO_PROXY`, `XDG_CONFIG_HOME`, `GIT_AUTHOR_*`/`COMMITTER_*`, `USERPROFILE`. تست: هر متغیر به فرزند برسد | S1:R3-10 |
| **D-09** 🟢 | P1 | detached HEAD → commit یتیم + push «موفق» | `DETACHED_HEAD` از commit؛ تشخیص «Everything up-to-date» روی stderr → `pushed:false`. تست همان سناریو | S1:R3-11 |
| **D-10** 🟢 | P1 | `git_pr_create` head/base نمی‌فرستد؛ gh به remote توجه نمی‌کند | head=برنچ جاری، base=پیش‌فرض؛ `--repo host/owner/name`. تست REST + fork | S1:R3-12 |
| **D-11** 🟢 | P1 | `sequentialthinking` session مشترک + بدون redaction | session پیش‌فرض per-task/plan؛ TTL پاک‌سازی؛ redactor journal. تست: دو پلن ۳۰ فکری؛ بدون راز در فایل | S1:R3-13 |
| **D-12** 🟢 | P2 | ذخیرهٔ نتیجهٔ fetch محتوای placeholder می‌نویسد | اعلان بریدگی فیلد جدا؛ غیرمتنی → `success:false`/`UNSUPPORTED_CONTENT_TYPE`. تست: `content` بدون marker | S1:R3-15 |
| **D-13** 🟢 | P2 | پیام commit بدنه نمی‌تواند داشته باشد | پذیرش چندخطی + ارسال با `-F -`. تست پیام چندخطی | S1:R3-16 |
| **D-14** 🟢 | P2 | `get_current_time` تاریخ ناممکن را جلو می‌برد | `{date:"2026-02-31"}` → `INVALID_DATE`. تست | S1:R3-17 |
| **D-15** 🟢 | P2 | `create_task` قدیمی موفقیت ساختگی | `success:false` با پیام یا حذف ابزار. تست | S1:R3-06؛ S2:DEBT-001 |
| **D-16** 🟢 | P3 | `git_pr_list/view` در read-only نیستند | افزودن به `readOnlyToolIds()` + تست عدم‌نوشتن. تست | S1:R3-07 |
| **D-17** 🟢 | P3 | `get_previous_plan_summary` تعریف‌شده ولی ثبت‌نشده | ثبت + تست یا حذف. تست | S1:R3-08 |
| **D-18** 🟢 | P1 | journal با پیش‌فرض `summary` نتیجهٔ کامل ابزار را می‌نویسد؛ redaction ناهمسان (substring vs نام‌محور؛ حداقل طول راز ۶) | شرط withJournal: حذف فقط برای `none`؛ summary واقعی (سقف چند صد کاراکتر)؛ redaction کلیدها با تطبیق substring مثل observability logger؛ حداقل طول مقدار راز یکسان ۶. تست: کلیدهای `githubToken` و `x-api-key` و راز ۶ کاراکتری ماسک شوند؛ تست حالت summary (شکاف فعلی phase37-journal.test.ts) | S1:R2-13؛ S2:BUG-001 |

### فاز E — context، prompt و مدل 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.8)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **E-01** 🟢 | P0 | پلن‌ساز کاتالوگ persona/skill/tool را نمی‌بیند | تزریق کاتالوگ فشرده در prompt ارزیابی/تولید؛ حذف گام ۲ SKILL.md. تست: prompt شامل همهٔ idها؛ e2e persona ناشناخته شکست بخورد | S1:R4-01؛ S1:R7-01(وابسته) |
| **E-02** 🟢 | P0 | هر مرحله فقط `step.description` را می‌گیرد | بلوک فشرده: هدف پلن + acceptanceCriteria + resultSummary وابستگی‌ها (سقف ~۱۵۰۰ char)؛ در re-plan خلاصهٔ نتایج done. تست محتوا و سقف | S1:R4-02 |
| **E-03** 🟢 | P0 | تنظیمات مدل هرگز به SDK نمی‌رسند | پاس‌دادن `temperature`/`maxOutputTokens` به همهٔ فراخوانی‌ها؛ Anthropic به `baseURL`/`apiKeyEnv`. تست با مدل mock | S1:R4-09 |
| **E-04** 🟢 | P0 | persona coder تأیید تست را می‌خواهد ولی ابزار ندارد | ابزار C-phase (J-01) یا حذف جمله. قاعده: هیچ persona دستوری بدون ابزار. تست cross-registry | S1:R4-03 |
| **E-05** 🟢 | P1 | تضاد skillها و persona داور | persona خنثی `judge` برای داوری؛ بازنویسی `code_analysis`. تست فهرست تضاد | S1:R4-04 |
| **E-06** 🟢 | P1 | skill کامل به ایجنتی بدون ابزارهایش تزریق می‌شود | بخش‌بندی SKILL.md بر اساس ابزار یا validation رد. تست: system prompt researcher بدون git_push؛ ≥۳۰٪ کوتاه‌تر | S1:R4-05 |
| **E-07** 🟢 | P1 | context تکراری پلن‌ساز؛ تضاد «همیشه بپرس» | یک‌بار ENVIRONMENT/Language؛ همسویی persona planner. تست | S1:R4-06 |
| **E-08** 🟢 | P1 | تشخیص زبان خط اول به‌جای خط غالب | غلبهٔ خط؛ نادیده‌گرفتن ارقام؛ اردو/ژاپنی با حروف ویژه. تست جدول‌محور ۵ نمونه | S1:R4-12 |
| **E-09** 🟢 | P1 | `reasoning/SKILL.md` فراخوانی زائد time | دستور: از زمان system prompt استفاده کن. تست | S1:R4-07 |
| **E-10** 🟢 | P2 | schema پلن فیلدهای داخلی را از مدل می‌خواهد؛ دستور طول خروجی نیست | schema جدا برای خروجی مدل بدون status/taskId/...؛ JSDoc→describe؛ دستور خلاصه ≤N. تست schema | S1:R4-08 |
| **E-11** 🟢 | P2 | پیش‌فرض‌های مدل کهنه؛ سخت‌کد 'gpt-4o' ×۲۳ | `claude-sonnet-5`؛ ثابت واحد `DEFAULT_MODEL_ID`؛ اولویت maxContextTokens پیکربندی. تست grep + override | S1:R4-10 |
| **E-12** 🟢 | P3 | شرط تکراری زبان در planner | حذف شرط درونی. تست‌های موجود سبز | S1:R4-11 |

### فاز F — کارایی و مصرف توکن 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.9)

اندازه‌گیری پایه قبل از شروع (مطابق جدول S1 فاز R5) و تکرار پس از اتمام.

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **F-01** 🟢 | P0 | prompt caching عملاً غیرممکن | زمان فقط تا روز؛ cacheControl breakpoints (Anthropic) روی system+tools؛ ثبت cache usage. تست: دو فراخوانی → system بایت‌به‌بایت یکسان؛ usage کش در `hootl usage` | S1:R5-01 |
| **F-02** 🟢 | P0 | ابزارها بر اساس allowedTools کامل نه skill | اشتراک assignedTools مرحله × allowedTools؛ کوتاه‌کردن توضیح ۴ ابزار بزرگ. تست: ≤۳۵۰۰ توکن per step | S1:R5-02 |
| **F-03** 🟢 | P0 | خروجی ابزارها سقف ندارد | `directory_tree` پیش‌فرض‌های حذف + سقف ۵۰۰؛ read_file سقف+truncated+offset؛ git diff/show stat-first؛ سقف سراسری ~۳۰k در wrapper. تست: tree < ۲۰KB؛ truncated:true | S1:R5-03 |
| **F-04** 🟢 | P1 | تاریخچهٔ گفتگو هرگز کوتاه نمی‌شود | `prepareStep` جایگزینی نتایج قدیمی‌تر از K step + بودجهٔ کل. تست: ۲۰ step ≤ budget | S1:R5-04 |
| **F-05** 🟢 | P1 | اجرای مراحل موجی است | حلقهٔ رویدادمحور: پایان هر تسک → dispatch فوری readyها؛ انتظار فقط هم‌پلن. تست: C پیش از پایان B شروع شود | S1:R5-05؛ S1:R9-07 (persist فوری) در B-14 |
| **F-06** 🟢 | P2 | داوری‌های پذیرش پشت سر هم | `Promise.all` با سقف هم‌زمانی؛ سقف result ورودی داور. تست: ۳ داوری ۲۰۰ms < ۴۰۰ms | S1:R5-06 |
| **F-07** 🟢 | P2 | reviewer فیلدهای دورریز؛ re-plan از schema کامل | schema حداقلی reviewer؛ re-plan → `generatePlan` مستقیم. تست | S1:R5-07 |
| **F-08** 🟢 | P2 | I/O همگام و کار تکراری در نوشتن | redact/stringify یک‌بار در journal؛ JSON فشردهٔ plan. تست | S1:R5-08 |
| **F-09** 🟢 | P1 | followLog کل فایل را در هر event می‌خواند | خواندن از offset قبلی؛ watch دایرکتوری + ادامه پس از rotate؛ تست rotate. (شامل مسیر وب `/api/observability/stream`) | S1:R6-11؛ S3:F-0011؛ S2:§۱۱ LOW |
| **F-10** 🟢 | P3 | SSE بدون سقف اتصال | سقف اتصال per-process (پیکربندی). تست با N اتصال ساختگی | S3:F-0007 |

### فاز G — CLI، REPL و سرور 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.10)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **G-01** 🟢 | P0 | Ctrl-C هنگام پلن‌سازی کل REPL را می‌بندد | فقط goal جاری abort؛ prompt برگردد؛ `hootl run` رفتار فعلی بماند. تست PTY | S1:R6-01 |
| **G-02** 🟢 | P0 | محیط غیر TTY بدون `--yes` پس از پلن‌سازی پولی شکست می‌خورد | بررسی پیش از هر فراخوانی LLM. تست: هیچ فراخوانی مدل انجام نشود | S1:R6-14 |
| **G-03** 🟢 | P0 | `/cd` مقادیر `.env` پروژهٔ قبلی را نگه می‌دارد | snapshot env؛ حذف مقادیر A؛ بارگذاری B؛ محاسبهٔ مجدد model. تست | S1:R6-05 |
| **G-04** 🟢 | P1 | session حذف‌شده goalهای بعدی REPL را می‌شکند | پاک‌کردن sessionId پس از خطا؛ goal بعدی با session جدید. تست | S1:R6-06 |
| **G-05** 🟢 | P1 | paste چندخطی دور ریخته می‌شود | bracketed paste فعال. تست: سه خط → یک goal | S1:R6-07 |
| **G-06** 🟢 | P1 | مکان‌نما UTF-16 است | grapheme-aware: emoji=۲، ZWNJ/اعراب=۰. تست هر مورد | S1:R6-08 |
| **G-07** 🟢 | P1 | Ctrl-C در prompt تأیید «Error» + interaction باز | `ExitPromptError` → `{confirmed:false}`؛ interaction بسته. تست | S1:R6-12 |
| **G-08** 🟢 | P1 | ناهمسانی resume میان CLI و سرور | تابع مشترک بررسی وضعیت/override؛ route سرور RunState بسازد. تست برابری | S1:R6-13 |
| **G-09** 🟢 | P1 | هر goal در REPL یک Orchestrator تازه | کش per (cwd,model,persistent)؛ MCP یک بار. تست تعداد initialize | S1:R6-16 |
| **G-10** 🟢 | P1 | passthrough `/run` وضعیت REPL را نادیده می‌گیرد | استفاده از model/persistent/yes/session جاری. تست | S1:R6-15 |
| **G-11** 🟢 | P2 | JSON-RPC: batch و id نامعتبر | آرایه → آرایه پاسخ (2025-03-26)؛ id object → -32600. تست | S1:R6-09 |
| **G-12** 🟢 | P2 | خطاهای اعتبارسنجی و متن help | `plans resume --timeout-ms abc` → validateRunOptions؛ `/config set defaultMode` → parseRunMode؛ متن help exit 2. تست هر سه | S1:R6-10 |
| **G-13** 🟢 | P2 | splash غیرقابل رد؛ registry با هر کلید | هر کلید رد کند؛ کش registry در REPL. تست | S1:R6-17 |
| **G-14** 🟢 | P2 | `/api/usage` فقط همین پروسه را می‌شناسد | ساخت اعداد از `observability.jsonl` مثل CLI. تست برابری با `hootl usage` | S1:R9-13 |
| **G-15** 🟢 | P2 | رشد فایل session؛ محدودیت label ناهمسان (۶۴ vs ۱۲۰) | رشد محدود per interaction؛ JSON فشرده؛ محدودیت مشترک. تست | S1:R9-14 |
| **G-16** 🟢 | P3 | parser `.env` نحو رایج را اشتباه می‌خواند | پشتیبانی `export`، توضیح درون‌خطی، نقل‌قول، multiline. تست جدول‌محور | S1:R10-08؛ S2:CONF-002؛ S3:-(جدول CONF) |
| **G-17** 🟢 | P3 | یک منبع config در نقاط ورود مختلف رفتار متفاوت | resolve مشترک برای run/REPL/plans/server؛ `--no-persistent`. تست برابری | S1:R10-09 |
| **G-18** 🟢 | P3 | چاپ baseURL مدل فعال در ترمینال | پس از A-01 بلامانع؛ در غیر این صورت چاپ حذف شود یا فقط نام provider. تست: خروجی run بدون baseURL سفارشی | S3:F-0001 |

### فاز H — رابط وب ↔ سرور (UI) 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.11)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **H-01** 🟢 | P0 | modal پلن هر ۸۰۰ms دوباره رسم می‌شود (پاک‌کردن feedback) | باز کردن modal یک بار per planId؛ بستن فقط توسط مالک. تست: متن ۵ ثانیه survives؛ پیش‌نمایش حین اجرا باز بماند | S1:R11-01 |
| **H-02** 🟢 | P0 | SSE دیر شروع می‌شود؛ هیچ بازپخشی نیست | ارسال روی کانال runId یا بافر حلقوی با id + بازپخش/`Last-Event-ID`. تست: timeline اجرای auto-confirm از «plan started» | S1:R11-02 |
| **H-03** 🟢 | P1 | `plan:cancelled` هرگز به UI نمی‌رسد | شاخهٔ ترجمه در streaming-manager. تست: دقیقاً یک `plan:cancelled`، هیچ `plan:failed` | S1:R11-03 |
| **H-04** 🟢 | P1 | نام رویدادهای SSE ناهمخوان؛ `agentLevel` حذف می‌شود | listener برای task:tool-error/plan:replanned/plan:error؛ عبور agentLevel. تست: هر event ارسالی listener دارد؛ یک خط per transition | S1:R11-04 |
| **H-05** 🟢 | P1 | UI session جدید را نمی‌پذیرد | `finishRun` از `result.sessionId` استفاده کند. تست: دو goal در یک session | S1:R11-05 |
| **H-06** 🟢 | P1 | خطای اجرا حباب chat را گیر می‌اندازد | نمایش error در خود حباب. تست | S1:R11-06 |
| **H-07** 🟢 | P1 | preview پاسخ chat را نادیده می‌گیرد؛ خطای provider = سؤال | نمایش `answer`؛ جداسازی errors از needsClarification در route. تست «hello» و خطای کلید | S1:R11-07 |
| **H-08** 🟢 | P1 | preview و اجرا به هم متصل نیستند | `POST /api/run {previewId}` اجرای همان پلن یا برچسب «نمونه‌ای». تست: مراحل یکسان، بدون پلن‌سازی دوم | S1:R11-08 |
| **H-09** 🟢 | P1 | UI حالت (auto/chat/plan) ندارد؛ `@plan` نادیده | parse پیشوند در سرور؛ HOTL_MODE/defaultMode؛ کنترل حالت UI؛ preview با mode. تست «@plan hi» | S1:R11-09 |
| **H-10** 🟢 | P1 | جریان observability بدون فایل log از بین می‌رود | follow بدون فایل باز بماند؛ با ایجاد فایل نشان دهد. تست | S1:R11-11 |
| **H-11** 🟢 | P2 | `sessionId` ناشناخته بی‌صدا پذیرفته می‌شود | بررسی در `Orchestrator.run`؛ route 404. تست: `POST /api/run {sessionId:"nope"}` → 404 بدون فراخوانی مدل | S1:R9-06 |
| **H-12** 🟢 | P2 | جدول نهایی taskها دور ریخته می‌شود | `finishRunUi` قبل از loadTasks حالت را پاک نکند. تست | S1:R11-12 |
| **H-13** 🟢 | P3 | پاسخ chat در تاریخچه بی‌صدا بریده | یا کامل یا علامت «بریده‌شده». تست | S1:R11-13 |
| **H-14** 🟢 | P3 | poll در جریان modal سؤال‌ها را دوباره باز می‌کند | ردگیری دورهای ارسال‌شده. تست بدون 409 | S1:R11-14 |

### فاز I — تست، CI و مستندات 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.13)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **I-01** 🟢 | P0 | e2e باگ‌های prompt/کاتالوگ را نمی‌گیرد (persona همیشه coder) | fake LLM از کاتالوگ prompt انتخاب کند؛ نبود کاتالوگ → خطا؛ سناریوی `catalog` برای E-01/E-02 | S1:R7-01؛ S2:TEST-001؛ S3:TEST-001 |
| **I-02** 🟢 | P1 | تست‌های پوششی برای همهٔ یافته‌ها | `phase-i-coverage.test.ts`: یک `it` per ردیف 🟢 A–H با فایل regression | S1:R7-07 |
| **I-03** 🟢 | P1 | تست‌های flaky با sleep ثابت | `waitUntil` به‌جای sleep ثابت در followLog / stdio / EPIPE؛ ۲۰ بار پیاپی در تست | S1:R7-04 |
| **I-04** 🟢 | P2 | هر PR دو بار CI اجرا می‌کند | `push.branches: [main]`؛ concurrency per workflow+PR/sha؛ cache npm | S1:R7-02 |
| **I-05** 🟢 | P2 | `MAX_ANNOTATIONS` اعمال نمی‌شود؛ annotation بدون line | `scripts/ci-annotations.mjs` سقف ۴۰ + `line=` | S1:R7-03 |
| **I-06** 🟢 | P3 | کمبودهای real-provider.yml | grep Anthropic؛ مدل از `vars.HOTL_MODEL`؛ `HOTL_API_STYLE`؛ cron بدون secret → skip | S1:R7-05 |
| **I-07** 🟢 | P3 | ناهمخوانی مستندات | README/CHANGELOG؛ `maxContextTokens`؛ `HOTL_NO_SPLASH`؛ planner `skillIds: [task_decomposition]`؛ تست HOTL_* ↔ CONFIGURATION | S1:R7-06؛ S2:DEBT-005 ادغام |
| **I-08** 🟢 | P3 | کامنت‌های ادعا-محور بدون تطبیق کد + لاگ‌های «فاز X» | بازنویسی معنا-محور در فایل‌های همین فاز (fake-llm، ci-test، waitUntil). تست NA | S2:DEBT-003,DEBT-004؛ S2:API-001(doc face) |

### فاز J — قابلیت‌های جدید (پس از فازهای A–I) 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.14)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **J-01** 🟢 | P2 | ابزار `run_command`/`run_tests` | allowlist (`.ai-runtime/commands.json` + `HOTL_ALLOWED_COMMANDS`)؛ argv بدون shell؛ timeout+kill؛ سقف خروجی+`truncated`؛ journal؛ خارج از read-only. تست: `phase-j-run-command.test.ts` | S1:R8-01؛ (پیش‌نیاز E-04 گزینهٔ ابزار) |
| **J-02** 🟢 | P2 | حلقهٔ خودتأییدی | پس از coder اگر `testCommand` تعریف شده → `runProjectTests`؛ شکست → technical + re-plan با خروجی تست. e2e: `phase-j-self-verify.test.ts` | S1:R8-02 |
| **J-03** 🟢 | P2 | بودجهٔ توکن/هزینه پلن | `--budget` توکن یا `$`؛ عبور → `cancelled` / `budget exceeded`؛ بدون فراخوانی مدل بعدی؛ قیمت در registry مدل. تست: `phase-j-budget.test.ts` | S1:R8-03 |
| **J-04** 🟢 | P2 | handoff ساختاریافته میان مراحل | `{changedFiles,keyResult,notes}`؛ prompt وابسته `DEPENDENCY HANDOFF` نه transcript. تست: `phase-j-handoff.test.ts` | S1:R8-04 |
| **J-05** 🟢 | P2 | checkpoint/rollback | کپی درخت پیش از مرحلهٔ نوشتنی در `.ai-runtime/checkpoints`؛ شکست → restore؛ `hootl plans rollback`. تست درخت کاری: `phase-j-checkpoint.test.ts` | S1:R8-05 |
| **J-06** 🟢 | P3 | مسیریابی مدل بر اساس نوع کار | نقش classify/judge/review/plan/code؛ judge روی مدل routed؛ usage `byModel`. تست: `phase-j-model-routes.test.ts` | S1:R8-06 |
| **J-07** 🟢 | P3 | `--estimate` | فقط پلن‌سازی؛ چاپ مراحل/توکن/هزینه؛ بدون execute. تست: `phase-j-estimate.test.ts` | S1:R8-07 |
| **J-08** 🟢 | P3 | نمونه‌های پلن موفق برای پلن‌ساز | `.ai-runtime/plan-examples.jsonl`؛ `HOTL_PLAN_EXAMPLES=0`؛ سقف ۲۰؛ انتخاب همپوشانی. تست: `phase-j-plan-examples.test.ts` | S1:R8-08 |
| **J-09** 🟢 | P3 | ابزارهای تکمیلی | `delete_file` (sandbox+journal)؛ `read_graph` offset؛ `GET /api/runs`. تست: `phase-j-extras.test.ts` | S1:R8-09 |

### فاز K — راستی‌آزمایی بیرونی (نیازمند ورودی کاربر/محیط) ⛔/🟡

| ID | Pri | مورد | چه چیزی لازم است | منبع |
|---|---|---|---|---|
| **K-01** | P0 | اجرا با provider واقعی (OpenAI/Anthropic) | secretهای GitHub (`HOTL_API_KEY`...) و اجرای `real-provider.yml`، یا یک run واقعی دستی. معیار: run کامل + usage درست + 401/429/500 غیرکرش + بدون نشت | S4:P1 ⛔؛ S5:UNKNOWN-0003؛ S2:POT-002 |
| **K-02** | P1 | windows-leg ماتریس CI پس از v27.2.12/13 | اجرای دوباره `ci.yml` (اعتبار Actions). انتظار: سبز | S4:P8 🟡 |
| **K-03** | P1 | baseline typecheck/test در workspace تمیز | `npm ci && npx tsc --noEmit && npx vitest run && npm run e2e` روی ماشین/CI. معیار: سبز؛ خروجی در `audit/baseline/` | S5:UNKNOWN-0004؛ S3:P2 |
| **K-04** | P2 | اندازهٔ واقعی log/کلاینت SSE برای F-09/F-10 | telemetry یا load test. تصمیم: رفع یا پذیرش مکتوب | S5:UNKNOWN-0001؛ S3:F-0007/0011 |
| **K-05** | P2 | تعمدی بودن bind غیر-loopback در دیپلوی | تصمیم مالک پروژه (deployment config خارج repo). پس از A-01: bind غیر-loopback فقط با توکن | S5:UNKNOWN-0002؛ S2:POT-003 |
| **K-06** | P2 | رفتار داخلی @ai-sdk/mcp و ai@7 با SSE کند | تست با سرور SSE کند واقعی. معیار: بدون UND_ERR_BODY_TIMEOUT | S2:POT-005 |
| **K-07** | P3 | اثر SIGKILL واقعی روی waitForAll در shutdown | تست زنده kill. معیار: ترتیب shutdown حفظ | S2:REL-004 |
| **K-08** | P3 | discipline XSS در frontend (escapeHtml تک‌نقطه‌ای) | بازبینی هر PR DOM جدید + تست فرار رشته. تا آن زمان POTENTIAL می‌ماند | S2:POT-001؛ S2:ARCH-004 |
| **K-09** | P3 | re-verification زندهٔ R0-07/R0-09/R0-10 (رفع‌های ادعاشده) | اجرای سناریوهای بازتولید پس از فاز D. معیار: تست‌های موجود سبز + یک اجرای دستی | S2:§۹ نکته |

---

## §۴ — ردیابی کامل (اثبات «هیچ موردی از قلم نیفتاده»)

### ۴.۱ — ماتریس ۱۴۵یافتهٔ S1 → ردیف‌های این سند

**۲۱ مورد 🟢 (رفع‌شده، مرجع تاریخی):** R0-01..R0-05، R0-06..R0-12، R1-01، R1-02، R1-04..R1-10، R1-05(superseded)، R1-06، R1-07، R1-08، R1-09، R1-10. (خارج از دامنهٔ اجرا؛ در git log با کامیت‌های fix(R0-*)/fix(R1-*) قابل ردیابی‌اند.)

**۱۲۴ مورد باز → ردیف‌ها:**

| S1 | ردیف این سند |
|---|---|
| R1-03 | B-05 |
| R1-11 | B-07 |
| R1-12 | B-08 |
| R1-13 | C-14 |
| R2-01..R2-13 | C-01..C-12 (R2-01→C-01، R2-02→C-02، R2-03→C-03، R2-04→C-05، R2-05→C-06، R2-06→C-07، R2-07→C-08، R2-08→C-09، R2-09→C-04، R2-10→C-10، R2-11→C-11، R2-12→C-12، R2-13→D-18) |
| R3-01..R3-08 | (R3-01→D-01، R3-02→D-02، R3-03→D-03، R3-04→D-04، R3-05→D-06، R3-06→D-15، R3-07→D-16، R3-08→D-17) |
| R3-09..R3-17 | (R3-09→D-07، R3-10→D-08، R3-11→D-09، R3-12→D-10، R3-13→D-11، R3-14→D-05، R3-15→D-12، R3-16→D-13، R3-17→D-14) |
| R4-01..R4-12 | (R4-01→E-01، R4-02→E-02، R4-03→E-04، R4-04→E-05، R4-05→E-06، R4-06→E-07، R4-07→E-09، R4-08→E-10، R4-09→E-03، R4-10→E-11، R4-11→E-12، R4-12→E-08) |
| R5-01..R5-08 | (R5-01→F-01، R5-02→F-02، R5-03→F-03، R5-04→F-04، R5-05→F-05، R5-06→F-06، R5-07→F-07، R5-08→F-08) |
| R6-01..R6-17 | (R6-01→G-01، R6-02→B-01، R6-03→A-05، R6-04→A-05، R6-05→G-03، R6-06→G-04، R6-07→G-05، R6-08→G-06، R6-09→G-11، R6-10→G-12، R6-11→F-09، R6-12→G-07، R6-13→G-08، R6-14→G-02، R6-15→G-10، R6-16→G-09، R6-17→G-13) |
| R7-01..R7-07 | (R7-01→I-01، R7-02→I-04، R7-03→I-05، R7-04→I-03، R7-05→I-06، R7-06→I-07، R7-07→I-02) |
| R8-01..R8-09 | J-01..J-09 (نگاشت یک‌به‌یک: R8-01→J-01، …، R8-09→J-09) |
| R9-01..R9-14 | (R9-01→B-02، R9-02→B-06، R9-03→B-03، R9-04→B-11، R9-05→B-15، R9-06→H-11، R9-07→B-14، R9-08→B-09، R9-09→B-10، R9-10→B-12، R9-11→B-13، R9-12→C-13، R9-13→G-14، R9-14→G-15) |
| R10-01..R10-07 | B-16..B-22 (نگاشت کامل: R10-01→B-16، R10-02→B-17، R10-03→B-18، R10-04→B-19، R10-05→B-20، R10-06→B-21، R10-07→B-22) |
| R11-01..R11-14 | H-01..H-10، H-12..H-14 (R11-01→H-01، R11-02→H-02، R11-03→H-03، R11-04→H-04، R11-05→H-05، R11-06→H-06، R11-07→H-07، R11-08→H-08، R11-09→H-09، R11-10→A-04، R11-11→H-10، R11-12→H-12، R11-13→H-13، R11-14→H-14) |

### ۴.۲ — یافته‌های S2 (فارنزیک) → ردیف‌ها

| S2 | ردیف | نکته |
|---|---|---|
| SEC-001 | A-01 | + ۶ propagation از S3 |
| CONF-001 | A-02 | + ARCH-002 + DEBT-002 |
| SEC-003 | A-03 | |
| SEC-002 | A-06 | |
| POT-004 | A-07 | |
| BUG-001 | D-18 | رفع مشترک با C-11 (journal close/retention) — شرط summary واقعی + redaction substring + حداقل طول ۶ |
| ARCH-001 | C-04 | |
| BUG-002 | B-04 | هم‌ریشه با R1-08 (duplicate/overwrite id) |
| API-001 | B-20 | |
| REL-001 | B-10 | |
| REL-002 | C-03 | ادغام |
| REL-003 | F-09 | duplicate log lines با rebuild فاصله — همان رفع incremental tail |
| CONF-002 | G-16 | |
| DEBT-001 | D-15 | |
| DEBT-002 | A-02 | |
| DEBT-003/004 | I-08 | |
| DEBT-005 | I-07 | |
| TEST-001 | I-01 | |
| POT-001 | K-08 | |
| POT-002 | K-01 | |
| POT-003 | K-05 | |
| POT-005 | K-06 | |
| REL-004 | K-07 | |
| §۱۱ LOW (readEntries full scan) | F-09 | |
| R0-09/R0-10/R0-07 re-verify | K-09 | |

### ۴.۳ — یافته‌های S3 (ممیزی integration) → ردیف‌ها

| S3 | ردیف |
|---|---|
| F-0001 | G-18 — baseURL در ترمینال؛ پس از A-01 بلامانع، در غیر این صورت حذف چاپ |
| F-0002 | A-05 |
| F-0003 | A-01 |
| F-0004 | A-08 |
| F-0005 | A-01 |
| F-0006 | A-01 |
| F-0007 | F-10 |
| F-0008 | A-01 |
| F-0009 | A-01 |
| F-0010 | I-08 (doc drift) |
| F-0011 | F-09 |
| ENT/BND gaps | پوشش داده شد در ردیف‌های مربوط (B-03/B-12/H-04/...) |

*(G-18 ردیف کامل خودش را در فاز G §۳ دارد.)*

### ۴.۴ — S4 (READINESS) و S5 (unknowns) → ردیف‌ها

| منبع | ردیف |
|---|---|
| S4:P1 (provider واقعی) ⛔ | K-01 |
| S4:P8 (windows-leg) 🟡 | K-02 |
| S4:باگ‌های N..AM (رفع‌شده) | مرجع تاریخی؛ تست‌های موجود سبز می‌مانند |
| S4:P10 جانبی (step events) | قبلاً در AC/AD رفع شده — خارج |
| S5:UNKNOWN-0001 | K-04 |
| S5:UNKNOWN-0002 | K-05 |
| S5:UNKNOWN-0003 | K-01 |
| S5:UNKNOWN-0004 | K-03 |

### ۴.۵ — شمارش نهایی ردیف‌های باز

| فاز | ردیف‌ها | شمار |
|---|---|---|
| A | A-01..A-08 | ۰ 🟢 |
| B | B-01..B-22 | ۰ 🟢 |
| C | C-01..C-14 | ۰ 🟢 |
| D | D-01..D-18 | ۰ 🟢 |
| E | E-01..E-12 | ۰ 🟢 |
| F | F-01..F-10 | ۰ 🟢 |
| G | G-01..G-18 | ۰ 🟢 |
| H | H-01..H-14 | ۰ 🟢 |
| I | I-01..I-08 | ۸ |
| J | J-01..J-09 | ۹ |
| K | K-01..K-09 | ۹ |
| | **جمع** | **۲۶** |

---

## §۵ — ترتیب اجرا (DAG)

```
A (امنیت) ──┬─→ B (state) ─→ C (runtime) ─┬─→ F (perf) ─→ H (UI) ─→ J (features)
            │                             └─→ G (CLI/server) ─┘
K-03 (baseline سبز) ──→ همهٔ فازها (پیش‌نیاز اعتبار تست)
K-01/K-02 موازی با هر فاز (بیرونی)
D (ابزارها) پس از C-01 (abortSignal ابزارها)
E (context) پس از I-01 (fake LLM واکنش‌گرا)
I-01 زودهنگام؛ I-02 مستمر؛ I-08/I-07 انتهایی
```

**قواعد اجرا (از S1 حفظ شد):** هر فاز = یک مرحلهٔ اجرا؛ تست fail-سپس-pass پیش از رفع؛ `tsc --noEmit` + `vitest run` + `npm run e2e` سبز؛ کامیت و push جدا per فاز؛ تیک 🟢 در همین سند؛ ورودی در `CHANGELOG.md`.

## §۶ — معیار پذیرش کل سند

1. همهٔ ردیف‌های P0 (۲۳ ردیف) 🟢 شوند؛ P1/P2 یا 🟢 یا با دلیل مکتوب «پذیرفته‌شده/کنارگذاشته» در همین فایل.
2. K-01 تا K-03 بسته شوند (سبز واقعی روی provider و ماتریس و workspace).
3. شمارش تست‌های regression جدید ≥ تعداد ردیف‌های رفع‌شده (I-02).
4. اندازه‌گیری‌های F قبل/بعد ثبت شود؛ کاهش توکن ابزارهای coder ≥ ۶۰٪.
5. `CHANGELOG.md` برای هر فاز یک ورودی؛ این سند تنها مرجع status باشد (سندهای منبع freeze شوند با ارجاع به اینجا).

## §۷ — جدول وضعیت اجرا (برای تیک‌زدن)

| فاز | وضعیت | تاریخ | کامیت |
|---|---|---|---|
| A | 🟢 | 2026-09-27 | 3887ed5 |
| B | 🟢 | 2026-09-27 | 9b41a9c |
| C | 🟢 | 2026-09-27 | f977650 |
| D | 🟢 | 2026-09-27 | 87c3ade |
| E | 🟢 | 2026-09-27 | 619c739 |
| F | 🟢 | 2026-09-27 | 366a4e0 |
| G | 🟢 | 2026-09-27 | 720c267 |
| H | 🟢 | 2026-09-27 | f8b0bb1 |
| I | 🟢 | 2026-09-27 | |
| J | ⬜ | | |
| K | ⬜ | | |

---
*پایان سند. هر تغییر وضعیت فقط با ویرایش همین فایل و کامیت مرتبط.*
