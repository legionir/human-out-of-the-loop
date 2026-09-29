# Fixed Project Execution Rules

1. **ترتیب اجرا:** فازها را دقیقاً به ترتیب و گام‌های هر فاز را به ترتیب فهرست‌شده اجرا کن. هر فاز باید در یک مرحلهٔ اجرایی پیوسته کامل شود؛ اگر اندازهٔ آن این شرط را نقض می‌کند، پیش از اجرا طرح را در مرز وابستگی اصلاح و دلیل را ثبت کن.
2. هیچ الزام یا موردی از دامنهٔ این سند را حذف، نادیده یا بی‌صدا به آینده موکول نکن.
3. اطلاعات نامعلوم را حدس نزن. مورد را با برچسب **Unknown / Requires Verification:** ثبت کن و اگر بر ترتیب یا طراحی اثر دارد، پیش از ادامهٔ وابسته آن را حل یا برای تصمیم مالک متوقف کن.
4. کار ناتمام را کامل اعلام نکن و بدون شواهد قابل بازتولید ادعای موفقیت نداشته باش.
5. رفتارهای فعلی HOOTL را حفظ کن، مگر جایی که این طرح صریحاً تغییر تعریف کرده باشد؛ رفتار پروفایل پیش‌فرض باید با جریان فعلی سازگار بماند.
6. پیش از رفتن به فاز بعد، تمام معیارهای پذیرش فاز جاری را با شواهد بررسی کن.
7. **وضعیت‌ها:** 🔴 یعنی اجرا نشده؛ 🟡 یعنی ناقص، نادرست یا هنوز راستی‌آزمایی‌نشده؛ 🟢 یعنی همهٔ کارها پیاده‌سازی، یکپارچه‌سازی و اعتبارسنجی شده‌اند. بلافاصله بعد از هر گام وضعیت همان گام را به‌روز کن. پس از هر مرحلهٔ اجرایی وضعیت فاز را به‌روز کن. فاز فقط وقتی 🟢 می‌شود که تمام گام‌هایش 🟢 و همهٔ معیارهای پذیرش آن احراز شده باشند. اگر فاز کامل نشد، 🟡 بماند و دقیقاً کار باقی‌مانده و مانع آن ثبت شود. **تعریف Done:** همهٔ گام‌ها اجرا شده‌اند؛ هیچ الزام لازم جا نیفتاده؛ قابلیت‌های قبلی مرتبط سالم‌اند؛ تست‌های لازم پیاده‌سازی و گذرانده شده‌اند؛ نقاط اتصال کار می‌کنند؛ معیارهای پذیرش برقرارند؛ مانع مسدودکنندهٔ شناخته‌شده‌ای باقی نیست و کیفیت تولیدی در دامنهٔ همان فاز تأمین شده است.
8. این سند را با پیاده‌سازی واقعی همگام نگه دار. هیچ گام یا الزام تکمیل‌شده‌ای را حذف نکن و الزام را بی‌صدا بازنویسی نکن. کار اجباری تازه را با دلیل به فاز مناسب اضافه کن؛ تغییر معماری یا وابستگی را صریحاً در طرح و ترتیب فازها ثبت کن.
9. دامنهٔ نامرتبط اضافه نکن؛ فازها را نه مصنوعی خرد کن و نه کارهای مستقل یا پرریسک را بیش‌ازحد ادغام کن. ترتیب وابستگی‌ها مقدم است.
10. از الگوهای اعتبارسنجی، امنیت، TypeScript، تست، خطا، ثبت رخداد، migration و مستندسازی موجود در مخزن پیروی کن. پیش از تغییر، baseline و منبع حقیقت را بیاب. `main` را مستقیم تغییر نده. هر فاز اجرایی را در branch و PR کوچک و قابل‌بازبینی عرضه کن؛ ترجیحاً یک PR برای هر فاز یا برای فازهای واقعاً وابسته. PR بعدی باید بر مبنای فاز قبلیِ ادغام‌شده یا مبنای صریحاً تأییدشده باشد؛ PR بزرگِ چندفازی نساز. وضعیت، review و CI را پیش از ادامه بررسی کن. PRهای #5 و #6 یا rebase آن‌ها فقط وقتی پیش‌نیازند که Phase 1 وابستگی واقعی را اثبات کند؛ ادغام، انتشار یا عبور از تأیید انسانی بدون مجوز صریح ممنوع است.
11. پروفایل، Persona، Skill، Toolset و سایر محتوای registry **تعریف داده‌ای غیرقابل‌اعتماد** هستند، نه کد یا دستور اجرایی. DSL، eval، عبارت شرطی اجرایی یا کد دلخواه در پروفایل مجاز نیست. متن این داده‌ها هنگام ورود به prompt باید به‌صورت دادهٔ محصورشده معرفی شود و هرگز system policy یا مجوز را تغییر ندهد.
12. هیچ پروفایلی نمی‌تواند ابزارها، تأییدها، بودجه‌ها، دسترسی یا محدودیت‌های Runtime/HOOTL را تضعیف یا گسترش دهد. مؤثرترین/سخت‌گیرانه‌ترین سیاست Runtime، کاربر، Persona و پروفایل برنده است؛ کنترل authorization در مرز واقعی ابزار مستقل از validation اجرا می‌شود. Profileهای workspace/project غیرقابل‌اعتمادند؛ override از پروفایل پیش‌فرض نیازمند مسیر trust/opt-in صریح است.
13. دامنهٔ v1 فقط هفت node kind اعلام‌شده را دارد؛ هیچ inheritance، Node Template، Sub-workflow، recursion، parallelism، fan-out یا join در v1 مجاز نیست. هر افزودن این موارد نیازمند تصمیم معماری و نسخه/فاز جداگانه است و نباید بی‌صدا به schema یا Runtime افزوده شود.
14. انتخاب مسیر v1 قطعی و مشترک است: predicateها به ترتیب priority صعودی و سپس ترتیب تعریف ارزیابی می‌شوند؛ اولین شرط درست انتخاب می‌شود؛ یک default یکتا فقط در نبود شرط درست اجرا می‌شود؛ در نبود مسیر، اجرای workflow fail-closed می‌شود. هم‌پوشانی شرط‌ها ambiguity محسوب نمی‌شود و باید با first-match تست شود.
15. فقط وضعیت‌های 🔴/🟡/🟢 به‌کار ببر. «Blocked» وضعیت چهارم نیست: آیتم را 🟡 نگه دار و در همان‌جا `Blocked:`، تصمیم/شواهد لازم، مسئول تصمیم و موعد لازم پیش از گام وابسته را ثبت کن.

# Execution Plan

## [🟡] Phase 1: تثبیت baseline و قرارداد معماری پروفایل

پیش از پیاده‌سازی، وضعیت دقیق کد، نقاط اتصال موجود، اسناد اجرایی و وابستگی‌های باز را تثبیت کن. قرارداد باید Workflow Profile را لایهٔ پیکربندی روی Runtime فعلی تعریف کند، نه موتور اجرای موازی. خروجی این فاز تصمیم‌های ثبت‌شده، دامنهٔ نسخهٔ اول و به‌روزرسانی غیرمخرب طرح اجرایی پروژه است.

**وضعیت اجرا (2026-09-29):** شواهد baseline و معماری در `docs/workflow-profiles/PHASE1_BASELINE.md` ثبت شده است. Steps 1–2 تکمیل‌شده در branch این فازند؛ Steps 3–5 و Gate کل Phase 1 زرد می‌مانند تا تصمیم‌های مالک دربارهٔ validator/versioning/trust/approval/budget و seam معماری ثبت و PR این فاز بررسی/ادغام شود. Phase 2 فعلاً مجاز به شروع نیست.

### [🟢] Step 1: تعیین baseline، branch و وابستگی PRها

ثبت کن روی کدام branch و commit قرار است کار شود؛ `main`، نسخهٔ مرتبط از `docs/UNIFIED_EXECUTION_PLAN.md` و اسناد معماری را بررسی کن؛ وضعیت PR #5 و #6 را از GitHub دوباره بگیر و با مسیرهای prompt و registry در commit مبنا مقایسه کن. PR #7 هنگام نگارش فقط ظرف اسناد/قرارداد بود؛ وضعیت جاری را دوباره از GitHub بگیر. **Baseline بررسی‌شده در 2026-09-29:** `main` روی `ff7c030afaa20b8a343cdb090b3b2db16384279e` است؛ #5، #6 و #7 merged و PR بازی مشاهده نشد. #5/#6 پیش‌نیاز branch نیستند، چون تغییرهای prompt و registry آن‌ها در main هستند؛ هیچ rebase یا تغییر آن PRها لازم نیست. ادغام/rebase را از اجرای Workflow Profiles جدا نگه دار و بدون تصمیم مالک تغییر نده. جزئیات و merge SHAs در `docs/workflow-profiles/PHASE1_BASELINE.md` ثبت شود. برای اجرای فازهای بعد، PRهای کوچک فازبه‌فاز، CI/review gate هر PR، branch base و وابستگی صریح را ثبت کن؛ یک PR عظیم برای کل فازها نساز.

### [🟢] Step 2: ردیابی معماری و آزمون‌های baseline

مسیر واقعی جریان درخواست و اجرای کار را از entry pointها تا `Orchestrator`، `Planner`، `PlanRuntime`، `AgentRuntime`، `TaskRuntime`، Acceptance/Review، registryها، storeها و CLI/server دنبال کن. قرارداد `Plan` و `PlanStep` فعلی، DAG و CycleDetector، تأیید plan، re-plan، resume/cancel، `Persona.allowedTools` و لایه‌بندی registry پکیج/پروژه را ثبت کن. دستورات تست/typecheck/lint/build را از `package.json` و CI استخراج و baseline را اجرا کن؛ شکست‌های قبلی را بدون بازتولید به baseline نسبت نده. **شواهد اجراشده:** CI run `36577591299` روی SHA مبنا unit/integration را اجرا کرد، اما Windows Node 22/24 شکست خورد؛ علت به baseline یا regression نسبت داده نشده و در `PHASE1_BASELINE.md` با test names ثبت شده است. این Phase1 ادعای اجرای محلی کامل ندارد.

### [🟡] Step 3: تثبیت قرارداد v1 و ثبت نیازمندی‌ها/تصمیم‌ها

Schema را با semantics مشترک این سند نهایی کن: seven node kinds؛ Profile مستقل و بدون inheritance؛ v1 بدون Template/Sub-workflow/parallelism؛ mapping و predicate فقط به port سطح اول؛ priority صعودی و سپس ترتیب تعریف با first-match، حداکثر یک default برای هر source و fail-closed در نبود match؛ bounded loops و exhaustion؛ خطای `fail`، retry با `maxAttempts` به‌معنای کل invocationها شامل بار اول، دسته‌های `retryOn` و backoff ثابت، یا `route` مستقیم به `routeTo` با `routeMap` صریح؛ denial/cancellation/approval-denial غیرقابل‌retry و غیرقابل-route؛ و end output با emit صریح. از Phase 1 برای هر الزام شناسهٔ پایدار `R-xxx` بساز و ماتریس requirement→phase/step→test را از همان ابتدا نگه دار. هم‌زمان Decision/Unknown Register بساز که برای هر مورد وضعیت، شواهد لازم، مسئول تصمیم و مهلت (پیش از کدام گام) را ثبت کند. **Unknown / Requires Verification:** canonical schema/validator integration، قرارداد نسخه‌ای واقعی registry، precedence و trust scope پروفایل‌ها، semantics approval و waiting/resume در CLI/server، بودجهٔ Profile در برابر AgentRuntime، فرمت واقعی tool IDs، و limit امن اندازهٔ فایل. هر unknown اثرگذار را از مخزن resolve کن یا صریحاً به‌صورت blocked 🟡 نگه دار؛ مقدار/قرارداد را حدس نزن. ثبت فعلی D-WP-001…008، مالک، توصیهٔ غیرمصوب و dependent gate در `docs/workflow-profiles/PHASE1_BASELINE.md` است؛ تصمیم‌های D-WP-001…005 و D-WP-008 هنوز مالک‌خواه‌اند.

### [🟡] Step 4: حل seam بین workflow بیرونی و Plan DAG داخلی

به‌صورت read-only/آزمایشی، یک spike محدود و قابل‌بازگشت روی PlanRuntime واقعی اجرا/طراحی کن: آیا state machine بیرونی می‌تواند intake→plan→execute→review و یک بازگشت bounded را بدون flatten کردن Plan DAG، duplicate scheduler یا تغییر semantics PlanRuntime هدایت کند؟ Workflow Profile گراف کنترل بیرونی است؛ PlanRuntime همچنان DAG وابستگی درونی هر plan را اجرا می‌کند. ثبت کن کدام lifecycle (approval، re-plan، cancellation، resume، resource lock و status) در Runtime مشترک می‌ماند. نتیجهٔ spike و شواهد را در Decision Register ثبت کن؛ اگر reuse امن/واقعی ممکن نیست، فازهای وابسته را متوقف کن تا تصمیم معماری مالک ثبت شود، نه اینکه engine موازی بسازی. هر feature flag موجود و نقطهٔ مناسب آن را نیز از کد بیاب؛ flag تازه باید default-off باشد. **یافتهٔ baseline:** `Orchestrator.run()` composite است و facade مرحله‌ای عمومی ندارد؛ `PlanRuntime.execute()` تنها اجرای DAG داخلیِ plan تأییدشده را بر عهده دارد. پس seam عملیاتی هنوز اثبات نشده؛ D-WP-008 مسدودکننده است و Phase 4/5 تا تصمیم مالک متوقف می‌مانند. Profile flag موجودی یافت نشد؛ `HOTL_NO_PACKAGE_REGISTRY` flag اجرای Profile نیست. شواهد کامل در `PHASE1_BASELINE.md`.

### [🟡] Step 5: ثبت traceability و plan در مرجع پروژه

پس از شناخت branch هدف، `R-xxx` و Decision/Unknown Register را به مرجع اجرایی canonical مخزن وصل کن (در baseline فعلی `docs/UNIFIED_EXECUTION_PLAN.md` چنین جایگاهی دارد). متن/statusهای موجود را حذف یا بازنویسی نکن؛ source audit، شناسه‌های موجود و مسیرهای تأیید را حفظ کن. همین سند، فازبندی PRها و تصمیم‌های حل‌شده/باز را در مسیر مستندات مناسب قابل‌ردیابی کن. برای هر unknown مالک و موعد لازم پیش از اولین dependent step ثبت شود. **وضعیت 2026-09-29:** جدول traceability اولیه با WP-R-001…013 و register به `docs/UNIFIED_EXECUTION_PLAN.md` به‌شکل append-only افزوده می‌شود؛ سند جزئیات و evidence نیز `docs/workflow-profiles/PHASE1_BASELINE.md` است. این Step تا review/merge این PR زرد است.

**Acceptance criteria:**
baseline branch/commit و وضعیت PRها ثبت شده؛ مسیرهای واقعی و تست‌های موجود با شواهد مشخص‌اند؛ قرارداد نسخهٔ اول و مرز Runtime ثبت شده؛ همهٔ unknownهای اثرگذار حل یا صریحاً برای تصمیم مالک علامت‌گذاری شده‌اند؛ ناسازگاری DAG/loop راه‌حل تأییدشده دارد؛ دامنهٔ profiling به طرح canonical مخزن افزوده شده بدون حذف traceability یا تغییر ناموجه رفتار موجود.

**Gate evaluation (2026-09-29):** branch/commit/PRها و dependencyها ثبت شد؛ مسیرهای کد و CI در baseline report مستند است؛ semantics v1 از schema/plan موجود استخراج شد؛ requirements و Unknown Register اولیه ثبت شد. **معیار «راه‌حل seam با تأیید مالک» احراز نشده است.** D-WP-001…005 و D-WP-008 هنوز نیازمند تصمیم Pouya هستند؛ D-WP-006/007 پیش از loader باید با شواهد تکمیل شوند. Step 5 نیز تا review/merge PR این فاز 🟡 می‌ماند. بنابراین Phase 1 🟡 است و Phase 2 تا بستن این gate شروع نمی‌شود.

---

## [🔴] Phase 2: قرارداد JSON، بارگذار Profile و اعتبارسنجی معنایی

پیاده‌سازی قرارداد داده‌ای پایدار و قابل‌انتقال برای Profileها و مسیر کشف/بارگذاری آن‌ها بر اساس الگوی registry موجود. این فاز نباید اجرای workflow را فعال کند؛ پروفایل نامعتبر باید پیش از اجرا با خطای تشخیصی و قابل‌اقدام رد شود.

### [🔴] Step 1: افزودن Schema و fixtures مطابق semantics v1

JSON Schema Draft 2020-12، نمونهٔ پیش‌فرض ساختاری و fixtures شاخه/condition/approval/loop/error-route را اضافه کن. `schemaVersion` را از Profile semver جدا نگه دار؛ `$schema` و فقط namespace توسعهٔ `x-*` را با policy محدود مجاز کن؛ schema version diagnostic را از parse/validation جدا کن. همهٔ limitهای صریح nodes/edges/dependencies/ports/maps/values را نگه دار و loader-level byte cap را بر اساس baseline اندازهٔ registry ثبت/تصویب کن (هیچ سقف فایل حدسی نگذار). Schema باید v1 exclusionهای no-inheritance/no-templates/no-sub-workflows/no-parallelism را مستند کند. هر نمونه از Schema و سپس semantic test suite عبور کند؛ نمونهٔ default تا Phase 7 صرفاً structural sample بماند.

### [🔴] Step 2: هم‌ترازکردن اعتبارسنجی runtime و JSON Schema

مسیر اعتبارسنجی runtime را با روش پذیرفته‌شدهٔ Phase 1 پیاده کن. JSON Schema و validator نباید قراردادهای متناقض داشته باشند: یا یک منبع حقیقت با تولید/مصرف سازگار ایجاد شود یا آزمون parity کامل، اختلاف آن‌ها را آشکار کند. schema validation را از semantic validation جدا کن و خطاها را شامل profile ID، node/edge/field و علت مشخص ساز.

### [🔴] Step 3: افزودن خواندن و کشف Profile در Registry

Profileها را از scopeهای تصویب‌شده بخوان و با ترتیب precedence فعلی registry (package سپس project override) هماهنگ کن، مگر تصمیم Phase 1 خلاف آن را مستند کرده باشد. خطای JSON خراب، ID تکراری، profile override مبهم، نسخهٔ schema/Runtime پشتیبانی‌نشده و فایل غیرقابل‌دسترسی را ایمن و قابل‌تشخیص مدیریت کن. دادهٔ بارگذاری‌شده را immutable/validated به لایه‌های بعدی بده و هیچ فایل یا محتوایی را به‌عنوان کد اجرا نکن.

### [🔴] Step 4: Semantic validator و آزمون‌های قراردادی مثبت/منفی

Semantic validator را مستقل از اجرای مدل/ابزار پیاده کن و برای همهٔ موارد زیر assertion آزمون‌پذیر داشته باش: یکتایی IDهای node و یکتایی dependency `(kind,id)` حتی با نسخهٔ متفاوت؛ یکتایی `counterId`؛ وجود start و endpointها؛ یکتایی نام port در تعریف‌ها؛ هر mapping به port موجود در source/target، عمق دقیقاً یک، پوشش همهٔ required inputs در هر transition و سازگاری `required`/نوع/enum؛ عملگر predicate سازگار با نوع port؛ decision enum برابر دامنهٔ مجاز rubric؛ وجود/قابل‌دسترسی‌بودن end و دقیقاً یک result برای هر end با port/outcome منطبق و emit کامل؛ شرط‌های reachable و routeهای کامل؛ حداکثر یک default/source و تعیین کامل دامنه (پوشش تمام enum/boolean values یا default برای دامنهٔ باز)، درحالی‌که overlap با first-match مجاز و deterministic است؛ error route target/map/type/required-input و ممنوعیت چرخهٔ error-route؛ retry shape، retryOn، attempt count و منع retry/route برای security denial/cancel؛ JSON Pointer سطح‌اول معتبر؛ integrity و نسخهٔ dependency؛ و limitهای اندازه و budget. چرخه‌های گراف کنترلی را با normal edge، exhaustion route و error transition تحلیل کن: در هر دور باید یک loop counter محدود و monotonic مصرف شود؛ مسیرِ بدون مصرف counter درون همان state رد شود. کران محافظه‌کارانه با saturating arithmetic برابر `|nodes| × Π(1 + maxIterations_i)` است؛ profile وقتی رد شود که کران از `maxNodeVisits` بیشتر باشد؛ Runtime نیز `maxNodeVisits` را مستقل و سخت enforce کند. ارجاع‌های خارجی از نظر shape اینجا و resolution واقعی در Phase 3 بررسی شوند. هیچ expression/callback/code پذیرفته نشود.

**Acceptance criteria:**
JSON Schema مطابق Draft 2020-12 و همهٔ fixtures معتبرند؛ schema/semantic errors تشخیصی و parity پوشش‌داده‌شده دارند؛ تمام موارد مثبت/منفی Step 4 تست شده‌اند، ازجمله duplicate `(kind,id)`، `counterId`، enum/type mismatch، pointer عمیق، default/exhaustiveness، first-match overlap و tie order، result/end mismatch، routeMap، retry exhaustion و nested loops؛ profileهای ناقص/نامعتبر پیش از load/dispatch رد می‌شوند؛ loader byte cap مصوب را قبل از parse enforce می‌کند؛ build/typecheck سبزند.

---

## [🔴] Phase 3: resolution قطعات مشترک و مجوزهای مؤثر v1

این فاز فقط قطعاتی را resolve می‌کند که در schema v1 هستند: Persona، Skill، Toolset، Rubric و Model Profile. هیچ منبع حقیقت موازی نساز. **تصمیم دامنهٔ v1:** inheritance، Node Template و Sub-workflow، recursion و composition تو‌در‌تو خارج از این نسخه‌اند؛ این موارد فقط با RFC، قرارداد/نسخهٔ جدا و approval مالک در scope آینده وارد می‌شوند، نه به‌عنوان step اجرایی این plan.

### [🔴] Step 1: ساخت resolver برای وابستگی‌های Profile

در registry/factory موجود، ارجاع‌های هر Profile را resolve کن؛ نسخهٔ دقیق و digest اختیاری را اعمال و missing، duplicate، ambiguous، ناسازگار، غیرفعال یا integrity-mismatch را پیش از activation رد کن. با AgentDefinition فعلی (Persona + Skills + Model) هماهنگ شو و متن‌ها را در Profile کپی نکن. برای Rubric و Model Profile، اگر منبع حقیقت موجود نیست، طبق تصمیم ثبت‌شده به قرارداد موجود وصل شو یا design decision لازم را متوقف/ثبت کن؛ ساخت registry موازی بدون تصمیم ممنوع است. Artifactها در run به نسخه/digest resolve شده pin شوند.

### [🔴] Step 2: تعریف و اعمال Toolsetهای نام‌دار

ابتدا بررسی کن Toolset مستقل در مخزن وجود دارد یا نه؛ اگر ندارد، فقط پس از تصمیم Phase 1 حداقل registry نام‌دار و نسخه‌دار از tool IDs واقعی بساز. ابزار مؤثر برابر intersectionِ Runtime-permitted، Persona.allowedTools و Toolset است، سپس deny list آن را کمتر می‌کند. Toolset هرگز ابزار غایب/غیرفعال یا خارج از مجوز را اضافه نمی‌کند؛ approval و resource limits نیز فقط می‌توانند سخت‌تر شوند. ثبت کن که schema validation مجوز اجرایی محسوب نمی‌شود و authorization در call site واقعی تکرار خواهد شد.

**Acceptance criteria:**
تمام dependency kindهای v1 به منبع حقیقت موجود/مصوب resolve می‌شوند؛ نسخه و digest پین و هر mismatch پیش از اجرا رد می‌شود؛ Toolset فقط دسترسی را محدود می‌کند؛ هیچ inheritance/template/sub-workflow در schema یا resolver اجرا نمی‌شود؛ تست‌های valid/missing/duplicate/version/digest/ambiguous/denied و scope trust موفق‌اند. هر درخواست Template/Sub-workflow به عنوان deferred future scope با تصمیم و traceability ثبت شده، نه الزام فراموش‌شده.
---

## [🔴] Phase 4: Workflow graph engine و bounded control-flow

پیاده‌سازی هستهٔ interpreter برای node/edge، ورودی/خروجی، شرط و حلقهٔ محدود به‌عنوان یک واحد داخلی و قابل‌آزمون. در پایان این فاز هنوز Profile برای کاربر فعال نمی‌شود؛ فقط kernel کامل و پایدار است و اجرای مدل/ابزار به handlerهای فاز بعد وابسته می‌ماند.

### [🔴] Step 1: state machine و انتخاب first-match

کنترل‌جریان بیرونی را با state machine صریح پیاده کن: start، resolve input، dispatch handler، اعتبارسنجی/ثبت output و انتخاب edge. انتخاب شرطی فقط مطابق قرارداد مشترک است: conditional edges به‌ترتیب priority صعودی و سپس declaration order؛ اولین predicate درست برنده است، حتی اگر شرط بعدی نیز درست باشد؛ اگر هیچ‌کدام درست نیست، تنها default مجاز اجرا می‌شود؛ بدون match/default fail-closed. ambiguity error تولید نکن. routeMap mapping سطح‌اول را با port type/required کنترل کن. تست کن دو شرط هم‌زمان درست‌اند، priority tie به declaration order می‌رود، default فقط fallback است، default تکراری رد می‌شود، و نبود route fail-closed است.

### [🔴] Step 2: ارزیابی predicateهای داده‌ای

عملگرهای محدود مصوب را بر خروجی resolveشده پیاده کن؛ JSON Pointer نامعتبر، property مفقود، نوع نامتوافق و value مقایسه‌ناپذیر را طبق semantics ثبت‌شده مدیریت کن. هیچ string expression، eval یا کد دلخواه اجرا نشود. آزمون مرزی برای null، مقدار مفقود، آرایه و object مطابق قرارداد اضافه کن.

### [🔴] Step 3: اجرای loopهای محدود و کران node visit

هر loop counter یکتا، monotonic و run-scoped باشد؛ یک iteration دقیقاً traversal موفق همان edge است. در تلاش بعد از سقف، onExhausted به‌صورت transition مشخص اجرا می‌شود. تمام normal، exhaustion و error-route transitions در cycle analysis بیایند؛ چرخه‌ای که در یک counter-state بدون افزایش counter دور بزند رد شود. semantic validator کران محافظه‌کارانهٔ `|nodes| × Π(1 + maxIterations_i)` را با saturating arithmetic محاسبه و با `maxNodeVisits` مقایسه کند؛ Runtime هم در هر transition hard visit cap را enforce کند تا nested loops یا خطای تحلیل نتواند runaway بسازد. تست nested/overlapping loops، exhaustion route، counter collision و overflow را اضافه کن.

### [🔴] Step 4: اجرای قرارداد error/retry/route

قرارداد typed خطا را پیاده کن: `fail` خاتمهٔ failure؛ `retry` فقط دسته‌های صریح retryOn را با maxAttempts شامل invocation اول و backoff ثابت تکرار می‌کند و پس از exhaust یا nonretryable fail می‌شود؛ `route` انتقال مستقیم به routeTo با نگاشت target inputها از failure envelope محدود (`failure.category/code/retryable`، `node.id/attempt` و snapshot `inputs.<port>`). raw exception text به node/مدل داده نشود. authorization/approval denial و cancellation همواره fail-closed و خارج از retry/route پروفایل هستند. route transition از normal edges مستقل اما در reachability/budget/cycle graph منظور شود.

### [🔴] Step 5: feature flag و دسترس‌پذیری امن kernel

Feature flag پشتیبانی Profile را بر اساس الگوی موجود اضافه/تطبیق بده؛ پیش‌فرض خاموش باشد. تا زمانی که خاموش است هیچ entry point کاربر نباید Profile را اجرا کند و درخواست‌های legacy تغییر نکنند. تست مثبت opt-in کنترل‌شده و منفی default-off / unknown profile / invalid profile پیش از handler dispatch اضافه کن.

**Acceptance criteria:**
graphهای خطی، شاخه‌ای و bounded-loop با fake handlerها deterministic هستند؛ first-match/default semantics در overlap/tie/no-match تست شده؛ mapping/predicate/error route نوع‌دار است؛ retry شمارش و پایان قطعی دارد؛ چرخه‌های نامحدود و کران visit ناکافی رد می‌شوند و hard cap Runtime می‌ایستد؛ خطاهای security/cancel قابل route/retry نیستند؛ feature flag default-off است و هیچ مسیر عمومی بدون opt-in وجود ندارد؛ kernel هنوز engine موازی مدل/tool نیست؛ unit tests/typecheck موفق‌اند.

---

## [🔴] Phase 5: handlerهای node و اتصال به سرویس‌های موجود

هستهٔ graph را به قابلیت‌های واقعی HOOTL وصل کن. این فاز تنها adapterهای node را اضافه می‌کند؛ کنترل جریان، loop bound و امنیت پایه از Phase 4/Phase 6 می‌آیند و نباید در handlerها به‌صورت موازی دوباره پیاده شوند.

### [🔴] Step 1: اتصال nodeهای intake و condition و end

پیاده‌سازی intake باید ورودی درخواست و context را به قرارداد port تبدیل کند؛ condition از evaluator Phase 4 استفاده کند؛ end فقط result declaration معتبر را بسازد. Clarification و user-facing result باید با lifecycle و payloadهای entry point موجود سازگار باشند.

### [🔴] Step 2: اتصال planner، execute و review با مرز اعتماد از روز اول

`planner` به Planner/feasibility/cycle flow موجود، `execute` به PlanRuntime/AgentRuntime/TaskRuntime و `review` به Acceptance/Final Review و Rubric مصوب delegate شود. ورودی/خروجی با contract بررسی شود و lifecycle فعلی دور زده نشود. از اولین ارسال `goal`، description، Persona/Skill یا fetch content به مدل، متن را به‌صورت untrusted data محصور کن؛ دستورهای تعبیه‌شده در آن هرگز system policy، tool allowlist، approval، feature flag یا route را تغییر نمی‌دهند. همین‌جا unit/integration adversarial test برای prompt injection در goal/persona/skill/fetched text و تلاش برای tool escalation اضافه کن، نه اینکه به hardening نهایی موکول شود. مدل/tool فقط از registry/factory resolve شوند.

### [🔴] Step 3: اتصال approval و رفتارهای خطا

approval node به mechanism interaction/callback موجود متصل شود؛ تصمیم approved/denied/expired و timeout/cancel را مستقل ثبت کند. Side-effect approval باید digest محتوای نمایش‌داده‌شده را ثبت و بلافاصله پیش از effect دوباره تطبیق دهد؛ mismatch=abort. Clarification از approval gate جدا بماند. `fail/retry/route` دقیقاً طبق Phase 4 اجرا شوند؛ route مقصد و mapping فقط همان sanitized failure envelope را می‌گیرند و هیچ مسیر خطا مجوز را گسترش نمی‌دهد. Limit `ask-user` فقط pause/resume معتبر است، نه approval خودکار.

### [🔴] Step 4: تست یکپارچهٔ handlerها و مرز امنیتی

تست integration برای هر هفت kind بنویس؛ node/config ناشناخته پیش از side effect رد شود. adversarial tests از Step 2 باید در همان PR/fase سبز باشند و ثابت کنند prompt injection از goal/Persona/Skill/fetch نمی‌تواند system instruction، toolset، approval، route یا budget را تغییر دهد. delegation به runtime مشترک، policy enforcement و lifecycle جاری را اثبات کن.

**Acceptance criteria:**
تمام هفت kind از طریق قرارداد handler عملیاتی‌اند؛ planner/execute/review به اجزای موجود delegate می‌کنند؛ approval و خطاها نتیجهٔ مشخص دارند؛ output هر node با port قراردادش سازگار است؛ handler ناشناخته fail-closed است؛ تست‌های integration ثابت می‌کنند tool/task lifecycle، auth، PlanRuntime و policyهای موجود دور زده نمی‌شوند.

---

## [🔴] Phase 6: lifecycle پایدار، بودجه و enforcement امنیتی

اجرای Profile باید در کنار حلقهٔ فعلی دارای وضعیت قابل‌بازیابی، توقف امن، بودجهٔ نهایی، رخدادهای قابل‌مشاهده و مجوزهای واقعی باشد. وضعیت اجرای Profile با plan/session موجود هم‌زیست می‌شود و فرمت ذخیره‌شدهٔ قدیمی را نمی‌شکند.

### [🔴] Step 1: پایداری state و resume نسخه‌دار

در store/lifecycle موجود، state لازم برای workflow run را ذخیره کن: profile ID/version و hash از canonical profile bytes، schema/runtime version، resolved dependency versions/digests، node/status فعلی، outputs/handoffs لازم، loop counters، budget counters، approvals (شامل digest مورد تأیید) و plan/session ارتباط‌یافته. نوشتن باید crash-safe مطابق قرارداد store موجود باشد. پیش از resume hash و dependency integrity را تطبیق بده؛ mismatch یا profile/dependency حذف‌شده یعنی توقف پیش از هر side effect. **Unknown / Requires Verification:** تضمین‌های store فعلی برای تشخیص side effect انجام‌شده اما commit‌نشده؛ attempt ID و intent/effect/commit journaling را با قرارداد موجود هماهنگ کن، و اگر نتیجهٔ side effect مبهم است آن را خودکار تکرار نکن.

### [🔴] Step 2: cancellation، timeout و resource budget

`maxDurationSeconds`، `maxNodeVisits`، `maxModelCalls` و `maxToolCalls` را در مسیر واقعی و نه صرفاً config اعمال کن؛ بودجهٔ Profile با سقف‌های AgentRuntime/tool/provider تجمیع شود و هیچ لایه‌ای نتواند بودجه را reset یا افزایش دهد. v1 sub-workflow ندارد، پس aggregate budget فقط در Profile run و PlanRuntime موجود تعریف می‌شود. Unknown Phase 1 دربارهٔ budget accounting باید قبل از این step حل شده باشد. cancellation باید به handler/task فعال برسد، state terminal معتبر ثبت کند و از شروع کار بعدی جلوگیری کند. رفتار limit طبق policy مصوب به fail/handoff/ask-user برود و counters در resume reset نشوند.

### [🔴] Step 3: enforce کردن tools و approval در runtime

در نقطهٔ فراخوانی واقعی ابزار، دسترسی مؤثر را دوباره اعمال کن؛ به validation پروفایل اکتفا نکن. ابزار، approval و budget از Runtime، user, Persona, Toolset و Profile فقط به‌صورت strictest/intersection محدود شوند. Profile/workspace override برای default بدون trust/opt-in مصوب رد شود. deny list، سیاست filesystem/network/Git و کنترل approval پابرجا بمانند؛ denial/cancel fail-closed و خارج از profile error routing باشد. Side effect بدون مجوز/approval پیش از اجرا مسدود شود. تغییر policy بین آغاز و resume نباید موجب افزایش اختیار شود.

### [🔴] Step 4: رخدادها، audit و خطاهای lifecycle

چرخهٔ profile را از طریق EventBus/observability فعلی گزارش کن: آغاز، node transition، loop، approval، tool/model budget، retry، failure، resume و پایان. اطلاعات حساس، secret، prompt خام و دادهٔ خصوصی را با قواعد redaction موجود ثبت نکن. شکست persistence یا event sink نباید باعث state مبهم یا اجرای دوبارهٔ side effect شود؛ semantics سازگار با تضمین‌های فعلی را ثبت و تست کن.

**Acceptance criteria:**
workflow پس از restart از state و hash/version درست resume می‌شود یا fail-closed می‌کند؛ cancellation، timeout و تمام budgetها عملاً enforce می‌شوند؛ مجوز ابزار در مرز اجرای واقعی بررسی و هیچ Profile آن را افزایش نمی‌دهد؛ approval digest پیش از side effect دوباره تطبیق می‌شود؛ side effect با نتیجهٔ مبهم خودکار تکرار نمی‌شود؛ رخدادهای lifecycle قابل‌ردیابی و فاقد secret هستند؛ تست crash/resume، stale profile/dependency/digest، policy تغییرکرده، cancellation حین اجرا و failure persistence می‌گذرند؛ تست‌های موجود plan/session/store همچنان سبزند.

---

## [🔴] Phase 7: پروفایل پیش‌فرض و حفظ رفتار فعلی

جریان فعلی HOOTL را فقط پس از استخراج از کد/تست به Profile پیش‌فرض تبدیل کن. Feature flag در v1 پیش‌فرض خاموش می‌ماند؛ خاموش بودن یعنی مسیر legacy بدون تغییر. Profile فقط با opt-in صریح و پس از parity gate اجرا می‌شود؛ انتخاب implicit/فعال‌سازی عمومی بدون gate ممنوع است.

### [🔴] Step 1: مدل‌کردن جریان فعلی در Profile پیش‌فرض

ترتیب واقعی intake/clarification، planner، feasibility/cycle checks، نمایش و تأیید plan، execution، acceptance/re-plan، review/report و cancellation را از کد و تست‌ها استخراج و به node/edge و policy نگاشت کن. تفاوت‌های اصل Human-Out-Of-Loop، تنها تعامل مجاز، retry/re-plan خودکار، rate limit و خطای جزئی باید صریح باقی بمانند؛ behavior را از مستندات حدس نزن.

### [🔴] Step 2: اتصال default profile به Orchestrator

هنگام flag خاموش، هیچ Profileای resolve/dispatch نشود و مسیر legacy فعلی اجرا شود. با flag روشن و default profile صریح/مصوب، Profile resolve شود؛ profile نامعتبر fail-closed و diagnostic بدهد و هرگز silent fallback، اجرای نیمه‌راهی یا گسترش ابزار رخ ندهد. فعال‌سازی پیش‌فرض در محیط/کاربر فقط پس از parity و opt-in/approval ثبت‌شده انجام شود.

### [🔴] Step 3: اثبات parity و سازگاری دادهٔ موجود

تست‌های characterization/golden برای همان ورودی‌ها و خروجی‌های observable موجود بساز: clarification، plan confirmation، execution order، retry/replan، acceptance failure، cancellation، final report و tool authorization. Planها و Sessionهای قدیمی باید قابل‌خواندن/resume بمانند یا migration مستند و آزموده داشته باشند. هر تفاوت رفتاری عمدی باید در این طرح، release notes و approval مالک ثبت شود.

**Acceptance criteria:**
درخواست بدون profile نتیجه و مسیر observable سازگار با baseline دارد؛ تمام رفتارهای کلیدی default در parity test پوشش داده و گذرانده می‌شوند؛ authorization و Human-Out-Of-Loop ضعیف نشده‌اند؛ داده‌های plan/session موجود خوانده می‌شوند یا migration برگشت‌پذیر و آزموده دارند؛ فعال‌سازی default قابل rollback است و خطای بارگذاری به اجرای ناامن منجر نمی‌شود.

---

## [🔴] Phase 8: ساخت، انتخاب و اعتبارسنجی Profile توسط کاربر

قابلیت سفارشی‌سازی را روی رابط‌های موجود عرضه کن تا کاربر بتواند Profile JSON بسازد/قرار دهد، فهرست و اعتبارسنجی کند و برای یک اجرای مشخص انتخاب کند. این فاز ویرایشگر گرافیکی یا DSL جدید اضافه نمی‌کند؛ JSON همان قالب نویسندگی/انتقال باقی می‌ماند.

### [🔴] Step 1: فراهم‌کردن مسیر authoring و discovery

طبق scopeهای تصویب‌شدهٔ Phase 1، discovery و authoring Profile سفارشی را فراهم کن. Project/workspace profile untrusted است و نمی‌تواند default را override کند، مگر trust/opt-in صریح طبق قرارداد موجود. Feature flag تا انتخاب کاربر/اپراتور خاموش باقی می‌ماند. precedence، naming، schema/semantic errors و versioning مستند شود؛ registry پکیج دست‌نخورده بماند.

### [🔴] Step 2: افزودن فهرست/اعتبارسنجی/انتخاب در interfaceهای پشتیبانی‌شده

entry pointهای جاری CLI و server/API را دوباره تأیید و با الگوی config آن‌ها سازگار کن. کاربر بتواند Profileها را فهرست/اعتبارسنجی کند، یک profile ID را برای run انتخاب کند و خطای نسخه/وابستگی/مجوز را پیش از اجرا ببیند. سازگاری clientها و مسیر بدون تعیین profile را حفظ کن. **Unknown / Requires Verification:** نام دقیق command/flag، request field یا UI affordance را از قراردادهای موجود استخراج کن؛ API یا route جدید را از روی حدس نساز.

### [🔴] Step 3: نمونه‌ها و راهنمای نویسندگی

مستندات خودبسنده برای schema، nodeهای پشتیبانی‌شده، پورت و mapping، شرط‌های مجاز، bounded loop، Toolset/Persona/Skill reference، approval، بودجه، error policy، version compatibility، validation، انتخاب و troubleshooting اضافه کن. حداقل یک نمونهٔ کوچک سفارشی و یک نمونهٔ bounded review/fix ارائه کن؛ برای هر دو آزمون خودکار اعتبارسنجی بنویس تا در Phase 9 به CI متصل شوند. مشخص کن افزودن node kind تازه مستلزم handler و تست Runtime است.

**Acceptance criteria:**
نویسنده می‌تواند فقط با JSON مستندشده Profile سفارشی تعریف کند؛ Profile معتبر در scope مصوب discover و انتخاب می‌شود و Profile نامعتبر قبل از اجرا diagnostic می‌دهد؛ CLI و server/API موجود به‌صورت سازگار انتخاب Profile را پشتیبانی می‌کنند؛ درخواست قدیمی بدون profile حفظ می‌شود؛ نمونه‌ها در CI اعتبارسنجی می‌شوند؛ هیچ DSL، eval یا ویرایشگر خارج از دامنه اضافه نشده است.

---

## [🔴] Phase 9: hardening امنیتی و سنجش منابع

پس از اتصال handlerها و پیش از rollout، امنیت/adversarial و ظرفیت را با معیارهای مصوب harden کن. مرز اعتماد از Phase 5 برقرار شده؛ این فاز آن را end-to-end می‌بندد و جایگزین تست‌های زودهنگام نیست.

### [🔴] Step 1: آزمون adversarial سرتاسری و policy boundary

تست end-to-end برای profile/Persona/Skill/fetch injection، اجرای code/eval، tool/path escalation، untrusted workspace override، approval/budget downgrade، forged dependency/version/digest، route abuse، error payload leakage، graph بزرگ، nested/overlapping loops، exhaustion، cancellation، restart و persistence failure اضافه کن. ثابت کن injection هیچ‌گاه system policy، authorization، approval، feature flag یا budget را تغییر نمی‌دهد؛ raw exception/secret وارد route/prompt/log نمی‌شود؛ default-off واقعی است؛ denied/cancelled action هیچ‌وقت retry/routed نمی‌شود. تست‌ها از gateهای مراحل قبلی کپی مبهم نباشند؛ اینجا end-to-end و integration کامل پوشش داده شوند.

### [🔴] Step 2: ارزیابی performance و منابع

با workflow نماینده، load/schema/semantic validation/resolution/run هزینه، node visits، wall time و رشد state را نسبت به baseline اندازه‌گیری کن. اعداد هدف را از baseline و limits مصوب استخراج کن، نه با حدس. prove کن byte cap پیش از parse، counters قبل از call، `maxNodeVisits` hard cap و time/model/tool budgets قبل از runaway موثرند؛ flag خاموش overhead غیرضروری و regression محسوس ندارد. نتیجه و محیط قابل‌بازتولید را ثبت کن.

**Acceptance criteria:**
همهٔ security/adversarial E2Eهای تعریف‌شده سبزند؛ هیچ profile/untrusted text مجوز یا policy را تضعیف نمی‌کند؛ default-off و عدم‌اجرای denial/cancel با تست اثبات شده؛ limits قبل از مصرف runaway عمل می‌کنند؛ performance با معیار baseline مصوب سازگار است یا blocker صریح ثبت شده؛ suiteهای قبلی پابرجا هستند.

---

## [🔴] Phase 10: migration، مستندات، CI و تحویل مرحله‌ای

فقط بعد از hardening، compatibility/recovery، مستندات و gateهای PR را کامل کن. rollout باید opt-in، قابل‌ردیابی و rollback-safe باشد؛ merge/release همچنان نیازمند مجوز مالک است.

### [🔴] Step 1: migration و عملیات rollout/rollback

راهنمای upgrade نسخهٔ Profile/schema/Runtime و رفتار profile/dependency حذف‌شده یا ناسازگار را بنویس. migration persistent state اگر لازم است idempotent و rollback-aware باشد؛ اگر لازم نیست شواهد عدم نیاز ثبت کن. Feature flag default-off و opt-in enablement را در config/operations مستند کن؛ downgrade باعث تکرار side effect یا افزایش authorization نشود. دادهٔ run، profile digest/version و approval digest را در resume بررسی کن.

### [🔴] Step 2: مستندات، traceability و Gateهای CI

Schema/author guide، error/retry semantics، first-match/default، loop bound formula، trust/approval/tool policy، explicit v1 exclusions، migration و release notes را با implementation همگام کن. `R-xxx`→phase/step→test/doc matrix و Decision/Unknown Register را نهایی کن. Gateهای CI باید نمونه‌های default/bounded/error-route را با schema و semantic validators بررسی، parity/generator/typecheck/lint/build/test/security check را اجرا کنند؛ شکست baseline با clean baseline تفکیک شود.

### [🔴] Step 3: بازبینی مستقل و PR-by-phase handoff

برای هر فاز PR جدا و قابل‌بازبینی داشته باش؛ description شامل R IDs، تغییر، test evidence، CI head SHA و dependencies باشد. قبل از ساخت/ادامهٔ branch بعدی CI/review و base commit را کنترل کن؛ branchها را فقط طبق ترتیب dependency rebase کن. PR #5/#6 را تنها اگر gate فاز 1 وابستگی واقعی یافته دنبال کن. بازبینی معماری، QA، امنیت، عملیات و compatibility را انجام بده. statusهای plan را فقط با evidence به‌روز کن؛ merge/release بدون درخواست و مجوز مستقل مالک ممنوع است.

**Acceptance criteria:**
migration/rollback آزموده یا عدم نیاز مستند است؛ CI و semantic/schema/security gates روی head هر PR نتیجهٔ ثبت‌شده دارند؛ traceability برای همهٔ R IDs کامل است؛ هیچ unknown مسدودکننده‌ای بی‌صاحب/بی‌موعد نیست؛ PRها فازبندی و قابل‌بازبینی‌اند؛ regressions از baseline تفکیک شده؛ همهٔ docs/examples با implementation همخوانند؛ rollout default-off است؛ merge/release بدون مجوز انجام نشده است.