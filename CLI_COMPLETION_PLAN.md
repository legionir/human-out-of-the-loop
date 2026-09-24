# پلن اجرایی تکمیل CLI (CLI COMPLETION PLAN)

**تاریخ:** 2026-09-24
**بنیاد:** commit `bd10d4e` (فازهای ۱۸–۲۴ EXECUTION_PLAN_V2، 451/451 تست سبز)
**هدف:** expose کردن امکانات runtime که فعلاً interface ندارند (بر اساس جدول gap-analysis ۲۰۲۶-۰۹-۲۴)
**قانون اجرا:** مانند EXECUTION_PLAN_V2 — هر فاز = یک مرحله اجرا، کامل شدن معیارهای پذیرش پیش از فاز بعد، commit + push جدا برای هر فاز، علامت 🟢 در این فایل

---

## دامنه (چه چیزی کامل می‌شود)

| شکاف (ردیف جدول gap) | قابلیت |
|---|---|
| ۲۷–۳۰ | introspection registryها: models / personas / skills / tools |
| ۲۵–۲۶ | دستور `usage` (per-plan از داده‌های پایدار) |
| ۲۰ | دستور `tasks` (تکلیف‌ها از لاگ observability — read-only) |
| ۱۷, ۱۹, ۱۰ | پرچم‌های کنترل run: `--max-replans`، `--max-delegation-depth`، `--label` |
| ۶ | حلقه clarification تعاملی (سؤال model ← prompt ← re-plan) |
| — | به‌روزرسانی README + regression کامل |

## غیردامنه (صریح)

- **cancel تکلیف از فرایند دیگر:** امکان‌پذیر نیست — TaskRuntime در حافظه است و CLI در فرایند جدا اجرا می‌شود. دستور `tasks` فقط read-only است. (cancel سطح plan که امروز هست همین محدودی‌دفعه را دارد و در فازهای آینده این پلن تغییر نمی‌کند.)
- **usage خالصِ درحافظه** (`UsageAggregator`): از فرایند دیگر دیده نمی‌شود؛ `usage` روی داده‌های **پایدار** (review.usage در plan.json + رویدادهای task در لاگ observability) ساخته می‌شود.
- **EventBus خام:** داخلی است و expose نمی‌شود.
- **تغییرات فاز ۲۵ EXECUTION_PLAN_V2** (مستندات تحویلی) — این پلن جدا از آن است؛ README CLI در C5 به‌روز می‌شود.

---

## فاز C1 — Introspection registryها

**هدف:** `hotl models`، `hotl personas`، `hotl skills`، `hotl tools` — بدون bootstrap سنگین (نه MCP، نه LLM).

**گام‌ها:**
1. `src/cli/commands/registry.ts` — چهار subcommand؛ فقط `PersonaRegistry/SkillRegistry/ModelRegistry/ToolRegistry` را از `projectRoot` بیلد کند (utility سبک `loadRegistries(projectRoot)` در `src/cli/utils/`).
2. خروجی: جدول `id | name | توضیح کوتاه` (chalk)؛ `--json` برای مصرف ماشین‌پاس.
3. خطا: registry خالی → پیام `no <type>s registered` (exit 0)؛ projectRoot نامعتبر → exit 2 با راهنما.

**تست‌ها:** هر ۴ دستور روی registry نمونه (models 3، personas 4، skills 5، tools ثبت‌شده) + `--json` قابل-parse + حالت خالی + projectRoot خراب.

**معیارهای پذیرش:**
- [ ] چهار دستور اجرا می‌شوند بدون اتصال LLM/MCP (زیر ۱ ثانیه)
- [ ] خروجی `--json` دقیقاً مطابق فایل‌های `registry/*.json`
- [ ] ≥۷ تست جدید سبز

**فایل‌ها:** `src/cli/commands/registry.ts` (جدید)، `src/cli.ts` (ثبت)، `src/cli/utils/registries.ts` (جدید)، تست

---

## فاز C2 — دستورات `usage` و `tasks` (روی داده پایدار)

**هدف:** مشاهده مصرف tokenها و تکلیف‌ها پس از پایان run — بدون وابستگی به فرایند زنده.

**گام‌ها:**
1. `src/cli/utils/log-reader.ts` — parser سبک `logs.jsonl`: فیلتر planId + eventType (مبتنی بر همان `followLog` فاز ۲۳).
2. `hotl usage [--plan <id>] [--json]`:
   - per-plan: `plan.json → review.usage` (از فاز ۲۰ CORR-03 دقیقاً aggregation واقعی است)
   - fallback برای planهای بدون review: جمع `promptTokens/completionTokens` از رویدادهای `task:completed` لاگ
   - بدون `--plan`: جدول همه planها (از planStore) + مجموع
3. `hotl tasks list [--plan <id>]` و `hotl tasks show <taskId>`:
   - از جفت‌کردن `task:started` + `task:completed` در لاگ (id، status، stepId، persona، summary کوتاه، usage)
   - `show`: جزئیات کامل رکورد رویداد

**تست‌ها:** ساخت لاگ/plan-store مصنوعی (۲ plan، 4 task با usage) → اعداد `usage` و `tasks` دقیقاً مطابق؛ `--plan` فیلتر می‌کند؛ plan بدون review → fallback از لاگ؛ خالی → پیام مناسب.

**معیارهای پذیرش:**
- [ ] `usage --plan` اعداد = review.usage همان plan.json (تست عددی)
- [ ] `tasks list` همه taskهای لاگ‌شده را نشان می‌دهد + status درست
- [ ] ≥۸ تست جدید سبز

**فایل‌ها:** `src/cli/commands/usage.ts`، `src/cli/commands/tasks.ts` (جدید)، `src/cli/utils/log-reader.ts` (جدید)، `src/cli.ts`، تست

---

## فاز C3 — پرچم‌های کنترل run

**هدف:** `--max-replans <n>`، `--max-delegation-depth <n>`، `--label <text>` در `run` — passthrough به `OrchestratorConfig` / session.

**گام‌ها:**
1. `run.ts`: سه گزینه commander + passthrough (config برای دو تای اول؛ label → `sessionStore.createSession(label)` در run).
2. اعتبارسنجی: عدد صحیح مثبت؛ `--label` max 64 کاراکتر (خطای روشن exit 2).
3. `sessions label <id> <label>` — افزودن label به session موجود (متد کوچک `addLabel` در SessionStore + event `session:labeled`).

**تست‌ها:** هر سه پرچم به config/session می‌رسند (spy)؛ `sessions label` روی session پایدار کار می‌کند + id نامعتبر → exit 2؛ اعتبارسنجی‌ها.

**معیارهای پذیرش:**
- [ ] `--max-replans 1` در OrchestratorConfig نهایی دیده می‌شود (تست spy)
- [ ] `--label` روی session جدید + `sessions label` روی session قدیمی، هر دو در `sessions show`
- [ ] ≥۶ تست جدید سبز

**فایل‌ها:** `src/cli/commands/run.ts`، `src/cli/commands/sessions.ts`، `src/ai/runtime/session-store.ts` (addLabel)، `src/ai/types.ts` (event session:labeled)، تست

---

## فاز C4 — حلقه clarification تعاملی ⚠️ (بزرگ‌ترین تغییر، API orchestrator)

**هدف:** وقتی planner سؤال می‌پرسد (`isClear=false`)، CLI سؤال‌ها را درquirer می‌پرسد و با جواب‌ها re-plan می‌کند — تا plan شفاف یا سقف دور.

**گام‌ها:**
1. **Orchestrator API:** گزینه جدید `run(request, { clarificationCallback? })`:
   - `(questions: string[], attempt: number) => Promise<Record<string, string> | null>`
   - بدون callback → رفتار فعلی (failure با سؤال‌ها) — **CI-safe پیش‌فرض**
   - حلقه: `plan()` → اگر `!isClear` → callback → `planner.generatePlan(goal, answers)` → تکرار، سقف `maxClarificationRounds` (پیش‌فرض ۳، از config)
   - event جدید `plan:clarified` (planId, attempt, answeredCount)
2. **CLI:** callback در TTY → درquirer (هر سؤال یک prompt با `?:` + متن سؤال)؛ `Ctrl+C` در وسط → لغو run (cancelled). در non-TTY → اگر `--yes` نباشد همان خطای فعلی (بدون prompt آویخته).
3. **Guard test:** callback که null برگرداند → run cancelled با report روشن.

**تست‌ها (mock planner):** ۲ دور سؤال → جواب → plan شفاف (ترتیب exact)؛ بدون callback → رفتار قدیمی؛ سقف دور → failure با گزارش دورها؛ non-TTY+`--yes` → بدون prompt؛ event `plan:clarified` در لاگ.

**معیارهای پذیرش:**
- [ ] e2e mock: ۲ round clarification → plan → confirm (mock) → done
- [ ] رفتار بدون callback (CI) **بدون تغییر** (تست رگرسیون)
- [ ] `plan:clarified` در لاگ observability
- [ ] ≥۵ تست جدید سبز

**فایل‌ها:** `src/ai/orchestrator.ts`، `src/ai/orchestrator-config.ts` (maxClarificationRounds)، `src/ai/types.ts`، `src/cli/commands/run.ts`، تست

---

## فاز C5 — مستندات + regression کامل

**گام‌ها:**
1. بخش CLI در `README.md`: جدول کامل دستورات (راه‌اندازی، run + همه پرچم‌ها، sessions، plans، tasks، usage، registry، mcp، logs) + مثال + کد خروجی.
2. اجرای کامل: `npx tsc --noEmit` + کل suite + smoke واقعی CLI (`--help` هر دستور + یک `run --dry-run` روی registry نمونه).
3. به‌روزرسانی خط progress این فایل.

**معیارهای پذیرش:**
- [ ] `npx tsc --noEmit` بدون خطا
- [ ] کل suite سبز (شماره دقیق در جدول پایین ثبت می‌شود)
- [ ] `--help` همه دستورات بدون crash؛ `run --dry-run` smoke OK
- [ ] README: هر دستور جدید با مثال

---

## نقشه فایل (جمع)

| مسیر | نوع |
|---|---|
| `src/cli/commands/registry.ts` | جدید (C1) |
| `src/cli/utils/registries.ts` | جدید (C1) |
| `src/cli/commands/usage.ts`، `tasks.ts` | جدید (C2) |
| `src/cli/utils/log-reader.ts` | جدید (C2) |
| `src/cli/commands/run.ts` | تغییر (C3, C4) |
| `src/cli/commands/sessions.ts` | تغییر (C3) |
| `src/ai/orchestrator.ts`، `orchestrator-config.ts` | تغییر (C4) |
| `src/ai/runtime/session-store.ts`، `src/ai/types.ts` | تغییر (C3, C4) |
| `README.md` | تغییر (C5) |

## ریسک‌ها

| ریسک | تخفیف |
|---|---|
| C4: تغییر API `run()` ممکن است با U3/U5 پلن UI تعارض داشته باشد (هر دو options را گسترش می‌دهند) | options یک object است — افزودن فیلد شکسته نیست؛ هر دو پلن باید **extend** کنند نه duplicate. اگر یکی اول merge شد، دیگری روی همان interface می‌نشیند. |
| C2: فرمت `logs.jsonl` ممکن است eventهای کم‌کاربری نداشته باشد | parser tolerant (خطای parse → رد خط + هشدار)، تست با رکوردهای ناقص |
| C1: registry خالی در پروژه جدید | پیام دوست‌داشتنی، exit 0 (نه crash) |

## جدول پیشرفت

| فاز | وضعیت | نتیجه / انحراف |
|---|---|---|
| C1 registry list | 🟢 | کامل شد 2026-09-24 — 4 دستور (models/personas/skills/tools) با `--json`؛ ۷ تست جدید؛ انحراف: layout «directory-per-skill» نیاز به لودر جدا داشت |
| C2 usage + tasks | ⬜ | |
| C3 run flags | ⬜ | |
| C4 clarification | ⬜ | |
| C5 docs + regression | ⬜ | |

**Baseline:** 451/451 تست (27 فایل) · **هدف انتها:** ~451 + ≥۳۶ تست جدید
