# پلن اجرایی رفع یافته‌های بازبینی جامع (REVIEW_EXECUTION_PLAN)

**تاریخ:** 2026-09-25
**بنیاد:** نسخه `27.17.3` + commit رفع `mode` در re-plan پس از clarification (۱۲۱۹/۱۲۱۹ تست سبز، `tsc` تمیز)
**منبع:** بازبینی دومرحله‌ای — مرحلهٔ دوم متمرکز بر نواقص و خطاهای پنهان ورکفلوها (فازهای R9–R11 و موارد افزوده در R0، R3، R4). مرحلهٔ اول: بازبینی جامع پنج‌بخشی کد (orchestration/planning، runtime، tools، CLI/server/MCP، prompts/registry/tests/CI). هر یافته با فایل:خط ثبت شده؛ برچسب **[V]** یعنی با اسکریپت آزمایشی بازتولید یا با ردگیری کامل مسیر تأیید شده، **[S]** یعنی مشکوک و نیازمند بازتولید پیش از رفع.
**قانون اجرا:** هر فاز = یک مرحله اجرا؛ پیش از رفع هر باگ، تستی نوشته شود که **بدون رفع fail و با رفع pass** شود؛ همه معیارهای پذیرش فاز پیش از فاز بعد برآورده شوند؛ `npx tsc --noEmit` و `npx vitest run` سبز؛ commit + push جدا برای هر فاز؛ علامت 🟢 کنار فاز پس از اتمام.

**اولویت:** 🔴 بحرانی/بالا · 🟡 متوسط · ⚪ پایین

---

## غیردامنه (صریح)

- **احراز هویت و bind سرور وب (`src/server.ts:199`، `0.0.0.0` بدون auth/CORS):** به تصمیم مالک پروژه فعلاً کنار گذاشته شده است.
- **`servers-main/`:** کد vendor شده؛ بازبینی نشده است.

## یافتهٔ رفع‌شده (مرجع)

- ✅ **R1-00** — re-plan پس از clarification پارامتر `mode` را پاس نمی‌داد (`orchestrator.ts:843`)؛ اجرای `@plan` به `auto` برمی‌گشت. رفع + تست در `c4-clarification.test.ts`.

---

## فاز R0 — ایمنی ابزارها و سطح حمله 🔴 🟢

**هدف:** هیچ ابزاری نتواند محافظت‌های اعلام‌شده را دور بزند.

### R0-01 🔴 [V] 🟢 `git_push` برنچ محافظت‌شده را force-push یا حذف می‌کند
- **محل:** `src/ai/tools/implementations/git-push.ts:118,146`
- **مشکل:** `protectedMatch` رشته خام `branch` را مقایسه می‌کند ولی همان رشته به‌عنوان refspec به git می‌رود. `{branch:"+feat:main"}` → force-push به main؛ `{branch:":main"}` → حذف main. کامنت خط 127 («refspec قابل بیان نیست») نادرست است.
- **رفع:** رد کردن `:`، `+` ابتدایی، `^`، `~`، `..` در `branch`؛ اعتبارسنجی با `git check-ref-format --branch`؛ push صریح `refs/heads/X:refs/heads/X`.
- **معیار پذیرش:**
  - تست روی مخزن واقعی موقت: `+feat:main`، `:main`، `feat:main`، `main^`، `-f` همه با `BAD_ARGUMENT` رد شوند و ref `main` روی remote تغییر نکند.
  - push عادی برنچ غیرمحافظت‌شده همچنان موفق باشد.
  - کامنت خط 127 اصلاح شود.

### R0-02 🔴 [V] 🟢 مدل می‌تواند محافظت SSRF را خاموش کند
- **محل:** `src/ai/tools/implementations/fetch.ts:98`، `src/ai/tools/read-only.ts:24`
- **مشکل:** `allowPrivate` در schema ورودی مدل است؛ یک صفحه با prompt injection می‌تواند مدل را به خواندن `169.254.169.254` وادارد. `fetch` در لیست read-only است، پس در chat و `serve --mcp --read-only` هم در دسترس است.
- **رفع:** حذف `allowPrivate` از schema مدل؛ فقط از config اپراتور (`HOTL_FETCH_ALLOW_PRIVATE` یا گزینه factory).
- **معیار پذیرش:** schema ابزار `fetch` فیلد `allowPrivate` ندارد؛ فراخوانی با `allowPrivate:true` به آدرس خصوصی رد شود؛ با فعال‌سازی اپراتور مجاز شود؛ تست هر دو حالت.

### R0-03 🔴 [V-کد] 🟢 DNS rebinding در `fetch`
- **محل:** `src/ai/tools/net/url-safety.ts:242`، `fetch.ts:404`
- **مشکل:** آدرس یک بار resolve و بررسی می‌شود و undici هنگام اتصال دوباره resolve می‌کند (TOCTOU).
- **رفع:** `connect.lookup` در `Agent` که همان آدرس‌های بررسی‌شده را برگرداند یا آدرس را در lookup دوباره بررسی کند.
- **معیار پذیرش:** تست با lookup ساختگی که بار اول IP عمومی و بار دوم `127.0.0.1` می‌دهد → درخواست رد شود.

### R0-04 🟡 [V] 🟢 پروسه‌های فرزند MCP کل `process.env` را به ارث می‌برند
- **محل:** `src/ai/tools/mcp-stdio-transport.ts:55`
- **رفع:** env پایه allowlist (`PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `LANG`, …) + `config.env` صریح سرور.
- **معیار پذیرش:** تست: فرزند stdio متغیر `OPENAI_API_KEY` والد را نبیند مگر در `config.env` تعریف شده باشد؛ سرورهای موجود registry همچنان اجرا شوند (Windows و POSIX).

### R0-05 🟡 [V] 🟢 سرور MCP به notification پاسخ می‌دهد و `tools/call` بدون id را اجرا می‌کند
- **محل:** `src/mcp/server.ts:357-436`
- **رفع:** برای همه متدها: اگر `id` ندارد، اثر جانبی مجاز (در صورت نیاز) اجرا شود ولی پاسخی ارسال نشود؛ `tools/call` بدون id رد و اجرا نشود.
- **معیار پذیرش:** تست stdio و HTTP: `{"method":"ping"}` بدون id → بدون خروجی؛ HTTP → `202` بدون body؛ `tools/call` بدون id → هیچ فایلی نوشته نشود.

### R0-06 🟡 [V] 🟢 `--allow-tools` خالی همه ابزارها را باز می‌کند
- **محل:** `src/cli/commands/serve.ts:40-46`
- **رفع:** مقدار خالی یا فقط `,` → خطا (exit 2)؛ id ناشناخته → خطا با لیست idهای معتبر.
- **معیار پذیرش:** `--allow-tools ""` و `--allow-tools readfile` هر دو با exit 2 و پیام روشن خارج شوند.

### R0-07 🔴 [V] 🟢 کلید واقعی `OPENAI_API_KEY` به هر `baseURL` سفارشی ارسال می‌شود
- **محل:** `src/ai/models/providers/openai-provider.ts:24`، `src/ai/models/list-models.ts:54` (سربرگ این فایل ادعای خلاف دارد)
- **مشکل:** `apiKey = source[keyVar] || OPENAI_API_KEY || HOTL_API_KEY`. یک `.env` یا `registry/models/gpt-4o.json` در مخزنِ clone‌شده که `baseURL` را عوض کند، کلید واقعی را به سرور مهاجم می‌فرستد (با سرور محلی بازتولید شد: `Bearer sk-REAL-OPENAI`).
- **رفع:** fallback به `OPENAI_API_KEY` فقط وقتی `baseURL` ندارد یا `api.openai.com` است؛ `baseURL` سفارشی فقط `HOTL_API_KEY` یا `apiKeyEnv` صریح.
- **معیار پذیرش:** سرور آزمایشی روی `baseURL` سفارشی بدون `HOTL_API_KEY` هیچ header `Authorization` دریافت نکند؛ همین برای `list-models`.

### R0-08 🔴 [V-کد] 🟢 registry پروژه کد مورد اعتماد فرض می‌شود
- **محل:** `src/ai/orchestrator.ts:651`، `registry/mcp-servers` لایهٔ پروژه
- **مشکل:** هر سرور stdio تعریف‌شده در `<project>/registry/mcp-servers` در هر `initialize()` (حتی برای یک سؤال chat) spawn می‌شود؛ `tokenEnvVar`/`keyEnvVar` می‌تواند هر متغیر env را به هر URL بفرستد. یک مخزن مخرب با اولین `hootl run` اجرای دستور می‌گیرد.
- **رفع:** مرحلهٔ اعتماد صریح (لیست پروژه‌های مورد اعتماد در global config یا `--trust-project`) پیش از استفاده از mcp-servers و override‌های `baseURL` لایهٔ پروژه.
- **معیار پذیرش:** در پروژهٔ نامطمئن سرور stdio اجرا نشود و هشدار روشن نمایش داده شود؛ پس از اعتماد، اجرا شود.
- **یادداشت اجرا:** `Orchestrator` اکنون به‌طور پیش‌فرض لایهٔ پروژهٔ `mcp-servers` را بوت‌استرپ نمی‌کند مگر `trustedProject:true` (این ضمانت امنیتی برای هر فراخوان — CLI، سرور، تست — به‌صورت خودکار اعمال می‌شود). `src/ai/registries/trust.ts` و `GlobalCliConfig.trustedProjects` زیرساخت persist اعتماد را فراهم می‌کنند؛ سیم‌کشی `--trust-project` در `run`/`repl`/`serve` (برای خواندن/نوشتن این لیست خودکار) هنوز انجام نشده — فعلاً فراخوان باید `trustedProject:true` را صریحاً به `OrchestratorConfig` بدهد.

### R0-09 🔴 [V] 🟢 ابزارهای فایل می‌توانند در `.git/` و `.ai-runtime/` بنویسند
- **محل:** `src/ai/tools/implementations/path-security.ts:136`، `write-file.ts`، `edit_file`، `move_file`
- **مشکل:** `write_file('.git/config', core.fsmonitor=…)` و سپس `git_status` (read-only) دستور دلخواه اجرا می‌کند (بازتولید شد)؛ `.git/hooks/pre-commit` همین اثر را در `git_commit` دارد؛ بازنویسی `.ai-runtime/journal/*.jsonl` ردپای audit را جعل می‌کند. از طریق fetch آلوده به prompt injection و `serve --mcp` هم قابل دسترس است.
- **رفع:** رد هر نوشتن، ویرایش یا جابه‌جایی که مسیرش جزء `.git` یا `.ai-runtime` دارد (کد `PROTECTED_PATH`).
- **معیار پذیرش:** `write_file` به `.git/config` و `.ai-runtime/journal/x` هر دو رد شوند و بایت‌های فایل تغییر نکنند؛ همین برای `edit_file`، `move_file` و `copy`.

### R0-10 🔴 [V] 🟢 ابزارهای git در مخزن بزرگ‌تر از workspace فایل‌های بیرون workspace را تغییر می‌دهند
- **محل:** `src/ai/tools/git/git-runner.ts:310-313` (ریشهٔ مخزن بالاتر از projectRoot مجاز است)، `git-stash.ts:140`، `git-reset.ts:167`، `git-branch-write.ts:247`، `git-commit.ts`
- **مشکل:** `git_stash` تغییر کاربر در `../outside.txt` را برداشت و `git_commit` آن را commit کرد (بازتولید شد).
- **رفع:** وقتی ریشهٔ مخزن ≠ projectRoot: pathspec workspace به هر فرمان نوشتنی؛ یا رد عملیات اگر بیرون workspace تغییر نشده وجود دارد.
- **معیار پذیرش:** همان سناریو `outside.txt` را دست‌نخورده بگذارد.
- **یادداشت اجرا:** `git_stash push` اکنون با pathspec `-- .` به workspace محدود می‌شود؛ `git_reset --hard` وقتی تغییر بیرون workspace وجود دارد رد می‌شود (`OUTSIDE_WORKSPACE`) چون `--hard` را نمی‌توان با pathspec محدود کرد. `git-branch-write.ts` (checkout مسیرهای بیرون از طریق تغییر برنچ) هنوز پوشش داده نشده — ریسک پایین‌تر است چون عملیات branch مستقیماً محتوای دلخواه فایل بیرون workspace را نمی‌نویسد مگر با checkout که به‌طور طبیعی کل تری را جابه‌جا می‌کند؛ به فاز بعد موکول شد.

### R0-11 🔴 [V] 🟢 `git_commit` با `paths` کل index را commit می‌کند
- **محل:** `src/ai/tools/implementations/git-commit.ts:193-236`
- **مشکل:** `git add -- paths` و سپس `git commit -m` بدون pathspec → فایل‌های stage‌شدهٔ خود کاربر هم commit می‌شوند (بازتولید شد). پیام `NOTHING_TO_COMMIT` هم فایل‌های unstaged کاربر را فهرست می‌کند و مدل را به stage کردن آن‌ها تشویق می‌کند.
- **رفع:** `git commit --only -- <paths>`؛ بدون `paths`، گزارش یا رد ورودی‌های index که ایجنت stage نکرده است.
- **معیار پذیرش:** HEAD فقط فایل ایجنت را داشته باشد و فایل stage‌شدهٔ کاربر همچنان staged بماند.

### R0-12 🟡 [V] 🟢 `.ai-runtime/` در پروژه‌های کاربر git-ignore نمی‌شود
- **مشکل:** `git_add ["."]` فایل‌های `.ai-runtime/thinking/*.json` را stage کرد؛ journal، memory، plans و sessions هم commit و push می‌شوند.
- **رفع:** ساخت `.ai-runtime/.gitignore` با محتوای `*` هنگام ایجاد دایرکتوری.
- **معیار پذیرش:** پس از یک اجرا در مخزن تازه، `git add .` هیچ فایلی زیر `.ai-runtime` stage نکند.

---

## فاز R1 — صحت ارکستراسیون و اجرای پلن 🔴

**هدف:** هیچ اجرایی crash نکند، بی‌صدا کار را رها نکند، یا موفقیت نادرست گزارش ندهد.

### R1-01 🔴 [V] crash پس از clarification وقتی re-plan پاسخ `answer` می‌دهد
- **محل:** `src/ai/orchestrator.ts:819-966`
- **مشکل:** حلقه با `isClear:true` تمام می‌شود ولی `planningResult.plan` خالی است → `Cannot set properties of undefined (setting 'sessionId')`؛ interaction برای همیشه pending می‌ماند.
- **رفع:** پس از حلقه، `kind==='answer'` به `answerRun` برود (در حالت `plan` که `normalizeAssessment` آن را به plan تبدیل می‌کند، بدون تغییر).
- **معیار پذیرش:** تست: clarify → answer در حالت auto، نتیجه `kind:'answer'` بدون استثنا و interaction با `completedAt`.

### R1-02 🔴 [V] شکست مرحلهٔ برگ هیچ‌وقت re-plan را فعال نمی‌کند
- **محل:** `src/ai/runtime/plan-runtime.ts:125,152,617`
- **مشکل:** re-plan فقط از `isStuck()` صدا زده می‌شود که به مرحلهٔ pending مسدود نیاز دارد؛ شکست آخرین مرحله یا پلن تک‌مرحله‌ای فوراً `failed-partial`.
- **رفع:** در `shouldExit`، اگر مرحلهٔ failed وجود دارد و بودجهٔ re-plan باقی است، `attemptReplanning` پیش از خروج.
- **معیار پذیرش:** تست پلن A→B که B یک بار fail می‌شود: `replanningAttempts ≥ 1` و در صورت موفقیت جایگزین، وضعیت نهایی موفق.

### R1-03 🔴 [V] ادغام re-plan لبه‌های وابستگی را پاک می‌کند
- **محل:** `src/ai/runtime/replan-merge.ts:54-56`
- **مشکل:** جایگزین با id جدید (`step-3b`) → `step-4 dependsOn ['step-3']` به `[]` تبدیل و هم‌زمان با جایگزین اجرا می‌شود.
- **رفع:** لبه‌های مرحلهٔ شکست‌خورده به جایگزین آن redirect شوند؛ اگر جایگزینی مشخص نیست re-plan رد شود، نه اینکه لبه حذف شود.
- **معیار پذیرش:** تست واحد merge: `step-4.dependsOn` پس از merge شامل `step-3b` باشد؛ حالت بدون جایگزین → re-plan رد.

### R1-04 🟡 [V] ادغام کار جدید را زیر id تکراری دور می‌ریزد
- **محل:** `src/ai/runtime/replan-merge.ts:43`
- **رفع:** برخورد id با مرحلهٔ done و توضیح متفاوت → تغییر نام مرحلهٔ جدید (`step-2-r1`).
- **معیار پذیرش:** تست: مرحلهٔ جدید با id مرحلهٔ done و توضیح متفاوت در پلن ادغام‌شده حاضر باشد.

### R1-05 🟡 [V] بازیابی موفق همچنان `failed-partial` گزارش می‌شود
- **محل:** `src/ai/runtime/plan-runtime.ts:205` + merge
- **رفع:** وضعیت جدید `superseded` برای مرحلهٔ جایگزین‌شده (schema + formatter + UI) و حذف آن از محاسبهٔ `allDone`.
- **معیار پذیرش:** تست: مرحلهٔ شکست‌خورده + جایگزین موفق → پلن `completed` و review `success`؛ مرحلهٔ superseded در گزارش نهایی دیده شود.

### R1-06 🟡 [V] re-plan قبل از ادغام اعتبارسنجی می‌شود
- **محل:** `src/ai/runtime/plan-runtime.ts:570`
- **رفع:** feasibility gate و cycle detection روی **پلن ادغام‌شده**؛ مراحل pending قدیمی که مدل فراموش کرده حفظ شوند (مگر صریحاً جایگزین شده باشند).
- **معیار پذیرش:** تست: پلن جدید که به مرحلهٔ done ارجاع می‌دهد پذیرفته شود؛ مرحلهٔ pending قدیمیِ حذف‌نشده در پلن نهایی بماند.

### R1-07 🟡 [V] داور پذیرش در صورت خطا کار انجام‌شده را رد می‌کند و خروجی را بازنویسی می‌کند
- **محل:** `src/ai/runtime/acceptance-checker.ts:124-129`، `plan-runtime.ts:411`
- **رفع:** timeout یا خطای داور → یک retry؛ سپس نتیجه `unverified` (نه failure کیفیت). حکم داور به `resultSummary` **الحاق** شود نه جایگزین.
- **معیار پذیرش:** تست: داور throw کند → مرحله failed نشود، `unverified` ثبت شود؛ خروجی اصلی مرحله در review نهایی موجود باشد.

### R1-08 🟡 [V] id تکراری مراحل پذیرفته می‌شود
- **محل:** `src/ai/planning/feasibility-gate.ts:36`
- **معیار پذیرش:** پلن با دو مرحلهٔ `step-1` در gate با خطای `duplicate step id` رد شود.

### R1-09 🟡 [V] id و `createdAt` پلن از مدل پذیرفته می‌شود
- **محل:** `src/ai/planning/planner.ts:93`
- **مشکل:** مدلی که همیشه `plan-1` برمی‌گرداند پلن قبلی را در `FilePlanStore` بازنویسی می‌کند و در سرور ثبت لغو را متداخل می‌کند.
- **معیار پذیرش:** تست: خروجی مدل با `id:"plan-1"` → پلن نهایی `plan_<uuid>` و دو اجرا دو فایل جدا.

### R1-10 🟡 [V] `resumePlan` نسخهٔ کهنهٔ پلن را بازبینی می‌کند و مدل اجرا را نمی‌داند
- **محل:** `src/ai/orchestrator.ts:1437,1474`
- **رفع:** reload پلن پس از `resume()`؛ پاس دادن model اجرا (مدل ذخیره‌شده در پلن یا override) به planner و reviewer.
- **معیار پذیرش:** تست: resume پس از تکمیل یک مرحله → review وضعیت‌های پس از resume را ببیند؛ reviewer با همان model فراخوانی شود.

### R1-11 ⚪ [V] خروج‌های feasibility/cycle/رد تأیید interaction را به‌روز نمی‌کنند؛ feedback تأیید دور ریخته می‌شود
- **محل:** `src/ai/orchestrator.ts:994-1093`
- **رفع:** به‌روزرسانی interaction در هر سه مسیر؛ feedback غیر yes/no → re-plan با feedback (تا سقف `maxClarificationRounds`).
- **معیار پذیرش:** تست هر سه مسیر: interaction دارای `completedAt` و `outcome`؛ feedback متنی منجر به پلن دوم شود.

### R1-12 ⚪ [S] persist هنگام پذیرش وضعیت `done` مراحل داوری‌نشده را ذخیره می‌کند
- **محل:** `src/ai/runtime/plan-runtime.ts:407`
- **معیار پذیرش:** تست crash شبیه‌سازی‌شده میان دو داوری → پس از resume مرحلهٔ داوری‌نشده داوری شود.

### R1-13 ⚪ [V] usage ناقص
- **محل:** `planner.ts:586` (دورهای clarification بدون planId)، `orchestrator.ts:1301` (answer با usage خالی)، `llm-timeout.ts` (`withStructuredRetry` usage تلاش اول را گم می‌کند)
- **معیار پذیرش:** usage همهٔ فراخوانی‌های یک اجرا در `review.usage` و `hootl usage` جمع شود؛ تست برای هر سه مسیر.

---

## فاز R2 — صحت لایهٔ اجرای تسک و ایجنت 🔴

### R2-01 🔴 [V] timeout/cancel قفل منبع را آزاد می‌کند در حالی که ابزار هنوز اجرا می‌شود
- **محل:** `src/ai/runtime/agent-runtime.ts:353`، `task-runtime.ts:401,483`
- **رفع:** نگه‌داشتن قفل و اسلات تا settle شدن واقعی `executionPromise`؛ پاس دادن `abortSignal` به ابزارهای fs، git و fetch و احترام به آن.
- **معیار پذیرش:** تست (مدل mock): تسک A با timeout ۱۰۰ms و ابزار ۳۰۰ms، تسک B با همان منبع → ابزار B پس از پایان ابزار A شروع شود؛ `waitForAll` پیش از پایان هر دو برنگردد.

### R2-02 🔴 [V] خطای provider وسط استریم موفقیت گزارش می‌شود
- **محل:** `src/ai/runtime/agent-runtime.ts:536,650`
- **رفع:** part نوع `error` در `pipeThoughts` → failure؛ `finishReason==='error'` → failure.
- **معیار پذیرش:** تست: step 1 ابزار، step 2 خطای 502 → `success:false` با پیام خطا.

### R2-03 🔴 [V] لغو پلن هیچ تسکی را لغو نمی‌کند
- **محل:** `src/ai/runtime/cancellation-manager.ts:107-114`، `plan-runtime.ts:166-169`
- **رفع:** `taskRuntime.cancelTask` برای مراحل `running`؛ اتصال تسک‌های فرزند به والد و لغو آبشاری؛ رد کردن `runAcceptanceChecks` پس از cancel.
- **معیار پذیرش:** تست: لغو در میانهٔ مرحلهٔ running → `AbortSignal` تسک فعال شود، هیچ فراخوانی داور پس از cancel انجام نشود، وضعیت `cancelled`.

### R2-04 🟡 [V] عمق تفویض همیشه ۰ است و persona اشتباه بررسی می‌شود
- **محل:** `src/ai/orchestrator.ts:715`، `delegate-task.ts:101,135,220`
- **رفع:** ساخت ابزار `delegate_task` برای هر ایجنت با depth+1؛ بررسی persona **فراخواننده**.
- **معیار پذیرش:** تست با persona دارای `*` و `maxDelegationDepth:1` → تفویض دوم رد شود.

### R2-05 🟡 [V] توکن اجراهای شکست‌خورده شمرده نمی‌شود
- **محل:** `src/ai/runtime/agent-runtime.ts:426`
- **رفع:** جمع usage در `onStepFinish` و گزارش مجموع جزئی در خطا.
- **معیار پذیرش:** تست: timeout در step 2 → usage step 1 در `UsageAggregator` ثبت شود.

### R2-06 🟡 [V] تسک‌های تفویض‌شده `planId` ندارند و نتیجه به والد برنمی‌گردد
- **محل:** `src/ai/orchestrator.ts:706`
- **معیار پذیرش:** usage فرزند در bucket پلن والد؛ نتیجهٔ فرزند در خروجی ابزار `delegate_task` والد.

### R2-07 🟡 [S] `waitForAll` ممکن است در حلقهٔ داغ بچرخد؛ سراسری است
- **محل:** `src/ai/runtime/task-runtime.ts:367,440-458`
- **رفع:** cleanup در `.finally`؛ `waitFor(planId)` برای انتظار محدود به یک پلن.
- **معیار پذیرش:** تست: `run()` reject کند → `waitForAll` در کمتر از ۱ ثانیه برگردد؛ دو پلن هم‌زمان منتظر یکدیگر نمانند.

### R2-08 🟡 [V] mapهای `TaskRuntime` هرگز پاک نمی‌شوند
- **محل:** `src/ai/runtime/task-runtime.ts:233-234`
- **معیار پذیرش:** پس از پایان پلن، `agents` و `taskOverrides` تسک‌های آن آزاد شوند؛ رکورد تسک پس از TTL یا سقف تعداد حذف شود؛ تست اندازهٔ mapها پس از ۱۰۰ تسک.

### R2-09 🟡 [V] retry و rate limiter به‌کل بی‌اثرند
- **محل:** `src/ai/orchestrator.ts:400-407`، `rate-limiter.ts:144`، `agent-runtime-retry.ts`
- **مشکل:** `TaskRuntime` نسخهٔ خام `agentRuntime` را می‌گیرد؛ `run()` هرگز throw نمی‌کند پس retry هرگز رخ نمی‌دهد؛ sleep بک‌آف اسلات را نگه می‌دارد؛ retry کل ایجنت را با اثرهای جانبی تکرار می‌کند.
- **رفع:** retry فقط در سطح فراخوانی مدل (نه کل ایجنت) و فقط برای خطاهای retryable (429، 5xx، شبکه) با تشخیص status code به‌جای متن پیام؛ محدودیت هم‌زمانی per-provider در همان لایه.
- **معیار پذیرش:** تست: 429 در فراخوانی مدل → retry با backoff و بدون اجرای دوبارهٔ ابزارهای step قبلی؛ `maxConcurrentPerProvider:1` → دو تسک هم‌زمان فراخوانی مدل موازی نداشته باشند.

### R2-10 🟡 [S] race در شکستن قفل کهنه؛ `sleepSync` حلقهٔ رویداد را مسدود می‌کند
- **محل:** `src/ai/runtime/file-lock.ts:190-192`، `memory/graph.ts:128`
- **رفع:** شکستن قفل با rename اتمیک به نام یکتا و بررسی مالکیت پس از آن؛ نسخهٔ async قفل برای مسیر سرور.
- **معیار پذیرش:** تست دو waiter هم‌زمان روی قفل کهنه → دقیقاً یکی قفل را بگیرد.

### R2-11 ⚪ [V] Journal بسته نمی‌شود؛ retention و rotation وجود ندارد
- **محل:** `src/ai/orchestrator.ts:1521`، `journal.ts`، `observability-logger.ts`
- **رفع:** `journal.close()` در `shutdown`؛ `prune` دوره‌ای؛ rotation اندازه‌محور برای `observability.jsonl`؛ فراخوانی `cleanupStaleTempFiles`/`cleanupStaleLockFiles` در `initialize`؛ retention برای plans و sessions.
- **معیار پذیرش:** تست: پس از `shutdown` هیچ fd باز نماند؛ فایل log بالای سقف rotate شود.

### R2-12 🟡 [V] رویدادهای `agent:tool_call` پس از پایان اجرا ارسال می‌شوند
- **محل:** `src/ai/runtime/agent-runtime.ts:550-597`
- **معیار پذیرش:** رویداد هر ابزار هنگام شروع آن ارسال شود؛ در timeout ابزارهای اجراشده در `toolsUsed` باشند.

### R2-13 ⚪ [V] Journal در حالت summary نتیجهٔ کامل را می‌نویسد؛ redaction ناهمسان
- **محل:** `src/ai/runtime/journal.ts:352,421-442,532`
- **رفع:** summary واقعی (سقف چند صد کاراکتر)؛ redaction کلیدها با تطبیق substring مانند observability logger؛ حداقل طول مقدار راز یکسان (۶).
- **معیار پذیرش:** تست: کلیدهای `githubToken` و `x-api-key` و رازی ۶ کاراکتری در journal ماسک شوند.

---

## فاز R3 — صحت ابزارها 🟡

### R3-01 🟡 [V] `edit_file` در تطابق چندگانه فقط اولی را عوض می‌کند
- **محل:** `src/ai/tools/fs/lib.ts:490,531`
- **معیار پذیرش:** بیش از یک تطابق → خطای `AMBIGUOUS_MATCH` با تعداد تطابق‌ها؛ فایل تغییر نکند.

### R3-02 🟡 [V] `edit_file` tab را به space تبدیل می‌کند
- **محل:** `src/ai/tools/fs/lib.ts:520`
- **معیار پذیرش:** ویرایش در Makefile با tab → tab حفظ شود.

### R3-03 🟡 [V] `edit_file` فایل CRLF را LF می‌کند
- **محل:** `src/ai/tools/fs/lib.ts:477`
- **معیار پذیرش:** ویرایش یک خط در فایل CRLF → بقیهٔ خطوط بایت‌به‌بایت یکسان.

### R3-04 🟡 [V] `oldText` خالی متن را در اولین خط خالی درج می‌کند
- **محل:** `src/ai/tools/fs/lib.ts:483`
- **معیار پذیرش:** `oldText: ""` با خطای اعتبارسنجی رد شود (`.min(1)`).

### R3-05 🟡 [V] اتصال MCP ممکن است برای همیشه گیر کند؛ نشت فرزند؛ بدون reconnect
- **محل:** `src/ai/tools/mcp-connector.ts:341,374`
- **رفع:** `client.tools()` داخل race timeout؛ بستن client در catch؛ علامت‌گذاری ابزارهای سرور مرده و خطای روشن (یا reconnect یک‌باره).
- **معیار پذیرش:** تست: سرور ساختگی که به `tools/list` پاسخ نمی‌دهد → `connectAll` پس از `connectTimeoutMs` برگردد و پروسهٔ فرزند kill شود.

### R3-06 ⚪ [V] `create_task` قدیمی موفقیت ساختگی برمی‌گرداند
- **محل:** `src/ai/tools/implementations/task-control-tools.ts:53`
- **معیار پذیرش:** `success:false` با پیام روشن، یا حذف ابزار.

### R3-07 ⚪ [V] `git_pr_list` و `git_pr_view` در لیست read-only نیستند
- **محل:** `src/ai/tools/read-only.ts:21`
- **معیار پذیرش:** هر دو در `readOnlyToolIds()` باشند؛ تست که همهٔ ابزارهای read-only واقعاً چیزی نمی‌نویسند.

### R3-08 ⚪ [V] `get_previous_plan_summary` تعریف شده ولی ثبت نشده است
- **محل:** `src/ai/tools/implementations/session-tools.ts:14`
- **معیار پذیرش:** یا ثبت و تست شود یا حذف شود.

### R3-09 🟡 [V] timeout ابزارهای git محدود نمی‌کند و hookها نیمه‌کاره kill می‌شوند
- **محل:** `src/ai/tools/git/git-runner.ts:193`، `git-commit.ts:238` (پیش‌فرض ۱۵ ثانیه)
- **مشکل:** `runGit` روی `'close'` settle می‌شود که منتظر فرزندان hook می‌ماند؛ SIGKILL فقط به `git` می‌رسد. hook با `sleep 20` پس از ۲۰٫۰۵ ثانیه TIMEOUT داد، نه ۱۵؛ پروسه‌های hook پس از بازگشت ابزار زنده می‌مانند؛ husky/lint-staged بلندتر از ۱۵ ثانیه commit را غیرممکن می‌کند.
- **رفع:** spawn با `detached` و kill گروه پروسه؛ settle روی `'exit'`؛ timeout قابل پیکربندی برای commit (~۱۲۰ ثانیه مانند push).
- **معیار پذیرش:** hook با `sleep 60` و timeout ۱ ثانیه → بازگشت در ~۱٫۵ ثانیه و هیچ پروسهٔ `sleep` باقی نماند.

### R3-10 🟡 [V-کد] `gitEnv` متغیرهای لازم برای push و هویت را حذف می‌کند
- **محل:** `src/ai/tools/git/git-runner.ts:37-52`، `git-push.ts:146`
- **مشکل:** فقط `PATH` و `HOME` (روی Windows بدون HOME) منتقل می‌شوند؛ `SSH_AUTH_SOCK`، `GIT_SSH_COMMAND`، `HTTP(S)_PROXY`/`NO_PROXY`، `XDG_CONFIG_HOME`، `GIT_AUTHOR_*`/`GIT_COMMITTER_*`، `USERPROFILE` حذف می‌شوند → push با ssh-agent یا پشت proxy شکست می‌خورد و هویت env یا Windows به `MISSING_IDENTITY` می‌انجامد.
- **رفع:** allowlist این متغیرها.
- **معیار پذیرش:** تست که هر متغیر به پروسهٔ فرزند git برسد.

### R3-11 🟡 [V] در HEAD جدا، commit یتیم می‌شود و push موفقیت گزارش می‌کند
- **محل:** `src/ai/tools/implementations/git-commit.ts`، `git-push.ts:177`
- **مشکل:** commit روی detached HEAD بی‌هشدار (`branch:"HEAD"`)؛ `git_push {branch:"feat"}` با «Everything up-to-date» موفق برمی‌گردد و commit هرگز به remote نمی‌رسد. هشدار «Nothing was pushed» هرگز فعال نمی‌شود چون git آن را روی stderr می‌نویسد.
- **رفع:** `DETACHED_HEAD` از commit؛ تشخیص «Everything up-to-date» روی stderr و `pushed:false`.
- **معیار پذیرش:** همان سناریو هشدار یا شکست بدهد.

### R3-12 🟡 [V-کد] `git_pr_create` مقادیر پیش‌فرض head/base را نمی‌فرستد؛ backend `gh` به `remote` توجه نمی‌کند
- **محل:** `src/ai/tools/implementations/git-pr.ts:55-62`، `pr-backend.ts:411-418`
- **مشکل:** schema پیش‌فرض وعده می‌دهد ولی مسیر REST هیچ‌کدام را نمی‌فرستد → GitHub `422`. مسیر gh بدون `--repo` → در fork ممکن است PR روی مخزن دیگری ساخته شود.
- **رفع:** head = برنچ جاری، base = برنچ پیش‌فرض؛ `--repo host/owner/name`.
- **معیار پذیرش:** create از مسیر REST بدون head/base هر دو فیلد را ارسال کند؛ تست fork با `--repo` درست.

### R3-13 🟡 [V] `sequentialthinking` یک session مشترک دائمی برای کل پروژه دارد و redaction ندارد
- **محل:** `src/ai/tools/implementations/sequential-thinking.ts:86,153`
- **مشکل:** `sessionId` پیش‌فرض `"default"` با سقف ۵۰ فکر؛ پس از ۵۰ فکر در مجموع همهٔ اجراهای قبلی، اولین فکر هر پلن جدید با `THINKING_LIMIT` شکست می‌خورد (بازتولید شد) و به `task.errors` و داور پذیرش می‌رسد. زنجیره‌های پلن‌های مختلف قاطی می‌شوند؛ رازِ داخل فکر خام ذخیره می‌شود؛ `thinking/` هرگز پاک نمی‌شود.
- **رفع:** session پیش‌فرض به ازای task/پلن؛ پاک‌سازی TTL؛ عبور افکار از redactor journal.
- **معیار پذیرش:** دو پلن هرکدام با ۳۰ فکر هر دو موفق؛ فایل ذخیره هیچ رازی نداشته باشد.

### R3-14 🟡 [V] `edit_file` فایل‌های غیر UTF-8 را خراب می‌کند
- **محل:** `src/ai/tools/fs/lib.ts:477,551`
- **مشکل:** ویرایش یک خط در فایل Latin-1، بایت `é` (0xE9) را به `EF BF BD` تبدیل کرد و `success:true` داد. `write_file` حالت باینری ندارد.
- **رفع:** decode با `TextDecoder('utf-8',{fatal:true})` و رد با `ENCODING_UNSUPPORTED`؛ گزینهٔ `encoding: base64` برای `write_file`.
- **معیار پذیرش:** فایل Latin-1 بدون تغییر بماند و فراخوانی شکست بخورد.

### R3-15 ⚪ [V-کد] ذخیرهٔ نتیجهٔ fetch محتوای ناخواسته در فایل می‌نویسد
- **محل:** `src/ai/tools/implementations/fetch.ts:569-577,596-599`
- **مشکل:** fetch بریده‌شده `<error>Content truncated…</error>` را داخل `content` می‌گذارد؛ پاسخ غیرمتنی `success:true` با محتوای placeholder برمی‌گرداند؛ ایجنتی که آن را ذخیره کند، marker را در فایل می‌نویسد.
- **رفع:** اعلان بریدگی در فیلد جدا؛ پاسخ غیرمتنی `success:false` با `UNSUPPORTED_CONTENT_TYPE`.
- **معیار پذیرش:** `content` هرگز marker را نداشته باشد.

### R3-16 ⚪ [V-کد] پیام commit بدنه نمی‌تواند داشته باشد
- **محل:** `src/ai/tools/implementations/git-commit.ts:128-135`
- **مشکل:** هر newline رد می‌شود ولی متن خطا به مدل می‌گوید «در بدنه از \n استفاده کن» → حلقهٔ تلاش مجدد؛ trailerهایی مثل `Co-authored-by` غیرممکن.
- **رفع:** پذیرش پیام چندخطی و ارسال با `-F -`.
- **معیار پذیرش:** پیام چندخطی با بدنهٔ دست‌نخورده commit شود.

### R3-17 ⚪ [V] `get_current_time` تاریخ ناممکن را بی‌صدا جلو می‌برد
- **محل:** `src/ai/tools/implementations/get-current-time.ts:103-111`
- **معیار پذیرش:** `{date:"2026-02-31"}` خطای `INVALID_DATE` بدهد نه ۳ مارس.

---

## فاز R4 — کیفیت context و prompt 🔴

**هدف:** مدل آنچه برای تصمیم درست لازم دارد را ببیند — و نه بیشتر.

### R4-01 🔴 [V] پلن‌ساز هرگز کاتالوگ persona/skill/tool را نمی‌بیند
- **محل:** `src/ai/planning/planner.ts:634`، `plan-generator.ts:61`، `registry/skills/task_decomposition/SKILL.md:14-16`
- **مشکل:** SKILL.md می‌گوید از `list_personas` استفاده کن ولی `generateObject` ابزار ندارد و prompt هیچ idی ندارد؛ مدل حدس می‌زند و feasibility gate رد می‌کند.
- **رفع:** تزریق کاتالوگ فشرده (id persona + یک خط هدف + allowedTools، idهای skill) در prompt پلن‌ساز (~۱.۵k توکن)؛ حذف گام ۲ SKILL.md.
- **معیار پذیرش:** تست واحد: prompt ارزیابی و تولید پلن شامل همهٔ idهای persona و skill باشد؛ fake LLM در e2e فقط از idهای موجود در prompt استفاده کند (R7-01) و سناریوی persona ناشناخته شکست بخورد.

### R4-02 🔴 [V] هر مرحله فقط `step.description` را می‌گیرد
- **محل:** `src/ai/runtime/plan-runtime.ts:295`، prompt re-plan در `:536`
- **رفع:** بلوک فشرده: هدف پلن، `acceptanceCriteria`، و `resultSummary` مراحل `dependsOn` (هرکدام حداکثر ~۱۵۰۰ کاراکتر). در re-plan: خلاصهٔ نتایج مراحل done، نه فقط توضیحشان.
- **معیار پذیرش:** تست: prompt مرحلهٔ B (وابسته به A) شامل هدف، معیار پذیرش B و خلاصهٔ A باشد و از سقف تعیین‌شده بلندتر نشود.

### R4-03 🔴 [V] persona `coder` تأیید تست را می‌خواهد ولی ابزاری برای آن نیست
- **محل:** `registry/personas/coder.json`
- **معیار پذیرش:** یا ابزار R8-01 اضافه شود یا جمله از prompt حذف شود؛ هیچ persona دستوری نداشته باشد که ابزارش موجود نیست.

### R4-04 🟡 [V] تضاد skillها و persona داور
- **محل:** `registry/skills/code_analysis/SKILL.md` («فایل را تغییر نده») روی ایجنت `coder` (`registry/agents.json:5`)؛ persona `reviewer` به‌عنوان داور پذیرش (`acceptance-checker.ts:145`) در تضاد با «برای سلیقه رد نکن».
- **رفع:** persona داور خنثی `judge`؛ بازنویسی `code_analysis` بدون ممنوعیت کلی (یا جدا کردن skill تحلیل از ایجنت coder).
- **معیار پذیرش:** داور پذیرش با persona `judge` ساخته شود؛ تست cross-registry که persona و skillهای هر ایجنت دستورات متناقض ندارند (فهرست کلیدواژه‌های تضاد).

### R4-05 🟡 [V] skill کامل به ایجنتی تزریق می‌شود که ابزارهایش را ندارد
- **محل:** `src/ai/agents/agent-factory.ts`، ایجنت `researcher` + `git_operations` (۵۸۶۰ کاراکتر، ۸ ابزار فیلترشده)
- **رفع:** بخش‌بندی SKILL.md بر اساس ابزار و حذف بخش‌هایی که ابزارشان مجاز نیست؛ یا هشدار و رد در validation.
- **معیار پذیرش:** system prompt `researcher` هیچ دستورالعملی برای `git_push`/`git_commit` نداشته باشد؛ طول آن حداقل ۳۰٪ کمتر شود.

### R4-06 🟡 [V] context تکراری در پلن‌ساز؛ تضاد «همیشه بپرس» با «context کافی است»
- **محل:** `src/ai/planning/planner.ts:146`، `agent-factory.ts:219`، `registry/personas/planner.json`
- **معیار پذیرش:** بلوک ENVIRONMENT و Language فقط یک بار در هر فراخوانی پلن‌ساز؛ persona planner با قاعدهٔ «درخواستی که فقط project/stack کم دارد CLEAR است» همسو شود.

### R4-07 🟡 [V] `reasoning/SKILL.md` فراخوانی زائد `get_current_time` را اجباری می‌کند
- **معیار پذیرش:** دستور به «از زمان موجود در system prompt استفاده کن؛ فقط برای timezone دیگر ابزار را صدا بزن» تغییر کند.

### R4-08 ⚪ [V] دستور طول خروجی برای ایجنت‌ها نیست؛ schema پلن فیلدهای داخلی را از مدل می‌خواهد
- **محل:** `src/ai/runtime/agent-runtime.ts:832`، `src/ai/schemas/plan.ts`
- **رفع:** دستور «پاسخ نهایی را در ≤ N جمله خلاصه کن»؛ schema جدا برای خروجی مدل بدون `status`، `taskId`، `resultSummary`، `failureType`، `sessionId`؛ تبدیل JSDoc مهم به `.describe()`.
- **معیار پذیرش:** JSON Schema ارسالی به مدل فیلدهای داخلی را نداشته باشد؛ تست اندازهٔ schema.

### R4-09 🔴 [V] تنظیمات مدل هرگز به SDK نمی‌رسند
- **محل:** `src/ai/models/providers/openai-provider.ts:40`، `anthropic-provider.ts:27`
- **رفع:** پاس دادن `temperature` و `maxOutputTokens` به همهٔ فراخوانی‌های `generateText`/`generateObject`/`streamText`؛ provider Anthropic به `baseURL` و `apiKeyEnv` احترام بگذارد.
- **معیار پذیرش:** تست با مدل mock: `temperature` و `maxOutputTokens` پیکربندی‌شده در پارامترهای فراخوانی دیده شوند.

### R4-10 🟡 [V] پیش‌فرض‌های مدل کهنه و محدودیت‌های سخت‌کد
- **محل:** `registry/models/claude-sonnet.json`، ۲۳ مورد `'gpt-4o'` در `src`، `agent-factory.ts:85` (`KNOWN_MODEL_LIMITS` بر `maxContextTokens` غلبه می‌کند)
- **رفع:** به‌روزرسانی به `claude-sonnet-5`؛ یک ثابت `DEFAULT_MODEL_ID`؛ اولویت `maxContextTokens` پیکربندی‌شده.
- **معیار پذیرش:** `grep "'gpt-4o'" src` فقط یک تعریف ثابت؛ تست: `maxContextTokens` پیکربندی‌شده بر مقدار شناخته‌شده غلبه کند.

### R4-11 ⚪ [V] شرط تکراری زبان
- **محل:** `src/ai/planning/planner.ts:369-372`
- **معیار پذیرش:** شرط درونی تکراری حذف؛ تست‌های موجود زبان سبز.

### R4-12 🟡 [V] تشخیص زبان اولین خط با ≥۲ نویسه را انتخاب می‌کند، نه خط غالب را
- **محل:** `src/ai/language.ts:97-107`
- **مشکل:** `Translate "привет" to English` → دستور روسی؛ `Rename key کلید in i18n` → فارسی؛ اردو `یہ کوڈ ٹھیک کریں` → فارسی؛ کانجی `東京の天気` → چینی؛ `step ۱۲ fails` → عربی (ارقام شمرده می‌شوند).
- **رفع:** الزام غالب‌بودن خط نسبت به حروف لاتین؛ نادیده‌گرفتن ارقام؛ تشخیص اردو با حروف ویژهٔ آن (ٹ ڈ ڑ ں ے)؛ تشخیص ژاپنی با کانا یا الگوی رایج.
- **معیار پذیرش:** تست جدول‌محور برای همهٔ نمونه‌های بالا با زبان درست (انگلیسی، انگلیسی، اردو، ژاپنی، انگلیسی).

---

## فاز R5 — سرعت و مصرف توکن 🔴

**اندازه‌گیری‌های پایه (برای مقایسه پس از فاز):**

| مورد | پیش از فاز |
|---|---|
| تعریف ابزارهای `coder` در هر step | ~۹٬۸۰۰ توکن (۴۵ ابزار، ۳۹٬۲۲۴ کاراکتر) |
| system prompt `researcher` | ~۲٬۲۰۰ توکن |
| system prompt پلن‌ساز | ~۹۷۰ توکن (~۹۰۰ کاراکتر تکراری) |
| `directory_tree` پیش‌فرض روی همین مخزن | ~۹۸۳KB (~۲۵۰k توکن) |
| `search_code` پیش‌فرض (۵۰ تطابق) | ۱۷٫۹KB (۷٫۸KB تکراری) |

### R5-01 🔴 [V] prompt caching عملاً غیرممکن است
- **محل:** `src/ai/environment-context.ts:176`، `agent-factory.ts:222`
- **مشکل:** زمان با دقت ثانیه در system prompt؛ هیچ `cacheControl` در کد نیست؛ `toTokenUsage` مقادیر `cacheRead`/`cacheWrite` را دور می‌ریزد.
- **رفع:** زمان فقط تا روز (یا انتقال به user prompt)؛ breakpoint کش Anthropic روی system prompt و تعریف ابزارها؛ ثبت usage کش.
- **معیار پذیرش:** دو فراخوانی متوالی یک ایجنت system prompt بایت‌به‌بایت یکسان داشته باشند؛ فراخوانی Anthropic شامل `cacheControl` باشد؛ `hootl usage` توکن‌های cache را نشان دهد.

### R5-02 🔴 [V] ابزارها بر اساس `allowedTools` کامل داده می‌شوند نه skill
- **رفع:** مجموعهٔ ابزار هر مرحله = اشتراک `assignedTools` مرحله (یا ابزارهای skillها) با `allowedTools`؛ کوتاه‌کردن توضیح طولانی‌ترین ابزارها (`search_code`، `search_files`، `sequentialthinking`، `fetch`).
- **معیار پذیرش:** تعریف ابزارهای یک مرحلهٔ `coder` معمولی ≤ ۳٬۵۰۰ توکن (اندازه‌گیری با همان اسکریپت).

### R5-03 🔴 [V] خروجی ابزارها سقف ندارد
- **محل:** `read-file.ts:86-88`، `fs/lib.ts:337`، `directory-tree.ts:65-108`، `git-diff.ts:174`، `search-code.ts:191`، `list-directory`
- **رفع:**
  - `directory_tree`: حذف پیش‌فرض `node_modules`، `.git`، `dist` و … ؛ سقف ~۵۰۰ ورودی؛ حذف `formatted`.
  - `read_file`/`read_multiple_files`: سقف بایت یا خط پیش‌فرض + `truncated` و `offset` ادامه.
  - `git_diff`/`git_show`: پیش‌فرض stat-first و صفحه‌بندی؛ حذف مسیر مطلق `repository` از نتیجه.
  - `search_code`/`list_directory`: فقط یک نمایش.
  - سقف سراسری ~۳۰k کاراکتر برای هر نتیجهٔ ابزار در wrapper.
- **معیار پذیرش:** `directory_tree` پیش‌فرض روی همین مخزن < ۲۰KB؛ هیچ نتیجهٔ ابزاری در تست از سقف سراسری بزرگ‌تر نباشد؛ `truncated:true` در نتیجه‌های بریده‌شده.

### R5-04 🟡 [V] تاریخچهٔ گفتگو در طول `maxSteps` هرگز کوتاه نمی‌شود
- **محل:** `src/ai/agents/agent-factory.ts:203` (`contextBudgetChars` فقط system prompt)
- **رفع:** `prepareStep` که نتایج ابزار قدیمی‌تر از K step را با خلاصهٔ یک‌خطی جایگزین کند و بودجهٔ کل context را اعمال کند.
- **معیار پذیرش:** تست با مدل mock و ۲۰ step: اندازهٔ پیام‌های ارسالی در step آخر ≤ `contextBudgetChars`.

### R5-05 🟡 [V] اجرای مراحل موجی است
- **محل:** `src/ai/runtime/plan-runtime.ts:178-181`
- **رفع:** حلقهٔ رویدادمحور: با پایان هر تسک، مراحل تازه ready فوراً dispatch شوند؛ انتظار فقط برای تسک‌های همین پلن.
- **معیار پذیرش:** تست پلن A(۱۰۰ms)، B(۵۰۰ms)، C وابسته به A → C پیش از پایان B شروع شود.

### R5-06 🟡 [V] بررسی‌های پذیرش پشت سر هم
- **محل:** `src/ai/runtime/plan-runtime.ts:391-403`، `acceptance-checker.ts:90-94`
- **معیار پذیرش:** داوری مراحل هم‌زمان با `Promise.all` (با سقف هم‌زمانی)؛ `result` ارسالی به داور سقف داشته باشد؛ تست زمان: سه داوری ۲۰۰ms در < ۴۰۰ms.

### R5-07 ⚪ [V] بازبینی نهایی فیلدهایی تولید می‌کند که دور ریخته می‌شوند؛ re-plan از schema ارزیابی کامل استفاده می‌کند
- **محل:** `src/ai/runtime/final-reviewer.ts:129-160`
- **معیار پذیرش:** schema خروجی reviewer فقط فیلدهای استفاده‌شده؛ re-plan مستقیماً `generatePlan` (یک فراخوانی).

### R5-08 ⚪ [V] I/O همگام و کار تکراری در هر نوشتن
- **محل:** `journal.ts:534`، `observability-logger.ts`، `plan-store.ts`
- **معیار پذیرش:** در journal هر نتیجه یک بار redact و stringify و `artifactsOf` یک بار محاسبه شود؛ plan با JSON فشرده ذخیره شود.

---

## فاز R6 — CLI، سرور و سرور MCP 🟡

### R6-01 🔴 [V] Ctrl-C هنگام پلن‌سازی کل REPL را می‌بندد
- **محل:** `src/cli/commands/run.ts:274-279`، `repl.ts:394`
- **معیار پذیرش:** در REPL، Ctrl-C فقط goal جاری را abort کند و prompt برگردد؛ در `hootl run` رفتار فعلی (exit 130) بماند.

### R6-02 🔴 [V] resume روی پلن در حال اجرا مراحل را دوباره اجرا می‌کند
- **محل:** `src/server/routes/plans.ts:57-75`، `plan-runtime.ts:249-266`
- **رفع:** مجموعهٔ in-process پلن‌های فعال + فایل قفل مالکیت با pid/heartbeat؛ رد resume برای پلن `running` با مالک زنده.
- **معیار پذیرش:** تست: resume هم‌زمان با اجرای فعال → `409`؛ پس از مرگ مالک → resume مجاز.

### R6-03 🔴 [V] بسته شدن تب UI اجرا را برای همیشه منتظر نگه می‌دارد
- **محل:** `src/server/routes/run.ts:139-146,162-167`
- **رفع:** TTL قابل پیکربندی برای تأیید و clarification (پیش‌فرض ۳۰ دقیقه → `confirmed:false`)؛ route لغو resolverها را resolve کند؛ `GET /api/runs` برای اتصال مجدد.
- **معیار پذیرش:** تست: پس از TTL اجرا با `cancelled` تمام شود و interaction بسته شود؛ `POST /plans/:id/cancel` روی پلن در انتظار تأیید آن را فوراً ببندد.

### R6-04 🟡 [V] map اجراها در سرور بی‌حد رشد می‌کند
- **محل:** `src/server/routes/run.ts:108`
- **معیار پذیرش:** اجراهای پایان‌یافته پس از N دقیقه (قابل پیکربندی) حذف شوند؛ تست با fake timers.

### R6-05 🟡 [V] `/cd` مقادیر `.env` پروژهٔ قبلی را نگه می‌دارد
- **محل:** `src/cli/repl.ts:498-504`، `src/cli/utils/config.ts:75`
- **معیار پذیرش:** snapshot env اولیه؛ پس از `/cd B` مقادیر `.env` پروژهٔ A حذف و مقادیر B بارگذاری شوند؛ `state.model` از نو محاسبه شود.

### R6-06 🟡 [V] session حذف‌شده همهٔ goalهای بعدی REPL را می‌شکند
- **محل:** `src/cli/repl.ts:417-419`
- **معیار پذیرش:** پس از «Session not found»، `sessionId` پاک و goal بعدی با session جدید اجرا شود.

### R6-07 🟡 [V] paste چندخطی خطوط بعدی را دور می‌ریزد
- **محل:** `src/cli/line-editor.ts:191-199`
- **معیار پذیرش:** bracketed paste فعال؛ paste سه‌خطی یک goal سه‌خطی بسازد.

### R6-08 🟡 [V] محاسبهٔ مکان‌نما بر اساس UTF-16
- **محل:** `src/cli/line-editor.ts:58,95-146,226-235`
- **معیار پذیرش:** Backspace روی emoji کل grapheme را حذف کند؛ عرض CJK/emoji ۲، ZWNJ و اعراب فارسی ۰؛ تست واحد برای هر مورد.

### R6-09 ⚪ [V] JSON-RPC: batch و idهای نامعتبر
- **محل:** `src/mcp/protocol.ts:120`
- **معیار پذیرش:** آرایهٔ درخواست پردازش و آرایهٔ پاسخ برگردد (مطابق `2025-03-26`)؛ `id` از نوع object → `-32600`.

### R6-10 ⚪ [V] خطاهای اعتبارسنجی و متن help
- `plans resume --timeout-ms abc` → ZodError خام (`plans.ts:157`) → استفاده از `validateRunOptions` و exit 2.
- `/config set defaultMode foo` بدون اعتبارسنجی (`repl.ts:114`) → `parseRunMode`.
- help `run` برای model ناشناخته exit 2 را وعده می‌دهد ولی 1 است (`cli.ts:374`) → اصلاح متن.
- **معیار پذیرش:** تست CLI برای هر سه مورد.

### R6-11 ⚪ [V/S] دنبال‌کنندهٔ log کل فایل را در هر رویداد می‌خواند؛ rotation را از دست می‌دهد
- **محل:** `src/cli/commands/logs.ts:153-163`
- **معیار پذیرش:** خواندن فقط از offset قبلی؛ watch روی دایرکتوری و ادامه پس از rotate؛ تست rotate.

### R6-12 🟡 [S] Ctrl-C در prompt تأیید «Error» نشان می‌دهد و interaction باز می‌ماند
- **محل:** `src/cli/utils/confirm.ts:45`
- **معیار پذیرش:** `ExitPromptError` → `{confirmed:false}`؛ خروجی «cancelled» و interaction بسته.

### R6-13 🟡 [V] ناهمسانی resume میان CLI و سرور
- **معیار پذیرش:** یک تابع مشترک برای بررسی‌های وضعیت و overrideها در هر دو مسیر؛ route سرور `RunState` بسازد.

### R6-14 🟡 [V] محیط غیر TTY بدون `--yes` پس از پلن‌سازی پولی شکست می‌خورد
- **معیار پذیرش:** بررسی پیش از هر فراخوانی LLM؛ تست که هیچ فراخوانی مدل انجام نشود.

### R6-15 ⚪ [V] passthrough `/run` در REPL وضعیت REPL را نادیده می‌گیرد
- **محل:** `src/cli/repl.ts:482`
- **معیار پذیرش:** `/run` از model، persistent، yes و session جاری استفاده کند.

### R6-16 🟡 [V] هر goal در REPL یک Orchestrator تازه می‌سازد
- **محل:** `src/cli/commands/run.ts:324-347`، `repl.ts:406`
- **معیار پذیرش:** Orchestrator برای هر (cwd, model, persistent) کش و بازاستفاده شود؛ اتصال MCP یک بار؛ تست تعداد `initialize`.

### R6-17 ⚪ [V] splash سه‌ثانیه‌ای غیرقابل رد؛ بارگذاری registry با هر کلید
- **محل:** `src/cli/repl.ts:255,342`
- **معیار پذیرش:** هر کلید splash را رد کند؛ registryها یک بار در REPL بارگذاری و کش شوند.

---

## فاز R7 — تست، CI و مستندات 🟡

### R7-01 🔴 [V] e2e باگ‌های prompt و کاتالوگ را نمی‌گیرد
- **محل:** `e2e/fake-llm.mjs:447` (همیشه `assignedPersona:'coder'`)
- **معیار پذیرش:** fake LLM persona را از کاتالوگ موجود در prompt انتخاب کند و اگر کاتالوگ نبود خطا دهد؛ سناریوی e2e جدید برای R4-01 و R4-02.

### R7-02 🟡 [V] هر PR دو بار CI اجرا می‌کند
- **محل:** `.github/workflows/ci.yml`
- **معیار پذیرش:** `push` فقط روی برنچ پیش‌فرض؛ concurrency group یکسان؛ کش npm.

### R7-03 🟡 [V] `MAX_ANNOTATIONS` اعمال نمی‌شود؛ annotation بدون `line=`
- **محل:** `scripts/ci-test.mjs:22`
- **معیار پذیرش:** حداکثر N annotation با شماره خط.

### R7-04 🟡 [S] تست‌های flaky با sleep ثابت
- **محل:** `src/cli/__tests__/cli.test.ts:567-589`، `phase30-p6.test.ts:312`، `phase43-mcp-server.test.ts:472`
- **معیار پذیرش:** جایگزینی با انتظار شرطی (poll تا شرط با سقف)؛ ۲۰ اجرای پیاپی روی macOS و Windows سبز.

### R7-05 ⚪ [V] کمبودهای `real-provider.yml`
- **معیار پذیرش:** بررسی نشت کلید Anthropic هم انجام شود؛ نام model مخفی نشود (از var به‌جای secret)؛ `HOTL_API_STYLE` برای base URL سفارشی؛ اجرای cron بدون secret به‌جای fail، skip شود.

### R7-06 ⚪ [V] ناهمخوانی مستندات
- تعداد تست‌ها در `README.md:854` و CHANGELOG؛ `CONFIGURATION.md:210` (`maxContextTokens`)؛ `HOTL_NO_SPLASH` مستند نشده؛ `agents.json` برای planner `skillIds: []` دارد ولی runtime از `task_decomposition` استفاده می‌کند.
- **معیار پذیرش:** همهٔ موارد اصلاح؛ تست ساده‌ای که متغیرهای `HOTL_*` استفاده‌شده در کد در `CONFIGURATION.md` آمده باشند.

### R7-07 🟡 تست‌های پوششی برای این پلن
- **معیار پذیرش:** برای هر یافتهٔ رفع‌شده در فازهای R0–R6 حداقل یک تست regression که بدون رفع fail شود.

---

## فاز R8 — قابلیت‌های جدید (پس از R0–R7) 🟡

### R8-01 ابزار `run_command` / `run_tests`
- **شرح:** اجرای دستور با allowlist (از config پروژه)، timeout، سقف خروجی، بدون shell (argv)، cwd محدود به projectRoot؛ ثبت در journal.
- **معیار پذیرش:** دستور خارج از allowlist رد شود؛ timeout پروسه را kill کند؛ خروجی بالای سقف `truncated`؛ در لیست read-only **نباشد**.

### R8-02 حلقهٔ خودتأییدی
- **شرح:** پس از هر مرحلهٔ coder، اگر پروژه دستور تست تعریف کرده، `run_tests` خودکار؛ شکست → failure فنی و ورودی re-plan.
- **معیار پذیرش:** تست e2e: تغییری که تست را می‌شکند → re-plan با خروجی تست در prompt.

### R8-03 بودجهٔ توکن/هزینه برای هر پلن
- **شرح:** `--budget <tokens|$>`، جدول قیمت مدل‌ها در registry، نمایش هزینهٔ تخمینی در صفحهٔ تأیید، توقف پلن هنگام عبور از سقف با گزارش.
- **معیار پذیرش:** عبور از بودجه → وضعیت `cancelled` با دلیل «budget exceeded» و هیچ فراخوانی مدل پس از آن.

### R8-04 handoff ساختاریافته میان مراحل
- **شرح:** هر مرحله خروجی `{changedFiles, keyResult, notes}` تولید کند که به مراحل وابسته داده شود (مکمل R4-02).
- **معیار پذیرش:** schema handoff؛ prompt مرحلهٔ وابسته فقط handoff را دریافت کند نه متن کامل.

### R8-05 checkpoint و rollback با git
- **شرح:** پیش از هر مرحلهٔ نوشتنی snapshot (بر پایهٔ `withSnapshot` موجود)؛ شکست یا لغو → بازگشت خودکار؛ `hootl plans rollback <id>`.
- **معیار پذیرش:** تست: مرحلهٔ شکست‌خورده که فایل نوشته → پس از rollback درخت کاری برابر پیش از مرحله.

### R8-06 مسیریابی مدل بر اساس نوع کار
- **شرح:** مدل‌های جدا برای `classify`، `judge`، `review` (ارزان) و `plan`، `code` (قوی) در config.
- **معیار پذیرش:** تست: داوری پذیرش با model مسیریابی‌شده فراخوانی شود؛ usage به تفکیک model.

### R8-07 تخمین هزینه (`hootl run --estimate`)
- **معیار پذیرش:** فقط پلن‌سازی؛ خروجی تعداد مراحل، توکن و هزینهٔ تخمینی؛ هیچ اجرایی.

### R8-08 نمونه‌های پلن موفق برای پلن‌ساز
- **شرح:** ذخیرهٔ پلن‌های موفق (هدف + ساختار) در `.ai-runtime` و افزودن نزدیک‌ترین نمونه به prompt پلن‌ساز.
- **معیار پذیرش:** قابل خاموش‌کردن؛ سقف اندازه؛ تست انتخاب نمونه.

### R8-09 ابزارهای تکمیلی
- `delete_file` (با sandbox و journal)؛ صفحه‌بندی `read_graph`؛ `GET /api/runs` (در R6-03).
- **معیار پذیرش:** هر ابزار با تست sandbox و ثبت در registry و persona مناسب.

---

> **بازبینی دوم (2026-09-25):** فازهای R9 تا R11 و موارد R0-07..R0-12، R3-09..R3-17 و R4-12 از بازبینی دوم با تمرکز بر نواقص و خطاهای پنهان ورکفلوها اضافه شده‌اند (ردگیری سرتاسری چرخهٔ اجرا، پیکربندی و registry، رابط وب ↔ سرور، و ورکفلوهای چندابزاری).

## فاز R9 — پایداری داده و چرخهٔ عمر اجرا 🔴

**هدف:** هیچ crash، kill یا اجرای هم‌زمانی state روی دیسک را ناسازگار یا غیرقابل بازیابی نکند.

### R9-01 🔴 [V] `resumePlan` interaction اشتباه را می‌بندد
- **محل:** `src/ai/orchestrator.ts:1483-1496`
- **مشکل:** جست‌وجو با `userRequest === plan.goal` (که `goal` نوشتهٔ مدل است و تقریباً هرگز برابر نیست) و سپس fallback به جدیدترین interaction باز؛ `interaction.planIds` که id پلن را دارد (خط 979) نادیده گرفته می‌شود. session با I1 (اجرای crash‌شده) و I2 (اجرای فعلی): resume پلن I1 → I2 با review پلن I1 به‌عنوان `failure` بسته می‌شود و I1 برای همیشه `pending` می‌ماند (بازتولید شد).
- **رفع:** اول تطبیق با `planIds.includes(planId)`؛ هرگز interaction متعلق به پلن دیگری بسته نشود.
- **معیار پذیرش:** در همان سناریو I1 بسته و I2 دست‌نخورده بماند.

### R9-02 🔴 [V] interaction برای همیشه `pending` می‌ماند وقتی پلن پایان‌یافته، لغوشده یا draft است
- **محل:** `src/ai/orchestrator.ts:1183-1194,1442`، `src/cli/commands/plans.ts:169-188`
- **مشکل:** پلن پیش از بازبینی نهایی (یک فراخوانی کند LLM) پایان‌یافته ذخیره می‌شود و interaction پس از آن؛ kill در این فاصله → پلن `completed` و interaction `pending`. `plans resume` پلن‌های `completed`/`cancelled`/`draft` را پیش از فراخوانی `resumePlan` رد می‌کند، پس هیچ فرمانی آن را نمی‌بندد. crash هنگام انتظار تأیید هم همین را به‌جا می‌گذارد.
- **رفع:** مرحلهٔ reconcile (در `initialize` و `plans resume`) که interactionهای pending با پلن پایان‌یافته را ببندد؛ draft رها‌شده → `cancelled`.
- **معیار پذیرش:** kill میان ذخیرهٔ پلن و به‌روزرسانی interaction → پس از اجرای بعدی یا `plans resume <id>` interaction دارای `completedAt` باشد.

### R9-03 🔴 [V] storeها فایل را بدون اعتبارسنجی بارگذاری می‌کنند؛ یک فایل خراب همهٔ فهرست‌ها را می‌شکند
- **محل:** `src/ai/runtime/plan-store.ts:93` (`raw as Plan`)، `session-store.ts:99` (`as Session`)؛ فراخوان‌ها: `cli/commands/plans.ts:51,83`، `sessions.ts:39,96`، `server/routes/plans.ts:24`، `server/routes/sessions.ts:18`
- **مشکل:** `.default()`های schema هرگز اعمال نمی‌شوند. فایل پلن `{"id","status","goal"}` → `plans list/show/resume` با «Cannot read properties of undefined» شکست؛ session بدون `interactions` → `sessions list` می‌شکند؛ `createdAt` رشته‌ای → «Invalid time value»؛ `GET /api/plans` و `/api/sessions` → 500 و sidebar UI خراب (بازتولید شد).
- **رفع:** بارگذاری با `PlanSchema.safeParse`/`SessionSchema.safeParse`؛ فایل نامعتبر رد و با هشدار گزارش شود.
- **معیار پذیرش:** یک فایل خراب + یک فایل سالم → فهرست فایل سالم را با هشدار نشان دهد و exit 0؛ API ‏200.

### R9-04 🟡 [V] فایل‌های قالب قدیمی در فهرست دیده می‌شوند ولی بارگذاری یا حذف نمی‌شوند
- **محل:** `src/ai/runtime/plan-store.ts:57-66,108-123`، الگوی مشابه در `session-store.ts`
- **مشکل:** `list()` هر `*.json` را می‌خواند ولی `load()`/`delete()` فقط نام `sha256(id)` را؛ فایل‌های پیش از فاز ۲۲ به‌صورت `unknown 0/0` فهرست می‌شوند و `show`/`delete` روی آن‌ها کار نمی‌کند.
- **رفع:** مهاجرت یک‌باره به نام hash در `list()`.
- **معیار پذیرش:** پلن با نام قدیمی فهرست، بارگذاری، resume و حذف شود.

### R9-05 🔴 [V] نوبت‌های قبلی session هرگز به پلن‌ساز یا ایجنت chat نمی‌رسند
- **محل:** `src/ai/orchestrator.ts:801,843`، `src/ai/planning/planner.ts:728`
- **مشکل:** فقط `userRequest` ارسال می‌شود؛ پیگیری «حالا برایش تست هم بنویس» در REPL یا ادامهٔ گفتگوی chat هیچ حافظه‌ای از نوبت قبل ندارد — session فقط یک log است.
- **رفع:** تزریق بلوک محدود از N تعامل آخر (درخواست + خلاصه) در promptهای ارزیابی، تولید پلن و پاسخ.
- **معیار پذیرش:** prompt goal دوم خلاصهٔ تعامل اول را داشته باشد و از سقف تعیین‌شده بزرگ‌تر نشود.

### R9-06 🟡 [V] `sessionId` ناشناخته یا حذف‌شده بی‌صدا پذیرفته می‌شود
- **محل:** `src/server/routes/run.ts:54,120`، `src/ai/orchestrator.ts:782-784`، `session-store.ts:176`
- **مشکل:** `addInteraction` مقدار `undefined` برمی‌گرداند و اجرا بدون ثبت ادامه می‌یابد و همان id ساختگی را گزارش می‌کند؛ CLI این را بررسی می‌کند (`run.ts:352`)، سرور نه.
- **رفع:** بررسی وجود در `Orchestrator.run` (خطای مشخص)؛ route ‏404.
- **معیار پذیرش:** `POST /api/run {sessionId:"nope"}` ‏404 بدهد و هیچ فراخوانی مدل انجام نشود.

### R9-07 🟡 [V] نتیجهٔ مرحلهٔ تمام‌شده تا پایان کل موج و همهٔ داوری‌ها ذخیره نمی‌شود
- **محل:** `src/ai/runtime/plan-runtime.ts:178-187,346` (`syncStepStatuses`)
- **مشکل:** مرحله‌ای که دقایقی پیش تمام شده روی دیسک `running` می‌ماند تا مرحلهٔ هم‌موجش تمام شود؛ crash در این فاصله → resume آن را دوباره اجرا می‌کند و اثرهای جانبی (commit، push، ویرایش) تکرار می‌شوند. (R5-05 دربارهٔ تأخیر است؛ این دربارهٔ پایداری است.)
- **رفع:** ذخیرهٔ نتیجهٔ هر تسک همان لحظهٔ پایان؛ هنگام resume تطبیق با رکوردهای `task:completed` در log یا journal.
- **معیار پذیرش:** crash پس از پایان A و در حین اجرای B → resume مرحلهٔ A را دوباره اجرا نکند.

### R9-08 🟡 [S] به‌روزرسانی وضعیت پلن میان پروسه‌ها یکدیگر را بازنویسی می‌کنند
- **محل:** `src/ai/runtime/cancellation-manager.ts:61-97`، `src/cli/commands/run.ts:171-182`، `plan-runtime.ts:633-639`
- **مشکل:** قفل فقط نوشتن را می‌پوشاند نه چرخهٔ خواندن ← تغییر ← ذخیره؛ `plans cancel` پلن را بارگذاری می‌کند، پروسهٔ مالک `completed` را می‌نویسد، ذخیرهٔ cancel آخر می‌رسد → دیسک `cancelled` با وضعیت‌های مرحلهٔ عقب‌رفته در حالی که اجرا موفق گزارش شده است.
- **رفع:** `PlanStore.update(id, fn)` که قفل را دور کل خواندن و نوشتن نگه دارد.
- **معیار پذیرش:** تست cancel هم‌زمان با ذخیرهٔ نهایی هرگز وضعیت مراحل را عقب نبرد.

### R9-09 🟡 [V-کد] شکست ذخیرهٔ پلن کاملاً بلعیده می‌شود
- **محل:** `src/ai/runtime/plan-runtime.ts:627-644`
- **مشکل:** همهٔ خطاها catch می‌شوند و برخلاف کامنت هیچ log نمی‌شوند؛ دیسک پر یا EACCES → فایل پلن کهنه، `plans resume` مراحل تمام‌شده را دوباره اجرا می‌کند و کاربر چیزی نمی‌بیند.
- **رفع:** `logSystemError`؛ علامت `persistenceDegraded` در review؛ شکست پس از N خطای پیاپی.
- **معیار پذیرش:** `planStore.save` که throw کند → یک رکورد log و هشدار قابل مشاهده در گزارش.

### R9-10 🟡 [V-کد] خاموش‌شدن سرور وب state ناتمام به‌جا می‌گذارد
- **محل:** `src/server.ts:201-204,271-276`، `orchestrator.ts:1521`
- **مشکل:** `http.Server` حاصل از `app.listen` دور ریخته می‌شود، پس درخواست‌های `/api/run` هنگام خاموش‌شدن پذیرفته می‌شوند؛ اجراهای منتظر تأیید یا clarification resolve نمی‌شوند؛ `waitForAll` میان موج‌ها برمی‌گردد و `exit(0)` حلقهٔ پلن را وسط کار می‌کشد → پلن `running` می‌ماند؛ سیگنال دوم یک `close()` دیگر شروع می‌کند به‌جای خروج اجباری.
- **رفع:** بستن listener؛ resolve منتظرها به‌عنوان لغو؛ لغو runtimeهای فعال و ذخیره؛ خروج سخت در سیگنال دوم.
- **معیار پذیرش:** SIGTERM در حین اجرا → پلن `cancelled` (یا interrupted ثبت‌شده) و interaction بسته.

### R9-11 🟡 [V-کد] `hootl run` و REPL به SIGTERM و SIGHUP واکنش نشان نمی‌دهند
- **محل:** `src/cli/commands/run.ts:290`، `src/cli/repl.ts:395` (فقط SIGINT)
- **مشکل:** timeout در CI، `kill` یا بستن ترمینال → هیچ finalize اجرا نمی‌شود: پلن `running`، interaction `pending`، `mcpConnector.closeAll` اجرا نمی‌شود (نشت پروسهٔ فرزند MCP مشکوک).
- **رفع:** هدایت SIGTERM و SIGHUP به همان مسیر اولین Ctrl-C با مهلت زمانی.
- **معیار پذیرش:** `kill -TERM` در میانهٔ یک مرحله → پلن `cancelled` و هیچ پروسهٔ فرزند MCP زنده نماند.

### R9-12 ⚪ [V-کد] همهٔ نوبت‌های chat یک session یک task id مشترک دارند
- **محل:** `src/ai/orchestrator.ts:1251` (`chat:${sessionId}`)
- **مشکل:** journal و `tasks list` همهٔ نوبت‌ها را یک task نشان می‌دهند؛ chat kill‌شده برای همیشه `running` است چون reconcile به `planId` نیاز دارد.
- **معیار پذیرش:** `chat:${interactionId}`؛ دو نوبت chat به‌صورت دو task نمایش داده شوند.

### R9-13 ⚪ [V-کد] API مصرف سرور فقط همین پروسه را می‌شناسد
- **محل:** `src/server/routes/usage.ts`
- **مشکل:** پلن اجراشده از CLI یا پیش از restart سرور ۰ توکن نشان می‌دهد در حالی که `hootl usage` (از log) عدد واقعی را دارد.
- **معیار پذیرش:** ساخت اعداد از `observability.jsonl` مانند CLI؛ `GET /api/usage?planId=` و `hootl usage` برای پلن اجراشده از CLI عدد یکسان بدهند.

### R9-14 ⚪ [V-کد] رشد فایل session و ناهمسانی محدودیت label
- **محل:** `src/ai/runtime/session-store.ts:105-118`، `cli/commands/sessions.ts:67` (۶۴) در برابر `server/routes/sessions.ts:67` (۱۲۰)
- **مشکل:** هر نوبت کل فایل pretty-print را حدود سه بار بازنویسی می‌کند؛ `reviewSummary` پلن سقف ندارد (chat ‏۵۰۰).
- **معیار پذیرش:** رشد فایل session به ازای هر نوبت محدود؛ JSON فشرده؛ یک محدودیت مشترک label در CLI و سرور.

---

## فاز R10 — پیکربندی، registry و راه‌اندازی 🟡

**هدف:** آنچه مستندات و فرمان‌های فهرست نشان می‌دهند همان باشد که اجرا بارگذاری می‌کند، و خطای پیکربندی بی‌صدا نماند.

### R10-01 🟡 [V] ورودی‌های نامعتبر registry برخلاف مستندات بی‌صدا رد می‌شوند
- **محل:** `src/ai/orchestrator.ts:651` (دور ریختن `configErrors` و `connectionResults`)، `:678` (خطاهای models)، `:688` (`resolveAll(false)` هرگز throw نمی‌کند؛ catch آن کد مرده است)، `:697` (خطاهای agents.json)؛ `docs/CONFIGURATION.md:34`
- **مشکل:** یک ویرگول اضافه در `gpt-4o.json` پروژه (که قرار بود به gateway محلی اشاره کند) نادیده گرفته می‌شود و کد به OpenAI واقعی می‌رود (بازتولید شد)؛ نبود کلید API هرگز در شروع log نمی‌شود.
- **معیار پذیرش:** فایل خراب models، agents یا mcp-servers → `initialize` با نام فایل reject شود؛ نبود کلید مدل پیش‌فرض پیش از هر فراخوانی پولی گزارش شود.

### R10-02 🟡 [V] id تکراری داخل لایهٔ پروژه بی‌صدا به آخرین فایل می‌رسد
- **محل:** `src/ai/registries/loader.ts:91`
- **مشکل:** `override` برای کل لایهٔ پروژه اعمال می‌شود؛ دو فایل persona با id `coder` → دومی برنده (بازتولید شد)؛ با `HOTL_NO_PACKAGE_REGISTRY=1` همان فایل‌ها خطای تکراری مهلک می‌دهند.
- **معیار پذیرش:** id تکراری داخل یک لایه در هر دو حالت خطا بدهد.

### R10-03 🟡 [V] `allowedTools` در persona اعتبارسنجی نمی‌شود
- **محل:** `src/ai/schemas/persona.ts:23`، `agent-registry.ts` (`validateAll` personaها را بررسی نمی‌کند)
- **مشکل:** `["read-file","write_fiel"]` بدون خطا شروع می‌شود و ایجنت بی‌ابزار می‌ماند (بازتولید شد).
- **معیار پذیرش:** id ناشناخته (غیر از `*` یا پیشوند MCP) در شروع خطا یا هشدار آشکار بدهد.

### R10-04 🟡 [V] قطع یک سرور MCP کل runtime را از شروع بازمی‌دارد
- **محل:** `src/ai/registries/skill-registry.ts:154` + `orchestrator.ts:651`
- **مشکل:** skill‌ای که `gh_list_issues` را استفاده می‌کند و سرورش در دسترس نیست → «Invalid skill registry entries … unknown tool(s)» با فهرست ۴۵ ابزار، بی‌هیچ اشاره‌ای به شکست MCP (بازتولید شد).
- **رفع:** حذف ابزارهای MCP آن skill با هشدار؛ درج خطای اتصال MCP در پیام.
- **معیار پذیرش:** سرور MCP قطع → runtime با هشدار شامل خطای اتصال شروع شود و بقیهٔ skillها کار کنند.

### R10-05 🟡 [V] فرمان‌های فهرست CLI چیزی متفاوت از بارگذاری اجرا نشان می‌دهند
- **محل:** `src/cli/commands/registry.ts:94-150`
- **مشکل:** `models`، `personas`، `skills` و `tools` هرگز `prepareCliEnvironment` را صدا نمی‌زنند → مدل `custom` حاصل از HOTL_MODEL/HOTL_BASE_URL در `.env` پروژه نمایش داده نمی‌شود؛ `hootl skills` برای skill بدون SKILL.md و با ابزار ناشناخته exit 0 می‌دهد در حالی که `run` شکست می‌خورد؛ `tools --mcp` فقط `<root>/registry/mcp-servers` را می‌خواند نه لایه‌های ادغام‌شده.
- **رفع:** یک loader مشترک برای فهرست‌های CLI و runtime.
- **معیار پذیرش:** برای هر ترکیب env و registry، خروجی `hootl models/personas/skills/tools` با آنچه `Orchestrator.initialize` بارگذاری می‌کند برابر باشد (تست مقایسه‌ای).

### R10-06 🟡 [V] برخورد slug مشخصهٔ مدل بی‌صدا مدل دیگری را انتخاب می‌کند
- **محل:** `src/ai/models/env-endpoint.ts:105`، `src/ai/orchestrator.ts:564-568`
- **مشکل:** `--model claude.sonnet` (مدل gateway) مدل ثبت‌شدهٔ Anthropic `claude-sonnet` را اجرا می‌کند؛ `gpt 4o` → `gpt-4o`؛ `local:llama3:8b` و `local:llama3-8b` یک id دارند؛ `anthropic:` → خطای خام «Too small» با exit 1 به‌جای 2؛ `:foo` → مدل OpenAI ‏":foo".
- **رفع:** پسوند hash هنگام برخورد slug با provider/model متفاوت؛ نام خالی → `InvalidModelError`.
- **معیار پذیرش:** تست جدول‌محور برای همهٔ نمونه‌های بالا.

### R10-07 🟡 [V] `HOTL_BASE_URL` به‌تنهایی `defaultModel` پیکربندی سراسری را کنار می‌زند
- **محل:** `src/ai/models/env-endpoint.ts:63-68` از مسیر `cli/utils/registries.ts:168`، `run.ts:227`، `server.ts:77`؛ در تضاد با `docs/CONFIGURATION.md:20`
- **معیار پذیرش:** بدون `HOTL_MODEL`، `defaultModel` سراسری برنده باشد.

### R10-08 ⚪ [V] parser فایل `.env` نحو رایج را اشتباه می‌خواند
- **محل:** `src/cli/utils/config.ts:61-77`
- **مشکل:** `export OPENAI_API_KEY=…` متغیری به نام `export OPENAI_API_KEY` می‌سازد؛ `HOTL_MODE=chat # default` → «chat # default» و exit 2؛ `HOTL_MODEL="gpt-4o" # prod` نقل‌قول و توضیح را نگه می‌دارد؛ `\n` و مقدار چندخطی پشتیبانی نمی‌شود.
- **معیار پذیرش:** تست واحد برای `export`، توضیح درون‌خطی، و مقدار نقل‌قول‌دار با توضیح.

### R10-09 ⚪ [V-کد] یک منبع پیکربندی در نقاط ورود مختلف رفتار متفاوت دارد
- `hootl run` و `plans` مقدار `projectRoot` سراسری را نادیده می‌گیرند (`run.ts:207`)؛ REPL (`repl.ts:224`) و سرور (`server.ts:74`) رعایت می‌کنند.
- `--no-persistent` وجود ندارد، پس `persistent:true` سراسری قابل لغو نیست (`cli.ts:270`).
- REPL مقدار نامعتبر `HOTL_MODE` را بی‌صدا نادیده می‌گیرد (`repl.ts:236`) در حالی که `run` طبق مستندات exit 2 می‌دهد.
- REPL فقط `.env` ریشه را بارگذاری می‌کند (`repl.ts:228`)؛ `run` هم ریشه و هم cwd.
- **معیار پذیرش:** یک تابع مشترک resolve پیکربندی برای run، REPL، plans و سرور؛ تست برابری.

---

## فاز R11 — رابط وب ↔ سرور 🟡

**هدف:** هر عمل UI وضعیت درست را نشان دهد، هیچ رویدادی گم نشود، و UI با CLI برابر باشد.

### R11-01 🔴 [V] modal پلن هر ۸۰۰ میلی‌ثانیه دوباره رسم می‌شود
- **محل:** `public/app.js:369-374,744`
- **مشکل:** در `awaiting-confirmation` هر poll، `openPlanModal` را صدا می‌زند و `#plan-feedback` را پاک می‌کند → متن بازخورد کاربر برای Reject ظرف ۰٫۸ ثانیه پاک می‌شود. در `running` هر poll `closePlanModal()` را صدا می‌زند → پیش‌نمایشی که در حین اجرا باز شده ناپدید می‌شود. poll در جریان پس از Confirm modal را دوباره باز می‌کند و کلیک دوم ‏409 می‌گیرد.
- **رفع:** باز کردن modal یک بار به ازای هر planId (مانند `clarifyOpenFor`)؛ بستن فقط وقتی مالکش همین اجراست.
- **معیار پذیرش:** متن تایپ‌شده ۵ ثانیه poll را تحمل کند؛ پیش‌نمایش در حین اجرا باز بماند.

### R11-02 🔴 [V] اشتراک SSE اجرا دیر شروع می‌شود و هیچ رویدادی بازپخش نمی‌شود
- **محل:** `public/app.js:362-365`، `src/server/routes/run.ts:148-152,156`، `src/server/sse.ts:35-37`
- **مشکل:** UI فقط از poll بعدی planId را می‌فهمد؛ با تأیید خودکار، `plan:started` و اولین رویدادهای مرحله و ابزار پیش از اشتراک ارسال و توسط `SseHub.emit` دور ریخته می‌شوند. رویداد `awaiting-confirmation` به کانالی می‌رود که کسی نمی‌تواند هنوز در آن مشترک باشد. `id:`، بافر و `Last-Event-ID` نیست؛ اتصال مجدد هم رویداد گم می‌کند؛ مقدار بازگشتی `res.write` (backpressure) نادیده گرفته می‌شود.
- **رفع:** ارسال روی کانال runId (که از ابتدا مشترک است) یا بافر حلقوی به ازای پلن با id و بازپخش هنگام اشتراک یا `Last-Event-ID`.
- **معیار پذیرش:** timeline اجرای خودکار تأییدشده همیشه با «▶ plan started» شروع شود؛ اتصال مجدد رویداد گم نکند.

### R11-03 🟡 [V] `plan:cancelled` هرگز به UI نمی‌رسد
- **محل:** `src/ai/runtime/streaming-manager.ts:114-171` (فقط نوع در خط 22 تعریف شده)، `plan-runtime.ts:135,143,209`، `public/app.js:644`
- **مشکل:** شاخهٔ ترجمه برای `plan:cancelled` وجود ندارد؛ `plan:finished` بعدی به `plan:failed` تبدیل می‌شود و لغو کاربر با سبک شکست «❌ Plan cancelled…» نمایش داده می‌شود؛ listener UI هرگز فعال نمی‌شود.
- **معیار پذیرش:** لغو پلن در حال اجرا دقیقاً یک رویداد SSE ‏`plan:cancelled` و هیچ `plan:failed` تولید کند.

### R11-04 🟡 [V] نام رویدادهای SSE میان سرور و UI ناهمخوان است و فیلد لازم حذف می‌شود
- **محل:** `src/server.ts:100-111`، `public/app.js`، `server/routes/plans.ts:70`
- **مشکل:** UI به `task:tool-error`، `plan:replanned` و `plan:error` گوش نمی‌دهد؛ `payload.agentLevel` حذف می‌شود → هر مرحله دو بار نمایش داده می‌شود و ✔ از `agent:completed` پیش از ✖ شکست داوری ظاهر می‌شود.
- **معیار پذیرش:** یک خط به ازای هر تغییر وضعیت مرحله؛ خطاهای ابزار نمایش داده شوند؛ تست که همهٔ انواع رویداد ارسالی سرور در UI listener داشته باشند.

### R11-05 🟡 [V] UI session ساخته‌شده توسط اجرای جدید را نمی‌پذیرد
- **محل:** `public/app.js:658-672` (`finishRun` مقدار `s.sessionId` را نادیده می‌گیرد)
- **معیار پذیرش:** دو goal پیاپی از «New session» در یک session ثبت شوند و session در sidebar برجسته شود.

### R11-06 🟡 [V] خطای اجرا حباب chat را در حالت «planning…» گیر می‌اندازد
- **محل:** `public/app.js:377-381`
- **معیار پذیرش:** اجرای خطادار «error: <پیام>» را در خود حباب chat نشان دهد، نه فقط toast چهارثانیه‌ای.

### R11-07 🟡 [V] پیش‌نمایش پاسخ chat را نادیده می‌گیرد و خطای provider را سؤال رفع ابهام نشان می‌دهد
- **محل:** `src/server/routes/preview.ts:38-45`، `public/app.js:828-836`، `src/ai/orchestrator.ts:1363-1375`
- **مشکل:** `{ok:true, answer}` → UI «No plan could be produced»؛ `errors` در `needsClarification` قرار می‌گیرد و route ‏400 با `questions` برمی‌گرداند → نبود کلید API به‌صورت «planner needs clarification» نمایش داده می‌شود.
- **معیار پذیرش:** پیش‌نمایش «hello» متن پاسخ را نشان دهد؛ خطای provider به‌صورت خطا (نه سؤال) نمایش داده شود.

### R11-08 🟡 [V] پیش‌نمایش و اجرا به هم متصل نیستند
- **محل:** `src/server/routes/run.ts:120` → `orchestrator.ts:801`
- **مشکل:** اجرا همیشه دوباره پلن می‌سازد: دو بار هزینه، و ممکن است کاربر پلنی متفاوت از پیش‌نمایش را تأیید کند.
- **رفع:** token پیش‌نمایش و `POST /api/run {previewId}` که همان پلن را اجرا کند (با همان تأیید)، یا برچسب «نمونه‌ای» روی پیش‌نمایش.
- **معیار پذیرش:** اجرا از پیش‌نمایش مراحل یکسان را اجرا کند و هیچ فراخوانی دوم پلن‌ساز انجام نشود.

### R11-09 🟡 [V] UI نمی‌تواند حالت اجرا را انتخاب کند و `@chat`/`@plan` را نادیده می‌گیرد
- **محل:** `src/cli/commands/run.ts:195` (پیشوند فقط در CLI parse می‌شود)، `src/server/routes/run.ts`، `preview.ts:24`
- **مشکل:** سرور «@plan …» را متن خام پاس می‌دهد و `HOTL_MODE`/`defaultMode` را نمی‌خواند؛ UI کنترل حالت ندارد.
- **معیار پذیرش:** «@plan hi» از UI در حالت plan اجرا شود؛ انتخاب‌گر حالت در UI؛ پیش‌نمایش `mode` را رعایت کند.

### R11-10 🟡 [V] اجرا در مرحلهٔ پلن‌سازی قابل لغو نیست
- **محل:** `public/app.js:715-718`
- **مشکل:** دکمهٔ Cancel نمایش داده می‌شود ولی پیام «Nothing to cancel yet» می‌دهد؛ هیچ routeی پلن‌سازی (از جمله چند دور clarification) را abort نمی‌کند.
- **رفع:** `POST /api/runs/:runId/cancel` با `AbortSignal` که به planner برسد.
- **معیار پذیرش:** لغو در حین پلن‌سازی → اجرا `cancelled` و هیچ فراخوانی LLM بعدی.

### R11-11 🟡 [V] جریان observability وقتی فایل log نیست از بین می‌رود
- **محل:** `src/server/routes/observability-stream.ts:65` → `cli/commands/logs.ts:153`
- **مشکل:** `fs.watch` پس از ارسال header ‏200 با ENOENT throw می‌کند؛ اتصال قطع و EventSource هر ~۳ ثانیه با stack trace دوباره وصل می‌شود؛ پنل فقط «— following —» نشان می‌دهد (بازتولید شد). (مکمل R6-11.)
- **معیار پذیرش:** Follow بدون فایل log باز بماند و با ایجاد فایل ورودی‌ها را نشان دهد.

### R11-12 ⚪ [V] جدول نهایی taskها دور ریخته می‌شود
- **محل:** `public/app.js:412,674-686` (`finishRunUi` پیش از بازگشت `loadTasks`، `state.run=null` می‌کند)
- **معیار پذیرش:** پنل پس از پایان وضعیت نهایی taskها را نشان دهد.

### R11-13 ⚪ [V] پاسخ‌های chat در تاریخچهٔ session بی‌صدا بریده می‌شوند
- **محل:** `src/ai/orchestrator.ts:1287` (۵۰۰ کاراکتر)، `public/app.js:250`
- **معیار پذیرش:** پاسخ بازگشایی‌شده برابر پاسخ زنده باشد یا صریحاً «بریده‌شده» علامت بخورد.

### R11-14 ⚪ [S] poll در جریان modal سؤال‌های پاسخ‌داده‌شده را دوباره باز می‌کند
- **محل:** `public/app.js:523` (`openClarifyModal`)
- **معیار پذیرش:** پس از پاسخ در حین poll هیچ ‏409 رخ ندهد؛ دورهای ارسال‌شده ردگیری شوند.

---

## ترتیب اجرا و وابستگی‌ها

| ترتیب | فاز | وابستگی |
|---|---|---|
| ۱ | R0 — ایمنی ابزارها | — |
| ۲ | R1 — صحت ارکستراسیون | — |
| ۳ | R2 — صحت runtime | R1 (R2-03 با R1-05 هم‌پوشانی دارد) |
| ۴ | R3 — صحت ابزارها | — |
| ۵ | R7-01 — fake LLM واکنش‌گرا | پیش‌نیاز تست R4 |
| ۶ | R4 — context و prompt | R7-01 |
| ۷ | R5 — سرعت و توکن | R4 (R5-02 به `assignedTools` و R4-01 وابسته است) |
| ۸ | R9 — پایداری داده و چرخهٔ عمر | R1، R2 (R9-07 با R5-05، R9-08 با R6-02) |
| ۹ | R6 — CLI/سرور/MCP | R2، R9 (R6-02 به قفل مالکیت) |
| ۱۰ | R10 — پیکربندی و registry | R0-08 (مرحلهٔ اعتماد) |
| ۱۱ | R11 — رابط وب ↔ سرور | R6-03، R9-06 |
| ۱۲ | R7 (باقی) — تست، CI، مستندات | همهٔ فازهای قبل |
| ۱۳ | R8 — قابلیت‌های جدید | R8-02 ← R8-01؛ R8-04 ← R4-02 و R9-05 |

## معیار پذیرش کل پلن

- همهٔ یافته‌های 🔴 و 🟡 رفع یا با دلیل مکتوب در همین فایل «پذیرفته‌شده/کنار گذاشته» علامت خورده باشند.
- `npx tsc --noEmit` تمیز؛ `npx vitest run` و `npm run e2e` سبز روی ماتریس CI.
- اندازه‌گیری‌های جدول فاز R5 تکرار و در این فایل ثبت شوند؛ کاهش توکن ابزارهای coder ≥ ۶۰٪.
- `CHANGELOG.md` برای هر فاز یک ورودی داشته باشد.
