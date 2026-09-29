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
10. از الگوهای اعتبارسنجی، امنیت، TypeScript، تست، خطا، ثبت رخداد، migration و مستندسازی موجود در مخزن پیروی کن. پیش از تغییر، baseline و منبع حقیقت را بیاب. تغییرات را در branch و PR انجام بده؛ `main` را مستقیم تغییر نده. هیچ merge، انتشار یا عبور از تأیید انسانی را بدون مجوز صریح انجام نده.
11. پروفایل، Persona، Skill، Toolset و سایر محتوای registry **تعریف داده‌ای غیرقابل‌اعتماد** هستند، نه کد یا دستور اجرایی. DSL، eval، عبارت شرطی اجرایی یا کد دلخواه در پروفایل مجاز نیست. Runtime باید قواعد امنیتی نهایی را مستقل از پروفایل اعمال کند.
12. هیچ پروفایلی نمی‌تواند ابزارهای خارج از مجوز Persona، محدودهٔ اجرای Runtime یا سیاست‌های ایمنی HOOTL را اعطا کند. محدودیت ابزارها فقط می‌تواند دسترسی را کمتر کند، نه بیشتر.

# Execution Plan

## [🔴] Phase 1: تثبیت baseline و قرارداد معماری پروفایل

پیش از پیاده‌سازی، وضعیت دقیق کد، نقاط اتصال موجود، اسناد اجرایی و وابستگی‌های باز را تثبیت کن. قرارداد باید Workflow Profile را لایهٔ پیکربندی روی Runtime فعلی تعریف کند، نه موتور اجرای موازی. خروجی این فاز تصمیم‌های ثبت‌شده، دامنهٔ نسخهٔ اول و به‌روزرسانی غیرمخرب طرح اجرایی پروژه است.

### [🔴] Step 1: تعیین baseline و وضعیت تغییرات موجود

ثبت کن روی کدام branch و commit قرار است کار شود؛ `main`، نسخهٔ مرتبط از `docs/UNIFIED_EXECUTION_PLAN.md` و اسناد معماری را بررسی کن؛ وضعیت و تفاوت PRهای باز را دوباره از GitHub بگیر و مشخص کن کدام تغییرات در مبنای منتخب ادغام شده‌اند. در آخرین بررسی این طرح، `main` روی `bbbf6ee` بود و PRهای Draft #5 (تمرکز promptها) و #6 (انتقال Persona/Skillها) باز و ادغام‌نشده بودند؛ این وضعیت را جاری فرض نکن. تصمیم بگیر این PRها پیش‌نیاز واقعی‌اند یا می‌توان با قراردادهای موجود ادامه داد؛ وابستگی فرضی ایجاد نکن.

### [🔴] Step 2: ردیابی معماری و آزمون‌های baseline

مسیر واقعی جریان درخواست و اجرای کار را از entry pointها تا `Orchestrator`، `Planner`، `PlanRuntime`، `AgentRuntime`، `TaskRuntime`، Acceptance/Review، registryها، storeها و CLI/server دنبال کن. قرارداد `Plan` و `PlanStep` فعلی، DAG و CycleDetector، تأیید plan، re-plan، resume/cancel، `Persona.allowedTools` و لایه‌بندی registry پکیج/پروژه را ثبت کن. دستورات تست/typecheck/lint/build را از `package.json` و CI استخراج و baseline را اجرا کن؛ شکست‌های قبلی را بدون بازتولید به baseline نسبت نده.

### [🔴] Step 3: نهایی‌کردن مرز و معنای قرارداد

پیشنهاد JSON Schema موجود را به‌عنوان پیش‌نویس بررسی و قرارداد نسخهٔ اول را نهایی کن: metadata و سازگاری Runtime؛ نسخهٔ schema و profile؛ Workflow با start، node، edge، port، mapping و خروجی؛ nodeهای محدود `intake`، `planner`، `execute`، `review`، `condition`، `approval` و `end`؛ ارجاع‌های Persona/Skill/Toolset/Rubric/Model Profile؛ خطا، retry و سقف منابع؛ سیاست ابزار/تأیید؛ نتیجهٔ پایانی. شرط‌ها فقط عملگرهای داده‌ای محدود و JSON Pointer باشند. **Unknown / Requires Verification:** روش canonical برای هم‌ترازی JSON Schema با اعتبارسنجی runtime، نسخه‌بندی واقعی اجزای Registry، محل و precedence پروفایل‌های پکیج/پروژه/کاربر، semantics دقیق approval در CLI و server، و اینکه toolset/rubric/model-profile اکنون قرارداد مستقل دارند یا نه. هر مورد را با بررسی مخزن حل کن یا تصمیم لازم را صریح ثبت کن؛ فرض‌های حل‌نشده را پنهان نکن.

### [🔴] Step 4: تثبیت سازگاری با موتور فعلی و دامنهٔ rollout

طراحی کن پروفایل‌ها چگونه بر جریان فعلی سوار می‌شوند بدون جایگزین‌کردن Orchestrator/PlanRuntime یا تضعیف چرخهٔ تأیید، re-plan، cancellation و محدودیت‌های ابزار. ناسازگاری مهم را مشخص کن: Plan فعلی مبتنی بر وابستگی‌های DAG است، درحالی‌که Workflow Profile مسیر شرطی و حلقهٔ محدود می‌خواهد. تصمیم اجرایی دربارهٔ adapter/لایهٔ کنترل جریان را مستند کن؛ اگر reuse بدون تغییر معنای فعلی ممکن نیست، پیش از ساخت موتور موازی، تصمیم معماری و اثر سازگاری را ثبت کن. رفتار پیش‌فرض پس از تأیید plan باید همچنان مطابق اصل Human-Out-Of-Loop باشد؛ approval node فقط طبق پروفایل و policy مجاز افزوده شود.

### [🔴] Step 5: ثبت طرح در مرجع پروژه

پس از شناخت branch هدف، scope پروفایل‌ها را به‌صورت epic/فازهای ردیابی‌شده به مرجع اجرایی canonical مخزن اضافه کن (در baseline فعلی `docs/UNIFIED_EXECUTION_PLAN.md` چنین جایگاهی دارد). متن و statusهای موجود را حذف یا بازنویسی نکن؛ source audit، شناسه‌های موجود و مسیرهای تأیید پروژه را حفظ کن. همین سند و تصمیم‌های حل‌شده/باز را در مسیر مستندات مناسب مخزن قابل‌ردیابی کن.

**Acceptance criteria:**
baseline branch/commit و وضعیت PRها ثبت شده؛ مسیرهای واقعی و تست‌های موجود با شواهد مشخص‌اند؛ قرارداد نسخهٔ اول و مرز Runtime ثبت شده؛ همهٔ unknownهای اثرگذار حل یا صریحاً برای تصمیم مالک علامت‌گذاری شده‌اند؛ ناسازگاری DAG/loop راه‌حل تأییدشده دارد؛ دامنهٔ profiling به طرح canonical مخزن افزوده شده بدون حذف traceability یا تغییر ناموجه رفتار موجود.

---

## [🔴] Phase 2: قرارداد JSON، بارگذار Profile و اعتبارسنجی معنایی

پیاده‌سازی قرارداد داده‌ای پایدار و قابل‌انتقال برای Profileها و مسیر کشف/بارگذاری آن‌ها بر اساس الگوی registry موجود. این فاز نباید اجرای workflow را فعال کند؛ پروفایل نامعتبر باید پیش از اجرا با خطای تشخیصی و قابل‌اقدام رد شود.

### [🔴] Step 1: افزودن schema نسخه‌دار و نمونهٔ معتبر

JSON Schema مطابق Draft 2020-12 را با فیلدهای نهایی Phase 1 اضافه کن. `schemaVersion` را از نسخهٔ مستقل Profile جدا نگه دار؛ `additionalProperties` را برای سطوح قراردادی به‌صورت سخت‌گیرانه تعریف کن؛ محدودیت طول/شناسه/enum و نسخهٔ Runtime را مستند کن. نمونهٔ پروفایل را بساز و یک جریان نمونه شامل شرط، approval و حلقهٔ دارای سقف را به‌صورت fixture داشته باش. محل دقیق فایل‌ها را با convention واقعی مخزن انتخاب کن.

### [🔴] Step 2: هم‌ترازکردن اعتبارسنجی runtime و JSON Schema

مسیر اعتبارسنجی runtime را با روش پذیرفته‌شدهٔ Phase 1 پیاده کن. JSON Schema و validator نباید قراردادهای متناقض داشته باشند: یا یک منبع حقیقت با تولید/مصرف سازگار ایجاد شود یا آزمون parity کامل، اختلاف آن‌ها را آشکار کند. schema validation را از semantic validation جدا کن و خطاها را شامل profile ID، node/edge/field و علت مشخص ساز.

### [🔴] Step 3: افزودن خواندن و کشف Profile در Registry

Profileها را از scopeهای تصویب‌شده بخوان و با ترتیب precedence فعلی registry (package سپس project override) هماهنگ کن، مگر تصمیم Phase 1 خلاف آن را مستند کرده باشد. خطای JSON خراب، ID تکراری، profile override مبهم، نسخهٔ schema/Runtime پشتیبانی‌نشده و فایل غیرقابل‌دسترسی را ایمن و قابل‌تشخیص مدیریت کن. دادهٔ بارگذاری‌شده را immutable/validated به لایه‌های بعدی بده و هیچ فایل یا محتوایی را به‌عنوان کد اجرا نکن.

### [🔴] Step 4: اعتبارسنجی معنایی مستقل از اجرای مدل

اعتبارسنجی کن: یکتایی شناسهٔ node/port، start node موجود، endpointهای edge، تطابق نام/نوع پورت و mapping، سازگاری خروجی‌ها و terminal resultها، شرط‌های محدود و دارای نوع، مسیرهای reachable، امکان رسیدن مسیرهای مجاز به end، شاخه‌های شرطی کامل، ساختار و سقف retry/loop/budget، و نبود چرخهٔ نامحدود. در این فاز فقط قالب و ارجاع‌های قابل‌شناسایی با registryهای فعلی از نظر ساختاری کنترل شوند؛ resolution نسخه‌ای/وجودی Toolset و سایر قطعات جدید در Phase 3 کامل می‌شود. هر دور فقط وقتی معتبر باشد که edge/loop guard صریح، counter مستقل و max iteration محدود داشته باشد. هیچ expression string یا کد دلخواه پذیرفته نشود.

**Acceptance criteria:**
JSON Schema مطابق Draft 2020-12 و sample معتبرند؛ validator runtime و schema parity آزمون‌پذیر دارند؛ registry فقط Profileهای ساختاری معتبر و نسخهٔ schema/Runtime پشتیبانی‌شده را بارگذاری می‌کند؛ خطاهای ساختاری و معنایی graph با محل و علت قابل‌اقدام رد می‌شوند؛ تست‌های مثبت و منفی برای ID تکراری، port mismatch، graph غیرقابل‌دسترسی، خروجی terminal نامعتبر و loop نامحدود موفق‌اند؛ resolution کامل اجزای خارجی به Phase 3 وابسته و صریح است؛ build/typecheckهای مربوطه سبزند.

---

## [🔴] Phase 3: قطعات قابل‌بازاستفاده و resolution وابستگی‌ها

Profileها باید بتوانند قطعات را بدون کپی prompt یا منطق کنار هم بچینند. این فاز قرارداد Persona/Skill/Toolset/Rubric/Model Profile را به registryهای HOOTL متصل می‌کند و Node Template و Sub-workflow را به شکل محدود، نسخه‌دار و غیرقابل‌اجرای کد عرضه می‌کند.

### [🔴] Step 1: ساخت resolver برای وابستگی‌های Profile

در لایهٔ registry/factory موجود، ارجاع‌های هر Profile را resolve کن؛ شناسه، نسخهٔ دقیق یا constraint مصوب Phase 1 را اعمال کن و مراجع missing، duplicate، ambiguous، ناسازگار یا غیرفعال را پیش از شروع اجرا رد کن. با AgentDefinition فعلی (Persona + Skills + Model) و AgentFactory هماهنگ شو و منبع موازی برای تعریف Persona/Skill نساز. برای Rubric و Model Profile، اگر Phase 1 منبع حقیقت مستقلی پیدا نکرد، طبق تصمیم ثبت‌شده به قرارداد موجود متصل شو یا کمینهٔ registry لازم را اضافه کن؛ prompt/model config را در Profile کپی نکن. چون ابزارها مجوز دارند، resolution باید intersection این مجموعه‌ها را بسازد: ابزارهای مجاز runtime، `Persona.allowedTools`، Toolset انتخابی و deny list Profile.

### [🔴] Step 2: تعریف و اعمال Toolsetهای نام‌دار

ابتدا بررسی کن آیا Toolset مستقل در مخزن وجود دارد؛ اگر ندارد، قرارداد داده‌ای registry آن را به‌صورت فهرست شناسهٔ ابزارها و metadata نسخه‌دار اضافه کن. Toolset فقط می‌تواند دسترسی را محدودتر کند؛ ابزار ناموجود، غیرفعال یا خارج از Persona هرگز با Toolset مجاز نمی‌شود. برابری با مجوزهای فعلی AgentFactory و `assignedTools` را حفظ کن.

### [🔴] Step 3: افزودن Node Templateهای داده‌ای

قابلیت template را برای پارامتردهی/بازتولید Nodeهای موجود طراحی کن؛ template نوع اجرایی تازه یا کد نمی‌سازد. ورودی‌های template باید schema/port تعریف‌شده داشته باشند، مقداردهی و overrideها محدود و deterministic باشند و پس از expansion، همهٔ nodeها دوباره از validator Phase 2 عبور کنند. IDهای حاصل باید پایدار و بدون collision باشند.

### [🔴] Step 4: افزودن Sub-workflow محدود

تعریف یک graph قابل‌فراخوانی با قرارداد ورودی/خروجی و نسخهٔ صریح اضافه کن. در زمان resolution، مرز ورودی/خروجی را به workflow فراخواننده نگاشت کن؛ recursion، چرخهٔ ارجاع، dependency حل‌نشده و mismatch را رد کن. محدودیت بودجه و مجوزهای caller باید به فرزند منتقل شوند و sub-workflow نتواند policy را گسترش دهد.

**Acceptance criteria:**
Profile می‌تواند Persona، Skill، Toolset، Rubric، Model Profile و قطعات قابل‌بازاستفادهٔ معتبر را resolve کند؛ template/sub-workflow پس از expansion deterministic و دوباره‌اعتبارسنجی می‌شوند؛ نسخه/مرجع نامعتبر پیش از اجرا خطای دقیق می‌دهد؛ هیچ مسیر ترکیب یا override مجوزی فراتر از `Persona.allowedTools`/Runtime ایجاد نمی‌کند؛ تست‌های مجاز، denied، نسخهٔ ناسازگار، ID collision، recursion و interface mismatch می‌گذرند.

---

## [🔴] Phase 4: Workflow graph engine و bounded control-flow

پیاده‌سازی هستهٔ interpreter برای node/edge، ورودی/خروجی، شرط و حلقهٔ محدود به‌عنوان یک واحد داخلی و قابل‌آزمون. در پایان این فاز هنوز Profile برای کاربر فعال نمی‌شود؛ فقط kernel کامل و پایدار است و اجرای مدل/ابزار به handlerهای فاز بعد وابسته می‌ماند.

### [🔴] Step 1: پیاده‌سازی state machine و data mapping

کنترل‌جریان profile را با state machine صریح پیاده کن: آغاز graph، resolve ورودی node، dispatch از طریق قرارداد handler، ثبت output و انتخاب edge واجدشرایط. داده از mapping نام‌دار منتقل شود و schema/type پورت در مرزها کنترل شود. انتخاب edge در صورت چند شرط درست باید deterministic و مطابق قرارداد باشد؛ ambiguity باید پیش از dispatch رد شود.

### [🔴] Step 2: ارزیابی predicateهای داده‌ای

عملگرهای محدود مصوب را بر خروجی resolveشده پیاده کن؛ JSON Pointer نامعتبر، property مفقود، نوع نامتوافق و value مقایسه‌ناپذیر را طبق semantics ثبت‌شده مدیریت کن. هیچ string expression، eval یا کد دلخواه اجرا نشود. آزمون مرزی برای null، مقدار مفقود، آرایه و object مطابق قرارداد اضافه کن.

### [🔴] Step 3: اجرای loopهای صریح و محدود

edgeهای دارای loop را فقط با `maxIterations` و counter اختصاصی اجرا کن. افزایش counter، ترتیب visit، شرط خروج و پایان به‌علت سقف را صریح کن؛ الگوریتم باید در هر ورودی معتبر terminate کند. cycleهای خارج از loop guard یا حلقهٔ چندمسیرهٔ فاقد bound باید پیش از dispatch رد شوند.

### [🔴] Step 4: قرارداد نتیجه/خطا و seam داخلی handler

قرارداد typed برای اجرای handler، نتیجهٔ موفق، شاخهٔ انتخابی، خطای فنی/کیفی و توقف تعریف کن. در این فاز فقط fake handlerهای تست برای اثبات kernel مجازند؛ هیچ stub تولیدی یا route عمومی که کار ناتمام را اجرا کند اضافه نکن. node kind یا config ناشناخته fail-closed باشد.

**Acceptance criteria:**
graphهای خطی، شاخه‌ای و bounded-loop با fake handlerهای تست به‌صورت deterministic اجرا می‌شوند؛ mapping و predicateها قرارداد نوع‌دار دارند؛ تمام چرخه‌ها یا دارای guard/sقف معتبرند یا رد می‌شوند؛ node visit/iteration متناهی است؛ error/result states ساختاریافته‌اند؛ kernel به کاربر عرضه نشده و هیچ موتور موازی مدل/tool ایجاد نشده؛ unit tests و typecheckهای فاز موفق‌اند.

---

## [🔴] Phase 5: handlerهای node و اتصال به سرویس‌های موجود

هستهٔ graph را به قابلیت‌های واقعی HOOTL وصل کن. این فاز تنها adapterهای node را اضافه می‌کند؛ کنترل جریان، loop bound و امنیت پایه از Phase 4/Phase 6 می‌آیند و نباید در handlerها به‌صورت موازی دوباره پیاده شوند.

### [🔴] Step 1: اتصال nodeهای intake و condition و end

پیاده‌سازی intake باید ورودی درخواست و context را به قرارداد port تبدیل کند؛ condition از evaluator Phase 4 استفاده کند؛ end فقط result declaration معتبر را بسازد. Clarification و user-facing result باید با lifecycle و payloadهای entry point موجود سازگار باشند.

### [🔴] Step 2: اتصال planner، execute و review

`planner` به Planner/feasibility/cycle flow موجود، `execute` به PlanRuntime/AgentRuntime/TaskRuntime و `review` به Acceptance/Final Review و Rubric مصوب delegate شود. ورودی و خروجی هر adapter با contract بررسی شود؛ handler حق ندارد auth، cancellation، resource lock، re-plan یا status موجود را دور بزند. مدل/toolها از AgentFactory و registries resolve شوند.

### [🔴] Step 3: اتصال approval و رفتارهای خطا

approval node به mechanism interaction/callback موجود متصل شود؛ قبل از side effect لازم، تصمیم مجاز/ردشده/منقضی را ثبت کند. خطای فنی، شکست کیفیت، clarification/approval، cancellation و limit را جدا map کن. `fail`، retry محدود، route به failure edge و ask-user فقط در دامنهٔ policy مصوب باشند؛ نتیجهٔ end و status summary با قراردادهای جاری هماهنگ بمانند.

### [🔴] Step 4: تست یکپارچهٔ handlerها

تست integration برای هر هفت kind (`intake`، `planner`، `execute`، `review`، `condition`، `approval` و `end`) بنویس؛ node ناشناخته و config بدون handler باید قبل از side effect رد شوند. ثابت کن delegation به orchestrator/runtime مشترک است و handlerها lifecycleهای جاری را تکراری نمی‌سازند.

**Acceptance criteria:**
تمام هفت kind از طریق قرارداد handler عملیاتی‌اند؛ planner/execute/review به اجزای موجود delegate می‌کنند؛ approval و خطاها نتیجهٔ مشخص دارند؛ output هر node با port قراردادش سازگار است؛ handler ناشناخته fail-closed است؛ تست‌های integration ثابت می‌کنند tool/task lifecycle، auth، PlanRuntime و policyهای موجود دور زده نمی‌شوند.

---

## [🔴] Phase 6: lifecycle پایدار، بودجه و enforcement امنیتی

اجرای Profile باید در کنار حلقهٔ فعلی دارای وضعیت قابل‌بازیابی، توقف امن، بودجهٔ نهایی، رخدادهای قابل‌مشاهده و مجوزهای واقعی باشد. وضعیت اجرای Profile با plan/session موجود هم‌زیست می‌شود و فرمت ذخیره‌شدهٔ قدیمی را نمی‌شکند.

### [🔴] Step 1: پایداری state و resume نسخه‌دار

در store/lifecycle موجود، state لازم برای workflow run را ذخیره کن: profile ID و version، schema/runtime version، node/status فعلی، outputs/handoffs لازم، loop counters، budget counters، approvals و plan/session ارتباط‌یافته. نوشتن باید crash-safe مطابق قرارداد store موجود باشد. resume باید همان snapshot/version را بازیابی کند؛ اگر profile/dependency/version موجود نیست یا integrity mismatch دارد، اجرای side effect را متوقف و خطای امن ارائه کند.

### [🔴] Step 2: cancellation، timeout و resource budget

`maxDurationSeconds`، `maxNodeVisits`، `maxModelCalls` و `maxToolCalls` را در مسیر واقعی و نه صرفاً config اعمال کن؛ محدودیت‌ها در sub-workflow هم تجمیع شوند. cancellation باید به handler/task فعال برسد، state terminal معتبر ثبت کند و از شروع کار بعدی جلوگیری کند. رفتار limit طبق policy مصوب به fail/handoff/ask-user برود و counters در resume reset نشوند.

### [🔴] Step 3: enforce کردن tools و approval در runtime

در نقطهٔ فراخوانی واقعی ابزار، دسترسی مؤثر را دوباره اعمال کن؛ به validation پروفایل اکتفا نکن. deny list، Persona policy، مجوز ابزارهای خارجی، محدودیت‌های filesystem/network/Git و قواعد approval موجود مستقل از پروفایل پابرجا بمانند. Side effect بدون مجوز یا بدون تأیید لازم باید پیش از اجرا مسدود شود. تغییر policy بین آغاز و resume نباید موجب افزایش اختیار شود.

### [🔴] Step 4: رخدادها، audit و خطاهای lifecycle

چرخهٔ profile را از طریق EventBus/observability فعلی گزارش کن: آغاز، node transition، loop، approval، tool/model budget، retry، failure، resume و پایان. اطلاعات حساس، secret، prompt خام و دادهٔ خصوصی را با قواعد redaction موجود ثبت نکن. شکست persistence یا event sink نباید باعث state مبهم یا اجرای دوبارهٔ side effect شود؛ semantics سازگار با تضمین‌های فعلی را ثبت و تست کن.

**Acceptance criteria:**
workflow پس از restart از state و نسخهٔ درست resume می‌شود یا fail-closed می‌کند؛ cancellation، timeout و تمام budgetها عملاً enforce می‌شوند؛ مجوز ابزار در مرز اجرای واقعی بررسی و هیچ Profile آن را افزایش نمی‌دهد؛ approval پیش از side effect اجباری اجرا می‌شود؛ رخدادهای lifecycle قابل‌ردیابی و فاقد secret هستند؛ تست crash/resume، stale profile، policy تغییرکرده، cancellation حین اجرا و failure persistence می‌گذرند؛ تست‌های موجود plan/session/store همچنان سبزند.

---

## [🔴] Phase 7: پروفایل پیش‌فرض و حفظ رفتار فعلی

جریان فعلی HOOTL را به Profile پیش‌فرض تبدیل کن و به‌صورت افزایشی فعال ساز. درخواست‌هایی که profile انتخاب نمی‌کنند باید همان behavior فعلی را داشته باشند؛ profile جدید تا عبور از parity gate جایگزین مسیر قدیمی نشود.

### [🔴] Step 1: مدل‌کردن جریان فعلی در Profile پیش‌فرض

ترتیب واقعی intake/clarification، planner، feasibility/cycle checks، نمایش و تأیید plan، execution، acceptance/re-plan، review/report و cancellation را از کد و تست‌ها استخراج و به node/edge و policy نگاشت کن. تفاوت‌های اصل Human-Out-Of-Loop، تنها تعامل مجاز، retry/re-plan خودکار، rate limit و خطای جزئی باید صریح باقی بمانند؛ behavior را از مستندات حدس نزن.

### [🔴] Step 2: اتصال default profile به Orchestrator

انتخاب implicit را به default profile resolve کن، اما fallback پنهان یا تغییر رفتار هنگام profile نامعتبر نساز. در صورت نبود profile registry یا فایل پیش‌فرض، مسیر legacy طبق migration تصمیم‌گرفته‌شده عمل کند و diagnostic بدهد. خطای loading نباید باعث اجرای نیمه‌راهی یا بی‌صدا برگشت به ابزارهای گسترده‌تر شود.

### [🔴] Step 3: اثبات parity و سازگاری دادهٔ موجود

تست‌های characterization/golden برای همان ورودی‌ها و خروجی‌های observable موجود بساز: clarification، plan confirmation، execution order، retry/replan، acceptance failure، cancellation، final report و tool authorization. Planها و Sessionهای قدیمی باید قابل‌خواندن/resume بمانند یا migration مستند و آزموده داشته باشند. هر تفاوت رفتاری عمدی باید در این طرح، release notes و approval مالک ثبت شود.

**Acceptance criteria:**
درخواست بدون profile نتیجه و مسیر observable سازگار با baseline دارد؛ تمام رفتارهای کلیدی default در parity test پوشش داده و گذرانده می‌شوند؛ authorization و Human-Out-Of-Loop ضعیف نشده‌اند؛ داده‌های plan/session موجود خوانده می‌شوند یا migration برگشت‌پذیر و آزموده دارند؛ فعال‌سازی default قابل rollback است و خطای بارگذاری به اجرای ناامن منجر نمی‌شود.

---

## [🔴] Phase 8: ساخت، انتخاب و اعتبارسنجی Profile توسط کاربر

قابلیت سفارشی‌سازی را روی رابط‌های موجود عرضه کن تا کاربر بتواند Profile JSON بسازد/قرار دهد، فهرست و اعتبارسنجی کند و برای یک اجرای مشخص انتخاب کند. این فاز ویرایشگر گرافیکی یا DSL جدید اضافه نمی‌کند؛ JSON همان قالب نویسندگی/انتقال باقی می‌ماند.

### [🔴] Step 1: فراهم‌کردن مسیر authoring و discovery

طبق scopeهای تصویب‌شدهٔ Phase 1، امکان ساخت و استفاده از Profile سفارشی در registry پروژه یا مسیر دیگر مصوب را فراهم کن. قرارداد فایل، precedence، نام‌گذاری، نسخه‌بندی، نمونه، خطاهای schema/semantic و نحوهٔ override مستند شود. Profileهای کاربر بدون دست‌کاری registry پکیج قابل تعریف باشند.

### [🔴] Step 2: افزودن فهرست/اعتبارسنجی/انتخاب در interfaceهای پشتیبانی‌شده

entry pointهای جاری CLI و server/API را دوباره تأیید و با الگوی config آن‌ها سازگار کن. کاربر بتواند Profileها را فهرست/اعتبارسنجی کند، یک profile ID را برای run انتخاب کند و خطای نسخه/وابستگی/مجوز را پیش از اجرا ببیند. سازگاری clientها و مسیر بدون تعیین profile را حفظ کن. **Unknown / Requires Verification:** نام دقیق command/flag، request field یا UI affordance را از قراردادهای موجود استخراج کن؛ API یا route جدید را از روی حدس نساز.

### [🔴] Step 3: نمونه‌ها و راهنمای نویسندگی

مستندات خودبسنده برای schema، nodeهای پشتیبانی‌شده، پورت و mapping، شرط‌های مجاز، bounded loop، Toolset/Persona/Skill reference، approval، بودجه، error policy، version compatibility، validation، انتخاب و troubleshooting اضافه کن. حداقل یک نمونهٔ کوچک سفارشی و یک نمونهٔ bounded review/fix ارائه کن؛ برای هر دو آزمون خودکار اعتبارسنجی بنویس تا در Phase 9 به CI متصل شوند. مشخص کن افزودن node kind تازه مستلزم handler و تست Runtime است.

**Acceptance criteria:**
نویسنده می‌تواند فقط با JSON مستندشده Profile سفارشی تعریف کند؛ Profile معتبر در scope مصوب discover و انتخاب می‌شود و Profile نامعتبر قبل از اجرا diagnostic می‌دهد؛ CLI و server/API موجود به‌صورت سازگار انتخاب Profile را پشتیبانی می‌کنند؛ درخواست قدیمی بدون profile حفظ می‌شود؛ نمونه‌ها در CI اعتبارسنجی می‌شوند؛ هیچ DSL، eval یا ویرایشگر خارج از دامنه اضافه نشده است.

---

## [🔴] Phase 9: hardening، migration، rollout و تحویل نهایی

کل قابلیت را در محیط پروژه سخت‌سازی و قابل‌نگهداری کن؛ traceability، امنیت، تست سرتاسری، CI، اسناد و rollout/rollback باید قبل از اعلام تکمیل بسته شوند.

### [🔴] Step 1: سخت‌سازی مرز دستور و داده و آزمون‌های adversarial

محتوای Profile، Persona/Skill و هر دادهٔ بیرونی، به‌ویژه خروجی `fetch`، باید صریحاً به‌عنوان دادهٔ غیرقابل‌اعتماد پردازش شود، نه دستور یا مجوز ابزار. promptهای system/user و مسیرهای prompt centralization موجود را در branch نهایی بررسی کن؛ در نقطهٔ لازم مرز اعتماد را بیان و هر راهی را ببند که متن fetched/profile بتواند system policy را override یا tool call را مجاز کند. تست unit/integration/e2e برای schema و semantic validator، resolver، templates/sub-workflows، هر node kind، شاخه/loop، approval و tool authorization، persistence/recovery و هر entry point اضافه کن. ورودی‌های مخرب را پوشش بده: prompt injection در description/fetch result، تلاش برای اجرای code، path/tool escalation، ارجاع یا نسخهٔ جعلی، graph بسیار بزرگ، fan-out، چرخه، loop limit، output حجیم، secret و فایل خراب؛ اثبات کن دادهٔ خارجی توان تغییر مجوز یا دستور سیستم را ندارد.

### [🔴] Step 2: ارزیابی performance و منابع

با workflow نمونهٔ نماینده، هزینهٔ load/validation/resolution، تعداد node visit، latency و رشد state را اندازه‌گیری کن. مطمئن شو سقف‌های اجرایی قبل از runaway resource مصرفی مؤثرند، profile سنگین روی همهٔ requestها هزینهٔ غیرضروری تحمیل نمی‌کند و اجرای پیش‌فرض regression محسوس ندارد. معیار performance را با baseline پروژه تعیین و نتیجه ثبت کن؛ عدد دلخواه اختراع نکن.

### [🔴] Step 3: migration و عملیات rollout/rollback

راهنمای upgrade نسخهٔ profile/schema/runtime و رفتار هنگام profile/dependency حذف‌شده یا ناسازگار را بنویس. migration دادهٔ ماندگار، در صورت نیاز، idempotent و rollback-aware باشد؛ اگر migration لازم نیست، شواهد عدم نیاز را ثبت کن. مسیر feature rollout و بازگشت به default/legacy را در config و عملیات موجود مشخص کن؛ downgrade نباید state را بی‌صدا خراب یا execution را تکرار کند.

### [🔴] Step 4: مستندسازی و Gateهای CI

اسناد معماری، schema، author guide، migration/release note، وضعیت طرح اجرایی و traceability requirement-to-test را به‌روز کن. Gateهای موجود را برای schema validation نمونه‌ها، generator/parity checks، typecheck، lint، build، test و security-relevant checks توسعه بده؛ workflow واقعی CI را اجرا/بررسی کن. شکست‌های baseline را با اجرای clean baseline و گزارش جدا از regression تشخیص بده؛ هیچ شکست را صرفاً با عنوان قدیمی یا نامرتبط حذف نکن.

### [🔴] Step 5: بازبینی نهایی مستقل و تحویل

از دید معماری، کدنویسی، QA، امنیت، عملیات و سازگاری محصول، کل دامنه و PR را بازبینی کن. مطابقت هر الزام این سند با کد/test/doc را بررسی کن؛ وضعیت هر فاز/گام را فقط با شواهد نهایی به‌روزرسانی کن. تغییرات را در branch/PR بازبینی‌پذیر نگه دار؛ merge/release فقط با درخواست و مجوز جداگانهٔ مالک.

**Acceptance criteria:**
suite و gateهای CI روی head نهایی نتیجهٔ ثبت‌شده دارند؛ regressions جدید صفرند و هر baseline failure با شواهد تفکیک شده؛ تست‌های امنیتی و end-to-end موفق‌اند؛ performance در معیارهای مصوب است؛ migration/rollback مستند و آزموده یا عدم نیاز آن مستند است؛ تمام requirementها traceability دارند؛ اسناد و نمونه‌ها همگام‌اند؛ هیچ مانع مسدودکنندهٔ شناخته‌شده‌ای باقی نیست؛ merge/release بدون تأیید صریح انجام نشده است.
