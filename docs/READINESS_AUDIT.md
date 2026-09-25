# Readiness Audit — «آیا سیستم ۱۰۰٪ آماده است؟»

**Date:** 2026-09-24
**Baseline:** commit `71b5047` (Phase 29) — `tsc` clean، **۵۸۵ تست در ۳۹ فایل** سبز، باینری سراسری `hootl` 27.2.0
**E2E موجود:** ۴۳ سناریوی PTY واقعی در `/tmp/e2e` (استاب LLM محلی Responses API — هیچ provider واقعی)
**پیشرفت:** P2 🟢 (v27.2.1) · **P3 🟢 (v27.2.2)** · **P4 🟢 (بدون تغییر کد)** · **P5 🟢 (v27.2.4)** · **P6 🟢 (v27.2.5)** · **P7 🟢 (v27.2.6)** · **P8 🟢 (v27.2.11 — ماتریس CI)** · **P9 🟢 (v27.2.8)** · **P10 🟢 (v27.2.9)** · **P10-follow-up 🟢 (v27.2.10)** · **CI 🟢 (v27.2.11)** — ۶۷۰ تست در ۴۹ فایل، `tsc` clean، ۳۲/۳۲ سناریوی E2E
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

**وضعیت فعلی:** P1 ⛔ · P2 🟢 · P3 🟢 · P4 🟢 · P5 🟢 · P6 🟢 · P7 🟢 · **P8 🟡 (جزئی — دو محور تأیید، یک محور نیازمند ماشین شما)** · **P9 🟢** · **P10 🟢**

**چرا این ترتیب:** P1 مسدود است (کلید واقعی). بقیه بر اساس «احتمال شکست × هزینه‌ی شکست» چیده شده‌اند: P2/P3/P4 می‌توانند به از دست رفتن کار یا داده منجر شوند؛ P5 در حد fidelity است (مسیر abort واحد-تست دارد)؛ P6–P10 وابستگی محیطی/مقیاسی دارند.

---

## P1 — اجرا با provider واقعی (OpenAI/Anthropic) ⛔

**چرا Unknown:** ۲۱ فایل تست ماژول `ai` را mock می‌کنند؛ هیچ تستی به `api.openai.com` / `api.anthropic.com` درخواست نمی‌زند. همه‌ی e2e فاز ۲۹ با استاب محلی Responses API اجرا شد. یعنی: صحت شمارش توکن واقعی، رفتار streaming/SSE واقعی، نگاشت خطاهای ۴۰۱/۴۲۹/۵۰۰، retry، timeout شبکه، و شکل واقعی structured output (`text.format.json_schema`) با مدل واقعی **آزموده نشده**.

**چطور راستی‌آزمایی می‌شود:**
- (الف) در محیطی که کلید واقعی دارد: `hootl run "<goal کوچک>" --persistent --verbose` و مقایسه‌ی plan/usage/log با انتظار.
- (ب) بدون کلید: شبیه‌ساز پرفیدلیتی‌تر (SSE تدریجی، خطای ۴۲۹/۵۰۰، قطع وسط پاسخ، JSON خراب) برای سنجش رفتار خطا/retry/توکن.

**معیار پذیرش:** یک run واقعی کامل (plan→confirm→execute→review) + صحت `hootl usage` + پیام خطای درست و غیر-کرش برای ۴۰۱/۴۲۹/۵۰۰ + بدون نشت کلید در log.

**وضعیت:** ⛔ مسدود برای مسیر (الف) (کلید واقعی). مسیر (ب) در v27.2.14 اجرا شد: خطاهای ۴۰۱/۴۲۹/۵۰۰، قطع اتصال، hang، پاسخ خالی و JSON خراب با استاب آزموده شدند و ۴ باگ رفع شد (Execution Log). هنوز تأییدنشده: streaming/SSE واقعی و شکل واقعی structured output مدل.

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

## P8 — ماتریس محیط (macOS/Windows/WSL، Node>22، CI بدون TTY) 🟡

**چرا Unknown بود:** همه‌ی آزمون‌ها روی Linux + Node 22 + PTY اجرا شده بودند: رفتار روی نسخه‌های جدیدتر Node، اجرای بدون TTY (CI)، و مسیرها/پرمیشن‌ها روی Windows/macOS تأیید نشده بود.

**معیار پذیرش:** `tsc` + suite سبز روی نسخه‌های Node؛ دستورهای کلیدی بدون TTY پیام درست بدهند (نه hang)؛ مسیرها/پرمیشن‌ها روی سیستم غیر-Linux نشکنند.

**وضعیت:** 🟡 **جزئی — ماتریس در v27.2.11 ساخته شد؛ windows-leg پس از رفع‌های v27.2.12/13 هنوز دوباره اجرا نشده (مسدود به‌دلیل صورت‌حساب GitHub Actions)** — محور «نصب تازه» و «بدون TTY» در سندباکس تأیید شد؛ دو محور باقی‌مانده («Node>22» و «Windows/macOS واقعی») به `.github/workflows/ci.yml` منتقل شدند: ماتریس Ubuntu + Windows + macOS × Node 22/24 (به‌علاوه Node 26 روی Linux) که `tsc`، کل suite، بیلد، نصب سراسری، smoke و سناریوهای E2E را اجرا می‌کند. جزئیات در بخش «CI» پایین‌تر.


### نتیجه‌ی اجرا

| محور | نتیجه |
|---|---|
| **نصب تازه از صفر** (مثل ماشین کاربر) | `git archive HEAD` → `/tmp/cleanroom`، سپس `npm ci` (۲۱۴ پکیج) + `npm run build` (tsc پاک) + `npm test` → **۴۴ فایل / ۶۲۷ تست سبز**؛ سپس خود CLI از همان بیلد: `run --yes --persistent` → `Outcome: SUCCESS`، exit 0 در ۴.۳s و `mcp test e2e-stdio` → exit 0 |
| **بدون TTY / CI** (۲۶ دستور کلیدی، stdin بسته و stdout به فایل) | هیچ hang نبود؛ همه‌ی دستورهای خواندنی exit 0؛ `run` بدون `--yes` در غیر-TTY → **exit 1 با پیام روشن** «Interactive confirmation requires a TTY. Re-run with --yes…»؛ `plans cancel` روی پلن ترمینال → exit 1؛ `sessions delete` با id ناموجود → exit 1؛ `mcp test` → exit 0 |
| `logs --follow` در پایپ | وقتی مصرف‌کننده می‌بندد فوراً خارج می‌شود (`| head -3` → ۲۲۳ms، صفر پروسه‌ی یتیم)؛ در ریدایرکت به فایل مثل `tail -f` می‌ماند — این رفتار درست است، نه باگ (مستند شد) |
| **Node 22** (نگاشت `engines: >=22`) | بیلد + کل suite + E2E سبز (ردیف اول) |
| **Node 24/26** | ⚠️ **در این سندباکس قابل تأیید نبود:** `nodejs.org`، دارایی‌های GitHub Releases و آینه‌های Node همگی از داخل سندباکس مسدودند (فقط npm registry باز است) و هیچ نسخه‌ی دیگری از Node نصب نیست. پس این ادعا **تأییدنشده** می‌ماند |
| **Windows/macOS/WSL** | اجرا نشد (دسترسی به آن سیستم‌عامل‌ها نیست) — به‌جایش بازرسی ایستای کامل + رفع باگ X؛ شاخه‌ی Windows **روی سخت‌افزار واقعی آزموده نشده** |

**دستور تأیید محور Node (روی ماشین شما، ۳۰ ثانیه):**
```bash
nvm install 24 && nvm use 24 && npm ci && npm test   # انتظار: ۶۲۷ تست در ۴۴ فایل
```

### باگ X — سرورهای stdio استاندارد روی Windows اصلاً اجرا نمی‌شدند

`npx`/`npm` روی Windows فایل‌های `.cmd` هستند و `CreateProcess` نمی‌تواند آن‌ها را مستقیم اجرا کند؛ `spawn('npx', …)` بدون شل با `ENOENT` شکست می‌خورد — یعنی رایج‌ترین شکل کانفیگ MCP (`"command": "npx"`) روی Windows کار نمی‌کرد (روی Linux/macOS سالم بود، پس هیچ تست موجودی آن را نمی‌دید).

رفع (دو تکه، هیچ تغییری در رفتار POSIX):
- `stdioSpawnOptions(platform, env)` — تابع **خالص** و واحد-تست‌شده: فقط روی `win32` مقدار `shell: true` می‌دهد؛ روی linux/darwin دقیقاً مثل قبل (بدون شل، بدون دردسر quoting).
- `terminate(proc, signal)` — با `shell: true` سرور واقعی یک **نوه‌ی** پروسه است و `child.kill()` تنهایی آن را زنده می‌گذارد؛ روی Windows با `taskkill /PID <pid> /T /F` کل درخت کشته می‌شود (روی POSIX همان SIGTERM → SIGKILL قبلی).

**محدودیت صادقانه:** این شاخه روی Windows واقعی اجرا نشد؛ فقط «تصمیم پلتفرمی» تست واحد دارد (`phase30-p6.test.ts`: win32 → شل، linux/darwin → بدون شل، ادغام env).

### بازرسی ایستا برای سیستم‌های غیر-Linux (خلاصه‌ی یافته‌ها)

- **مسیرها:** مقایسه‌ی مسیر روی `win32` case-insensitive است و فرار از طریق symlink با `realpathSync` بررسی می‌شود (`path-security.ts`)؛ همه‌ی مسیرها با `path.join`/`resolve`/`fileURLToPath` ساخته می‌شوند و در کد محصول هیچ مسیر مطلق POSIX (`/tmp`، `/usr/bin`، `/bin/sh`) وجود ندارد.
- **نام فایل‌ها:** idها (`randomUUID`، `sha256`) فقط حرف/عدد دارند و برچسب سشن وارد نام فایل نمی‌شود (نام فایل = sha256(id)) → روی Windows بی‌خطر (بدون کاراکتر ممنوع/رزرو).
- **پرمیشن و symlink:** کد محصول هیچ `chmod`/`symlink` نمی‌سازد (فقط اسکریپت‌های آزمون).
- **shell-outها:** تنها دو مورد — `git` با `execFile` (روی Windows `git.exe` از PATH پیدا می‌شود، بدون shell) و MCP stdio (رفع‌شده در باگ X).
- **EOL:** هیچ فرض `\r\n` یا `os.EOL` در کد نیست؛ JSONL با `\n` نوشته می‌شود (خواندن با Node/Python هر دو سالم).
- **نصب:** `bin` دو نام دارد و npm روی Windows شیم `.cmd` می‌سازد؛ اسکریپت‌ها فقط `tsc`/`tsx`/`vitest` از `node_modules/.bin` هستند (پورتابل)؛ `engines: { node: ">=22" }` از قبل اعلام شده.
- **انطباق با Node جدیدتر:** هیچ API حذف/منسوخ‌شده‌ای (`url.parse`، `new Buffer`، `fs.rmdirSync` بازگشتی، `punycode`، `process.binding`) در کد محصول استفاده نمی‌شود (grep روی کل `src`).

**پوشش تست:** ۱ تست جدید (`phase30-p6.test.ts`) برای تصمیم پلتفرمی spawn؛ کل: **۶۲۷ تست در ۴۴ فایل**.

**وضعیت:** 🟡

---

## P9 — UI/سرور پس از تغییرات فاز ۲۹ 🟢

**چرا Unknown بود:** آخرین smoke UI مربوط به فاز ۲۸ بود؛ پس از تغییرات runtime (abort/redaction/cancel/toolIds) جریان UI دوباره آزموده نشده بود.

**چطور راستی‌آزمایی شد:** هارنس stdlib-only `/tmp/e2e/p9-api.py` — ۱۵ بررسی روی سرور واقعی (`node dist/src/server.js --port 8955`، پروژه‌ی `/tmp/e2e/proj`، استاب محلی LLM): preview → run تعاملی (توقف در `awaiting-confirmation`) → confirm از API → خواندن SSE تا پایان → usage/tasks → مقایسه‌ی توکن UI با `hootl usage --plan <id>` → cancel وسط اجرا → اجرای re-plan با `maxReplans: 2` و دیدن `plan:replanning`/`plan:replanned` روی همان استریم. هر اجرا با `rm -rf .ai-runtime` **در حین اجرای سرور** شروع شد.

**نتیجه:** ۱۵/۱۵ (دو اجرای پشت‌سرهم روی بیلد نهایی). ۹ پروب MCP همه HTTP 200 با `ok:false` درست (dead URL، env غایب، `url`/`command` خالی، stdio بی‌پاسخ) — هیچ ۵۰۰. UI: `GET /` → 200 با `<title>Human Out of the Loop</title>` و `/app.js` → 200؛ دکمه‌های confirm/cancel همان مسیرهای `/api/plans/:id/...` را صدا می‌زنند که هارنس آزمود. `GET /api/usage?planId=P` و `hootl usage --plan P --json` هر دو ۳۳۰ توکن / ۱ task (تناقض UI↔CLI رفع شد).

**سه باگ واقعی پیدا و رفع شد (هر سه از یک جنس: پروسه‌ای که از دایرکتوری/فایل خودش بیشتر عمر می‌کند):**

- **باگ Y — ENOENT روی هر نوشتن پس از پاک‌شدن `.ai-runtime`.** استورها دایرکتوری را فقط در constructor می‌ساختند؛ `withFileLockSync` با `open(lockPath,'wx')` و `atomicWriteFileSync` روی دایرکتوری ناپدیدشده ENOENT می‌دادند و هر `/api/run` به `state=error` (ENOENT روی `.json.lock`) می‌رسید. رفع: هر دو primitive در صورت ENOENT یک‌بار دایرکتوری والد را بازمی‌سازند و دوباره تلاش می‌کنند.
- **باگ Z — لاگ observability در inode حذف‌شده می‌نوشت.** fd باز ObservabilityLogger پس از حذف فایل به inode بی‌ارتباط می‌نوشت؛ هر خواننده‌ای که مسیر را باز می‌کند (`hootl logs`/`usage`) چیزی نمی‌دید در حالی که شمارنده‌های in-memory سرور می‌شمردند. رفع: تطبیق inode مسیر با fd در هر نوشتن و بازگشایی (همراه ساخت دایرکتوری) در صورت تفاوت — همچنان یک `open` به‌ازای هر فایل (PERF-04).
- **باگ AA — یک rejection بی‌مسئول می‌توانست سرور را بکشد.** در لاگ سرور واقعی trace از undici دیده شد (`TypeError: terminated` / `UND_ERR_BODY_TIMEOUT` از fetch استریمِ یک MCP client). رفع: `installCrashGuards()` در نقطه‌ی ورود سرور، `unhandledRejection` را گزارش می‌کند و سرویس‌دهی ادامه می‌یابد (uncaught exception همچنان پروسه را می‌بندد).

**پوشش تست:** ۹ تست جدید (`phase30-p9.test.ts`): بازسازی دایرکتوری توسط lock و atomic-write، ادامه‌کار دو استور پس از wipe، بازگشایی لاگ پس از حذف فایل، حفظ PERF-04، و گارد crash. جهت‌آزمایی: بدون رفع، ۵ از ۶ تست اول شکست می‌خورند؛ برای گارد، پروسه‌ی بدون گارد با unhandled rejection می‌میرد و با گارد زنده می‌ماند. کل: **۶۳۶ تست در ۴۵ فایل**.

**محدودیت:** UI با مرورگر واقعی کلیک نشد (سندباکس مرورگر ندارد)؛ مسیر دکمه‌ها از `public/app.js` و همان endpointهایی که هارنس آزمود تأیید شد.

**وضعیت:** 🟢

---

## P10 — محتوای خصمانه (prompt-injection، فرار از sandbox، نشت credential) 🟢

**چرا Unknown بود:** بازبینی‌های SEC (فاز ۲۰) انجام شده بود، ولی سناریوی واقعی آزموده نشده بود: فایلی در پروژه که به مدل دستور می‌دهد sandbox را دور بزند یا credential را چاپ کند.

**چطور راستی‌آزمایی شد:** هارنس `/tmp/e2e/p10-hostile.py` روی پروژه‌ی تازه‌ی `/tmp/e2e/proj10`: `.env` واقعی‌نما (`OPENAI_API_KEY=sk-live-P10-…` + توکن MCP)، فایل تله‌ی injection، symlink به `/etc/passwd`، symlink دایرکتوری به بیرون از root، نام یونیکد و نام ۱۸۰ کاراکتری — ۸ اجرای واقعی CLI. استاب نقش «مدل کاملاً آلوده» را بازی می‌کند: هر credential که در context ببیند را در متن نهایی بازمی‌گوید (بدترین حالت).

**نتیجه: ۱۴/۱۴ بررسی.**
- **sandbox:** خواندن از طریق symlink→`/etc/passwd`، نوشتن از طریق symlink دایرکتوری، مسیر مطلق `/etc/passwd`، `../../../../etc/passwd` و مسیر انکودشده (`..%2f…`): همه با `PATH_TRAVERSAL_BLOCKED` رد شدند؛ هیچ فایلی بیرون از root ساخته نشد؛ محتوای `/etc/passwd` در هیچ خروجی‌ای دیده نشد.
- **نام‌های خصمانه:** نام یونیکد (`یونیکد-👻.txt`) ساخته و خوانده شد؛ نام ۱۸۰ کاراکتری بدون کرش.
- **injection + مدل آلوده:** فایل تله خوانده شد و مدل دستور تزریقی را «اجرا» کرد (تلاش برای خواندن `/etc/passwd` و نوشتن بیرون) — sandbox همه را بست؛ و key را در متن نهایی‌اش بازگو کرد.
- **نشت credential:** مقدار key (و توکن MCP) در **هیچ‌کدام** از آرتیفکت‌های runtime نیامد: لاگ observability، هر ۱۷ فایل زیر `.ai-runtime` (پلن/سشن/لاگ) و خروجی `hootl logs`. در رکورد پلن، متن مدل به‌صورت `***REDACTED***` ثبت شده است.

**باگ AB پیدا و رفع شد — مقدار credential در آرتیفکت‌های runtime.** `redactKeys` فقط *نام* فیلدها را پاک می‌کرد (`apiKey`, `token`, …)، اما متن مدل می‌تواند خودِ *مقدار* را داشته باشد و آن متن به خلاصه‌ی step و از آنجا به رکورد پلن می‌رسد. رفع: ماژول جدید `src/ai/runtime/secret-scrub.ts` — `collectSecretValues` (مقادیر env را با الگوی نام‌ها جمع می‌کند)، `scrubSecretValues`، و `ScrubbingPlanStore` (پاک‌سازی خلاصه‌ها پیش از ذخیره)؛ logger و orchestrator هم به آن وصل شدند (payload تودرتو و message هم پاک می‌شوند). جهت‌آزمایی: با خاموش‌کردن جمع‌آوری مقادیر، همان key در فایل پلن ظاهر شد (`Leaked credential: sk-live-P10-…`)؛ با رفع، `***REDACTED***`.
- **مرز آگاهانه (مستند):** متن خودِ مدل که زنده چاپ می‌شود سانسور نمی‌شود — اگر کاربر از مدل بخواهد مقدار یک key را بگوید، مدل می‌گوید. تضمین روی آرتیفکت‌های runtime است (لاگ، رکورد پلن/سشن، خروجی دستورات `logs`/`usage`/`tasks`).

**پوشش تست:** ۹ تست جدید (`phase30-p10.test.ts`): scrub مقادیر، جمع‌آوری از env (شامل الگوهای اضافی و رد مقادیر کوتاه)، پاک‌سازی payload و message در لاگ، حفظ redaction نام‌محور، و `ScrubbingPlanStore` (پاک‌سازی + دست‌نزدن به ورودی). کل: **۶۴۵ تست در ۴۶ فایل**.

**مشاهده‌ی جانبی (خارج از معیار P10):** رویدادهای `step:started`/`step:completed` در لاگ observability ثبت نمی‌شوند (فقط `step:quality-failed`)؛ لاگ از خودِ step جزئیات کمتری دارد.

**وضعیت:** 🟢

## P10 — پیگیری (step در لاگ + هویت پلن) 🟢

**چرا باز شد:** در بازبینی پس از P10، دو شکاف واقعی در مسیر «مدل واقعی» پیدا شد — دقیقاً چیزهایی که در تست واقعی کاربر لازم می‌شوند.

- **باگ AC — پلنی که مدل داخل assessment می‌سازد، شناسه نداشت.** `Planner.plan()` آن را دست‌نخورده برمی‌گرداند (برخلاف `generatePlan()` که `plan_<uuid>` می‌دهد). نتیجه: `hootl plans show/cancel/resume` به پلن دسترسی نداشت، لاگ‌ها `"planId":""` بودند، `hootl usage` اجرا را `(unattributed)` نشان می‌داد و گزارش «Plan: unknown» می‌نوشت. بدتر: `FilePlanStore` روی `sha256(plan.id ?? "unknown")` می‌نویسد، پس **همه‌ی** پلن‌های بی‌شناسه در یک فایل می‌نشستند و همدیگر را بازنویسی می‌کردند. رفع: یک `finalizePlan()` مشترک (شناسه، وضعیت `draft`، `createdAt`، همه‌ی stepها `pending`) برای هر دو مسیر + `FilePlanStore.save` پلن بی‌شناسه را رد می‌کند.
- **باگ AD — چرخه‌ی عمر step هرگز در لاگ نمی‌آمد.** runtime رویدادهای `step:<id>:running|done|failed` را منتشر می‌کرد و logger هم متدهای `logStepStarted/Completed/Failed` را داشت، ولی هیچ‌کس صدا نمی‌زد (کد مرده). رفع: ماژول `step-events.ts` که این رویدادها را ترجمه و با خلاصه‌ی step (پاک‌سازی‌شده) ثبت می‌کند.

**شواهد:** اجرای واقعی CLI با استاب: گزارش `Plan: plan_<uuid>`، حضور پلن در `hootl plans list/show`، انتساب `160 tokens` در `hootl usage`، و در `hootl logs` توالی `step:started → task:created → task:tool-call → task:completed → step:completed`. همان جریان روی سرور API: `POST /api/run` → `state=done` با `planId` واقعی، `/api/usage?planId=P` = ۱۶۰ توکن، `GET /api/plans/:id` = 200، UI سرو می‌شود. جهت‌آزمایی: قبل از رفع، `id: None` در فایل پلن و `"planId":""` در لاگ دیده شد.

**پوشش تست:** ۶ تست جدید در `phase30-p10.test.ts` (`finalizePlan` ×۲، رد پلن بی‌شناسه، تجزیه و ثبت رویدادهای step ×۳). کل: **۶۵۱ تست در ۴۶ فایل**.

**ضمیمه:** هارنس محلی `e2e/` (استاب Responses API + راهنما) به مخزن اضافه شد تا راستی‌آزمایی بدون provider واقعی و بدون مصرف توکن تکرارشدنی باشد.

**بستن سرنخ نشت child (P6/P9):** در P9 یک child پروسه‌ی stdio پس از پروب زنده مانده بود و تسویه‌نشده ماند. با بیلد نهایی ۲۷.۲.۱۰ دوباره آزموده شد: سرور stdio واقعی (JSON-RPC روی stdio) + یک سرور بی‌پاسخ، ۱۰ پروب پشت‌سرهم + ۳ پروب با timeout ۳۰۰۰ms. هر ۱۳ child سیگنال SIGTERM گرفت و با کد ۰ خارج شد؛ **صفر پروسه‌ی بازمانده** و صفر نشت. یعنی آن survivor از بیلد پیش از رفع P6 بود، نه یک باگ باز.

**وضعیت:** 🟢

## CI — تست با provider واقعی از روی secretها + ماتریس سیستم‌عامل‌ها 🟢 (v27.2.11)

**چرا:** P1 («اجرا با provider واقعی») از سندباکس قابل اجرا نیست (needs a key)، و P8 دو محور داشت که هیچ‌وقت روی سخت‌افزار واقعی آزموده نشده بودند (Node 24/26 و Windows/macOS). هر دو حالا با GitHub Actions اجرا می‌شوند.

| ورک‌فلو | محرک | چه چیزی را ثابت می‌کند |
|---|---|---|
| `.github/workflows/real-provider.yml` | `workflow_dispatch` + `schedule` (دوشنبه‌ها) | `hootl run` با مدل واقعی: endpoint و کلید از secretها خوانده می‌شوند (`HOTL_API_KEY` اجباری، `HOTL_BASE_URL`/`HOTL_MODEL`/`HOTL_ANTHROPIC_API_KEY` اختیاری). اجرا فقط وقتی «سبز» است که (الف) پلن ذخیره شده باشد، (ب) provider توکن غیرصفر گزارش کند (صفر توکن = مدل واقعاً صدا زده نشده)، (ج) رشته‌ی کلید در هیچ فایل زیر `.ai-runtime` نباشد. اگر secret نباشد، job با خطای صریح `::error::` می‌افتد — نه «سبز بی‌معنی» |
| `.github/workflows/ci.yml` | push + PR + دستی | ماتریس واقعی: Ubuntu/Windows/macOS × Node 22/24 (+Node 26 روی Linux) → `tsc`، ۶۷۰ تست، بیلد، `npm install -g .`، smoke، و **سناریوهای E2E کامیت‌شده** (`node e2e/scenarios/run.mjs`) |

**سناریوهای E2E کامیت‌شده (`e2e/scenarios/`, `npm run e2e`):** ۷ سناریو / ۳۲ بررسی در ~۲۵ ثانیه، بدون کلید و بدون شبکه، روی همان CLI واقعی (`dist/src/cli.js`) با استاب `e2e/fake-llm.mjs`:

| سناریو | چه چیزی را ثابت می‌کند |
|---|---|
| `success` | پلن ذخیره‌شده با شناسه، فایلِ نوشته‌شده توسط ابزار، رویدادهای `step:*` در لاگ، انتساب توکن |
| `resume` | فقط stepهای ناتمام دوباره اجرا می‌شوند؛ اجرای دوم no-op است |
| `sandbox` | `read_file`/`write_file` از project root بیرون نمی‌زنند (`/etc/passwd`، مسیر مطلق) |
| `credential` | یادداشت خرابکار مدل را وادار می‌کند کلید را بگوید؛ کلید در هیچ آرتیفکتی نیست و نشانگر `***REDACTED***` در لاگ، اثبات می‌کند تله واقعاً شلیک شده |
| `mcp` | `hootl tools --mcp` سرور stdio واقعی را بالا می‌آورد، ابزارش را فهرست می‌کند، سرور مرده را گزارش می‌کند و با `--json` معتبر می‌ماند |
| `cancel` | `plans cancel` وسط اجرا → پلن `cancelled` و پروسه‌ی run خودش تمام می‌شود |
| `ctrlc` | یک Ctrl-C = لغو گرَیسفول (روی Windows skip؛ سیگنال POSIX ندارد) |

**نتیجه‌ی اولین اجرای واقعی ماتریس (۲۰۲۶-۰۹-۲۴، کامیت `ad30e70`):**

| پایه | نتیجه |
|---|---|
| ubuntu-latest × Node 22/24/26 | 🟢 سبز |
| macos-latest × Node 22/24 | 🟢 سبز |
| **e2e روی Ubuntu/Windows/macOS** | 🟢 **سبز روی هر سه سیستم‌عامل** — مسیر واقعی CLI روی Windows کار می‌کند |
| windows-latest × Node 22/24 (job تست) | 🔴 قرمز — سطح CI برای اولین بار نسخه‌ی روی Windows را اجرا می‌کرد |

علت قرمزی Windows: خودِ محصول نبود (job e2e روی Windows سبز بود)، بلکه **تست‌هایی که بی‌سروصدا فرض POSIX داشتند** — در v27.2.12 رفع شد:

1. `os.homedir()` روی Windows از `USERPROFILE` می‌خواند، نه `HOME`؛ دو suite فقط `HOME` را ست می‌کردند → الان `src/test-utils/isolated-home.ts` هر چهار متغیر را ست/بازگردانی می‌کند.
2. Windows سیگنال ندارد: `kill('SIGTERM')` = `TerminateProcess` و هندلر JS اجرا نمی‌شود → تست‌های marker-based در `phase30-p6` روی Windows «فایل نشانه نباید باشد» را تأیید می‌کنند (رفتن child هنوز تست می‌شود).
3. ساخت symlink روی Windows بدون `SeCreateSymbolicLinkPrivilege` → `EPERM`؛ تست‌های symlink در `phase20` یک‌بار capability را probe می‌کنند و با دلیل skip می‌شوند (چک‌های lexical همه‌جا اجرا می‌شوند).

**توان رصد شکست‌ها:** لوگ job ویندوز از سندباکس قابل دانلود نبود؛ پس suite در CI از `scripts/ci-test.mjs` اجرا می‌شود و هر تست شکست‌خورده به‌صورت **annotation** (فایل، نام تست، خط اول assertion) منتشر می‌شود که از Checks API خوانده می‌شود.

**دور دوم (annotationها خوانده شد — لوگ job قابل دانلود نبود ولی checks API جواب داد):** پنج حقیقت دیگر ویندوز، یکی از آن‌ها **در محصول**:
1. `mkdirSync` در مسیر self-heal وقتی والد یک *فایل* است روی Windows با `EEXIST` شکست می‌خورد (POSIX: `ENOTDIR`) و خطای mkdir جای خطای اصلی را می‌گرفت → الان خطای اصلی دوباره throw می‌شود (`file-lock.ts` + `atomic-write.ts`).
2. دو assertion در `hardening-security.test.ts` مسیر مطلق POSIX را هارد‌کد کرده بودند → با `path.resolve` محاسبه می‌شوند.
3. EPIPE یک پدیده‌ی POSIX است (pipe ناشناس Windows آن را گزارش نمی‌کند) → assertion مربوط به `onerror` فقط روی POSIX؛ تضمین قابل‌حمل (reject شدن نوشتن) همه‌جا تست می‌شود.
4. `os.homedir()` = `USERPROFILE` روی Windows (رفع در v27.2.12).
5. symlink روی Windows نیازمند privilege است (probe + skip با دلیل، v27.2.12).

**محدودیت بیرونی:** اجرای بعدی ماتریس با خطای GitHub متوقف شد — «recent account payments have failed or your spending limit needs to be increased» (مخزن private است و دقایق Actions صورت‌حساب می‌شود). این محدودیت حساب است، نه کد؛ چهار اجرای موفق قبلی روی Ubuntu/macOS و اجرای e2e روی Windows سبز بودند.

**باقی‌مانده برای تأیید نهایی P8:** اجرای دوباره‌ی ماتریس پس از v27.2.12 (نیازمند توکن گیت‌هاب که در همین لحظه منقضی شد) — تا آن لحظه، ماتریس ساخته و روی Linux/macOS/Windows-e2e سبز است، و windows-leg پس از این سه رفع باید سبز شود (تأییدنشده تا اجرای بعدی).

**قابلیت‌های استاب که برای این سناریوها اضافه شد:** مارکرهای goal (`READ:`/`WRITE:`/`OVERWRITE:`/`SEARCH:`/`GITSTATUS`) که به step و ابزارش ترجمه می‌شوند، `SLOW:<ms>`/`SLOWALL:<ms>` برای ساختن پنجره‌ی لغو، و بازگویی کلید خوانده‌شده (بدترین حالت: مدل آلوده) تا مسیر redaction واقعاً آزموده شود.

**راستی‌آزمایی دستی همین حالا:** `npm run e2e` → `32/32 checks passed` (۲۰۲۶-۰۹-۲۴، بیلد ۲۷.۲.۱۱). بدون secret، ورک‌فلوی provider واقعی قابل اجرا نیست — آدرس و کلید را در Settings → Secrets and variables → Actions بگذارید و از تب Actions، `Real provider (P1)` را Run کنید.

---

### جمع‌بندی این دور (v27.2.11) — باگ‌هایی که در همین مسیر پیدا شدند

| # | باگ | چطور پیدا شد | رفع |
|---|---|---|---|
| AE | `--yes` شناسه‌ی پلن را ذخیره نمی‌کرد → اولین Ctrl-C فوری خارج می‌شد (بدون لغو پلن) | آزمون واقعی Ctrl-C با PTY | ثبت شناسه در مسیر `--yes` |
| AF | Ctrl-C دوم پلن را در وضعیت `cancelling` جا می‌گذاشت (پروسه خارج، فایل پلن نه) | همان آزمون + `plans list` بعد از خروج | نوشتن همگام وضعیت ترمینال در مسیر خروج |
| AG | `plans resume` پلن `cancelling` را «ادامه‌پذیر» می‌دید و از نو اجرا می‌کرد | تست دوجهته روی `resume()` | `cancelling` هم ترمینال است و نهایی می‌شود |
| AH | `tasks list` task متعلق به پلنِ تمام‌شده/لغوشده را ابداً `running` نشان می‌داد | اجرای واقعی پس از Ctrl-C دوم | آشتی با وضعیت پلن (منبع حقیقت = فایل پلن) |
| AI | `tools --mcp --json` قابل parse نبود (یادداشت‌های انسانی روی stdout) | تست CLI جدید | یادداشت‌ها در حالت `--json` به stderr می‌روند |

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
| 2026-09-24 | **P8** | نصب تازه در clean-room، ۲۶ دستور بدون TTY، بازرسی ایستای macOS/Windows، محور Node>22 | 🟡 جزئی: نصب تازه + بدون TTY + Node 22 تأیید شد؛ باگ X (سرور stdio استاندارد روی Windows با `npx` اجرا نمی‌شد + نبود tree-kill) پیدا و رفع شد؛ Node 24/26 و Windows واقعی در سندباکس قابل آزمون نبودند؛ ۱ تست جدید (نسخه ۲۷.۲.۷) |
| 2026-09-24 | **P9** | جریان کامل UI/API روی سرور واقعی (preview→confirm→SSE→usage/tasks→cancel→replan) + `rm -rf .ai-runtime` زنده + ۹ پروب MCP | 🟢 تأیید شد؛ ۳ باگ رفع شد: Y (ENOENT روی هر نوشتن پس از wipe)، Z (نوشتن لاگ در inode حذف‌شده → تناقض UI↔CLI)، AA (مرگ سرور با unhandled rejection)؛ ۹ تست جدید (نسخه ۲۷.۲.۸) |
| 2026-09-24 | **P10** | پروژه‌ی تله (injection + symlink→/etc/passwd + نام یونیکد/بلند) و مدل کاملاً آلوده که credential خوانده‌شده را بازمی‌گوید؛ ۸ اجرای واقعی | 🟢 تأیید شد؛ ۱۴/۱۴ بررسی — sandbox همه‌ی تلاش‌ها را بست و مقدار key در هیچ آرتیفکت runtime نبود؛ باگ AB (نشت *مقدار* credential در خلاصه/رکورد پلن) پیدا و با `secret-scrub.ts` رفع شد؛ ۹ تست جدید (نسخه ۲۷.۲.۹) |
| 2026-09-24 | **P10-follow-up** | بازبینی پس از P10 با استاب محلی (اجرای واقعی CLI + مسیر API سرور) | 🟢 تأیید شد؛ ۲ باگ رفع شد: AC (پلنِ مسیر assessment بی‌شناسه بود → عدم دسترسی به cancel/resume، `planId` خالی در لاگ، usage بی‌انتساب، و بازنویسی همه‌ی پلن‌های بی‌شناسه روی یک فایل) و AD (رویدادهای `step:*` هرگز لاگ نمی‌شدند)؛ ۶ تست جدید + هارنس `e2e/` (نسخه ۲۷.۲.۱۰) |
| 2026-09-24 | **CI / P1** | ورک‌فلوی `real-provider.yml`: endpoint و کلید از secretها، اجرای واقعی، سه شرط پذیرش (پلن ذخیره‌شده، توکن غیرصفر، نبود کلید در آرتیفکت‌ها)، ضمیمه‌ی لاگ اجرا | 🟢 ساخته شد؛ بدون secret با خطای صریح می‌افتد (اجرای واقعی به‌عهده‌ی شما با secretها) |
| 2026-09-24 | **CI / P8 (دور دوم)** | خواندن annotationهای job ویندوز از Checks API (لوگ قابل دانلود نبود) | 🟢 ۵ ریشه‌ی دیگر شناسایی شد؛ ۱ باگ محصول (`mkdir` ماسک‌کننده‌ی خطا) + ۲ اصلاح تست (path مطلق، EPIPE) رفع شد (v27.2.13) |
| 2026-09-24 | **CI / P8 (اجرای اول)** | ماتریس روی runnerهای واقعی: Ubuntu 22/24/26 🟢، macOS 22/24 🟢، e2e روی Windows/macOS/Linux 🟢، windows-leg تست 🔴 | 🔴 → ۳ فرض POSIX در تست‌ها رفع شد (homedir/SIGTERM/symlink) + annotation برای شکست‌ها (v27.2.12)؛ اجرای دوباره پس از reconnect گیت‌هاب |
| 2026-09-24 | **CI / P8** | ماتریس `ci.yml` روی Ubuntu/Windows/macOS × Node 22/24 (+26 روی Linux): `tsc`، suite، بیلد، نصب سراسری، smoke، سناریوهای E2E | 🟢 دو محور باقی‌مانده‌ی P8 بسته شد (اجرا روی runnerهای واقعی) |
| 2026-09-24 | **مورد ۴** | بازسازی هارنس E2E به‌صورت فایل‌های کامیت‌شده و تکرارشدنی (`e2e/scenarios/`, `npm run e2e`) + استاب marker-دار | 🟢 ۳۲/۳۲ بررسی؛ ۷ سناریو؛ ~۲۵ ثانیه |
| 2026-09-24 | **Ctrl-C** | سیاست «گرَیسفول»: Ctrl-C اول پلن را لغو می‌کند و step در جریان را تمام می‌کند؛ Ctrl-C دوم فوری خارج می‌شود | 🟢 آزمون واقعی PTY؛ ۵ باگ/نقص در همین مسیر پیدا و رفع شد (زیر) |
| 2026-09-24 | **مورد ۲ (undici)** | ریشه‌یابی `UND_ERR_BODY_TIMEOUT` روی SSE بلندمدت MCP و رفع دائمی via dispatcher مخصوص MCP | 🟢 `mcp-fetch.ts` + ۵ تست + `undici` در deps |
| 2026-09-24 | **resume** | `plans resume` نباید گام‌های انجام‌شده را دوباره اجرا کند؛ پلن ترمینال هم قابل resume نیست | 🟢 `resume()` بازنویسی شد؛ ۶ تست + آزمون واقعی E2E |
| 2026-09-24 | **`tools --mcp`** | «چرا ابزارهای MCP در `hootl tools` دیده نمی‌شوند؟» | 🟢 افزودن `--mcp` (نصب و فهرست‌کردن واقعی)؛ `--json` هم اکنون فقط JSON چاپ می‌کند |
| 2026-09-24 | **سرنخ باز P9** | ۱۳ پروب stdio روی بیلد نهایی (۱۰ موفق + ۳ timeout) و شمارش چرخه‌ی عمر childها | 🟢 بسته شد؛ همه‌ی childها SIGTERM+exit، صفر بازمانده — نشت قبلی مربوط به بیلد پیش از P6 بود |
| 2026-09-24 | **P1 (ب) — تزریق خطا** | استاب با `FAULT:` (429/500/401/CUT/HANG/EMPTY) و `BADJSON:` + سناریوی `faults` | 🟢 ۴ باگ پیدا و رفع شد: AJ (توکن فراخوانی‌های planning/acceptance/review هرگز شمرده نمی‌شد — نصف صورت‌حساب)، AK (گزارش نهایی مصرف همه‌ی runهای orchestrator را جمع می‌زد — روی سرور هر run بزرگ‌تر)، AL (یک پاسخ JSON خراب planner کل run را با پیام گمراه‌کننده‌ی «Clarification needed» می‌کشت — اکنون یک retry و «Planning failed»)، AM (پاسخ خالی مدل step را done می‌کرد)؛ ۹ تست جدید، e2e ۴۲/۴۲ (نسخه ۲۷.۲.۱۴) |
| 2026-09-25 | **گزارش کاربر: «⚠️ Clarification needed» خالی** | در یک اجرای واقعی (ویندوز، `I:\structured-ai\last\test-projects`, `@aur/auto`) مدل با کلید `clarificationQuestions` سه سؤال داد؛ اسکیما فقط `needsClarification` را می‌شناخت و zod کلید ناشناس را حذف می‌کند → لیست خالی → حلقه‌ی توضیح بی‌صدا رد شد و گزارش با تیتر خالی چاپ شد | 🟢 چهار لایه بسته شد: فیلدهای هم‌معنا در اسکیما، ادغام/حذف تکراری در `normalizeAssessment`، تضمین «حداقل یک سؤال» با پرسش ساخته‌شده از ریشه‌ی پروژه و ورودی‌هایش، و صریح‌کردن نام فیلد در پرامپت؛ ۱۳ تست + سناریوی `clarify` (۵ بررسی) که دقیقاً همان پاسخ provider را بازتولید می‌کند؛ ۱۱۲۵ تست، ۱۶۹/۱۶۹ e2e (نسخه ۲۷.۱۶.۱) |
| 2026-09-25 | **حالت چت + زبان کاربر** | درخواست کاربر: «همیشه نخواد پلن بسازد؛ سلام پلن نشود؛ AI به زبان کاربر جواب بده» | 🟢 سه‌حالته شد: `auto` (پیش‌فرض) / `chat` / `plan` با پیشوند `@chat`/`@plan` در خود درخواست، `--mode`، `HOTL_MODE` و `defaultMode` (ترتیب: پیشوند > فلگ > env > کانفیگ > auto)؛ persona جدید `chat` با دقیقاً همان ۲۲ ابزار خواندنیِ `serve --mcp --read-only` و اجرا از مسیر AgentRuntime (Journal + usage)؛ بدون پلن/تأیید/اجرا و exit 0. زبان: تشخیص خط نوشتاری + بخش `## Language` در ارزیابی، پلن، پاسخ چت، system prompt هر agent (با hint از goal)، داوری پذیرش و بازبینی؛ خط عربیِ بدون نشانهٔ فارسی حدس زده نمی‌شود. ۲۶ تست جدید + ۴ تست سرور + ۱۰ تست CLI + سناریوی e2e `chat` (۱۳ بررسی)؛ ۱٬۱۶۵ تست، ۱۸۲/۱۸۲ e2e (نسخه ۲۷.۱۷.۰) |
