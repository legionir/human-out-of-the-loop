# پلن اجرایی گسترش ابزارها، Journal و عرضه MCP (فازهای ۳۷–۴۳)

**تاریخ:** 2026-09-25
**بنیاد:** commit `7a5aaa1` — فازهای ۳۳–۳۶ کامل (۱۶ ابزار filesystem، سیستم عامل در prompt)، ۸۶۶ تست سبز، e2e ۸۷/۸۷، نسخه ۲۷.۹.۰
**هدف:** بستن شکاف ابزارها با سرورهای مرجع (git / memory / time / sequentialthinking / fetch)، افزودن **Journal** به‌عنوان ثبت خودکار همه‌کارهای AI، و عرضهٔ خود runtime به‌عنوان یک **MCP server**
**قانون اجرا:** مثل پلن‌های قبلی — هر فاز یک commit + push مستقل روی `arena/01a0d510-human-out-of-the-loop`، معیار پذیرش کامل پیش از فاز بعد، علامت 🟢 در همین فایل، و هر فاز در بدنهٔ PR #3 اضافه می‌شود.

**وضعیت (2026-09-25):** 🔵 در حال اجرا — فازهای ۳۷ (Journal)، ۳۸ (time + sequentialthinking)، ۳۹ (memory)، ۴۰ (fetch) و ۴۱ (Git خواندن) 🟢 کامل و پوش‌شده؛ فازهای ۴۲–۴۳ در نوبت. ۱۰۳۴ تست سبز (۶۴ فایل)، e2e ۱۴۰/۱۴۰، نسخه ۲۷.۱۴.۰

---

## ۰) تصمیم‌های بنیادی (قبل از فاز ۳۷)

### ۰.۱ لغو محدودیت قبلی Git

در فاز ۳۳ صریحاً «ابزار Git نوشتنی نه» انتخاب شد. این پلن **آن تصمیم را لغو می‌کند** (به‌درخواست کاربر: «خواندن و نوشتن، مدیریت و ایجاد pr، commit، branch»). در عوض، مدل امنیتی فاز ۴۲ جایگزین آن محدودیت می‌شود (allowlist زیرفرمان، بدون shell، برنچ‌های محافظت‌شده، تأیید برای عملیات مخرب).

### ۰.۲ Journal کجا وصل می‌شود؟ (خواستهٔ صریح کاربر)

> «باید جایی که tool ها به درخواست ai اجرا میشن اضافه بشه»

نقطهٔ دقیق: `src/ai/runtime/agent-runtime.ts` → متد `executeTurn()`:
- ساخت `generateOptions` برای `generateText` (خط ۴۱۶–۴۲۷: `tools: hasTools ? { tools: agent.tools } : {}`)،
- و شعبهٔ `streamWithThoughts` (خط ۴۳۸: `tools: hasTools ? agent.tools : undefined`).

هر دو از **یک** مجموعه ابزار تغذیه می‌شوند، پس کافی است یک بار سرِ `executeTurn` ابزارها با `withJournal(tools, context)` پیچیده شوند:

```ts
const context = { taskId, agentId, ...planContext };          // همان چیزی که به eventBus می‌رود
const tools   = hasTools ? withJournal(agent.tools, context) : undefined;
```

چرا این نقطه و نه جای دیگر:
- **همهٔ ابزارها را می‌گیرد** — local، MCP (که در همان `agent.tools` ثبت شده)، `delegate_task`، و ابزارهای فازهای بعدی؛ بدون تغییر در هیچ factory.
- `taskId` / `agentId` / `planId` / `planStepId` همان‌جا موجود است (فاز ۲۰ آن‌ها را در `planContext` گذاشت).
- `generateText` و `streamText` هر دو پوشش داده می‌شوند (اگر فقط یکی پوشش داده شود، اجرای دارای thinking لاگ نمی‌شود — یک باگ سکوت‌آمیز).
- `execute(input, { toolCallId })` در SDK v7 باعث می‌شود `callId` همان چیزی باشد که `agent:tool_call` منتشر می‌کند؛ یعنی Journal و رخدادها از هم قابل‌اتصال‌اند.

### ۰.۳ Journal در برابر Observability Log (تفکیک صریح)

`observability.jsonl` عمداً **متن رکوئست/ریسپانس را ذخیره نمی‌کند** (کامنت خودش: «No raw transcripts … only tool names and status»). Journal دقیقاً مکمل آن است: **ترنسکریپت کامل کنش‌ها** با redaction. دو فایل، دو مصرف: observability برای رویداد/متریک، Journal برای «AI چه کاری انجام داد؟».

### ۰.۴ سیاست وابستگی

| نیاز | تصمیم |
|---|---|
| git | **بدون وابستگی** — `execFile('git', args)` بدون shell (هم‌الگو با `git-status.ts` فعلی) |
| memory / time / sequentialthinking | **بدون وابستگی** — Node API (`Intl`, `fs`) |
| fetch | `undici` (از قبل dependency است) + مبدل HTML→Markdown **داخل‌ساخت** (~۱۵۰ خط برای heading/link/list/code/table) تا وابستگی جدید اضافه نشود |
| MCP server | **بدون وابستگی** — JSON-RPC دست‌ساز روی stdio/HTTP؛ همان الگویی که `e2e/scenarios/fixtures/stdio-server.mjs` امروز به‌عنوان سرور تست استفاده می‌کند. JSON Schema ابزارها از zod v4 (`z.toJSONSchema`) گرفته می‌شود |

---

## ۱) دامنه / غیردامنه

**دامنه:** ۷ فاز زیر + به‌روزرسانی مستندات و registry/persona/skill برای هر ابزار جدید.

**غیردامنه (صریح):**
- **هیچ ابزار shell عمومی** ساخته نمی‌شود (خطر prompt-injection). فقط زیرفرمان‌های git به‌صورت صریح.
- پورت سرورهای Python (`fetch`, `git`) با `uv` — `uv/uvx` در این محیط نصب نیست؛ همه نatively بازنویسی می‌شوند (مثل کاری که برای filesystem با سرور TS شد).
- `git rebase -i`، `git config` نوشتنی، `--force`/`--force-with-lease`، عملیات روی remote غیر از origin به‌صورت پیش‌فرض ممنوع.
- تغییر پروتکل MCP کلاینت (فاز ۱۲/۲۸ دست‌نخورده).
- حذف/جایگزینی ابزارهای موجود؛ فاز ۴۱ فقط `git_status` را **گسترش** می‌دهد (سازگاری عقب‌رو حفظ می‌شود).

---

## ۲) نقشهٔ سرور مرجع → ابزار ما

| سرور مرجع (`servers-main/src/`) | زبان | ابزارهای مرجع | فاز ما |
|---|---|---|---|
| `git/` | Python | `git_status, git_diff, git_diff_staged, git_diff_unstaged, git_log, git_show, git_branch, git_create_branch, git_checkout, git_add, git_commit, git_reset` | ۴۱ (خواندن) + ۴۲ (نوشتن) |
| `memory/` | TS | `create_entities, create_relations, add_observations, delete_entities, delete_observations, delete_relations, read_graph, search_nodes, open_nodes` | ۳۹ |
| `time/` | Python | `get_current_time, convert_time` | ۳۸ |
| `sequentialthinking/` | TS | `sequentialthinking` | ۳۸ |
| `fetch/` | Python | `fetch` | ۴۰ |
| — (خارج از مرجع) | — | `git_push, git_pr_create, git_pr_list, git_pr_view, git_pr_comment, git_remote_list` | ۴۲ (خواستهٔ کاربر: PR) |
| — (خارج از مرجع) | — | **Journal** (خودِ این سیستم) | ۳۷ |
| — (خارج از مرجع) | — | **MCP server exposure** (خودِ این سیستم) | ۴۳ |

---

## فاز ۳۷ — Journal (ثبت خودکار کنش‌های AI) 🟢

**هدف:** هر فراخوانی ابزارِ AI — موفق یا ناموفق — به‌صورت خودکار، اتمیک و redact‌شده ثبت شود؛ به‌علاوهٔ رخدادهای سطح پلن/استپ.

**فایل‌ها:**
- `src/ai/runtime/journal.ts` (جدید) — `JournalWriter` + `withJournal(tools, context)` + `journalPath(runtimeDir, date)`
- `src/ai/runtime/agent-runtime.ts` — وصل‌کردن `withJournal` در `executeTurn` (هر دو شعبه)
- `src/ai/runtime/orchestrator.ts` (یا همان‌جا که `runtimeDir` ساخته می‌شود) — ساخت writer با `runtimeDir` و تنظیمات
- `src/ai/runtime/task-runtime.ts` / `plan-runtime.ts` — ثبت رخدادهای `plan`/`step` (kind های غیرابزاری) با همان writer
- `src/cli/commands/journal.ts` (جدید) + ثبت در `src/cli.ts`
- `src/ai/runtime/secret-scrub.ts` — استفادهٔ مجدد برای redaction
- `src/ai/schemas/config.ts` (یا مکان config فعلی) — بخش `journal`

**شِمای هر خط (JSONL، یک خط = یک کنش):**
```json
{"ts":"2026-09-25T21:04:11.512Z","kind":"tool","tool":"write_file","callId":"call_3",
 "taskId":"task_…","agentId":"plan-step-2","planId":"plan_…","planStepId":"step-2",
 "durationMs":12,"ok":true,"input":{"filePath":"src/x.ts","content":"…"},
 "summary":"wrote 240 bytes","artifacts":[{"path":"src/x.ts","bytes":240,"sha256":"…"}]}
```

**گام‌ها:**
1. `JournalWriter`: append-only روی `<runtimeDir>/journal/YYYY-MM-DD.jsonl`، با همان ترفند fd-بازماندهٔ `ObservabilityLogger` (یک `writeSync` به‌ازای هر خط + تشخیص فایل حذف‌شده با inode)، ساخت پوشه در صورت نبود.
2. سازگاری با `.ai-runtime/` که ممکن است وسط اجرا `rm -rf` شود (فاز ۲۱ همان درس را دارد).
3. `withJournal`: پوشش `execute` هر ابزار؛ گرفتن `toolCallId` از آرگومان دوم `execute` (در SDK v7)؛ اندازه‌گیری `durationMs`؛ تشخیص موفقیت با همان منطق `describeToolFailure` (سه حالت: throw، `{success:false}`، MCP با `isError:true`).
4. redaction: هم `redactKeys` (مثل `apiKey`, `token`, `password`, `authorization`) و هم مقادیر واقعی env (`secret-scrub` فاز ۳۰) — سپس سقف `maxEntryBytes` (پیش‌فرض ۸KB) با `"truncated": true`.
5. ثبت نتیجه: پیش‌فرض **خلاصه** (`journal.includeResults: 'summary' | 'full'`)، «full» برای دیباگ. برای نوشتن فایل‌ها `artifacts` (path/bytes/sha256) همیشه ثبت می‌شود.
6. رخدادهای پلن/استپ: subscribe به `EventBus` (بدون تغییر در ناشران) برای `plan:*`/`step:*`/`agent:tool_error`.
7. retention: نگه‌داشتن N روز (پیش‌فرض ۳۰) و پاک‌سازی در باز کردن writer؛ `journal.enabled` و `HOTL_JOURNAL=0/1`.
8. CLI: `hootl journal [--follow] [--since 24h] [--tool X] [--plan Y] [--failed] [--json] [--limit N]` — خواندن همان JSONL با همان الگوی `hootl logs`.

**معیار پذیرش:**
- تست واحد: موفق/ناموفق/throw ثبت می‌شود؛ `callId` با رخداد هم‌خوان است؛ کلید و مقدار محرمانه هر دو redact می‌شوند؛ سقف ورودی رعایت می‌شود؛ rotation روزانه و retention؛ فایل حذف‌شده در میانهٔ اجرا روشنایی دوباره می‌سازد.
- تست یکپارچه: `agent-runtime` با مدل mock → Journal در `runtimeDir` نوشته شده و شعبهٔ `streamText` هم ثبت می‌کند (اگر یکی از دو شعبه ثبت نکند، تست fail).
- e2e: سناریوی جدید `journal` — یک run واقعی، سپس assert که خط مربوط به `write_file` با مسیر و اندازهٔ درست در فایل است؛ و سناریوی `credential` علاوه‌بر حالا: `journal/*.jsonl` نباید API key را داشته باشد.
- مستندات: README (بخش Journal)، CHANGELOG، `docs/CONFIGURATION.md`، `docs/history` (همین فایل).

**ریسک:** حجم/حریم‌خصوصی. پاسخ: `retentionDays`، سقف اندازه، redaction، `.ai-runtime/` که از قبل gitignore است و از جست‌وجوی `search_code`/`search_files` هم حذف می‌شود (فاز ۳۴/۳۶).

**تحویل‌شده (۲۰۲۶-۰۹-۲۵):** `src/ai/runtime/journal.ts` (نویسنده + `withJournal` + `artifactsOf` + `outcomeStatus`)، اتصال در `AgentRuntime.executeTurn` (هر دو شعبه) از طریق `setJournal`، ساخت writer و ثبت رخدادهای plan/step در `orchestrator.ts`، دستور `hootl journal`، ۲۷ تست واحد، سناریوی e2e جدید `journal` و گسترش سناریوی `credential` (توکن دوم هم نباید در هیچ artifact — از جمله Journal — باشد). نسخه ۲۷.۱۰.۰.

---

## فاز ۳۸ — time و sequentialthinking 🟢

**هدف:** دو ابزار کوچک و پرکاربرد؛ زمان (با منطقهٔ زمانی) و «تفکر مرحله‌به‌مرحله» با وضعیت ماندگار.

**ابزارها:** `get_current_time`, `convert_time`, `sequentialthinking`

**گام‌ها:**
1. `src/ai/tools/implementations/get-current-time.ts`: ورودی `timezone` (IANA، پیش‌فرض منطقهٔ محلی سیستم)، خروجی: `iso`, `formatted`, `timeZoneName` (مثلاً `GMT+3:30`), `utcOffset`، `isDST`, `dayOfWeek` و — مطابق مرجع — اطلاعات DST. با `Intl.DateTimeFormat`؛ اعتبارسنجی نام منطقه با try/catch روی `Intl` (منطقهٔ نامعتبر → `INVALID_TIMEZONE`).
2. `convert-time.ts`: `sourceTimeZone, targetTimeZone, time (HH:MM)`؛ خروجی: زمان تبدیل‌شده + اختلاف ساعت بین دو منطقه.
3. `sequentialthinking.ts`: پارامترهای مرجع (`thought, nextThoughtNeeded, thoughtNumber, totalThoughts, isRevision?, revisesThought?, branchFromThought?, branchId?, needsMoreThoughts?`) + ماندگاری در `<runtimeDir>/thinking/<sessionId>.json` تا یک run طولانی/ازسرگرفته‌شده بتواند ادامه دهد؛ خروجی: تأیید + شمارهٔ گام + `thinkingId` + خلاصهٔ مسیر. سقف: ۵۰ گام و ۲۵۶KB برای هر session (`THINKING_LIMIT`).
4. **یکپارچگی‌های ارزان و باارزش:**
   - `get_current_time` در بلوک ENVIRONMENT فاز ۳۶ هم بیاید (ساعت و منطقهٔ محلی کاربر) — تا مدل برای تاریخ/ساعت حدس نزند.
   - هر گام sequentialthinking (در صورت وجود) به `ThoughtSink` فاز ۳۲ هم فرستاده شود، تا در CLI به‌صورت زنده/ایتالیک دیده شود.
5. registry JSON ×۳، `local-tools.ts`، personas (coder/reviewer)، skill جدید `reasoning` (یا افزودن به `code_analysis`).

**معیار پذیرش:** تست واحد برای منطقه‌های زمانی مختلف (شامل تهران +۳:۳۰ و یک منطقهٔ دارای DST مثل `Europe/Berlin`)، `convert_time` با تغییر روز (23:00 → 03:00 فردا)، منطقهٔ نامعتبر، و سقف/شاخه‌زنی sequentialthinking؛ e2e: سناریوی `time` (یک marker جدید) که نتیجهٔ ابزار در درخواست بعدی مدل دیده شود.

**تحویل‌شده (۲۰۲۶-۰۹-۲۵):** `src/ai/tools/time/tz.ts` (هستهٔ منطقه‌های زمانی روی `Intl`، شامل تشخیص DST نیم‌کره‌جنوبی و پیشنهاد منطقهٔ نزدیک)، سه ابزار `get_current_time` / `convert_time` / `sequentialthinking` (ماندگاری اتمیک در `thinking/<sessionId>.json`، سقف ۵۰ گام، سانیتایز id)، ساعت محلی در بلوک ENVIRONMENT، مهارت جدید `reasoning`، به‌روزرسانی personaها (۱۹/۱۴/۱۳ ابزار)، ۲۸ تست واحد و سناریوی e2e `time`. نسخه ۲۷.۱۱.۰.

---

## فاز ۳۹ — memory (گراف دانش در `.ai-runtime`) 🟢

**هدف:** حافظهٔ ماندگار بین runها — «این پروژه چه چیزهایی را قبلاً تصمیم گرفتیم/کشف کردیم».

**ابزارها (۹ مورد، همنام مرجع):** `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`

**گام‌ها:**
1. `src/ai/tools/implementations/memory/` با هستهٔ مشترک: خواندن/نوشتن `<runtimeDir>/memory.json` با `atomicWriteFileSync` + `file-lock` (فازهای ۲۱/۲۷ — دو پروسهٔ همزمان نباید حافظه را خراب کنند).
2. شِمای گراف: `entities[{name, entityType, observations[]}]`, `relations[{from, to, relationType}]` — همان مرجع.
3. معناشناسی مهم: `create_entities` روی نام موجود، observations را **ادغام** می‌کند (بدون تکرار)؛ `add_observations` برای موجودیت ناموجود خطا می‌دهد (`ENTITY_NOT_FOUND`)؛ حذف‌ها آرایهٔ حذف‌شده را برمی‌گردانند.
4. `search_nodes`: جست‌وجوی case-insensitive در نام/نوع/observations؛ `read_graph` با سقف خروجی (پیش‌فرض ۲۰۰ موجودیت) + `truncated`.
5. دامنه: پیش‌فرض project-scoped؛ اختیار `scope: 'project' | 'global'` (global در config dir کاربر) — تصمیم کاربر.
6. **Journal (فاز ۳۷) به‌صورت خودکار این نوشتن‌ها را ثبت می‌کند** — حافظه بدون audit trail نمی‌ماند.
7. اختیاری (stretch): `hootl memory list|search|export` برای بازرسی انسانی.

**معیار پذیرش:** تست واحد: ادغام/تکرار، خطاها، حذف‌های آبشاری (حذف موجودیت → حذف relationهای وابسته)، کار همزمان دو نویسنده با lock، برخورد با فایل خراب (JSON نامعتبر → خطای واضح، بدون پاک‌کردن داده)، سقف‌ها. e2e: سناریوی `memory` — run اول یک entity می‌سازد، run دوم (پروسهٔ جدید) آن را می‌خواند (اثبات ماندگاری واقعی بین اجراها).

---

**تحویل‌شده (۲۰۲۶-۰۹-۲۵):** `src/ai/tools/memory/graph.ts` (هستهٔ گراف: `memoryFilePath`، `loadGraph`، `mutateGraph` با `withFileLockSync` + `atomicWriteFileSync`، معناشناسی مرجع) و `src/ai/tools/implementations/memory-tools.ts` (۹ ابزار همنام مرجع). طبق تصمیم §۶ فقط **project-scoped** — `scope: 'global'` ساخته نشد. کدها: `GRAPH_CORRUPT` (فایل خراب هرگز بازنویسی نمی‌شود)، `GRAPH_UNREADABLE`، `ENTITY_NOT_FOUND`، `LOCK_TIMEOUT`، `WRITE_FAILED`. افزوده‌های ما به مرجع: قفل روی فایل sidecar (`memory.json.lock` — قفل هرگز فایل داده را لمس نمی‌کند)، صفحه‌بندی خواندن‌ها (`read_graph` ۲۰۰ / `search_nodes` ۱۰۰) با `total`/`truncated` و `relatedOutsideResult`، و `memoryFile` در هر نتیجه. کاتالوگ ۱۹ → **۲۸ ابزار**، مهارت `project_memory` (اولویت ۷۵)، personaها: `coder` ۲۸ (کل مجموعه، شامل `delete_*`)، `architect` ۲۰ و `reviewer` ۱۹ (خواندن + ثبت، بدون حذف). ۱۶ تست واحد (فاز ۳۹) و سناریوی e2e `memory` (۱۳ چک؛ دو run: ساخت گراف با هر ۹ ابزار، سپس یافتن آن توسط **پروسهٔ جدید** و رد رابطه به موجودیت ناموجود). کل: ۹۳۷ تست (۶۲ فایل)، e2e ۱۱۶/۱۱۶. نسخه ۲۷.۱۲.۰.

---

## فاز ۴۰ — fetch (صفحهٔ وب → متن/Markdown) 🟢

**هدف:** خواندن یک URL و برگرداندن محتوای قابل‌استفاده برای مدل (نه HTML خام).

**ابزار:** `fetch` با `url`, `maxLength` (پیش‌فرض 5000، سقف 100000), `startIndex`, `raw`, `respectRobots` (پیش‌فرض true)

**گام‌ها:**
1. `src/ai/tools/implementations/fetch.ts` با `undici` (وابستگی موجود): timeout پیش‌فرض 10s، حداکثر ۵ ریدایرکت، `User-Agent: human-out-of-the-loop/<version>`, سقف خواندن بدنه (2MB) با قطع stream.
2. تبدیل: `text/html` → Markdown با مبدل داخل‌ساخت (`src/ai/tools/implementations/html-to-markdown.ts`): heading، پاراگراف، لینک، لیست، `pre/code`، `table`, `blockquote`؛ حذف `script/style/nav/footer`. `application/json` و `text/*` بدون تغییر؛ بقیه → فقط متادیتا (`unsupported content type`).
3. robots.txt: بررسی برای هر میزبان (با کش)؛ `respectRobots: false` برای دورزدن آگاهانه.
4. **تفاوت‌های عمدی با مرجع (مستند‌شده):** مسدودسازی آدرس‌های loopback/private/link-local به‌صورت پیش‌فرض (`allowPrivate: true` برای override) — دفاع در برابر SSRF از طریق prompt-injection (مثلاً `http://169.254.169.254/…` در یک note). هیچ هدر احراز هویتی ارسال نمی‌شود.
5. registry JSON + skill جدید `web_research` + شخصای researcher/researcher-like (در صورت وجود) و coder.

**معیار پذیرش:** تست واحد با یک HTTP server محلی (بدون شبکهٔ بیرونی): HTML→MD شامل heading/link/list/code/table، برش `maxLength/startIndex`، ریدایرکت، timeout، محتوای بزرگ (قطع در سقف)، نوع غیرمتنی، رعایت/عدم‌رعایت robots، و **مسدودبودن** `127.0.0.1`/`169.254.169.254` به‌صورت پیش‌فرض. e2e: سناریوی `fetch` با سرور استاب محلی (خارج از fake-llm) که نتیجه‌اش در درخواست بعدی مدل دیده شود.

---

**تحویل‌شده (۲۰۲۶-۰۹-۲۵):** `src/ai/tools/net/url-safety.ts` (دروازهٔ SSRF: کلاس‌بندی کامل IPv4/IPv6 شامل IPv4-mapped، 6to4 و NAT64؛ بررسی روی آدرس *حل‌شده* با تزریق lookup برای تست)، `src/ai/tools/net/html-to-markdown.ts` (مبدل درون‌ساخت: سرتیتر، پاراگراف، لینک **مطلق**، لیست تودرتو، `pre` فنس‌دار، جدول GFM، نقل‌قول، تأکید، تصویر؛ حذف `script/style/nav/footer/form/...` با محتوا؛ موجودیت‌ها؛ مقاوم در برابر HTML خراب)، `src/ai/tools/net/robots.ts` (پارسر RFC 9309: گروه‌ها، `*`، `$`، بلندترین قاعده با برد Allow در تساوی، اولویت توکن دقیق بر `*` + کش TTL) و `src/ai/tools/implementations/fetch.ts`. تفاوت‌های عمدی با مرجع: مسدودسازی پیش‌فرض آدرس‌های خصوصی روی **هر hop ریدایرکت** (`allowPrivate` برای عبور آگاهانه + گزارش `privateAllowed`)، سقف‌ها (۱۰s، ۵ ریدایرکت، ۲MB با *کنسل* stream، ۱۰۰k کاراکتر)، بدون هیچ هدر اعتبارنامه‌ای، و robots غیرقابل‌خواندن = امتناع. ابزارهای local: ۲۸ → **۲۹**؛ مهارت `web_research` (اولویت ۶۵)؛ personaها: `coder` ۲۹، `architect` ۲۱، `reviewer` ۲۰ (planner نه — برنامه‌ریزی پژوهش نیست). ۵۱ تست واحد (فاز ۴۰) و سناریوی e2e `fetch` (۱۱ چک؛ چهار فراخوانی روی سرور loopback خودِ runner: Markdown، `raw`، امتناع robots با قاعده، و امتناع SSRF). کل: ۹۸۸ تست (۶۳ فایل)، e2e ۱۲۷/۱۲۷. نسخه ۲۷.۱۳.۰.

---

## فاز ۴۱ — Git: خواندن 🟢

**هدف:** درک وضعیت مخزن و تاریخچه، بدون هیچ تغییری.

**ابزارها:** `git_status` (گسترش‌یافته), `git_diff`, `git_diff_staged`, `git_diff_unstaged`, `git_log`, `git_show`, `git_branch_list`, `git_remote_list`

**گام‌ها:**
1. `src/ai/tools/git/` (هستهٔ مشترک): `runGit(cwd, args, {timeoutMs})` روی `execFile` — **بدون shell**، آرایهٔ آرگومان‌ها، `PATH` کنترل‌شده، `GIT_TERMINAL_PROMPT=0` و `GIT_ASKPASS` خالی (هیچوقت منتظر رمز نماند)، سقف خروجی (پیش‌فرض 256KB).
2. `git_status` فعلی حفظ می‌شود ولی ورودی‌های تازه می‌گیرد: `porcelain: 'v1'|'v2'`, `branch` (نام برنچ + ahead/behind + upstream) — سازگاری عقب‌رو حفظ شود.
3. `git_diff`: `target` (بدون آرگومان = working tree، `--staged`، یا یک commit/ref)، `path?`, `contextLines?`, `statOnly?`. مرجع سه ابزار جدا دارد؛ ما **یک** ابزار با `staged: boolean` و `target` می‌سازیم و هر سه حالت را پوشش می‌دهیم (کمتر برای مدل، کامل برای کاربر) + معادل‌های نامی مرجع به‌عنوان alias مستند می‌شوند.
4. `git_log`: `maxCount` (پیش‌فرض ۲۰)، `path?`, `author?`, `since?`, `format: 'oneline'|'short'|'json'` (json = `--pretty` با جداکننده تا پارس شود).
5. `git_show`: commit/ref + `path?` با همان سقف خروجی؛ `git_branch_list`: `-a`, `-v` → آرایهٔ ساخت‌یافته (نام، current، upstream، آخرین commit).
6. همه با `resolvePathInWorkspace` (هستهٔ فاز ۳۳) و خطای ساخت‌یافته: `NOT_A_REPO`, `GIT_MISSING`, `TIMEOUT`, `PATH_TRAVERSAL_BLOCKED`.
7. registry JSON، `local-tools.ts`، personaها (coder/architect/reviewer)، skill جدید `git_operations` (از قبل وجود دارد — گسترش).

**معیار پذیرش:** تست واحد با مخزن git واقعی که در `mkdtemp` ساخته می‌شود (کامیت مصنوعی، فایل تغییر‌یافته، برنچ دوم): status/diff staged و unstaged/log/show/branch/remote درست؛ بیرون از workspace → `PATH_TRAVERSAL_BLOCKED`؛ دایرکتوری بدون git → `NOT_A_REPO`. e2e: سناریوی `gitread` روی پروژهٔ اسکرچ.

---

**تحویل‌شده (۲۰۲۶-۰۹-۲۵):** `src/ai/tools/git/git-runner.ts` (اجرای git با `spawn` و آرایهٔ آرگومان — بدون shell؛ محیط ثابت `GIT_TERMINAL_PROMPT=0`/`GIT_ASKPASS=echo`/`SSH_ASKPASS=echo`/`GIT_PAGER=cat`/`GIT_OPTIONAL_LOCKS=0`؛ سقف ۲۵۶KB با SIGKILL و `OUTPUT_TOO_LARGE`؛ `rejectFlagLike` برای هر مقدار کاربری؛ `ensureRepo` با `resolvePathInWorkspace` → `PATH_TRAVERSAL_BLOCKED` بیرون از workspace و `NOT_A_REPO` داخل پوشهٔ غیرمخزن؛ کدها: `NOT_A_REPO`, `GIT_MISSING`, `TIMEOUT`, `BAD_ARGUMENT`, `OUTPUT_TOO_LARGE`, `GIT_FAILED`) و `src/ai/tools/git/parse.ts` (porcelain v1/v2، `for-each-ref`، `--pretty` با `%x1f`/`%x1e`، `--numstat`، هدر diff، unquote). شش ابزار: `git_status` گسترش‌یافته (porcelain v1/v2 + `entries`/`counts` + `branch` با upstream/ahead/behind + `path`؛ سازگاری عقب‌رو: `directory`/`short`/`output`؛ کد phase-18 `NOT_A_GIT_REPO` به `NOT_A_REPO` تغییر نام یافت) و پنج تازه `git_diff` (یک ابزار برای هر سه ابزار مرجع: worktree / `staged` / `target` + `statOnly`/`nameOnly`/`path`/`contextLines`)، `git_log` (فیلتر path/author/since/until، فرمت oneline/short/json، مخزن بدون commit → لاگ خالی)، `git_show` (متادیتا + patch؛ دو نکتهٔ git رمزگذاری شد: option قبل از revision، و `--unified` که `--patch` را ایجاب می‌کند پس در حالت `statOnly` حذف می‌شود)، `git_branch_list` (`for-each-ref` + contains/notContains + گزارش HEAD جدا‌شده با sha) و `git_remote_list` (fetch/push URL، فقط config). کاتالوگ ۲۹ → **۳۴ ابزار**؛ مهارت `git_operations` گسترش یافت (نسخه ۱.۱.۰)؛ personaها: `coder` ۳۴، `architect` ۲۶، `reviewer` ۲۵. ۴۶ تست واحد روی یک مخزن واقعی ساخته‌شده در `mkdtemp` و سناریوی e2e `gitread` (۱۳ چک، شامل اثبات دست‌نخورده ماندن مخزن). کل: ۱۰۳۴ تست (۶۴ فایل)، e2e ۱۴۰/۱۴۰. نسخه ۲۷.۱۴.۰.

---

## فاز ۴۲ — Git: نوشتن + PR

**هدف:** انجام کارهای واقعی مخزن — با مدل امنیتی سخت‌گیرانه — و ساخت/خواندن Pull Request.

**ابزارها:** `git_add`, `git_commit`, `git_create_branch`, `git_checkout`, `git_reset`, `git_push`, `git_stash` (اختیاری), `git_pr_create`, `git_pr_list`, `git_pr_view`, `git_pr_comment`

**مدل امنیتی (بر پایهٔ همان کاری که `servers-main/src/git` می‌کند — بخش ۶.۱):**
1. **مرجع‌محور:** بدون shell (argv مستقیم)، `--` قبل از مسیرها، رد هر ورودی با `-` در ابتدا، `git_reset` پیش‌فرض = **unstage**.
2. **برنچ‌های محافظت‌شده** (پیش‌فرض `main`, `master`, قابل تنظیم): push مستقیم و `reset --hard` روی آن‌ها ممنوع (`PROTECTED_BRANCH`).
3. **مخرب‌ها پشت پرچم صریح:** `git_reset --hard` و `git_checkout` با `discardChanges: true` فقط با `confirmDestructive: true` — خطای `CONFIRM_REQUIRED` فهرست دقیق چیزی که از دست می‌رود را برمی‌گرداند.
4. **`--force` ساخته نمی‌شود:** `git_push` هیچ گزینهٔ force/`--no-verify` ندارد.
5. `git_commit`: فقط آنچه staged است (یا `paths` صریح)، پیام اجباری و غیرخالی، هویت author از `git config` خوانده می‌شود و **هرگز** config نوشته نمی‌شود.
6. `git_push`: پیش‌فرض `origin` + برنچ جاری + `--set-upstream` اختیاری.
6. **PR:** اول `gh` اگر در PATH بود (`gh pr create/list/view/comment --json`)، وگرنه GitHub REST با `GITHUB_TOKEN`/`GH_TOKEN`؛ نبودِ هر دو → `PR_UNAVAILABLE` با راهنمای نصب/توکن. هیچ توکنی در Journal نمی‌رود (فاز ۳۷ صریحاً assert می‌کند).
7. هر عملیات: قبل/بعد `HEAD` + `status --porcelain` در نتیجه برگردانده می‌شود (و در Journal ثبت) — «چه چیزی عوض شد» همیشه قابل‌بازبینی است.

**معیار پذیرش:** تست واحد روی مخزن واقعی: add/commit (SHA عوض شود، پیام درست)، ساخت و checkout برنچ، `reset --hard` بدون پرچم → `CONFIRM_REQUIRED` و **بدون هیچ تغییری روی دیسک**، با پرچم → انجام شود، رد شدن `--hard` روی `main` (`PROTECTED_BRANCH`)، push به یک remote محلی bare در `mkdtemp` (بدون شبکه)، رد شدن push به `main`، و آزمون اینکه گزینهٔ force در شِمای ابزار **وجود ندارد**. PR: تست با `gh` mock (stub در PATH) و مسیر REST با یک fetch mock؛ نبود gh+token → `PR_UNAVAILABLE`. e2e: سناریوی `gitwrite` — ساخت برنچ، commit، push به remote bare محلی، سپس assert روی لاگ/Journal.

---

## فاز ۴۳ — عرضهٔ خود سیستم به‌عنوان MCP server

**هدف:** Claude/Cursor/هر کلاینت MCP بتواند ابزارهای همین runtime را استفاده کند (عکس مسیر فعلی که ما کلاینتیم).

**گام‌ها:**
1. `src/mcp/server.ts` (+ `src/mcp/protocol.ts`): JSON-RPC 2.0 روی stdio (خط‌جداشده — همان استاندارد MCP و همان الگوی fixture فعلی) و روی HTTP با `express` (وابستگی موجود).
2. متدها: `initialize` (مذاکرهٔ نسخه: 2025-06-18 با عقب‌گرد به 2025-03-26/2024-11-05), `tools/list`, `tools/call`, `ping`, و `resources/list`/`resources/read` برای منابع فقط‌خواندنی: `plan://{id}`, `journal://{date}`, `memory://graph`.
3. JSON Schema ابزارها از همان تعاریف zod (`z.toJSONSchema`) — یک منبع حقیقت، بدون تعریف دوباره.
4. `tools/call` **همان** مسیر اجرای داخلی را طی می‌کند: اعتبارسنجی مسیر، Journal، خطای ساخت‌یافته. یعنی ابزار از بیرون هم audit می‌شود.
5. CLI: `hootl serve --mcp [--http --port 3300 --token <t>] [--read-only] [--allow-tools a,b] [--prefix m]`؛ stdio پیش‌فرض؛ HTTP فقط روی `127.0.0.1` و با bearer token اجباری.
6. `--read-only` فقط ابزارهای غیرنوشتنی (فهرست سفید: read_*/list_*/search_*/git read/get_*/convert_time/…) — برای وصل‌کردن به کلاینت‌های نامطمئن.
7. هشدار در `hootl mcp-servers` docs: این سطح دسترسی به فایل‌های پروژه می‌دهد؛ `--read-only` را پیشنهاد کن.

**معیار پذیرش (dogfooding + interop):**
- تست واحد: `initialize`/`tools/list` (شمار ابزار = `LOCAL_TOOL_IDS`)، `tools/call` موفق و ناموفق، نسخهٔ پروتکل ناشناس، JSON-RPC بدشکل، ابزار ناشناس (`-32601`)، فیلتر `--allow-tools` و `--read-only`، توکن نامعتبر روی HTTP.
- تست interop واقعی: سرور ما با **کلاینت** `@ai-sdk/mcp` (وابستگی موجود) وصل شود و ابزارها را ببیند/صدا بزند.
- e2e: سناریوی `mcpserve` — `hootl serve --mcp` بالا بیاید، `hootl tools --mcp` (کلاینت خودمان) به آن وصل شود و ابزار فهرست/صدا زده شود؛ و assert شود که آن call در Journal ثبت شده.

---

## ۳) چک‌لیست مشترک هر فاز (تعریف «تمام‌شده»)

1. ابزار: factory در `src/ai/tools/implementations/…` + ثبت در `local-tools.ts` + `registry/tools/<id>.json`
2. شخصا/skill: به‌روزرسانی `registry/personas/{coder,architect,reviewer}.json` و مهارت مربوطه
3. تست واحد در `src/ai/__tests__/phase<NN>-*.test.ts` (شامل خطاها و مرزهای امنیتی، نه فقط مسیر خوشبینانه)
4. سناریوی e2e + marker لازم در `e2e/fake-llm.mjs` (اگر marker می‌خواهد) و سطر در `e2e/README.md`
5. Journal (از فاز ۳۷ به بعد): هر ابزار جدید **بدون کد اضافه** ثبت می‌شود؛ در تست فاز تأیید شود که خط Journal ساخته می‌شود
6. مستندات: `CHANGELOG.md` (نسخهٔ جدید)، `README.md` (جدول ابزار + توضیح)، `docs/CONFIGURATION.md` (درخت registry و نمونه‌ها)
7. `npx tsc -p tsconfig.json --noEmit` تمیز، کل تست‌ها سبز، `npm run e2e` کامل سبز
8. commit مستقل + push + یک بخش تازه در بدنهٔ PR #3 + 🟢 در همین فایل

---

## ۴) ترتیب، وابستگی و اندازه

| فاز | موضوع | وابسته به | اندازه | چرا این ترتیب |
|---|---|---|---|---|
| ۳۷ | Journal | — | متوسط | زیرساخت؛ همهٔ فازهای بعدی از آن سود می‌برند و خواستهٔ صریح کاربر بود |
| ۳۸ | time + sequentialthinking | — | کوچک | سریع، بدون ریسک، و زمان در بلوک ENVIRONMENT ادغام می‌شود |
| ۳۹ | memory | ۳۷ (audit) | متوسط | ماندگاری بین اجراها؛ هستهٔ atomic-write آماده است |
| ۴۰ | fetch | ۳۷ | متوسط | شبکه؛ مدل امنیتی SSRF لازم دارد |
| ۴۱ | Git خواندن | ۳۷ | متوسط | پایهٔ ۴۲؛ بدون ریسک تغییر |
| ۴۲ | Git نوشتن + PR | ۴۱، ۳۷ | بزرگ | حساس‌ترین فاز؛ نیاز به مدل تأیید و تست روی remote محلی |
| ۴۳ | MCP server | ۳۷–۴۱ (کاتالوگ پایدار) | متوسط | سطح بیرونی؛ باید کاتالوگ ابزار تثبیت شده باشد + Journal برای audit |

---

## ۵) ریسک‌ها و پاسخ‌ها

| ریسک | پاسخ |
|---|---|
| prompt-injection → اجرای دستور مخرب git | بدون shell، allowlist، برنچ محافظت‌شده، تأیید برای مخرب، بدون `--force`، Journal کامل |
| لو رفتن راز در Journal | redaction کلید+مقدار، تست e2e با سناریوی `credential` |
| SSRF از طریق `fetch` | مسدودسازی loopback/private/link-local به‌صورت پیش‌فرض، بدون هدر auth |
| حافظهٔ خراب/تلاقی نوشتن | `atomicWriteFileSync` + `file-lock`، تست JSON خراب |
| رشد بی‌سقف فایل‌ها | rotation روزانه + retention + سقف ورودی/خروجی |
| MCP بیرونی = دسترسی به فایل پروژه | `--read-only`، `--allow-tools`، HTTP فقط localhost + token، هشدار مستند |
| PR وابسته به `gh`/توکن | مسیر دوگانه (gh → REST) با خطای واضح `PR_UNAVAILABLE` |

---

## ۶) پرسش‌های باز (نیازمند تصمیم کاربر قبل از فاز مربوطه)

1. **Git نوشتن — مدل تأیید:** آیا `git_reset --hard`/`checkout` روی working tree کثیف/`push` باید در CLI از کاربر تأیید بگیرد (مسیر approval موجود) یا در حالت `--yes`/غیرتعاملی خودکار رد شود؟
2. **PR:** اجرا از طریق `gh` (اگر نصب باشد) کافی است، یا پشتیبانی REST با `GITHUB_TOKEN` هم لازم است؟ (پیش‌فرض پلن: هر دو)
3. **fetch:** آدرس‌های private/loopback به‌صورت پیش‌فرض مسدود باشند؟ (پیش‌فرض پلن: بله، با override)
4. **memory:** دامنهٔ پیش‌فرض project-scoped باشد یا global (مشترک بین پروژه‌ها) هم لازم است؟
## ۶) تصمیم‌های قفل‌شده (۲۰۲۶-۰۹-۲۵، پاسخ کاربر)

### ۶.۱ Git — امنیت ساختاری، نه تأیید تعاملی (منبع: خود `servers-main/src/git`)

کاربر پرسید «آیا در `servers-main/src/git` وجود ندارد؟» — بررسی شد و جواب **منفی** است: مرجع هیچ مکانیزم تأییدی ندارد. کاری که می‌کند:

| مکانیزم مرجع | جای آن در کد |
|---|---|
| بدون shell — GitPython، argv مستقیم | کل `server.py` |
| `--` قبل از مسیرها (فایلی که با `-` شروع شود، پرچم تفسیر نشود) | `git_add` |
| رد ref/برنچ/timestamp که با `-` شروع می‌شود (ضد flag-injection) | `git_log`, `git_create_branch`, `git_checkout`, `git_show` |
| **`git_reset` فقط unstage است** (`repo.index.reset()`) — `--hard` در مرجع **وجود ندارد** | تابع `git_reset` |

**تصمیم (بهترین کار = فلسفهٔ مرجع + آنچه مرجع ندارد):**

1. **همان کاری که مرجع می‌کند عیناً:** بدون shell (argv مستقیم)، `--` قبل از مسیرها، رد هر ورودی با `-` در ابتدا، و `git_reset` با پیش‌فرض **unstage**.
2. **`--hard` قابلیتی است که نباید پیش‌فرض باشد:** فقط با `confirmDestructive: true` صریح؛ در غیر این‌صورت خطای `CONFIRM_REQUIRED` که فهرست دقیق فایل‌های dirty (چیزی که از دست می‌رود) را برمی‌گرداند. پرچم، نه پرسش تعاملی — تا در CI و اجرای `--yes` هم قابل استفاده بماند و مدل نتواند تصادفی (یا از طریق prompt-injection) مخرب باشد.
3. **دو چیزی که مرجع ندارد و ما اضافه می‌کنیم:**
   - **برنچ‌های محافظت‌شده** (پیش‌فرض `main`, `master`، قابل تنظیم): `push` مستقیم و `reset --hard` روی آن‌ها ممنوع (`PROTECTED_BRANCH`).
   - **`--force` ساخته نمی‌شود:** `git_push` هیچ گزینهٔ force/`--no-verify` ندارد — نه پنهان، نه با پرچم. کسی که force می‌خواهد، دستی می‌زند. (همان اصل مرجع: خطرناک را نساز.)
4. **`checkout`:** جابه‌جایی برنچ با working tree کثیف را خود git مدیریت می‌کند (و در تعارض refuse)؛ حالت خطرناک، `checkout` برای **دورریختن تغییرات** است (`discardChanges: true`) که مثل `--hard` به `confirmDestructive` نیاز دارد.
5. Journal (فاز ۳۷) هر عملیات نوشتنی را با argv کامل، `HEAD` قبل/بعد و `status --porcelain` ثبت می‌کند — audit trail همان چیزی است که تأیید را معنادار می‌کند.

### ۶.۲ بقیهٔ تصمیم‌ها

- **PR:** هر دو مسیر — اول `gh` (اگر در PATH و authenticated)، وگرنه GitHub REST با `GITHUB_TOKEN`/`GH_TOKEN`؛ نبود هر دو → `PR_UNAVAILABLE` با راهنمای نصب/توکن.
- **fetch:** آدرس‌های private/loopback/link-local **پیش‌فرض مسدود**، با `allowPrivate: true` برای override (دفاع در برابر SSRF و prompt injection).
- **memory:** فقط **project-scoped** (`<project>/.ai-runtime/memory.json`) — بدون scope جهانی.
- **MCP server:** stdio پیش‌فرض + HTTP فقط روی `127.0.0.1` با bearer token.
