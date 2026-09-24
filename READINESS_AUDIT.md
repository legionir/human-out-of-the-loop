# Readiness Audit — «آیا سیستم ۱۰۰٪ آماده است؟»

**Date:** 2026-09-24
**Baseline:** commit `71b5047` (Phase 29) — `tsc` clean، **۵۸۵ تست در ۳۹ فایل** سبز، باینری سراسری `hootl` 27.2.0
**E2E موجود:** ۴۳ سناریوی PTY واقعی در `/tmp/e2e` (استاب LLM محلی Responses API — هیچ provider واقعی)
**پیشرفت:** P2 🟢 (v27.2.1) · **P3 🟢 (v27.2.2)** · **P4 🟢 (بدون تغییر کد)** · **P5 🟢 (v27.2.4)** · **P6 🟢 (v27.2.5)** · **P7 🟢 (v27.2.6)** — ۶۲۶ تست در ۴۴ فایل، `tsc` clean
**سؤال مبنا (کاربر):** «باگ‌ها از runtime بود؟ الان می‌تونی بگی که سیستم ۱۰۰٪ آماده استفاده هست؟»

---

## Executive Summary

**پاسخ: نه.** ۵ از ۱۱ باگ فاز ۲۹ در runtime بود و همه روی **درزِ بین ماژول‌ها** نشسته بودند — مجموعه‌ی تست سبز بود در حالی که `hootl run` تعاملی حتی یک‌بار تا آخر نمی‌رفت. پس «سبز بودن تست‌های ماژولی» معادل «آماده بودن سیستم» نیست.

این فایل، تمام مواردِ **تأییدنشده** را به‌ترتیب اولویت ثبت می‌کند (طبق قاعده‌ی «بدون حدس → Unknown / Requires Verification»). هر مورد سه بخش دارد: چرا Unknown است (شواهد)، چطور راستی‌آزمایی می‌شود (گام‌های اجرایی)، و معیار پذیرش.

**قاعده‌ی وضعیت:** ⬜ تأیید نشده · 🟡 در حال اجرا · 🟢 تأیید شده (با شواهد) · 🔴 باگ پیدا شد (وضعیت رفع) · ⛔ مسدود (نیازمند ورودی بیرونی)

---

## ترتیب اولویت و دلیل آن

| اولویت | مورد | ریسکِ اصلی که با آن بسته می‌شود |
|---|---|---|
| **P1** | اجرا با provider واقعی | ⛔ **مسدود** — کل زنجیره‌ی LLM هرگز با شبکه‌ی واقعی آزموده نشده |
| **P2** | بازیابی پس از crash (`kill -9`) + `plans resume` | از دست رفتن/خرابی کار نیمه‌تمام؛ مسیر resume هیچ تستی ندارد |
| **P3** | اثر واقعی ابزارها در run (`write_file`/`search_code`/`git_status`) و sandbox | اولین اجرایی که واقعاً چیزی می‌نویسد، هنوز آزموده نشده |
| **P4** | دو اجرای هم‌زمان روی یک پروژه | overwrite/corrupt در plans/sessions/log |
| **P5** | مدل واقعاً کند/حلقه‌ای: timeout، `--max-steps`، abort | hang کردن یا خرج بی‌پایان |
| **P6** | MCP واقعی (stdio + http) | ادعای «ابزارهای MCP در run» عملاً آزموده نشده |
| **P7** | اهداف بزرگ/چندمرحله‌ای و re-planning واقعی | مقیاس‌پذیری و کیفیت پلن در واقعیت |
| **P8** | ماتریس محیط (macOS/Windows/WSL، Node>22، CI بدون TTY) | قابل استفاده بودن در محیط کاربر |
| **P9** | UI/سرور پس از تغییرات فاز ۲۹ | مسیر غیر-CLI محصول |
| **P10** | محتوای خصمانه (prompt-injection، فرار از sandbox، نشت credential) | امنیت در شرایط واقعی |

**وضعیت فعلی:** P1 ⛔ · P2 🟢 · P3 🟢 · P4 🟢 · P5 🟢 · P6 🟢 · P7 🟢 · P8–P10 ⬜

**چرا این ترتیب:** P1 مسدود است (کلید واقعی). بقیه بر اساس «احتمال شکست × هزینه‌ی شکست» چیده شده‌اند: P2/P3/P4 می‌توانند به از دست رفتن کار یا داده منجر شوند؛ P5 در حد fidelity است (مسیر abort واحد-تست دارد)؛ P6–P10 وابستگی محیطی/مقیاسی دارند.

---

## P1 — اجرا با provider واقعی (OpenAI/Anthropic) ⛔

**چرا Unknown:** ۲۱ فایل تست ماژول `ai` را mock می‌کنند؛ هیچ تستی به `api.openai.com` / `api.anthropic.com` درخواست نمی‌زند. همه‌ی e2e فاز ۲۹ با استاب محلی Responses API اجرا شد. یعنی: صحت شمارش توکن واقعی، رفتار streaming/SSE واقعی، نگاشت خطاهای ۴۰۱/۴۲۹/۵۰۰، retry، timeout شبکه، و شکل واقعی structured output (`text.format.json_schema`) با مدل واقعی **آزموده نشده**.

**چطور راستی‌آزمایی می‌شود:**
- (الف) در محیطی که کلید واقعی دارد: `hootl run "<goal کوچک>" --persistent --verbose` و مقایسه‌ی plan/usage/log با انتظار.
- (ب) بدون کلید: شبیه‌ساز پرفیدلیتی‌تر (SSE تدریجی، خطای ۴۲۹/۵۰۰، قطع وسط پاسخ، JSON خراب) برای سنجش رفتار خطا/retry/توکن.

**معیار پذیرش:** یک run واقعی کامل (plan→confirm→execute→review) + صحت `hootl usage` + پیام خطای درست و غیر-کرش برای ۴۰۱/۴۲۹/۵۰۰ + بدون نشت کلید در log.

**وضعیت:** ⛔ مسدود تا انتخاب مسیر (الف) توسط کاربر یا اجرای (ب) به‌عنوان تقریب.

---

## P2 — بازیابی پس از crash + `plans resume` 🟢

**چرا Unknown:** صفر تست برای `SIGKILL`؛ `resumePlan` هیچ تست واحدی ندارد؛ تنها پوشش موجود «resume پلن نیمه‌تمام با mock» در `cli.test.ts` است. همچنین قفل فایل (`file-lock.ts`, PERS-04) هرگز در سناریوی پروسه‌ی مُرده آزمایش نشده.

**چطور راستی‌آزمایی می‌شود:**
1. اجرای `hootl run … --yes --persistent` با استاب کند (`FAKE_DELAY_MS=4000`).
2. `kill -9` روی پروسه در حین اجرای step دوم.
3. بازرسی وضعیت روی دیسک: `status` پلن، وضعیت هر step، باقی‌مانده‌ی قفل، فایل session، لاگ.
4. `hootl plans resume <id>` → انتظار: ادامه از step دوم، پایان موفق، بدون افزودن step تکراری.
5. تکرار crash در فاز planning (قبل از persist پلن) و در پرامپت تأیید.

**معیار پذیرش:** پلن نیمه‌تمام قابل resume باشد؛ stepهای تمام‌شده دوباره اجرا نشوند؛ قفل پروسه‌ی مرده بسته/تصاحب شود؛ هیچ plan/session خراب یا نیمه‌نوشته باقی نماند؛ exit code و پیام درست.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹-۲۴)** — با یک باگ پیدا‌شده و رفع‌شده (زیر).

### نتیجه‌ی اجرا

| سناریو | نتیجه |
|---|---|
| `kill -9` وسط اجرای step دوم | وضعیت روی دیسک سالم: پلن `running`، step-1 `done`، step-2 `running`؛ **صفر قفل باقی‌مانده**، صفر پروسه‌ی یتیم، فایل session/plan نیمه‌نوشته ندارد |
| `hootl sessions show` بعد از crash | پلنِ قابل‌resume به کاربر نشان داده می‌شود (`Plans: plan_stub_…`) |
| `hootl plans resume <id>` | فقط step-2 اجرا شد (۳ task کل: step-1 یک‌بار، step-2 دو بار)، پلن `completed`، usage = ۳۳۰ (نصف یک اجرای کامل) → **step کامل‌شده دوباره اجرا نمی‌شود** |
| `kill -9` وسط **planning** | هیچ پلنی روی دیسک نیست → چیزی برای resume وجود ندارد (پایین: محدودیت شناخته‌شده) |
| پلن **draft** (هرگز تأیید نشده) | `plans resume` رد می‌کند: `not found (or not resumable)` + exit 1 (قاعده‌ی فاز ۲۴ حفظ شد) |
| پلن ناموجود | `not found (or not resumable)` + exit 1 |

### باگ N (پیدا و رفع شد) — اثر crash روی session

**علامت:** بعد از crash+resume، interaction سشن تا ابد `pending` می‌ماند، `completedAt` ندارد و **`planIds` هم خالی بود** — یعنی `sessions show` هیچ راهی برای رسیدن به پلنِ نیمه‌تمام به کاربر نمی‌داد و همان اجرای موفقِ resume هم سشن را نمی‌بست.

**ریشه:** link پلن↔سشن هیچ‌جا ذخیره نمی‌شد (نه روی پلن، نه روی interaction تا لحظه‌ی پایان اجرا) و `resumePlan` هم Store سشن را لمس نمی‌کرد (`sessionId: 'resumed'` یک مقدار جعلی بود).

**رفع (کمترین تغییر):** فیلد اختیاری `Plan.sessionId`؛ ثبت هر دو جهت link **قبل از شروع اجرا**؛ و در `resumePlan` بستن interaction بازِ همان سشن با outcome/summary/planIds اجرای resume شده. تست: `src/cli/__tests__/phase30.test.ts` (۵ تست، جهت‌دار — بدون رفع: `expected undefined to be 'session_…'` و `expected 'pending' to be 'success'`).

### پیگیری P2 (۲۰۲۶-۰۹-۲۴، نسخه ۲۷.۲.۳) — taskِ باقی‌مانده از crash

آخرین مورد تأییدنشده‌ی P2 بسته شد: پروسه‌ی `kill -9` شده هیچ‌وقت رویداد پایانیِ task خود را نمی‌نویسد، پس `hootl tasks list` آن task را **تا ابد `running`** نشان می‌داد — حتی بعد از resume موفق. حالا `plans resume` قبل از اجرا، stepهای `running` روی دیسک را ثبت می‌کند و رویداد `task:interrupted` (سطح warn) می‌نویسد؛ `tasks list` وضعیت جدید `interrupted` را جدا می‌شمارد.

شاهد واقعی (crash + resume): قبل `task_344a1a98 | step-2 | running` → بعد `task_344a1a98 | step-2 | interrupted` در کنار `task_e94d4fe6 | step-2 | done`؛ خلاصه: `3 task(s): 2 done, 0 failed, 1 interrupted, 0 running`. تست: یک تست جدید در `phase30.test.ts` (جهت‌دار).

### محدودیت شناخته‌شده (پذیرفته‌شده، نه باگ)

اگر پروسه **قبل از ساخته‌شدن پلن** بمیرد، interaction با outcome `pending` و بدون `planId` می‌ماند و چیزی برای resume وجود ندارد. این «حالت واقعیِ نیمه‌تمام» است؛ تشخیص خودکار آن heartbeat می‌خواهد که فعلاً وجود ندارد. `sessions show` این وضعیت را صادقانه نشان می‌دهد.

---

## P3 — اثر واقعی ابزارها در run (`write_file`/`search_code`/`git_status`) 🟢

**چرا Unknown:** در همه‌ی e2e فاز ۲۹ تنها ابزاری که واقعاً اجرا شد `read_file` بود. مسیر نوشتن (که مستقیماً به sandbox مسیرها وصل است) در یک run واقعی هرگز اجرا نشده؛ تنها تست واحد `path-security` وجود دارد.

**چطور راستی‌آزمایی می‌شود:** پلنی که `write_file` می‌خواهد + تلاش نوشتن بیرون از `projectRoot` (مسیر مطلق، `..`، symlink) + `search_code` روی درخت واقعی + `git_status` در ریپوی واقعی/غیر‌ریپو.

**معیار پذیرش:** فایل درست داخل پروژه نوشته شود؛ همه‌ی تلاش‌های خروج از sandbox با خطای روشن رد شوند و **هیچ** فایلی بیرون از root ساخته/تغییر نکند؛ `search_code` نتایج درست بدهد؛ `git_status` روی غیر-ریپو کرش نکند.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹-۲۴)** — با یک باگ پیدا‌شده و رفع‌شده (باگ O).

### نتیجه‌ی اجرا (CLI واقعی + استاب، پروژه‌ی `/tmp/e2e/proj`)

| سناریو | نتیجه |
|---|---|
| `WRITE:notes/p3-demo.txt` (هدف واقعی نوشتن) | فایل واقعاً روی دیسک ساخته شد (`notes/p3-demo.txt`، ۱۲ بایت، محتوای `stub content`؛ پوشه‌ی والد هم ساخته شد) — `Outcome: SUCCESS`، exit 0 |
| `SEARCH:demo` (الگوی موجود) | ابزار واقعی `search_code` اجرا شد (`task:tool-call`)، پلن SUCCESS |
| `SEARCH:zzz-…` (الگوی ناموجود) | ابزار واقعی اجرا شد، «بدون نتیجه» یک موفقیت است (طراحی) |
| `GITSTATUS:here` در ریپوی واقعی | `git_status` واقعی، SUCCESS |
| `GITSTATUS:here` در **غیر**-ریپو | پیام واقعی git (`fatal: not a git repository …`) → step `failed`، `Outcome: FAILURE`، exit 1 → یعنی ابزار واقعاً git را صدا می‌زند |
| `WRITE:../p3-escape.txt` (خروج با `..`) | رد شد: `PATH_TRAVERSAL_BLOCKED`؛ **هیچ فایلی** در `/tmp/e2e/p3-escape.txt` ساخته نشد؛ step `failed`، پلن `FAILURE`، exit 1 |
| `WRITE:/tmp/p3-abs-escape.txt` (مسیر مطلق) | رد شد، صفر فایل بیرون از `projectRoot` |

### باگ O (پیدا و رفع شد) — شکست ابزار کاملاً نامرئی بود

**علامت:** قبل از رفع، اجرای «نوشتن بیرون از sandbox» را **SUCCESS** اعلام می‌کرد: `Tools used: write_file`، لاگ `Task "…" completed. 1 tools used.`، پرامپت acceptance عیناً `## Task Errors (if any)\nNone`، و هر step `done` — در حالی که ابزار صفر کار انجام داده بود. sandbox جلوی نوشتن را گرفته بود، اما هیچ‌کس (نه انسان، نه judge) خبر نداشت.

**ریشه:** `AgentRuntime.executeWithSdk` فقط `step.toolCalls` را می‌خواند؛ سه شکل شکست ابزار هیچ‌کدام ثبت نمی‌شد:
1. ابزاری که `execute` آن **throw** کند → SDK یک content part از نوع `tool-error` می‌سازد (نه `toolResult`)؛
2. قرارداد خودِ ابزارهای پروژه: `{ success: false, error, code }` که از دید SDK یک نتیجه‌ی **موفق** است (همین حالت `write_file`/`git_status`/`search_code`)؛
3. `execution-denied` (رد اجرا).

**رفع (کمترین تغییر):**
- event جدید `agent:tool_error` + تابع `describeToolFailure` در `src/ai/runtime/agent-runtime.ts` (پیام ≤۲۰۰ کاراکتر، آرگومان‌های ابزار هرگز وارد event نمی‌شوند — Law 14 رعایت شد)؛
- پیام خطا در `summary` نتیجه‌ی agent هم می‌آید (`Tool errors: write_file — …`) — یعنی همان رشته‌ای که judge می‌بیند؛
- `task.errors` روی مسیر **موفق** هم ذخیره می‌شود (`src/ai/runtime/task-runtime.ts`) تا `AcceptanceChecker` شکست ابزار را ببیند؛
- خط `task:tool-error` (سطح `warn`) در observability log؛
- progress event `task:tool-error` که **همیشه** چاپ می‌شود (بدون نیاز به `--verbose`): `✖ tool failed: write_file — Path … outside workspace … [PATH_TRAVERSAL_BLOCKED]`.

**تست:** `src/ai/__tests__/phase30-p3.test.ts` — ۹ تست؛ جهت‌دار: با غیرفعال‌کردن تشخیص، ۵ تست fail می‌شوند (`expected [] to have a length of 1`, `expected 'Step finished. Used tools: write_file.' to contain 'outside workspace'`).

**تغییر harness (خارج از ریپو، `/tmp/e2e`):** استاب حالا از نشانه‌های هدف مسئله پلن می‌سازد و همان ابزار را واقعاً صدا می‌زند (`WRITE:path`، `OVERWRITE:path`، `SEARCH:pattern`، `READ:path`، `GITSTATUS:here`), و judge استاب صادق شده: اگر بخش `## Task Errors` خالی نباشد، `accepted: false` می‌دهد. سناریوها: `p3a`–`p3f`.

---

## P4 — دو اجرای هم‌زمان روی یک پروژه 🟢

**چرا Unknown:** `file-lock.ts` واحد تست شده (PERS-04) ولی سناریوی دو‌پروسه‌ای واقعی (دو ترمینال، یک پروژه، هم‌زمان) هرگز اجرا نشده — همان‌جایی که انتظار می‌رود قفل کار کند.

**چطور راستی‌آزمایی می‌شود:** دو `hootl run … --persistent --yes` هم‌زمان روی یک پروژه (با استاب کند)، سپس بازرسی: فایل‌های plans/sessions/log، تداخل id، پیام قفل، و رفتار `usage`/`tasks` بعد از آن.

**معیار پذیرش:** هیچ فایل نیمه‌نوشته/خراب، هیچ overwrite وضعیت، هر دو اجرا نتیجه‌ی خودشان را ثبت کنند (یا دومی با خطای روشن رد شود)؛ لاگ بدون خط شکسته.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹-۲۴)** — بدون نیاز به تغییر کد.

### نتیجه‌ی اجرا (پروسه‌های واقعی، استاب کند `FAKE_DELAY_MS=4000`)

| سناریو | نتیجه |
|---|---|
| ۲ اجرای هم‌زمان روی یک پروژه (`p4-concurrent.sh`) | هر دو `Outcome: SUCCESS`؛ ۲ فایل plan + ۲ فایل session، همه قابل‌parse، idهای یکتا، صفر overwrite |
| ۴ اجرای هم‌زمان | هر چهار `SUCCESS` (۶۶۰ توکن هر کدام)؛ ۸ فایل، همه سالم؛ ۴۸ خط لاگ، **صفر خط شکسته** |
| `usage`/`tasks` بعد از ۴ اجرای هم‌زمان | `usage`: ۴ پلن × ۶۶۰ = ۲۶۴۰ توکن روی ۸ task؛ `tasks list`: `8 task(s): 8 done, 0 failed, 0 interrupted, 0 running` |
| **crash وسط هم‌زمانی** (A با `kill -9` کشته می‌شود، B ادامه می‌دهد) | B سالم تمام کرد (`SUCCESS`)؛ پلن A روی دیسک `running` و قابل‌resume ماند؛ ۱۸ خط لاگ، صفر خط شکسته؛ صفر قفل باقی‌مانده، صفر پروسه‌ی یتیم |
| resume همان پلن A (پس از پایان رقابت) | `Outcome: SUCCESS`, usage 660 (resumed)؛ پلن `completed`؛ taskِ کشته‌شده صادقانه `interrupted` (فاز ۲۷.۲.۳) |
| **رقابت روی یک فایل خروجی** (هر دو اجرا `WRITE:notes/shared.txt` خودشان) | A برنده نوشت (محتوا `A`)؛ B با خطای روشن رد شد: `File already exists: notes/shared.txt. Set overwrite=true to replace. [EEXIST]` و `Outcome: FAILURE` → هیچ overwrite خاموشی رخ نداد |

**چرا این مورد سالم است (ساختاری):** نام فایل هر plan/session هش SHA-256 از id است (فاز ۲۲/STORE-01)، نوشتن **اتمی** است (فاز ۱۹/PERS-01) و نویسندگان بین‌پروسه‌ای با `withFileLockSync` سریال می‌شوند (فاز ۲۷/PERS-04). هر رکورد فایل مستقل خود را دارد، پس «وضعیت مشترک» وجود ندارد که overwrite شود.

**پوشش تست موجود:** `PERS-01` (atomic write) و `PERS-04` (cross-process file lock) واحد-تست شده‌اند؛ شاهد P4 اجرای واقعی چند-پروسه‌ای است (اسکریپت‌های `/tmp/e2e/p4-concurrent.sh` و `/tmp/e2e/p4-crash-concurrent.sh`). چون کدی تغییر نکرد، تست جدیدی هم لازم نبود.

---

## P5 — مدل واقعاً کند/حلقه‌ای: timeout، `--max-steps`، abort 🟢

**چرا Unknown:** مسیر `abortSignal`/`TimeoutError` فقط واحد تست شده (phase7/19/20/22/27)؛ در e2e استاب همیشه فوری پاسخ می‌دهد، پس رفتار واقعی «مدل کند» یا «حلقه‌ی ابزار» دیده نشده.

**چطور راستی‌آزمایی می‌شود:** استاب با تأخیر بلند (مثلاً ۱۲۰ ثانیه) + `--timeout-ms 5000`؛ استاب حلقه‌ای که بی‌پایان tool call می‌دهد + `--max-steps 3`؛ بررسی: abort تمیز، پیام قابل‌فهم، ثبت `plan:step-failed`، عدم hang، خروج با exit درست.

**معیار پذیرش:** در هر دو حالت فرآیند در زمان محدود تمام شود، وضعیت پلن درست ثبت شود و هیچ پروسه‌ی زامبی/قفل باقی نماند.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹-۲۴)** — با دو باگ وقتی‌دار پیدا و رفع شد (باگ Q).

### نتیجه‌ی اجرا (CLI واقعی + استاب، `--timeout-ms 5000`)

| سناریو | نتیجه |
|---|---|
| مدل کند (`SLOW:120`) + `--timeout-ms 5000` | `Agent run timed out after 5000ms` → step `failed`، `Outcome: FAILURE`، exit 1، **کل اجرا ۵ ثانیه** |
| حلقه‌ی بی‌پایان ابزار (`LOOP`) + `--max-steps 3` | دقیقاً **۳** فراخوانی ابزار و پایان در ۱ ثانیه (exit 0) — بدون حلقه‌ی بی‌پایان، بدون خرج بی‌پایان |
| planner بی‌پاسخ (`SLOWALL:120`) + `--timeout-ms 5000` | خاتمه در **۵ ثانیه** با پیام صادقانه: `⚠️ Clarification needed: The planner was unable to process the request: Planner assessment timed out after 5000ms…`، exit 1 |
| Ctrl-C وسط اجرا (^C واقعی در PTY) | خروج فوری (exit `-2`)، **صفر پروسه‌ی یتیم**، صفر فایل نیم‌نوشته؛ پلن روی دیسک `running` می‌ماند و با `plans resume` ادامه می‌یابد (مسیر P2) |

### باگ Q (پیدا و رفع شد) — دو انتظار بی‌کران

**علامت ۱:** در اجرای «مدل کند + `--timeout-ms`»، تایم‌اوت درست کار می‌کرد (step `failed`، گزارش چاپ می‌شد) اما **پروسه هرگز خارج نمی‌شد**: هارنس مجبور شد بعد از ۹۰ ثانیه با SIGKILL بکشدش. علت: درخواست رهاشده‌ی مدل هنوز روی سوکت باز بود و event loop را زنده نگه می‌داشت.

**علامت ۲:** هیچ‌کدام از فراخوانی‌های ساختاریافته (planner assessment، تولید پلن، acceptance، review نهایی) هیچ مهلتی نداشتند — ارائه‌دهنده‌ای که سوکت را باز کند و هرگز پاسخ ندهد، CLI را **برای همیشه** بی‌خروجی معطل می‌کرد (در e2e بیش از ۹۰ ثانیه معطل ماند).

**رفع (کمترین تغییر):**
- فایل جدید `src/ai/runtime/llm-timeout.ts`: `withLlmTimeout(label, ms, fn)` — مهلت سخت + **abort** درخواست روی انقضا (پیام `LlmTimeoutError`)؛
- همان `--timeout-ms` (پیش‌فرض ۱۲۰s) از طریق orchestrator به Planner/FinalReviewer/AcceptanceChecker تزریق شد و هر ۵ فراخوانی `generateObject` با `abortSignal` زیر این مهلت اجرا می‌شوند؛
- در `AgentRuntime` هم مهلت اجرا (که از قبل بود) حالا درخواست in-flight را **abort** می‌کند و rejection بازنده‌ی race هم بلعیده می‌شود (بدون unhandled rejection)؛
- `Planner` دیگر خطای واقعی را پشت «request unclear» پنهان نمی‌کند و علت را می‌گوید.

**تست:** `src/ai/__tests__/phase30-p5.test.ts` — ۵ تست (helper، abort در agent run، planner بامهلت، acceptance فِیل‌کلوز، پیام‌های صادقانه). جهت‌دار: با غیرفعال‌کردن دو `abort`، دقیقاً ۲ تست fail می‌شوند.

### نکته‌ی تصمیم‌گیری (نه باگ)

Ctrl-C امروز «توقف سخت» است: پروسه فوراً می‌میرد و پلن روی دیسک `running` می‌ماند (قابل resume، مثل crash). رفتار «لغو مؤدبانه» — یعنی علامت‌زدن پلن به‌عنوان `cancelled`، پیام پایانی و exit 130 — نیازمند یک SIGINT handler در طول اجرا است و چون تغییر رفتار (نه رفع باگ) است، تا تصمیم کاربر اجرا نشد.

---

## P6 — MCP واقعی (stdio + http + sse) 🟢

**چرا Unknown بود:** `mcp test` فقط روی یک registry با URL مرده آزموده شده بود (شکست درست). هیچ سرور MCP واقعی وصل نشده بود؛ ادعای «ابزارهای MCP در run در دسترس‌اند» عملاً آزموده نشده بود. بدتر: transport استاندارد `stdio` در schema و help تبلیغ می‌شد ولی کانکتور `throw` می‌کرد («stdio transport is not supported in this version») — یعنی همه‌ی سرورهای محلی (npx/python) غیرقابل‌استفاده بودند.

**معیار پذیرش:** `mcp test` ابزارها را لیست کند (exit 0)؛ tool با `source: "mcp"` در run قابل استفاده باشد؛ خطای سرور مرده پیام redacted و exit 1 بدهد.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹۲۴)** — stdio از صفر ساخته شد و ۴ باگ در درزهایش پیدا و رفع شد (R/S/T/U).

### نتیجه‌ی اجرا (CLI واقعی + سرورهای واقعی محلی)

| سناریو | نتیجه |
|---|---|
| `mcp test e2e-stdio` (child واقعی node، JSON-RPC روی stdin/stdout) | `✔ Connected. 2 tool(s) registered.` → `stdio_demo_echo`, `stdio_demo_fail` — **exit 0 در ۲۴۸ms** (قبلاً: هرگز خارج نمی‌شد؛ `timeout 60` → exit 124) |
| `mcp test e2e-http` (Streamable HTTP روی 127.0.0.1:8940) | `✔ Connected. 1 tool(s) registered.` → `http_http_echo` — exit 0 در ۳۳۸ms |
| `mcp test e2e-sse` (HTTP+SSE روی 127.0.0.1:8941) | `✔ Connected. 1 tool(s) registered.` → `sse_sse_echo` — exit 0 در ۳۲۲ms |
| `run` با ابزار MCP روی stdio (`MCP:stdio_demo_echo`) | `Outcome: SUCCESS` (exit 0) در ۱.۴s؛ سرور در لاگ خودش ثبت کرد `demo_echo {text:"from-mcp"}`؛ مدل `stdio-echo:from-mcp` را دید؛ رویداد `task:tool-call | Tool "stdio_demo_echo" called by "plan-step-step-1"` |
| `run` با ابزار MCP روی http (`MCP:http_http_echo`) | `Outcome: SUCCESS`؛ خروجی `http-echo:from-mcp` |
| `run` با ابزار MCP روی sse (`MCP:sse_sse_echo`) | `Outcome: SUCCESS`؛ سرور ثبت کرد `sse_echo {text:"from-mcp"}`؛ خروجی `sse-echo:from-mcp` |
| ابزار MCP که `isError: true` برمی‌گرداند | دیگر موفقیت به‌حساب نمی‌آید: `✖ tool failed: stdio_demo_fail — demo_fail always fails` → acceptance رد شد → `Outcome: FAILURE`، exit 1 |
| سرور مرده: DNS نامعتبر (`demo`) | exit 1 در ۱.۲۸s؛ پیام خطا **بدون نشت توکن** (با `DEMO_MCP_TOKEN=supersecret-token-abc`) |
| سرور مرده: پورت بسته (`e2e-dead-http`) | exit 1 در ۱.۲۳s؛ بدون نشت `E2E_DEAD_TOKEN=supersecret-token-xyz` |
| سرور مرده: اسکریپت ناموجود (`e2e-dead-stdio`) | exit 1 در ۰.۲۷s (`Connection closed`) |
| سرور stdio بی‌پاسخ (`e2e-hang-stdio`، هرگز JSON-RPC جواب نمی‌دهد) | exit 1 در **۳.۲۵s** = `connectTimeoutMs: 3000` واقعاً قطع می‌کند (قبلاً exit 124 بعد از ۳۰s) |
| config ناقص: stdio بدون `command` / http بدون `url` | exit 1 با پیام روشن و سریع (۲۱۴ms / ۱۸۵ms): `[mcp:e2e-bad-stdio] stdio transport requires "command" field.` |
| بعد از همه‌ی موارد بالا | `ps` هیچ پروسه‌ی یتیم (stdio child یا سرور تست) نشان نمی‌دهد |

**نکته‌ی صداقتی (محدودیت، نه باگ):** `hootl tools` فقط تعریف‌های استاتیک `registry/tools/*.json` را لیست می‌کند و به سرورهای MCP وصل نمی‌شود؛ پس id ابزارهای MCP را باید از `mcp test <serverId>` یا لاگ اجرا دید. (اتصال به همه‌ی سرورها در یک دستور «list» عمداً انجام نمی‌شود: هر سرور stdio یک child process است.)

**محدودیت دوم:** برای سرور stdio، فیلدهای `auth` (که header می‌سازند) معنایی ندارند؛ child **محیط پدر را ارث می‌برد**، پس credentialها باید یا در محیط شل export شده باشند یا خود سرور از راه دیگری بگیرد. (این رفتار مستند شد؛ افزودن فیلد `env` به schema یک قابلیت جدید است، نه رفع باگ — انجام نشد.)

### باگ‌های پیدا و رفع‌شده (R/S/T/U)

**R — `mcp test <stdio>` هرگز تمام نمی‌شد.** اتصال موفق بود و ابزارها لیست می‌شدند، اما `mcpTestCommand` کانکتور را close نمی‌کرد؛ childِ زنده event loop را باز نگه می‌داشت (هارنس: `timeout 60` → exit 124). رفع: `await connector.closeAll()` در مسیر `finally` (پس شکست هم می‌بندد).

**S — تلاشِ ناموفق، transport را جا می‌گذاشت.** اگر اتصال fail می‌شد یا timeout می‌خورد، `state.client` هرگز ست نمی‌شد، پس هیچ‌کس نمی‌توانست transport را ببندد: child زنده می‌ماند و CLI بعد از چاپ خطا hang می‌کرد (سرور بی‌پاسخ → exit 124 بعد از ۳۰s). رفع: transport همان تلاش در `catch` آزاد می‌شود (`closeTransport`). همان نشت در سرور هم وجود داشت: `POST /api/mcp/:id/test` حالا در `finally` می‌بندد.

**T — مرگ child وسط کار، کل CLI را با unhandled `EPIPE` می‌کشت.** در یک اجرای واقعی، write روی stdin بعد از مرگ child خطای `EPIPE` را به‌شکل **unhandled 'error' event** بالا آورد و پروسه با stack trace crash کرد. رفع: listener خطا روی stdin/stdout + محافظت write. (تست واحد: childی که fd ورودی‌اش را می‌بندد و زنده می‌ماند → `send()` reject می‌شود، پروسه زنده می‌ماند.)

**U — شکست ابزار MCP نامرئی بود.** `@ai-sdk/mcp` نتیجه‌ی `isError: true` را به‌عنوان یک نتیجه‌ی عادی برمی‌گرداند (نه throw)؛ پس نه رویداد خطا ثبت می‌شد و نه acceptance آن را می‌دید — همان کلاس باگ O، این‌بار برای ابزار بیرونی. رفع: `describeToolFailure` حالا `isError: true` (و متن `content`) را به `ToolFailure` تبدیل می‌کند.

### پوشش تست

`src/ai/__tests__/phase30-p6.test.ts` — ۱۰ تست: framing (دو پیام JSON در یک chunk)، close = SIGTERM واقعی (child خودش فایل نشانه می‌نویسد)، refuse-to-send-after-close، زنده‌ماندن روی EPIPE، بسته‌شدن transport در timeout و در خطای ساخت client، ثبت `source: "mcp"` + `closeAll` روی یک child واقعی، و «ابزار MCP با `isError`» در `AgentRuntime` (خطا به `task.errors` و summary می‌رسد).

جهت‌دار (بررسی شد): حذف تشخیص `isError` → ۲ تست fail؛ حذف `closeTransport` → ۲ تست fail؛ حذف `closeAll` از `mcp test` → ۱ تست fail؛ حذف listener خطای stdin → ۱ تست fail.

**هارنس:** سرورهای تست در `/tmp/e2e/mcp-stdio-server.mjs`، `/tmp/e2e/mcp-http-server.mjs`، `/tmp/e2e/mcp-sse-server.mjs` (خارج از ریپو؛ فقط ابزار آزمون).

**وضعیت:** 🟢

---

## P7 — اهداف بزرگ/چندمرحله‌ای و re-planning واقعی 🟢

**چرا Unknown بود:** استاب همیشه یک پلن ۲ مرحله‌ای ساده می‌داد؛ پس مقیاس (زنجیره‌ی واقعی وابستگی‌ها)، شکست واقعی step و مسیر re-planning هیچ‌وقت اجرا نشده بود (پوشش قبلی فقط تست واحد بود).

**چطور راستی‌آزمایی شد:** استاب MARKER جدید `BIG:<n>` (زنجیره‌ی n مرحله‌ای با وابستگی خطی) و `FAILSTEP:<n>` (آن step فایلی را می‌خواند که وجود ندارد ⇒ شکست واقعی ابزار) گرفت؛ سپس سه اجرای واقعی CLI.

**معیار پذیرش:** پلن بزرگ بدون deadlock اجرا شود؛ شکست step منجر به replan یا شکست کنترل‌شده با گزارش درست شود؛ هیچ step بدون دلیل skipped نشود.

**وضعیت:** 🟢 **تأیید شد (۲۰۲۶-۰۹-۲۴)** — دو باگ پیدا و رفع شد (V و W).

### نتیجه‌ی اجرا (CLI واقعی، سرور مدل استاب)

| سناریو | نتیجه |
|---|---|
| پلن زنجیره‌ای ۱۰ مرحله‌ای (`BIG:10`) | `⏵ Plan started (10 steps)` → `✅ Plan completed. 10/10 steps completed.`، `Outcome: SUCCESS`، exit 0، **۴.۴ ثانیه**، ۳۳۰۰ توکن |
| ترتیب وابستگی‌ها (همان اجرا) | ترتیب دقیق و سریال: `step-1 → step-2 → … → step-10`؛ در لاگ هر step فقط بعد از `task:completed` step قبلی `task:created` گرفته (هیچ وابسته‌ای زودتر اجرا نشد) |
| اثر واقعی جانبی در پلن بزرگ | ۳ فایل واقعی نوشته شد (`notes/big-3.txt`, `big-6.txt`, `big-9.txt`) — اجرای ۱۰ مرحله‌ای واقعاً روی دیسک اثر گذاشت |
| شکست step میانی + `--max-replans 2` (`BIG:12 FAILSTEP:5`) | step-5 با `ENOENT … missing-part-5.md` شکست خورد → **`↻ Re-planning attempt 1`** → **`↻ Plan revised — 12 step(s) after re-planning`** → بقیه (۶ تا ۱۲) اجرا و تمام شد → `❌ Plan failed-partial. 11/12 steps completed.`، `Outcome: PARTIAL-SUCCESS`، و در گزارش `⏸ Incomplete Steps (1)` شامل همان step-5 با دلیلش |
| همان شکست بدون بودجه‌ی replan (`--max-replans 0`) | شکست کنترل‌شده: `❌ Plan failed-partial. 4/12 steps completed.` + `⏸ Incomplete Steps (8)` که هفت step «Never started (blocked or cancelled)» را با نام و دلیل لیست می‌کند — هیچ step بی‌صدا skipped نشد |
| بازرسی رکورد پلن روی دیسک (پس از replan) | `status: failed-partial`، **۱۲ step** (step-5 با `status: failed` و `resultSummary` دلیلش باقی می‌ماند)، step-6 با `dependsOn: []` (وابستگی به step شکست‌خورده حذف شده تا deadlock نشود) |
| لاگ JSONL | `plan:replanning` (warn: «Re-planning attempt 1.») و `plan:replanned` (warn: «Plan revised: 12 step(s) — 4 done, 1 abandoned step(s) kept in the plan.») ثبت شد |

### باگ‌های پیدا و رفع‌شده (V/W)

**V — re-planning کاملاً نامرئی بود.** `PlanRuntime` رویداد `plan:replanning-attempt-N` می‌فرستد، ولی `translatePlanEvent` فقط رشته‌ی دقیق `plan:replanning` را می‌شناخت؛ `plan:replanned` هم هیچ‌جا ترجمه یا لاگ نمی‌شد (متد `logPlanReplanning` وجود داشت و هیچ‌وقت صدا زده نمی‌شد). یعنی پلن بازنویسی می‌شد و کاربر نه در ترمینال و نه در لاگ چیزی می‌دید. رفع: ترجمه‌ی هر دو رویداد (`plan:replanning-attempt-*` با شماره‌ی تلاش، و `plan:replanned`) + ثبت `plan:replanning`/`plan:replanned` در observability + خط `↻` در CLI.

**W — step رهاشده بی‌صدا ناپدید می‌شد و پلن «موفق» گزارش می‌شد.** در merge پلن اصلاح‌شده فقط stepهای `done` نگه داشته می‌شدند؛ step شکست‌خورده از پلن حذف می‌شد. نتیجه: پلنی که ۱۲ بخش داشت و بخش ۵ را از دست داده بود، `✅ Plan completed. 11/11 steps completed.` و `Outcome: SUCCESS` می‌داد و هیچ ردی از بخش رهاشده در store/گزارش نمی‌ماند. رفع (در `replan-merge.ts` جدید):
- stepهای **ترمینال** (هم `done` هم `failed`) در پلن می‌مانند؛ دلیل شکست حفظ می‌شود و وضعیت پلن صادقانه `failed-partial` می‌شود؛
- اگر پلنر همان id خطادیده را برای «جایگزین» استفاده کند، جایگزین با id `…~replan<n>` کنار آن ثبت می‌شود (قبلاً کلاً دور ریخته می‌شد) و وابستگان به آن rewire می‌شوند؛
- وابستگی به step شکست‌خورده حذف می‌شود (وضعیتش ترمینال است ولی `done` نیست) تا پلن به deadlock نخورد؛
- `logPlanCompleted` هم وضعیت‌آگاه شد: پلن `failed-partial` دیگر با eventType `plan:completed` لاگ نمی‌شود.

**نکته‌ی صادقانه (تصمیم، نه باگ):** خروجی CLI برای `partial-success` همچنان **۰** است (سیاست مستند «۰ = success/partial، ۱ = fail»). یعنی اتوماسیونی که فقط exit code را می‌بیند، اجرای نیمه‌کاره را موفق تلقی می‌کند؛ برای تشخیص، `Outcome: PARTIAL-SUCCESS` و بخش `⏸ Incomplete Steps` در گزارش و رکورد `failed-partial` روی دیسک قابل اتکا هستند. اگر تصمیم بگیرید، سخت‌گیرانه‌کردن این نگاشت تغییر یک‌خطی + تست است.

### پوشش تست

`src/ai/__tests__/phase30-p7.test.ts` — ۱۰ تست: merge (نگه‌داشتن step رهاشده، حذف وابستگی به step شکست‌خورده، جایگزین با id تکراری، «هرگز کار done را تکرار نکن») + ترجمه‌ی رویدادهای replan + لاگ `plan:replanned` + «failed-partial دیگر `plan:completed` لاگ نمی‌شود».

جهت‌دار (بررسی شد): برگرداندن merge قدیم → ۳ تست fail؛ ترجمه‌ی فقط `plan:replanning` دقیق → ۱ تست fail؛ لاگ‌کردن failed-partial به‌عنوان completed → ۱ تست fail.

**وضعیت:** 🟢

---

## P8 — ماتریس محیط (macOS/Windows/WSL، Node>22، CI بدون TTY) ⬜

**چرا Unknown:** همه‌ی آزمون‌ها روی Linux + Node 22 + PTY. رفتار روی Node 24، macOS (BSD tools/`sed`)، Windows/Git-Bash (مسیرها، `chmod`، symlink)، و اجرای CI بدون TTY (که fail-fast دارد) تأیید نشده.

**چطور راستی‌آزمایی می‌شود:** اجرای suite + سناریوهای کلیدی روی Node 22/24 و یک محیط غیر-Linux (اگر در دسترس باشد)؛ اجرای بدون TTY (`| cat`، CI) برای هر دستور.

**معیار پذیرش:** `tsc` + suite سبز روی نسخه‌های Node؛ دستورهای کلیدی بدون TTY پیام درست بدهند (نه hang)؛ مسیرها/پرمیشن‌ها روی سیستم غیر-Linux نشکنند.

**وضعیت:** ⬜

---

## P9 — UI/سرور پس از تغییرات فاز ۲۹ ⬜

**چرا Unknown:** آخرین smoke UI مربوط به فاز ۲۸ بود؛ پس از تغییرات runtime (abort/redaction/cancel/toolIds) جریان UI دوباره آزموده نشده.

**چطور راستی‌آزمایی می‌شود:** جریان کامل UI: preview → approve → progress (SSE) → usage/tasks؛ به‌همراه یک cancel از UI.

**معیار پذیرش:** همه‌ی مراحل با پاسخ درست و بدون خطای ۵۰۰؛ رخدادهای SSE کامل؛ شمارش توکن در UI مطابق `hootl usage`.

**وضعیت:** ⬜

---

## P10 — محتوای خصمانه (prompt-injection، فرار از sandbox، نشت credential) ⬜

**چرا Unknown:** بازبینی‌های SEC (فاز ۲۰) انجام شد، ولی سناریوی واقعی آزموده نشده: فایلی در پروژه که به مدل دستور می‌دهد sandbox را دور بزند یا credential را چاپ کند.

**چطور راستی‌آزمایی می‌شود:** فایل‌های تله در پروژه + ابزار خواندن آن‌ها توسط agent + تلاش‌های مسیر خصمانه (symlink به `/etc/passwd`، مسیر مطلق، `..` تکراری، نام‌های طولانی/یونیکد) + بار واقعی روی لاگ برای دیدن نشت.

**معیار پذیرش:** هیچ نوشتن/خواندن بیرون از root؛ هیچ credential در لاگ/خروجی؛ خطاها بدون افشای محتوای حساس؛ ابزارهای مسیر با ورودی خصمانه کرش نکنند.

**وضعیت:** ⬜

---

## Execution Log

| تاریخ | مورد | اقدام | نتیجه |
|---|---|---|---|
| 2026-09-24 | — | ساخت این فایل، اولویت‌بندی، ثبت ۱۰ مورد تأییدنشده | آماده‌ی اجرا؛ شروع از P2 طبق درخواست کاربر |
| 2026-09-24 | **P2** | crash واقعی با `kill -9` (وسط اجرا، وسط planning، پلن draft) + `plans resume` | 🟢 تأیید شد؛ باگ N (سشن `pending` ابدی + نبود link) پیدا و رفع شد؛ ۵ تست جدید `phase30.test.ts` |
| 2026-09-24 | **P3** | اجرای واقعی `write_file`/`search_code`/`git_status` + سه تلاش فرار از sandbox (`..`، مسیر مطلق، غیر-ریپو) | 🟢 تأیید شد؛ باگ O (شکست ابزار کاملاً نامرئی → SUCCESS کاذب) پیدا و رفع شد؛ ۹ تست جدید `phase30-p3.test.ts` |
| 2026-09-24 | **P2** (پیگیری) | علت «taskِ ابدی running» پس از crash + resume | 🟢 رفع شد؛ رویداد `task:interrupted` + وضعیت `interrupted` در `tasks list`؛ ۱ تست جدید (نسخه ۲۷.۲.۳) |
| 2026-09-24 | **P4** | ۲ و ۴ اجرای هم‌زمان روی یک پروژه + crash وسط هم‌زمانی + رقابت روی یک فایل | 🟢 تأیید شد بدون تغییر کد؛ صفر فایل خراب/overwrite، لاگ سالم، `usage`/`tasks` درست |
| 2026-09-24 | **P5** | مدل کند + `--timeout-ms`، حلقه‌ی ابزار + `--max-steps`، planner بی‌پاسخ، Ctrl-C | 🟢 تأیید شد؛ باگ Q (انتظار بی‌کران: درخواست رهاشده + نبود مهلت در فراخوانی‌های ساختاریافته) رفع شد؛ ۵ تست جدید (نسخه ۲۷.۲.۴) |
| 2026-09-24 | **P6** | سرورهای واقعی MCP: stdio (child محلی)، http، sse + ابزار MCP در run + سرورهای مرده/بی‌پاسخ + redaction | 🟢 تأیید شد؛ stdio از صفر ساخته شد و ۴ باگ رفع شد: R (hang بی‌پایان `mcp test`)، S (نشت child در اتصال ناموفق)، T (crash با unhandled EPIPE)، U (شکست `isError` نامرئی)؛ ۱۰ تست جدید (نسخه ۲۷.۲.۵) |
| 2026-09-24 | **P7** | پلن زنجیره‌ای ۱۰/۱۲ مرحله‌ای + شکست step میانی + `--max-replans 2`/`0` | 🟢 تأیید شد؛ ۲ باگ رفع شد: V (re-planning نامرئی در ترمینال و لاگ)، W (step رهاشده بی‌صدا ناپدید می‌شد و پلن SUCCESS کاذب می‌داد)؛ ۱۰ تست جدید (نسخه ۲۷.۲.۶) |
