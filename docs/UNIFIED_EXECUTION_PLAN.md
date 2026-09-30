# پلن اجرایی واحد و ردیابی‌شده (UNIFIED EXECUTION PLAN)

**شناسه سند:** `docs/UNIFIED_EXECUTION_PLAN.md`
**تاریخ تألیف:** 2026-09-26
**آخرین به‌روزرسانی:** 2026-09-27 (پس از Code Review فازهای A–K)
**مبنای کد:** شاخه `arena/01a0e249-human-out-of-the-loop`؛ v27.17.16 — A–J 🟢؛ فاز R (اصلاحات Code Review) 🟢؛ K: K-03/K-04/K-06/K-08/K-09 🟢، بقیه با مالک
**جایگاه:** این سند، **تنها مرجع ردیابی و اجرا** برای رفع همهٔ نواقص و باگ‌های شناسایی‌شده است. هر موردی که در هر سند منبع ثبت شده، یا اینجا یک ردیف دارد یا صراحتاً به یک ردیف ادغام شده — **هیچ موردی حذف نشده است** (اثبات کامل تطبیق در §۴).

---

## §۱ — منابع ادغام‌شده (۵ سند)

| # | سند منبع | محتوا | وضعیت |
|---|---|---|---|
| S1 | `docs/REVIEW_EXECUTION_PLAN.md` (834 خط) | ماتریس ۱۴۵ یافته R0–R11 + فازهای R8 (قابلیت جدید) | ۱۲۴ ردیف اجرایی در A–J 🟢؛ باقی‌مانده فقط K (بیرونی) |
| S2 | `docs/FORENSIC_AUDIT_REPORT.md` (891 خط) | ممیزی فارنزیک ۱۹بخشی: SEC/BUG/ARCH/REL/CONF/DEBT/POT/TEST/OPS + Appendix B | POT-001/005 🟢 (K-08/K-06)؛ ARCH-003 و OPS-001 و Appendix B-1 (در نسخهٔ قبلی این سند جا افتاده بودند) → R-28/R-27/R-29 🟢؛ POT-002/003 و REL-004 هنوز با مالک |
| S3 | `audit/` (workspace ممیزی integration) | ۶۵ EP، ۶۰ WF، ۵ ENT، ۱۰ BND، یافته‌های F-0001..F-0011 | F-0007 سقف SSE 🟢 (K-04)؛ بقیهٔ بازها در K-01/K-03 |
| S4 | `docs/READINESS_AUDIT.md` (514 خط) | ۱۰ محور readiness P1–P10 + CI | P1 ⛔ = K-01؛ P8 🟡 = K-02 (ماتریس در `ci.yml` هست، verdict Actions با مالک) |
| S5 | `audit/unknowns.md` + Appendix B فارنزیک | ۴ + ۱۰ مورد UNKNOWN/UNVERIFIED | UNKNOWN-0001 🟢 (K-04)؛ UNKNOWN-0004 🟢 (K-03)؛ 0002/0003 مالک؛ Appendix B-1..B-10 در §۴.۲ |
| S6 | Code Review فازهای A–K (همین شاخه، 2026-09-27) | باگ‌ها/پس‌رفت‌هایی که خودِ رفع‌ها ساختند یا ناقص گذاشتند | همه در فاز R 🟢 (R-01…R-30) |

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
| R | اصلاحات Code Review فازهای A–K | ۰ 🟢 | ۰ |
| K | راستی‌آزمایی بیرونی (نیازمند ورودی کاربر/محیط) | ۵ 🟡 | ۱ |
| | **جمع ردیف‌های باز** | **۵** | **۱** |

---

## §۳ — دستور کار (ردیف‌های قابل اجرا)

اولویت: P0 = پیش از هر دیپلوی/اشتراک‌گذاری · P1 = بلوک‌کننده کیفیت · P2 = مهم · P3 = بهبود.
ستون «رفع/تست» خلاصه فنی است؛ شرح کامل، معیار پذیرش و محل دقیق در سند منبع (ستون آخر) آمده است.

### فاز A — امنیت: سرور وب و گیت اعتماد 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.4)

| ID | Pri | عنوان | رفع / تست | منبع |
|---|---|---|---|---|
| **A-01** 🟢 | P0 | سرور وب بدون auth روی 0.0.0.0 (UI با توکن: R-07) | bind پیش‌فرض 127.0.0.1؛ token middleware مشابه `serve --http` (`transports.ts:169-174` الگو)؛ `HOTL_SERVER_TOKEN`/`--token`؛ بدون توکن و host≠loopback → refuse startup. تست: درخواست بدون توکن → 401 روی همهٔ routeها | S2:SEC-001؛ S3:F-0003/0004/0005/0006/0008/0009؛ S1:غیردامنه(سرور) |
| **A-02** 🟢 | P0 | گیت اعتماد R0-08 نیمه‌پیاده — `--trust-project` وجود ندارد | سیم‌کشی پرچم در `run`/`repl`/`serve` + persist با `trust.ts` و `GlobalCliConfig.trustedProjects`. تست: پروژهٔ غیرمطمئن → mcp-servers لایهٔ پروژه spawn نشود؛ پس از پرچم → اجرا | S1:R0-08(بخش سیم‌کشی)؛ S2:CONF-001,ARCH-002,DEBT-002 |
| **A-03** 🟢 | P0 | دورزدن گیت اعتماد در ۳ مسیر introspection | `collectMcpTools` (`registry.ts:150`)، `mcpTestCommand` (`mcp.ts:87`)، `POST /api/mcp/:id/test` (`routes/registry.ts:110`) همگی با همان فیلتر `trustedProject`. تست برای هر ۳ مسیر | S2:SEC-003؛ S3:WF-0021..27(W1.3),WF-0038..45(W1.3) |
| **A-04** 🟢 | P0 | اجرا در مرحلهٔ پلن‌سازی قابل لغو نیست | `POST /api/runs/:runId/cancel` + `AbortSignal` تا planner. تست: لغو حین planning → هیچ فراخوانی LLM بعدی | S1:R11-10؛ S3:WF-0002 |
| **A-05** 🟢 | P0 | ران‌های رهاشده (clarification/confirmation) هرگز timeout نمی‌شوند | TTL قابل پیکربندی (پیش‌فرض ۳۰ دقیقه → `confirmed:false`) + cleanup resolver در cancel. تست: TTL → run `cancelled`، interaction بسته | S1:R6-03؛ S3:F-0002؛ S1:R6-04(map رشد) ادغام شد |
| **A-06** 🟢 | P1 | schema MCP فیلد `env` ندارد؛ تناقض کامنت | افزودن `env: Record<string,string>` (از EnvSource) به `McpServerConfigSchema` و پاس‌دادن به `createStdioTransport`؛ یا پاکسازی کامنت‌ها. تست: env سفارشی به فرزند برسد | S2:SEC-002 |
| **A-07** 🟢 | P1 | قید scheme/url و tokenEnvVar در schema MCP | zod refine: scheme فقط http/https برای http-transport؛ `tokenEnvVar` الگوی نام متغیر. تست: `file://` و env-var نامعتبر رد شود | S2:POT-004 |
| **A-08** 🟢 | P2 | ownership فقط با دانستن UUID (در ابتدا فقط runها؛ session/plan/stream/log در R-17 تکمیل شد) | مدل مالکیت حداقلی: session/plan bound به توکن/کلاینت در سرور (پس از A-01)؛ یا صراحتاً پذیرفته‌شده و مستند. تست: کلاینت A روی run کلاینت B (پس از auth) 403 بگیرد | S3:F-0004/0007(SEC-001 propagation) |

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
| **E-11** 🟡 | P2 | پیش‌فرض‌های مدل کهنه؛ سخت‌کد 'gpt-4o' ×۲۳ | ✅ ثابت واحد `DEFAULT_MODEL_ID` و اولویت maxContextTokens پیکربندی. ⛔ تغییر مقدار پیش‌فرض به `claude-sonnet-5` انجام **نشده** (مقدار هنوز `gpt-4o`): عوض‌کردن provider پیش‌فرض برای همهٔ کاربران تصمیم مالک است → **K-10** | S1:R4-10 |
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

### فاز K — راستی‌آزمایی بیرونی (نیازمند ورودی کاربر/محیط) 🟡 (۲۰۲۶-۰۹-۲۷، v27.17.15 — جزئی)

| ID | Pri | مورد | رفع / تست | منبع |
|---|---|---|---|---|
| **K-01** 🟢 | P0 | اجرا با provider واقعی (OpenAI/Anthropic) | `real-provider.yml` روی gateway مالک (OpenAI-compatible، HOTL_BASE_URL) سبز شد، با ۴ سناریو: فایل تک‌خطی، کد چندفایلی (`src/math.js` + یادداشت؛ با re-plan خودکار پس از پاسخ خالی مدل)، درخواست فارسی، و خواندن فایل پروژه و استخراج داده (`coder`/`48` — دقیق). هر اجرا: plan ذخیره شد، توکن واقعی، بدون نشت کلید. یافته‌های همین اجراها رفع شد: `.env` در checkpoint کپی می‌شد (نشت کلید)، پاسخ 200 نامعتبر gateway بدون retry، درخواست فارسی در auto به «@plan بزنید» ختم می‌شد. مدل‌های ضعیف در structured output (مثلاً laguna) در planning شکست می‌خورند — انتخاب مدل با K-10. | S4:P1؛ S5:UNKNOWN-0003؛ S2:POT-002 |
| **K-02** 🟢 | P1 | windows-leg ماتریس CI | ماتریس کامل `ci.yml` (ubuntu/macos/windows × node 22/24/26 + e2e روی هر سه) سبز. رفع‌شده در مسیر: ریشهٔ مجاز پشت symlink (macOS `/var`→`/private/var`، Windows نام کوتاه `RUNNER~1`) همهٔ ابزارهای فایل را قفل می‌کرد؛ git toplevel؛ checkpoint مبتنی بر mtime؛ rename گذرا در Windows؛ و تست‌های وابسته به مسیر POSIX. بازتولید macOS روی Linux: `TMPDIR` پشت symlink. | S4:P8 |
| **K-03** 🟢 | P1 | baseline typecheck/test | پس از فاز R: tsc 0، build 0، vitest **1670/1670** (و با ترتیب تصادفی، ۳ seed)، e2e **209/209**. (پیش از R: 1607/19 و 144/194.) خلاصه: `audit/baseline/k03-SUMMARY.md`. اجرای ماتریس CI همچنان K-02 است. | S5:UNKNOWN-0004؛ S3:P2 |
| **K-04** 🟢 | P2 | اندازهٔ SSE / log | سقف اتصال ۳۲ + بافر ۲۰۰؛ تست synthetic `phase-k-sse-scale.test.ts` (به‌علاوهٔ F-10 در `phase-f-perf.test.ts`). telemetry پروداکشن نیست — پذیرش مکتوب همین سقف‌ها به‌عنوان کنترل F-10. | S5:UNKNOWN-0001؛ S3:F-0007/0011 |
| **K-05** | P2 | bind غیر-loopback در دیپلوی | 🟡 تصمیم مالک. پس از A-01 غیر-loopback فقط با توکن. `audit/baseline/K05_BIND_OWNER.md` | S5:UNKNOWN-0002؛ S2:POT-003 |
| **K-06** 🟢 | P2 | MCP SSE کند / UND_ERR_BODY_TIMEOUT | `bodyTimeout: 0`؛ تست زندهٔ استریم ساکت `phase30-p10-fetch.test.ts`؛ قفل مقدار در `phase-k-sse-scale.test.ts` | S2:POT-005 |
| **K-07** | P3 | SIGKILL روی waitForAll | 🟡 نیمه: cancel مسیر shutdown را باز می‌کند (`phase-k-shutdown.test.ts`). SIGKILL واقعی قابل catch نیست — تست زنده با مالک. | S2:REL-004 |
| **K-08** 🟢 | P3 | XSS / escapeHtml تک‌نقطه‌ای | `escapeHtml`/`renderMarkdown` فقط در `public/ui-logic.js`؛ اسکن innerHTML + payload. تست: `phase-k-xss.test.ts` | S2:POT-001؛ S2:ARCH-004 |
| **K-10** | P2 | مقدار مدل پیش‌فرض (باقی‌ماندهٔ E-11) | 🟡 تصمیم مالک: `DEFAULT_MODEL_ID` در `src/ai/models/defaults.ts` یک‌جا عوض می‌شود؛ مدل جدید باید در `registry/models` باشد و کاربران بدون کلید Anthropic باید مطلع شوند | S1:R4-10 |
| **K-09** 🟢 | P3 | re-verify R0-07/09/10 | تست‌های اصلی + `phase-k-r0-reverify.test.ts` سبز (همراه `r0-07-key-leak.test.ts`، `r0-09-protected-paths.test.ts`، `r0-10-outside-workspace.test.ts`) | S2:§۹ نکته |

### فاز R — اصلاحات Code Review فازهای A–K 🟢 (۲۰۲۶-۰۹-۲۷، v27.17.16)

بازبینی کد رفع‌های A–K (منبع S6) این موارد را یافت: پس‌رفت یا باگی که خودِ رفع ساخت، رفعی که ناقص بود، یا یافتهٔ منبعی که در نسخهٔ قبلی این سند جا افتاده بود. هر ردیف تست regression دارد؛ بیشترشان در `src/ai/__tests__/review-fixes.test.ts` (نام describe = ID ردیف).

| ID | Pri | مشکل | رفع / تست | کامیت | ریشه |
|---|---|---|---|---|---|
| **R-01** 🟢 | P0 | نتیجهٔ ابزارِ کوتاه‌شده شکل `ToolResultOutput` نداشت → از فراخوانی چهارمِ ابزار، پیام tool بدون content به provider می‌رفت | stub `{type:'text',value}`؛ اندازه per-message (نه O(n²)). تست با provider واقعی OpenAI در `phase-f-perf.test.ts` | `78b0545` | F-04 |
| **R-02** 🟢 | P1 | `registry/models/local-llama.json` با config شخصی (`local-aur`) جایگزین شده بود → ۸ تست قرمز | بازگردانی فایل پکیج | `78b0545` | کامیت `12c06b5` |
| **R-03** 🟢 | P0 | `ANTHROPIC_API_KEY` به هر `baseURL` سفارشی می‌رفت؛ `apiKeyEnv` می‌توانست کلید اصلی را نام ببرد | قاعدهٔ R0-07 برای هر دو provider. `r0-07-key-leak.test.ts` | `fb9e8c5`، `5ee92d4` | E-03 |
| **R-04** 🟢 | P0 | `run_command`: allowlist فقط basename (`./evil/npm`)، `commands.json` پروژهٔ untrusted خوانده می‌شد، allowlist خالی = هر testCommand، کل env (کلیدها) به فرزند | گیت اعتماد، تطبیق دقیق argv[0]، env بدون credential. `phase-j-run-command.test.ts` | `9090d78` | J-01/J-02 |
| **R-05** 🟢 | P1 | rollback چک‌پوینت کار مرحلهٔ هم‌زمان را پاک می‌کرد؛ کپی کامل درخت در هر مرحله، بدون پاک‌سازی | rollback فقط بدون هم‌زمانی؛ reflink، سقف ۵۰۰۰ فایل/۲۰۰MB، ۲ snapshot/plan، prune ۷ روزه. `phase-j-checkpoint.test.ts` | `868c28e` | J-05 |
| **R-06** 🟢 | P1 | چک‌پوینت همیشه در `<project>/.ai-runtime` (نه runtimeDir) — تست‌ها ~۲۰۰MB snapshot از خود مخزن ساختند؛ restore هر فایلِ غایب را حذف می‌کرد | ذخیره در runtimeDir؛ حذف فقط فایل‌های پس از snapshot | `51fc52e` | J-05 |
| **R-07** 🟢 | P0 | UI توکن نمی‌فرستاد (fetch و EventSource) → با `--token` کل UI 401 | `?token=` یک‌بار → sessionStorage؛ header در fetch؛ `?access_token=` فقط روی دو مسیر GET SSE. `phase-a-security.test.ts` | `68eb720` | A-01 |
| **R-08** 🟢 | P1 | timeout ایجنت وقتی فراخوانی abort را نادیده می‌گرفت هرگز برنمی‌گشت | بازگشت فوری + `settled`؛ قفل/اسلات تا settle (سقف ۳۰s)؛ `waitForAll` منتظر آزادسازی | `ff32bd1` | C-01 |
| **R-09** 🟢 | P1 | Ctrl-C/shutdown/cancel اپراتور re-plan پولی می‌ساخت | پرچم صریح `cancelled`؛ Ctrl-C در سؤال feedback؛ abort حین re-plan | `5271971` | B-07 × G-07 |
| **R-10** 🟢 | P1 | تاریخچهٔ session و budget، state مشترک Planner/Orchestrator — اجراهای هم‌زمان وب هم را می‌دیدند | AsyncLocalStorage per run | `e290552` | B-15، J-03 |
| **R-11** 🟢 | P1 | reconcile، interaction/پلن draft اجرای زنده (همین سرور یا CLI دیگر) را لغو می‌کرد | `ownerPid` روی interaction؛ رد live | `14f6cc7` | B-06 |
| **R-12** 🟢 | P2 | توکن chat دو بار شمرده می‌شد؛ review چت/clarification کل مصرف orchestrator را گزارش می‌داد | tally per-run | `06b05db` | C-06/C-14 |
| **R-13** 🟢 | P1 | `delegate_task`: والدِ منتظر اسلات را نگه می‌داشت → deadlock | والد اسلاتش را قرض می‌دهد | `34823b0` | C-07 |
| **R-14** 🟢 | P1 | قفل مالکیت پلن اتمیک نبود | check+write زیر قفل. تست چندپروسه‌ای | `6f65cc1` | B-01 |
| **R-15** 🟢 | P1 | شکستن قفل کهنه می‌توانست قفل تازه را بدزدد؛ pid بازیافتی = قفل ابدی | هویت inode+محتوا؛ سقف سخت ۱۰ دقیقه | `0c00624` | C-10 |
| **R-16** 🟢 | P1 | persona با ابزار سرور MCP قطع/skip‌شده، startup را متوقف می‌کرد (تناقض B-18/B-19) | هشدار در حالت degraded؛ typo واقعی همچنان خطا | `05a35a9`، `f26895e` | B-18/B-19 |
| **R-17** 🟢 | P2 | A-08 فقط runها را پوشش می‌داد | session/plan/stream/log/list per owner. `phase-a-security.test.ts` | `32c78d4` | A-08 |
| **R-18** 🟢 | P2 | settle روی `exit` → خروجی git/command بریده | `close` یا ۲۵۰ms پس از `exit`؛ تست D-07 zombie را مرده می‌شمارد | `cb1ec6c` | D-07 |
| **R-19** 🟢 | P2 | درخواست فارسی با مسیر/شناسهٔ کد، فارسی تشخیص داده نمی‌شد | فقط واژه‌های prose شمرده می‌شوند | `0ae0e27` | E-08 |
| **R-20** 🟢 | P2 | سقف نتیجهٔ ابزار فیلدها را به ۲۰۰۰ کاراکتر می‌برید | برش به اندازهٔ overshoot | `81240fa` | F-03 |
| **R-21** 🟢 | P3 | دو `stat` در هر نوشتن log؛ فایل‌های چرخیده بی‌پایان؛ نام تکراری در یک ms؛ retention ثابت | یک stat؛ ۵ فایل آخر؛ نام یکتا؛ `HOTL_RETENTION_DAYS` | `9e6d389`، `d21d362` | C-11 |
| **R-22** 🟢 | P3 | انتظارهای TaskRuntime هر ۱۰–۱۵ms poll | سیگنال تغییر وضعیت | `d21d362` | C-08/B-14 |
| **R-23** 🟢 | P3 | فایل مختلط CRLF/LF کلاً CRLF می‌شد | EOL per line با diff خطی | `6304c89` | D-03 |
| **R-24** 🟢 | P1 | resume پلن با گام `done` داوری‌نشده → crash در acceptance | Task کامل مصنوعی | `5430b9c` | B-08 |
| **R-25** 🟢 | P2 | C-02 re-ask v27.17.2 را شکست؛ G-02 قبل از pre-flight رایگان | re-ask فقط پیش از هر خروجی؛ G-02 پس از pre-flight و نه در chat | `5430b9c` | C-02، G-02 |
| **R-26** 🟢 | P1 | پاسخ chat دستور زبان کاربر را نمی‌گرفت (E-07 آن را از prompt برداشت ولی به agent چت نداد) | `buildChatAgent(…, language)` | `0f06514` | E-07 |
| **R-27** 🟢 | P2 | OPS-001: ۱۰–۱۲ تست با ترتیب تصادفی قرمز | reset mockها در phase11؛ phase42 سناریوی مرتب (`shuffle:false`) | `815aafa` | S2:OPS-001 |
| **R-28** 🟢 | P3 | ARCH-003: سه پیاده‌سازی جدا برای لایه‌بندی mcp-servers (`tools --mcp` حتی سرورهای پکیج را در پروژهٔ untrusted رد می‌کرد) | `loadLayeredMcpServers` + `mayConnectMcpServer` | `855b9fa` | S2:ARCH-003 |
| **R-29** 🟢 | P3 | Appendix B-1: `.env.example` نبود | افزوده شد (بدون مقدار) | `815aafa` | S2:App.B-1 |
| **R-30** 🟢 | P1 | کاتالوگ پلن‌ساز ابزار persona را در ۱۶ می‌برید (coder: ۴۸)؛ stub e2e، persona بی‌ابزار `judge` را انتخاب می‌کرد؛ کلید اکو‌شده از `handoff` به فایل پلن می‌رسید؛ e2e بدون HOME ایزوله | کاتالوگ کامل؛ stub اصلاح؛ scrub عمیق پلن؛ HOME موقت. e2e 144/194 → 209/209 | `55e8756`، `0f06514`، `8514b82` | E-01، I-01، J-04 |

**ثبت تست‌های فاز K (اجرا شده در همین شاخه، 2026-09-27):**

| ID | فایل تست | چه چیزی اثبات می‌شود | نتیجهٔ آخرین اجرا |
|---|---|---|---|
| K-03 | `audit/baseline/k03-SUMMARY.md` (نه vitest واحد) | `tsc --noEmit`؛ `vitest run` کامل؛ `npm run e2e` | tsc ✅ · vitest 1670/1670 · e2e 209/209 → 🟢 |
| K-04 | `src/ai/__tests__/phase-k-sse-scale.test.ts` | سقف N+1 اتصال؛ ring buffer ≤ `bufferSize` | ✅ |
| K-06 | همان فایل + `src/ai/__tests__/phase30-p10-fetch.test.ts` | `MCP_STREAM_BODY_TIMEOUT_MS === 0`؛ استریم ساکت با fetch پیش‌فرض می‌میرد، با MCP fetch زنده می‌ماند | ✅ |
| K-07 | `src/ai/__tests__/phase-k-shutdown.test.ts` | `cancelTask` → `waitForAll` در < ۲s برمی‌گردد | ✅ (نیمه؛ SIGKILL زنده نیست) |
| K-08 | `src/ai/__tests__/phase-k-xss.test.ts` | payload `<script>`/`onerror`؛ markdown escape-first؛ هیچ `${…}` در `innerHTML` بدون `escapeHtml`/`renderMarkdown` | ✅ |
| K-09 | `src/ai/__tests__/phase-k-r0-reverify.test.ts` | R0-07 کلید به baseURL سفارشی نمی‌رود؛ R0-09 `.git`/`.ai-runtime` دست‌نخورده؛ R0-10 `git_reset --hard` خارج از workspace را رد می‌کند | ✅ |
| K-09 (اصلی) | `r0-07-key-leak.test.ts`، `r0-09-protected-paths.test.ts`، `r0-10-outside-workspace.test.ts` | همان قراردادها، فایل‌های hardening اولیه | ✅ همزمان با K-09 |
| K-01/K-02/K-05 | — | تست خودکار در این محیط ممکن نیست | چک‌لیست مالک در `audit/baseline/` |

---

## §۴ — ردیابی کامل (اثبات «هیچ موردی از قلم نیفتاده»)

### ۴.۱ — ماتریس ۱۴۵یافتهٔ S1 → ردیف‌های این سند

**۲۱ مورد 🟢 (رفع‌شده پیش از این سند، مرجع تاریخی):** R0-01، R0-02، R0-03، R0-04، R0-05، R0-06، R0-07، R0-08، R0-09، R0-10، R0-11، R0-12، R1-00 (mode در re-plan پس از clarification)، R1-01، R1-02، R1-04..R1-10، R1-05(superseded)، R1-06، R1-07، R1-08، R1-09، R1-10. در git log با کامیت‌های `fix(R0-*)`/`fix(R1-*)`. R0-07/09/10 در K-09 دوباره سبز شدند.

**۱۲۴ مورد که در تألیف سند باز بودند — همه از طریق ردیف‌های A–J بسته شده‌اند.** نگاشت پایدار (S1 → ردیف این سند) برای ردپا:

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
| POT-001 | K-08 🟢 | `phase-k-xss.test.ts` |
| POT-002 | K-01 ⛔ | مالک / کلید واقعی |
| POT-003 | K-05 🟡 | تصمیم دیپلوی |
| POT-005 | K-06 🟢 | `phase30-p10-fetch.test.ts` + `phase-k-sse-scale.test.ts` |
| REL-004 | K-07 🟡 | `phase-k-shutdown.test.ts` (نه SIGKILL زنده) |
| §۱۱ LOW (readEntries full scan) | F-09 | |
| R0-09/R0-10/R0-07 re-verify | K-09 🟢 | `phase-k-r0-reverify.test.ts` + r0-07/09/10 |
| ARCH-003 | R-28 🟢 | در نسخهٔ قبلی جا افتاده بود |
| ARCH-004 (INFO) | K-08 🟢 | همان ریسک POT-001 |
| OPS-001 (UNVERIFIED) | R-27 🟢 | با `--sequence.shuffle` بازتولید و رفع شد |
| §12 شکاف تست #1 (TEST-001) | I-01 🟢 | |
| §12 شکاف تست #2 (BUG-001 summary) | D-18 🟢 | |
| §12 شکاف تست #3/#4/#5 (SEC-003/CONF-001/SEC-001) | A-03/A-02/A-01 🟢 | `phase-a-security.test.ts` |
| §12 شکاف تست #6 (429 integration) | C-04 🟢 | `phase-c-model-retry.test.ts` (AgentRuntime → 429 → retry) |
| §12 شکاف تست #7 (REL-001 persist) | B-10 🟢 | |
| §12 شکاف تست #8 (e2e 429/timeout) | 🟢 | سناریوی e2e `faults` (`FAULT:429`/`500`/`401`/`HANG`) — مستقل از POT-002 |
| Appendix B-1 (`.env.example`) | R-29 🟢 | |
| Appendix B-2 (provider واقعی) | K-01 ⛔ | |
| Appendix B-3 (workflowها) | 🟢 | `.github/workflows/ci.yml` و `real-provider.yml` در شاخه موجودند (I-04/I-06) |
| Appendix B-4 (XSS) | K-08 🟢 | |
| Appendix B-5 (schema MCP) | A-07 🟢 | |
| Appendix B-6 (shutdown سیگنال) | K-07 🟡 | |
| Appendix B-7 (readEntries بزرگ) | F-09 🟢 | |
| Appendix B-8 (R0 re-verify) | K-09 🟢 | |
| Appendix B-9 / B-10 (نسخه/شمارش مستندات) | I-07 🟢 | README/CHANGELOG با v27.17.16 و شمارش واقعی |

### ۴.۳ — یافته‌های S3 (ممیزی integration) → ردیف‌ها

| S3 | ردیف |
|---|---|
| F-0001 | G-18 — baseURL در ترمینال؛ پس از A-01 بلامانع، در غیر این صورت حذف چاپ |
| F-0002 | A-05 |
| F-0003 | A-01 |
| F-0004 | A-08 |
| F-0005 | A-01 |
| F-0006 | A-01 |
| F-0007 | F-10 + K-04 🟢 (سقف ۳۲ / بافر ۲۰۰) |
| F-0008 | A-01 |
| F-0009 | A-01 |
| F-0010 | I-08 (doc drift) |
| F-0011 | F-09 |
| ENT/BND gaps | پوشش داده شد در ردیف‌های مربوط (B-03/B-12/H-04/...) |

*(G-18 ردیف کامل خودش را در فاز G §۳ دارد.)*

### ۴.۴ — S4 (READINESS) و S5 (unknowns) → ردیف‌ها

| منبع | ردیف |
|---|---|
| S4:P1 (provider واقعی) ⛔ | K-01 (باز؛ چک‌لیست `K01_OWNER_CHECKLIST.md`) |
| S4:P8 (windows-leg) 🟡 | K-02 (باز؛ `K02_CI_WINDOWS.md`) |
| S4:باگ‌های N..AM (رفع‌شده) | مرجع تاریخی؛ تست‌های موجود سبز می‌مانند |
| S4:P10 جانبی (step events) | قبلاً در AC/AD رفع شده — خارج |
| S5:UNKNOWN-0001 | K-04 🟢 پذیرش مکتوب سقف SSE |
| S5:UNKNOWN-0002 | K-05 🟡 (`K05_BIND_OWNER.md`) |
| S5:UNKNOWN-0003 | K-01 ⛔ |
| S5:UNKNOWN-0004 | K-03 🟢 (`k03-SUMMARY.md`) |

### ۴.۵ — شمارش نهایی ردیف‌های باز (پس از v27.17.16)

| فاز | ردیف‌ها | شمار باز |
|---|---|---|
| A | A-01..A-08 | ۰ 🟢 |
| B | B-01..B-22 | ۰ 🟢 |
| C | C-01..C-14 | ۰ 🟢 |
| D | D-01..D-18 | ۰ 🟢 |
| E | E-01..E-12 | ۰ 🟢 |
| F | F-01..F-10 | ۰ 🟢 |
| G | G-01..G-18 | ۰ 🟢 |
| H | H-01..H-14 | ۰ 🟢 |
| I | I-01..I-08 | ۰ 🟢 |
| J | J-01..J-09 | ۰ 🟢 |
| R | R-01..R-30 | ۰ 🟢 |
| K | K-01، K-02، K-05، K-07، K-10 | ۵ 🟡 |
| | **جمع باز** | **۵** (P0 = K-01) |

K-03 / K-04 / K-06 / K-08 / K-09 🟢. E-11 به‌خاطر مقدار پیش‌فرض مدل 🟡 است و ادامه‌اش K-10 است.

---

## §۵ — ترتیب اجرا (DAG)

```
A 🟢 ─→ B 🟢 ─→ C 🟢 ─┬─→ F 🟢 ─→ H 🟢 ─→ J 🟢
                     └─→ G 🟢 ─┘
D 🟢 پس از C-01 · E 🟢 · I 🟢
K-03/K-04/K-06/K-08/K-09 🟢 (این شاخه) ─→ R 🟢 (Code Review)
K-07 🟡 نیمه
K-01 ⛔ / K-02 🟡 / K-05 🟡 / K-10 🟡 ── موازی، ورودی مالک/CI
```

**قواعد اجرا (از S1 حفظ شد):** هر فاز = یک مرحلهٔ اجرا؛ تست fail-سپس-pass پیش از رفع؛ `tsc --noEmit` + `vitest run` + `npm run e2e` سبز؛ کامیت و push جدا per فاز؛ تیک 🟢 در همین سند؛ ورودی در `CHANGELOG.md`. K-03 اکنون با suite تمام‌سبز ثبت است (`audit/baseline/k03-SUMMARY.md`).

## §۶ — معیار پذیرش کل سند

1. همهٔ ردیف‌های P0 داخل‌ریپو 🟢 شدند. تنها P0 باز **K-01** است (کلید واقعی — خارج از sandbox).
2. K-03 🟢 (tsc/vitest/e2e تمام‌سبز). K-01/K-02/K-05/K-10 ورودی مالک/CI می‌خواهند.
3. I-02 پوشش A–H دارد؛ J و K فایل تست مستقل per-ID دارند (`phase-j-*.test.ts`، `phase-k-*.test.ts`).
4. اندازه‌گیری‌های F در فاز F ثبت شد.
5. `CHANGELOG.md` برای هر فاز یک ورودی (A…J کامل؛ K = `[27.17.15]`؛ R = `[27.17.16]`)؛ این سند تنها مرجع status است.

## §۷ — جدول وضعیت اجرا (برای تیک‌زدن)

| فاز | وضعیت | تاریخ | کامیت |
|---|---|---|---|
| A | 🟢 | 2026-09-27 | `d8c02cf` |
| B | 🟢 | 2026-09-27 | `db443ec` |
| C | 🟢 | 2026-09-27 | `c15ea77` |
| D | 🟢 | 2026-09-27 | `763baec` |
| E | 🟢 | 2026-09-27 | `d20659c` |
| F | 🟢 | 2026-09-27 | `b18f389` |
| G | 🟢 | 2026-09-27 | `720c267` |
| H | 🟢 | 2026-09-27 | `433188d` |
| I | 🟢 | 2026-09-27 | `d4f4cb7` |
| J | 🟢 | 2026-09-27 | `5a4b51e` |
| K | 🟡 جزئی | 2026-09-27 | `b2a8acb` (K-03/04/06/08/09 🟢؛ K-01/02/05/07/10 با مالک) |
| R | 🟢 | 2026-09-27 | `78b0545` … `51fc52e` (هش هر ردیف در جدول فاز R) |

---

## §۸ — Addendum: Workflow Profiles v1 (2026-09-29, append-only)

این الحاقیه وضعیت و traceability کار Workflow Profiles را ثبت می‌کند؛ هیچ وضعیت تاریخی A–K/R، baseline یا source audit این سند را جایگزین نمی‌کند. پلن اجرایی تفصیلی: `docs/workflow-profiles/EXECUTION_PLAN.md`؛ گزارش شواهد Phase 1: `docs/workflow-profiles/PHASE1_BASELINE.md`.

**Baseline فعلی این کار:** `main` = `ff7c030afaa20b8a343cdb090b3b2db16384279e`. PRهای #5/#6/#7 merged هستند؛ هیچ‌کدام پیش‌نیاز باز نیست. CI run `36577591299` روی همین SHA در Windows Node 22/24 شکست داشته و در بقیهٔ matrix/E2Eهای گزارش‌شده سبز بوده است؛ failureها attribution نشده‌اند و regression یا flake فرض نمی‌شوند.

**Gate:** Phase 1 🟡؛ Steps 1–2 شواهد baseline/معماری دارند؛ Steps 3–5 تا تصمیم‌های مالک، حل seam، تکمیل evidence محدودیت‌ها، review و merge زرد می‌مانند. Phase 2 هنوز شروع نشده و اجرای Profile در دسترس کاربر نیست. v1 فقط JSON داده‌ای است، default-off در rollout، بدون inheritance/template/sub-workflow/recursion/parallelism/fan-out/join؛ Runtime و PlanRuntime موجود تنها مراجع اجرای مدل، ابزار و Plan DAG می‌مانند.

### شناسه‌های ردیابی افزوده‌شده

| ID | الزام | محل اجرا | راستی‌آزمایی هدف |
|---|---|---|---|
| WP-R-001 | JSON Schema versioned، سقف اندازهٔ مستند، بدون کد/DSL | Workflow Profiles Phase 2.1–2.2 | schema/loader tests |
| WP-R-002 | Semantic graph validation برای endpointها، portها، mapping، result و cycle/loop bounds | Phase 2.4 | semantic positive/negative fixtures |
| WP-R-003 | resolution وابستگی‌ها با نسخه/digest بدون کپی Persona/Skill | Phase 3.1 | resolver tests |
| WP-R-004 | Toolset/Persona/Runtime authorization فقط دسترسی را محدود می‌کند؛ enforcement در call-site | Phase 3.2 و 6.3 | denied-tool integration tests |
| WP-R-005 | first-match قطعی، loops محدود و error/retry/route typed | Phase 4.1–4.4 | graph-kernel tests |
| WP-R-006 | Feature flag پیش‌فرض خاموش و legacy behavior محفوظ | Phase 4.5 و 7.2–7.3 | default-off/opt-in + golden parity |
| WP-R-007 | handlerها lifecycle موجود را delegate و متن Profile را untrusted نگه می‌دارند | Phase 5.1–5.4 | handler/adversarial tests |
| WP-R-008 | lifecycle durable، resume/cancel، digest-bound approval و budget مشترک | Phase 6.1–6.4 | restart/recovery/policy tests |
| WP-R-009 | default profile با رفتار observable جاری برابر است | Phase 7.1–7.3 | characterization/golden suite |
| WP-R-010 | authoring/discovery/selection و diagnostics در interfaceهای پشتیبانی‌شده | Phase 8.1–8.3 | CLI/API contract tests |
| WP-R-011 | adversarial trust/tool boundaries و resource ceilings | Phase 5.2 و 9.1–9.2 | security/performance tests |
| WP-R-012 | migration، rollback، docs، CI و review gates | Phase 10.1–10.3 | migration/CI/review evidence |
| WP-R-013 | exclusionهای v1 صریح و enforce‌شده | Phase 1.3؛ Phase 2–4 | schema/semantic rejection tests |

شناسه‌های `WP-R-*` متعلق به این قابلیت‌اند و با IDهای تاریخی R-01…R-30 این سند تداخل ندارند. همهٔ verification targetهای بالا planned و اجرا‌نشده‌اند.

### تصمیم‌ها و موانع مالک

| ID | موضوع | وضعیت/موعد |
|---|---|---|
| D-WP-001 | JSON Schema authority و validator (پیشنهاد: Draft 2020-12 validator جدا از semantic TS checks) | 🟡 تصمیم Pouya، پیش از Phase 2.1–2.2 |
| D-WP-002 | pinning نسخه/digest؛ Persona/Tool registry فعلاً نسخهٔ یکنواخت ندارند | 🟡 تصمیم Pouya، پیش از Phase 2.3/3.1 |
| D-WP-003 | project-profile selection، default override و trust/opt-in | 🟡 تصمیم Pouya، پیش از Phase 2.3 |
| D-WP-004 | approval node در برابر Law 17 و waiting/resume پایدار | 🟡 تصمیم Pouya، پیش از Phase 2.1/5.3 |
| D-WP-005 | ترکیب capهای Profile/Plan/Agent/provider و شمارنده‌های monotonic | 🟡 تصمیم Pouya، پیش از Phase 6.2 |
| D-WP-006 | سازگاری MCP `toolPrefix + raw tool name` با ID محدودشدهٔ registry | 🟡 شواهد/compatibility tests پیش از Phase 2.1/3.2 |
| D-WP-007 | byte cap مبتنی بر اندازه‌گیری، نه مقدار حدسی | 🟡 اندازه‌گیری و تست پیش از Phase 2.1 |
| D-WP-008 | facade مرحله‌ای روی Orchestrator با حفظ PlanRuntime به‌عنوان تنها Plan DAG scheduler | 🟡 تصمیم معماری Pouya پیش از Phase 4/5 |

**PR/rollout:** یک PR مستقل برای Phase 1 و سپس یک PR برای هر فاز وابسته؛ Phase 2 فقط بعد از merge/review/CI و حل blockers Phase 1 بر مبنای همان merge SHA شروع می‌شود. `main` مستقیم تغییر نمی‌کند و این الحاقیه مجوز merge/rollout محسوب نمی‌شود.

---
*پایان سند. هر تغییر وضعیت فقط با ویرایش همین فایل و کامیت مرتبط.*


### 8.1 — Workflow Profiles owner-decision update (2026-09-29 19:38 GMT+3:30; append-only)

This update supersedes the initial D-WP open-decision statuses in §8 while preserving that historical record. Pouya Rahimi confirmed: Ajv + Draft 2020-12 structural validation separate from semantic validation; required content-digest pins (version optional and recorded only when available); one active profile per run with explicit selection > opted-in project > built-in default; digest-bound approval that grants no tool/effect permission; strictest per-dimension Runtime/user-session/profile budget; exact MCP IDs with a 256 UTF-8-byte cap and source-aware validation; a 1 MiB UTF-8-byte profile-file cap before parse; and an outer profile graph that delegates every inner Plan DAG to the existing `PlanRuntime` through an owner-approved narrow internal adapter (no second scheduler or public/generic Orchestrator facade). The Profile Schema and three structural fixtures were updated to reflect the digest and tool-ID contract; fixture digests are placeholders, not activation-ready pins.

**Evidence:** `Orchestrator.run()` delegates through private `runInSession()` and is composite; `PlanRuntime` exposes `execute/resume/cancel` and owns DAG scheduling. `mcp-connector.ts` concatenates prefix and raw name without normalization, but `ToolDefinitionSchema` currently applies the restricted local-ID regex to MCP IDs; source-aware validation is therefore a required Phase 2/3 change. Current profile schema/examples occupy 35,763 / 10,107 / 7,461 / 4,002 bytes, all below the approved 1 MiB cap. Boundary tests and live/fixture MCP compatibility tests remain future implementation work.

**Current gate at that historical update:** Phase 1 was 🟡 pending PR #8 review/merge (Step 5). This gate is superseded by the append-only completion note below; no prior history is removed.

### 8.2 — Phase 1 post-merge completion and Phase 2 status (2026-09-29 20:38 GMT+3:30; append-only)

PR #8 merged to `main` as `ee3fa3f67d695a251974d5bb94ce53ab6e605b5a`; post-merge CI run `36601818036` completed successfully. Phase 1 Step 5 and its Gate are 🟢. The PR #8 source branch remains intact; no artifact was deleted. The Phase 2 implementation is being prepared as a separate branch/PR based on this `main` head.

The related planning-time failure/lifecycle defect is recorded as **separate, not yet implemented work**: retain the entire transcript/context after planning failure; Retry resends the last user message verbatim with its conversation history; repeat failures preserve history and show Retry/Abort again; Abort stops the active attempt, retains history and the last message, and permits a new request. This is not part of the Workflow Profile Phase 2 code scope and must not be reported as implemented.

### 8.3 — Workflow Profiles Phase 2 contract completion (2026-09-30; append-only)

The Phase 2 contract (canonical Draft 2020-12 JSON Schema, bounded read/loader/registry boundaries, and a separate semantic validator) is implemented on `feat/workflow-profile-phase2-contract-20260929` and accepted at head `f1d403fdc30c548ba9036646e8b8cf35652867c5`. CI run `36701156470`, attempt 2, passed 10/10 jobs on that exact SHA; the PR diff contains 19 added/modified files and no deletions or renames.

Local full-repository verification on the same tree: `npm run typecheck`, `npm run build`, and all 63 Workflow Profile tests pass; the repository-wide `npm test` reports 1,761 of 1,762 tests passing, with one pre-existing environment-dependent failure in `phase-j-checkpoint` J-05 whose files are byte-identical to `main` (equal `mtimeMs` on this sandbox filesystem; recorded as out-of-scope and not fixed). Independent public-API probes confirm the three shipped examples load with zero diagnostics and that the approved 1 MiB cap is enforced at the read stage before parse.

WP-R-001 and WP-R-002 verification targets are exercised by the Phase 2 suites; the remaining WP-R targets stay planned for later phases. PR #9 remains Draft: merge, approval, and release require explicit owner authorization, and Phase 3 must be based on the merged Phase 2 commit or an owner-approved base. The pre-Runtime-integration gates (host-guaranteed stable/trusted/non-attacker-writable profile roots; the authoritative Runtime compatibility/enforcement contract) remain open.

### 8.4 — Workflow Profiles Phase 3 resolution (2026-09-30; append-only)

Phase 3 is implemented as static, pre-activation dependency resolution: `src/ai/workflow-profiles/profile-digest.ts` (typed `sha256` digest over canonical JSON with a kind/id envelope), `profile-resolver.ts` (per-kind resolution against the existing persona, skill, model-profile registries plus the named toolset registry and the built-in rubric catalogue, with aggregated fail-closed diagnostics), and `toolsets.ts` (named versioned toolsets and the strictest-intersection effective tool set). Reviewer decision domains are now compared with the digest-pinned rubric's real domain before activation, closing the Phase 2 deferral.

Two conservative owner-delegated decisions are recorded in `docs/workflow-profiles/PHASE3_RESOLUTION.md`: **D-WP-010** (v1 rubrics come only from a code-owned built-in catalogue; user-authored rubrics need a separate owner decision) and **D-WP-011** (digest envelope and resolved-content projection contract, including resolved SKILL.md text for skills). Local evidence: `npm run typecheck`, `npm run build`, and 79 Workflow Profile tests across five files pass on Node v22.22.3, including resolution against real repository components. WP-R-003 and WP-R-004 verification targets are exercised; WP-R-005 onward remain planned.

No Runtime execution, feature flag, or Orchestrator integration is included. PR #9 stays Draft; per the owner instruction of 2026-09-30 nothing is merged until every phase is complete. The trusted-host stable-root guarantee and the authoritative Runtime compatibility/enforcement contract remain pre-integration gates.

### 8.5 — Workflow Profiles Phase 4 kernel (2026-09-30; append-only)

Phase 4 implements the deterministic outer-control kernel and its opt-in access path: `src/ai/workflow-profiles/profile-predicate.ts` (one data-only predicate/port-domain contract shared by the semantic validator and the runtime), `profile-kernel.ts` (explicit state machine, first-match edge selection by ascending priority then declaration order, single-default fallback, typed normal and error-route mappings, run-scoped monotonic loop counters with fail/route exhaustion, the strictest-of three hard node-visit cap, and typed retry/route with a sanitized failure envelope), and `profile-runner.ts` (`HOOTL_WORKFLOW_PROFILE` default-off and the validated schema-version → structural → semantic → resolution → frozen-profile pipeline). Terminal categories — `security-denied`, `approval-denied`, `cancelled`, `visit-cap`, `budget` — can never be retried or routed, and raw exception text never reaches a node, event, or result.

Local evidence: `npm run typecheck`, `npm run build`, and 103 Workflow Profile tests across seven files pass on Node v22.22.3 (kernel 16, predicate 8, semantic 27, resolver 16, registry 21, schema 11, MCP-ID 4); the full repository suite is 1,801/1,802 with only the pre-existing phase-j J-05 mtime-tie failure. Recorded semantics and the acceptance mapping are in `docs/workflow-profiles/PHASE4_KERNEL.md`.

No model or tool execution, handler, approval interaction, persistence/resume, budget enforcement at the real call site, EventBus observability, or Orchestrator integration is included; those are Phases 5–7. PR #9 stays Draft, and per the owner instruction of 2026-09-30 nothing is merged until every phase is complete. The trusted-host stable-root guarantee and the authoritative Runtime compatibility/enforcement contract remain pre-integration gates.

### 8.6 — Workflow Profiles Phase 5 handlers (2026-09-30; append-only)

Phase 5 connects the kernel to existing capabilities without duplicating them: `src/ai/workflow-profiles/untrusted-content.ts` is the single confinement implementation (labelled `<untrusted-data>` blocks, zero-width delimiter neutralization, byte cap with the truncation stated inline, digest over the raw untruncated content), `node-handlers.ts` adapts intake plus planner/execute/review/approval over injected service ports — `condition` and `end` remain kernel-computed — and `orchestrator-adapters.ts` wires those ports to `Planner.plan`, `PlanRuntime.execute` (still the sole inner DAG scheduler), `FinalReviewer`/`AcceptanceChecker`, and the existing confirm callback.

Recorded owner-delegated decisions: **D-WP-012** (an approval node passes through any input port it also declares as an output, so a gated plan can flow onward; contracts cannot widen) and **D-WP-013** (side-effect approvals bind to the digest of the bound port and the approval must return the digest it approved — mismatch aborts as terminal; the text-confirm adapter echoes the digest it displayed, and out-of-band hosts must return their own approved digest). Denial, expiry, and cancellation are terminal and never routed or retried; an approval decision is data and is not a tool authorization.

Local evidence: `npm run typecheck`, `npm run build`, and 144 Workflow Profile tests across eleven files pass on Node v22.22.3, including a semantically validated seven-kind profile and the adversarial injection matrix; the full repository suite is 1,842/1,843 with only the pre-existing phase-j J-05 mtime-tie failure. Details are in `docs/workflow-profiles/PHASE5_HANDLERS.md`.

No Orchestrator entry point, feature-flag activation, persistence/resume, real-call-site budget enforcement, or EventBus observability is included; those are Phases 6–7. PR #9 stays Draft, and per the owner instruction of 2026-09-30 nothing is merged until every phase is complete.

### 8.7 — Workflow Profiles Phase 6 durable lifecycle (2026-09-30; append-only)

Phase 6 makes profile execution durable and self-limiting: `src/ai/workflow-profiles/profile-budget.ts` is the single per-dimension budget contract (schema maxima, strictest-of folding across profile/runtime/user-session, `onLimit`→status mapping, run-scoped counters that a resume continues), `profile-run-state.ts` stores a versioned record before any work (profile hash, schema/runtime versions, saved dependency pins, node/status, loop and budget counters, declared authority, approvals, linked plan/session, pending effect) through the existing atomic write helper and re-verifies all of it before a resume can touch an effect, `profile-access-guard.ts` narrows tools/approval/budget to the strictest effective policy and enforces it at the call site (`assertToolAccess`, `assertSideEffectAuthorized`, `assertNoAuthorityIncrease`), and `profile-events.ts` reports the lifecycle through the existing EventBus-shaped sink with secret scrubbing and a degraded-not-throwing failure mode. `profile-runner.ts` now materializes the run record, refuses any resume whose profile/pins/version/authority changed, and keeps an `ask-user` limit resumable.

Recorded contract consequences (no new owner decision): an `ask-user` limit is a pause — the kernel reports `limit: 'ask-user'`, the record keeps every counter with `awaitingUser: true` and status `interrupted`, resuming an exhausted budget pauses again instead of granting calls, and a caller offering wider authority is refused; a failing state-store write is fail-closed (rethrown after `workflow.persistence.degraded`) while a failing event sink only degrades; the visit cap keeps its Phase 4 code/category and now follows `onLimit` for its terminal status. The existing result-only stores still cannot prove whether an interrupted effect committed, so a pending effect is never auto-retried — a real intent/effect/commit journal stays part of the open Runtime compatibility/enforcement contract gate.

Local evidence: `npm run typecheck`, `npm run build`, and 180 Workflow Profile tests across fourteen files pass on Node v22.22.3 (budget 11, lifecycle 15, enforcement 10 added); the full repository suite is 1,878/1,879 with only the pre-existing phase-j J-05 mtime-tie failure. Details are in `docs/workflow-profiles/PHASE6_LIFECYCLE.md`.

The guards are enforcement primitives at the profile/adapter boundary: no Orchestrator entry point exists, `HOOTL_WORKFLOW_PROFILE` remains off by default, no profile is activated, and the live Orchestrator tool call site is not wired yet — that belongs to the Runtime integration phase. PR #9 stays Draft, and per the owner instruction of 2026-09-30 nothing is merged until every phase is complete.

### 8.8 — Workflow Profiles Phase 7 extraction and blocking decision (2026-09-30; append-only)

Phase 7 (default profile and current-behaviour parity) is 🟡: Step 1's extraction is complete and recorded in `docs/workflow-profiles/PHASE7_PARITY.md`. The real stage order — entry/session, planning assessment (with the answer branch and the `[[NEEDS_PLAN]]` escalation), the bounded clarification loop, the feasibility/cycle gate, plan persistence and the session link, the single plan-confirmation interaction, execution with per-step personas and acceptance plus automatic re-planning, cancellation, and the final review/report — is derived from `orchestrator.ts` and the characterization suites, and every stage is mapped to a profile construct with the delegation boundary (PlanRuntime stays the sole inner-DAG scheduler/validator) stated explicitly. The extraction also surfaced and fixed a tool-surface bug: the runner's authority snapshot now derives the declared tool surface from the content of the profile's pinned personas/toolsets, so `allowedToolsets: []` means "no narrowing" instead of "permit nothing".

Step 2 (Orchestrator wiring) is **blocked on owner decision D-WP-014**: v1 requires `bindings.personaRef` on `execute`, but the current flow assigns a persona per plan step (`plan-runtime.ts` `buildAgentForStep` ← `step.assignedPersona`) and the registry ships `planner`/`reviewer` (both used by the runtime) but no executor persona. The recorded options are (1) author a HOOTL-owned `hootl.executor` persona mirroring the runtime's step prompt, (2) make `personaRef` optional for `execute` as a versioned v1 contract change, or (3) defer activation and ship the modeling plus the parity harness only. No profile is activated and `HOOTL_WORKFLOW_PROFILE` stays off by default; Steps 2–3 remain 🔴 until the owner decides.

### 8.9 — D-WP-014 resolved: `personaSource: "plan-step"` for `execute` nodes (2026-09-30; append-only)

The owner decided D-WP-014 in favour of the standards-conformant contract change: an `execute` node may declare `bindings.personaSource: "plan-step"` ("the runtime assigns each plan step's persona") instead of a pinned `personaRef`. `planner`/`review` nodes still require `personaRef`; the two bindings are mutually exclusive and exactly one is required on `execute`; `personaSource` is rejected on every other node kind and its value is a closed single-value domain, so a profile cannot name an arbitrary persona source. Implementation: `docs/workflow-profiles/workflow-profile.schema.json` (`$defs/bindings` plus the execute-only `allOf` branch, twelve entries total), `src/ai/workflow-profiles/profile-types.ts`, and `src/ai/workflow-profiles/profile-semantic-validator.ts` (new codes `bindings.persona-source-invalid`, `bindings.persona-source-unsupported`, `bindings.persona-binding-ambiguous`, `bindings.persona-binding-missing`). Evidence: schema + semantic suites 40/40, all Workflow Profile suites 14 files / 183 tests, `npm run build` clean, on that commit's head. Nothing is weakened: the binding does not resolve a persona itself, does not add registry content, and cannot widen tools, approvals or budgets. The default profile built in Phase 7 Step 1 uses this binding for its `execute` node; the earlier blocking record in §8.8 is preserved as history.

### 8.10 — Workflow Profiles Phase 7 Step 1: the default profile artifact (2026-09-30; append-only)

Phase 7 Step 1 is 🟢. `createDefaultWorkflowProfileDocument(sources)` (`src/ai/workflow-profiles/default-profile.ts`) builds the built-in default profile in code, with dependency pins computed from the resolved persona/rubric content and a fail-closed `default-profile.component-missing` error when one is unavailable, so a placeholder-pinned default profile is not constructible. The graph models the extracted flow: `request` → `plan` with three exhaustive routes on the planner's required `kind` discriminator, a three-question clarification loop (`clarification-rounds`, `onExhausted: fail`, matching `maxClarificationRounds`), a digest-bound `confirm` approval (binds `planText`, the text the user is shown; the same `planDigest` is threaded to `execute`), delegated execution with `personaSource: "plan-step"` (D-WP-014), and a `review` node that accepts the built-in rubric's full `pass`/`revise`/`reject` domain and ends at `finish` (pass) or `rejected` (revise/reject). Budgets are sized so the profile never cuts a legitimate run short (`maxNodeVisits: 40` ≥ the conservative static bound 36; 1 h / 500 model calls / 2000 tool calls), and `allowedToolsets: []` adds no narrowing. Two intentional differences are recorded for the owner before any activation (Step 3 requires plan + release notes + owner approval): **G-5**, a confirmation denial with feedback cannot re-plan in v1 (the digest-bound decision port is an object and v1 predicates address one top-level scalar port; feedback terminates fail-closed like a cancellation), and **G-2**, the answer branch ends `success` while the `answered` interaction status stays the entry point's job. Recorded in `docs/workflow-profiles/PHASE7_PARITY.md` §5 with the artifact's evidence (new 11-test suite, all Workflow Profile suites 15 files / 194 tests, typecheck and build clean). Phase 7 remains 🟡 until Step 2 (Orchestrator wiring) and Step 3 (parity tests) are complete; no merge is authorized until all phases are complete.

### 8.11 — Workflow Profiles Phase 7 complete: default profile, Orchestrator hook, parity (2026-09-30; append-only)

Phase 7 is 🟢. `createDefaultWorkflowProfileDocument()` builds the built-in default profile in code with dependency pins computed from resolved persona/rubric content; `activateWorkflowProfile()` is the single fail-closed decision point (flag off ⇒ the legacy path and nothing profile-related resolves; flag on ⇒ a prepared profile or diagnostics, never a fallback or a half-created run; the built-in default additionally requires the recorded `BUILT_IN_DEFAULT_APPROVAL`, still unapproved); `OrchestratorConfig.workflowProfile` wires it to the Orchestrator, which keeps its own session/interaction lifecycle and delegates through its own Planner, FinalReviewer and a PlanRuntime built from the same policy deps. The first parity suite (`workflow-profile-parity.test.ts`, 9 tests) drives the legacy and profile paths with the same scripted model and compares plans, execution, step-agent prompts **and tool surfaces**, acceptance/re-review calls, clarification folding, cancellation, the final report, store data and the fail-closed load path. Two gaps the suite found were fixed in code: the profile path's PlanRuntime was missing the acceptance/status/persist-error callbacks (now a shared handler), and a failed plan execution would have skipped the review (now routed to the review node via `onError`, while authorization denial, approval denial and cancellation stay terminal). Recorded behaviour differences requiring the owner's approval before activation: G-5 (confirmation feedback cannot re-plan in v1), G-2 (answer branch ends `success`), report wording, and no legacy `plan:clarified` entry. Evidence: all Workflow Profile suites 21 files / 235 tests, adjacent suites 76 tests, full repository suite 1,924/1,925 with only the pre-existing J-05, typecheck and build clean. No merge is authorized until all phases are complete; Phase 8 (user authoring/selection) is next.

### 8.12 — Workflow Profiles Phase 8 complete: authoring, discovery, selection over CLI and API (2026-09-30; append-only)

Phase 8 is 🟢. Discovery lives on fixed conventions (`.hootl/workflow-profiles/*.json` behind the
trust opt-in, `HOOTL_WORKFLOW_PROFILES_DIR`, and an explicitly named file) and never throws on a
broken file; `resolveProfileSelection()` is the single selection path shared by `hootl run
--profile/--profile-file` and the server, so the CLI and the API cannot drift apart. The CLI gained
`profiles list` and `profiles validate <id|file>` (exit 1 on any diagnostic), the API gained one
request field — `POST /api/run { profile }` — resolved before the run exists (400 with diagnostics
otherwise; `profileFile` over HTTP is refused, because a client-supplied host path would be a new
file-reading primitive). Per-request selection rides a new per-run channel on the Orchestrator
(`OrchestratorRunOptions.workflowProfile`) rather than a second instance, so sessions, plans,
ownership, cancellation, TTL and SSE are the same objects on both paths by construction; selecting a
profile for one request leaves every other request on the legacy path, including under concurrency.
Two real defects were found and fixed during the security pass that this phase's tests drove:
**H-1** (a selected profile that omitted the approval node executed its plan with no human
confirmation — now the runtime requires a granted side-effect approval whose bound digest is the
plan being executed, and the refusal is a terminal `security-denied` failure) and **H-2** (the
profile path fed the planner its node goal text instead of the user's request, because the request
arrives as the entry payload object; both paths now pass the request, with a regression test that
fails without the fix). The user-visible `rejected` end is recorded as `failure` in the legacy
`Review.outcome` vocabulary (the profile status stays visible in the report) alongside the other
recorded differences. Authoring docs and two resolvable, CI-validated examples ship with the phase.
Evidence: `workflow-profile-discovery.test.ts` 6, `phase8-profiles.test.ts` 8,
`workflow-profile-examples.test.ts` 7, `phase8-profile-selection.test.ts` (server) 8,
`workflow-profile-hardening.test.ts` 9; all Workflow Profile + CLI + server suites 47 files / 554
tests; built CLI and a live server smoke (`profiles validate` → exit 0; `run --profile e2e.reject`
→ profile path; API untrusted → 400 `selection.profile-missing`, trusted → 202 + profile run); CI
10/10 at the phase heads. No merge, release or default activation is authorized until all phases are
complete.

### 8.13 — Workflow Profiles Phase 9 complete: hardening and measurement (2026-09-30; append-only)

Phase 9 is 🟢. Step 1 added two end-to-end suites on the real Orchestrator: `workflow-profile-hardening.test.ts` (9 tests — the confirmation gate, the digest binding, terminal denial/cancellation, injected request text not widening the step tool surface, and the flag-off switch) and `workflow-profile-adversarial.test.ts` (7 tests — component-content injection through a profile's own pinned persona, toolset narrowing, a toolset naming an unavailable tool, an unknown approval policy, error-payload leakage into report/session/observability log, graph caps, and an exhausted bounded loop stopping the run before execution). Three findings were fixed rather than documented around: **H-1** (a profile could omit the confirmation node and execute without human approval — now a terminal `security-denied` gate that requires a granted side-effect approval binding the plan being executed), **H-2** (the profile path handed the planner its node goal instead of the user's request), and **H-3** (a profile could pin a `toolset` but nothing wired a `ToolsetRegistry`, so it could never resolve — toolsets now load from the same registry layers as every other component and are re-checked against the live catalog). Step 2 delivered `scripts/profile-bench.mjs`, a reproducible measurement of the built output with its environment recorded, and the tabulated results in `PHASE9_HARDENING.md`: flag-off decision p50 0.000 ms, profile preparation ~0.8 ms, 43 KB validation ~0.7 ms, discovery+selection ~0.6 ms, an over-cap file refused in 0.016 ms versus 1.284 ms to parse a just-under-cap file (cap before parse), and a spent model budget stopping the planner call entirely. The one honest caveat is recorded: no pre-feature baseline exists, so the performance claim is "off by default adds one flag read" rather than a fabricated percentage. Evidence: profile + CLI + server suites 49 files / 565 tests, the CI-command suite, tsc/build clean, and 10/10 CI on the phase heads. No merge, release or default activation until all phases are complete.