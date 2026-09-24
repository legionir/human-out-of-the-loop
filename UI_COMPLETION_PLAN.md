# پلن اجرایی تکمیل UI (UI COMPLETION_PLAN)

**تاریخ:** 2026-09-24
**بنیاد:** commit `bd10d4e` (فازهای ۱۸–۲۴ EXECUTION_PLAN_V2، 451/451 تست سبز)
**هدف:** پر کردن شکاف‌های UI نسبت به runtime + برابری (parity) با CLI (بر اساس جدول gap-analysis ۲۰۲۶-۰۹-۲۴)
**قانون اجرا:** مانند EXECUTION_PLAN_V2 — هر فاز = یک مرحله اجرا، کامل شدن معیارهای پذیرش پیش از فاز بعد، commit + push جدا، علامت 🟢

---

## دامنه

| شکاف (ردیف جدول) | قابلیت |
|---|---|
| ۳۶–۳۷–۳۸ | ⚠️ **مهم‌ترین:** سرور `.env` پروژه + global config را می‌خواند؛ `HOTL_REDACT_KEYS` |
| ۲۷–۳۲ | endpointهای registry (models/personas/skills/tools/mcp) + پنل Registry در UI + تست MCP |
| ۱۴–۱۶–۱۷ | انتخاب model + timeout + max-steps + max-replans **per-run** از فرم UI |
| ۲ | **Preview بدون side-effect** (`POST /api/preview`) + دکمه «فقط پیش‌نمایش» |
| ۶ | حلقه clarification تعاملی (SSE event + فرم جواب‌ها + re-plan) |
| ۲۵ | `/api/usage` (aggregator در حافظه server — همان پروسه، پس معتبر است) |
| ۲۰–۲۲ | taskهای live: لیست + شمارنده + **cancel تکلیف** (همان پروسه → واقعاً ممکن است، برخلاف CLI) |
| ۱۰ | label برای session (ویرایش در sidebar) |
| ۳۳ | follow برای observability (SSE) |
| — | مستندات + regression کامل |

## غیردامنه (صریح)

- **resource lock table (#23)** و **EventBus خام (#35)**: دیباگی/داخلی — expose نمی‌شوند.
- **persist کردن usage فراتر از عمر server:** aggregator در حافظه است؛ با restart از بین می‌رود (plan.json همچنان review.usage پایدار را دارد — `/api/plans/:id` منبع پایدار است).
- **تغییرات فاز ۲۵ EXECUTION_PLAN_V2.**

---

## فاز U1 — پلن پیکربندی سرور (مهم‌ترین شکاف عملی) ⚠️

**هدف:** سرور دقیقاً همان منابع پیکربندی CLI را داشته باشد — وگرنه UI با کلیدهای `.env` کار نمی‌کند (باگ واقعی کاربر).

**گام‌ها:**
1. `src/server.ts`: در شروع — `loadDotEnv(projectRoot)` + `loadGlobalConfig()` (همان utility‌های CLI)؛ model پیش‌فرض: `options.model > global config > env`؛ `HOTL_REDACT_KEYS` (comma-separated) → `redactKeys` در `createOrchestrator` helper.
2. **ترتیب اولویت شفاف و تست‌شده:** flag/env صریح > global config > env پروژه > پیش‌فرض.
3. `GET /api/health` (یا `/api/config`): `projectRoot`، model فعال، تعداد redact keys، نسخه — **بدون هیچ مقدار راز**.
4. test: فایل `.env` در پروژه دمو با کلید mock → provider factory آن را ببیند (spy)؛ injection body همچنان بی‌اثر (تست فاز ۲۴ رگرسیون بماند).

**تست‌ها:** .env خوانده می‌شود؛ global config خوانده می‌شود؛ env صریح برتر است؛ redact keys در لاگ اعمال می‌شود؛ health بدون راز.

**معیارهای پذیرش:**
- [ ] کلید `OPENAI_API_KEY` در `.env` پروژه برای run در UI فعال می‌شود (تست spy روی provider factory)
- [ ] `HOTL_REDACT_KEYS` کار می‌کند
- [ ] تست injection فاز ۲۴ **هنوز** سبز (نوک‌زیاده امنیتی جدید)
- [ ] ≥۵ تست جدید سبز

**فایل‌ها:** `src/server.ts`، `src/server/routes/health.ts` (یا گسترش موجود)، تست

---

## فاز U2 — endpointها و پنل Registry

**گام‌ها:**
1. `routes/registry.ts`: `GET /api/models`، `/api/personas`، `/api/skills`، `/api/tools` (array ساده `{id,name,...}`) + `GET /api/mcp` و `POST /api/mcp/:id/test` (از همان منطق CLI فاز ۲۳ — extract به shared helper اگر clean باشد).
2. UI: پنل جمع‌شونده «Registry» در بالا یا sidebar — countها + لیست با scroll + دکمه Test برای MCP (نتیجه موفق/خطا inline).
3. `/api/models` منبع **model picker** فاز بعد هم هست.

**تست‌ها:** هر ۶ endpoint با registry نمونه + test روی MCP موجود و غایب + UI render (تست DOM سبک با jsdom اگر ارزشش را داشته باشد، وگرنه فقط endpoint تست می‌شود و render با smoke).

**معیارهای پذیرش:**
- [ ] ۶ endpoint ۲۰۰ + shape صحیح (تست)
- [ ] `POST /api/mcp/:id/test` success/failure را جداگانه برمی‌گرداند
- [ ] پنل Registry در UI داده واقعی نشان می‌دهد (smoke با curl+HTML)
- [ ] ≥۵ تست جدید سبز

**فایل‌ها:** `src/server/routes/registry.ts` (جدید)، `public/{app.js,index.html,style.css}`، تست

---

## فاز U3 — model و گزینه‌های run به‌ازای هر درخواست

**گام‌ها:**
1. **Orchestrator:** `run()` گزینه `runOverrides?: {modelId?, agentTimeoutMs?, maxSteps?, maxReplanningAttempts?}` — با `{...this.config, ...runOverrides}` PlanRuntime همان run ساخته می‌شود (بیلد runtime per-run از قبل این‌طور است). validation: modelId باید در `modelRegistry` باشد، وگرنه fail با لیست idهای معتبر.
2. `POST /api/run` فیلدهای اختیاری `{model, timeoutMs, maxSteps, maxReplans}` → runOverrides.
3. UI: فرم run — select **model** (از `/api/models`، پیش‌فرض = model server) + فیلدهای اختیاری تاشده «گزینه‌های پیشرفته».
4. مدل انتخابی در هدر مودال پلن نمایش داده شود (شفافیت).

**تست‌ها:** e2e mock — run با `model:'local-llama'` → mock model همان id را ببیند (spy)؛ model نامعتبر → 400 با لیست؛ timeout/maxSteps به runtime می‌رسند (spy)؛ بدون فیلدها → رفتار قدیمی (رگرسیون).

**معیارهای پذیرش:**
- [ ] تغییر model per-run واقعاً model متفاوت را صدا می‌زند (تست spy عددی)
- [ ] run بدون فیلدها با رفتار امروز **بی‌تفاوت** است
- [ ] UI: select پر می‌شود و انتخاب به body می‌رسد
- [ ] ≥۵ تست جدید سبز

**فایل‌ها:** `src/ai/orchestrator.ts`، `src/server/routes/run.ts`، `public/app.js`، تست

> **یادداشت سازگاری با C4 پلن CLI:** هر دو `run()` را extend می‌کنند — options یک object است و فیلد جدید شکسته نیست. هر کدام که اول merge شد، دیگری روی همان interface می‌نشیند (تعارض merge نباید پیش بیاید).

---

## فاز U4 — Preview بدون side-effect

**گام‌ها:**
1. `POST /api/preview {message}` → `orchestrator.previewPlan(message)` (فاز ۲۳) → `{plan, feasibility, cycles}` — **هیچ** session/interaction/plan-store write (previewPlan از قبل این قرارداد را دارد).
2. UI: در فرم run دو دکمه: `Run` و `Plan only` (ثانوی). `Plan only` → مودال پلن بدون دکمه‌ی Confirm + بنر «پیش‌نمایش — چیزی ذخیره نشد» + نمایش feasibility و سیکل‌ها.
3. `planId` در پاسخ preview = `null` (چون plan ذخیره نمی‌شود) — UI آن را «بدون id» نشان می‌دهد.

**تست‌ها:** e2e mock — بعد از preview: `/api/sessions` **تغییری نکرده**، planStore خالی، feasibility در پاسخ؛ preview برای goal نامفهوم (clarification) → 400 با سؤال‌ها (نه 500).

**معیارهای پذیرش:**
- [ ] تست صفر-side-effect سبز (sessions + plans هر دو بی‌تغییر)
- [ ] مودال preview در UI feasibility/cycles را نشان می‌دهد
- [ ] ≥۳ تست جدید سبز

**فایل‌ها:** `src/server/routes/preview.ts` (جدید)، `public/{app.js,index.html}`، تست

---

## فاز U5 — حلقه clarification تعاملی ⚠️ (بزرگ‌ترین؛ هم‌بافت با C4)

**گام‌ها:**
1. **Orchestrator:** همان `clarificationCallback` فاز C4 (اگر C4 زودتر merge نشده باشد، اینجا تعریف می‌شود — هر دو پلن باید دقیقاً این امضا را داشته باشند: `(questions, attempt) => Promise<Record<string,string>|null>`).
2. **سرور:** state جدید run: `awaiting-clarification` + در run-registry resolver نگه‌دار (همان الگوی `pendingConfirmation`). SSE event `clarification` `{planId, questions, attempt}`.
3. `POST /api/runs/:runId/clarification {answers}` → resolver → re-plan → بازگشت به `planning`/`awaiting-confirmation`. answers ناقص → 400.
4. UI: روی `clarification` — مودال سؤال‌ها (هر سؤال یک textarea + دکمه «پاسخ ندهم» = لغو)؛ بعد از ارسال، timeline رویداد `clarified` نشان بدهد.
5. Guard: draft-plan guard فاز ۲۴ (resume plan تأییدنشده) **بی‌تغییر** بماند — plan نتیجه roundهای clarification فقط بعد از confirm اجرا شود.

**تست‌ها (mock planner):** e2e — run → clarification event (۲ سؤال) → POST answers → plan مودال → confirm → done (کل زنجیره در یک تست SSE)؛ بدون پاسخ → 404/409 مناسب؛ guard draft plan؛ سقف round (orchestrator) → `plan:error` با گزارش.

**معیارهای پذیرش:**
- [ ] e2e کامل ۲-round clarification → confirm → done سبز
- [ ] state machine: `planning → awaiting-clarification → planning → awaiting-confirmation → running` در تست polling قابل مشاهده
- [ ] guard draft-plan فاز ۲۴ رگرسیون‌شده سبز
- [ ] ≥۴ تست جدید سبز

**فایل‌ها:** `src/ai/orchestrator.ts` (اگر C4 نباشد)، `src/server/routes/run.ts` (+state)، `src/server/sse.ts` (event جدید)، `public/app.js`، تست

---

## فاز U6 — usage + taskهای live

**گام‌ها:**
1. **usage:** `GET /api/usage?planId=` — از `usageAggregator.getPlanUsage(planId)` (getter عمومی کوچک در Orchestrator) + `GET /api/usage` (aggregated + شمارنده planها در این server). UI: خط usage در جزئیات plan + تب/بانر «مصرف این server».
2. **taskها:** `GET /api/runs/:runId/tasks` — از TaskRuntime همان run (status/summary/usage per task + running/pending counts) + `POST /api/runs/:runId/tasks/:taskId/cancel` (cancelTask — **همان پروسه، پس واقعی است**).
3. UI: در پانل run فعال — لیست taskها با badge وضعیت + دکمه Cancel روی تکلیف + شمارنده‌ها؛ بعد از `run:done` جدول نهایی taskها (از رویدادهای timeline).

**تست‌ها:** usage mock = جمع دقیق usageهای mock (عدد)؛ task list وسط run (mock execution آهسته) وضعیت درستی نشان می‌دهد؛ cancel تکلیف → task cancelled + run با بقیه ادامه/تکمیل؛ usage بعد از restart server خالی (رسم کردن رفتار document شده).

**معیارهای پذیرش:**
- [ ] `/api/usage?planId` اعداد = جمع usage mockها (تست عددی)
- [ ] cancel task واقعاً آن task را لغو می‌کند (spy روی TaskRuntime)
- [ ] UI task list + cancel button در smoke
- [ ] ≥۵ تست جدید سبز

**فایل‌ها:** `src/ai/orchestrator.ts` (getter)، `src/server/routes/{run,usage}.ts`، `public/app.js`، تست

---

## فاز U7 — session label + observability follow

**گام‌ها:**
1. `PATCH /api/sessions/:id {label?}` → (addLabel از C3 اگر موجود نباشد، اینجا تعریف می‌شود) → session بازمحورده. UI: rename inline در sidebar (دو کلیک / آیکون مداد).
2. `GET /api/observability/stream?planId=` — SSE از همان لاگ (heartbeat + tail اولیه + خطوط جدید با fs.watch — reuse الگوی `followLog`). UI: دکمه «Follow log» در جزئیات plan (اختیاری-پیشرفته، در منوی plan).
3. `DELETE /api/sessions/:id` label را هم پاک کند (هم‌الگویی) — رگرسیون.

**تست‌ها:** PATCH label persist (store reload) + label خالی/طولانی ۴۰۰؛ stream: خطوط اولیه + خط جدید بعد از log (تست با نوشتن همزمان) + abort تمیز؛ delete با label رگرسیون.

**معیارهای پذیرش:**
- [ ] label بعد از restart server حفظ است (persist تست‌شده)
- [ ] SSE follow حداقل ۱ خط جدید را می‌فرستد (تست race-free)
- [ ] ≥۴ تست جدید سبز

**فایل‌ها:** `src/server/routes/{sessions,stream}.ts`، `public/app.js`، `src/ai/runtime/session-store.ts` (اگر C3 نباشد)، تست

---

## فاز U8 — مستندات + regression کامل

**گام‌ها:**
1. بخش UI در `README.md`: راه‌اندازی سرور + همه envها (HOTL_PROJECT_ROOT/HOTL_PORT/HOTL_REDACT_KEYS + `.env`/global config) + جدول endpointها + flowهای UI (run/preview/clarification/usage).
2. `npx tsc --noEmit` + کل suite + smoke زنده: server روی :3000 → health/config + هر endpoint + یک run e2e mock (اگر ممکن در sandbox).
3. خط progress این فایل + شماره دقیق تست‌ها.

**معیارهای پذیرش:**
- [ ] tsc بدون خطا؛ کل suite سبز (شماره ثبت می‌شود)
- [ ] همه endpointهای جدید در README با مثال curl
- [ ] smoke زنده :3000 (health + registry + plans) OK

---

## نقشه فایل (جمع)

| مسیر | نوع |
|---|---|
| `src/server.ts` | تغییر (U1) |
| `src/server/routes/registry.ts`، `preview.ts`، `usage.ts` | جدید (U2, U4, U6) |
| `src/server/routes/{run,sessions,stream}.ts` | تغییر (U3–U7) |
| `src/server/sse.ts`، `src/server/types.ts` | تغییر (U5) |
| `src/ai/orchestrator.ts` | تغییر (U3, U5, U6) |
| `src/ai/runtime/session-store.ts` | تغییر (U7) |
| `public/{index.html,app.js,style.css}` | تغییر (U2–U7) |
| `README.md` | تغییر (U8) |

## ریسک‌ها

| ریسک | تخفیف |
|---|---|
| U5: run-registry resolver دوم (clarification) پیچیدگی state machine | دقیقاً الگوی `pendingConfirmation` تکرار می‌شود؛ تست state-machine polling موجود را گسترش می‌دهیم |
| U1: خواندن global config ممکن است `defaultModel` کاربر را عوض کند و رفتار فعلی سرور را تغییر دهد | **آگاهانه** (همان parity خواسته‌شده از CLI)؛ در health نمایش داده می‌شود + تست اولویت صریح برتر |
| U3: per-run override model باید validation شود (id نامعتبر) | 400 با لیست idهای معتبر (تست) |
| تعارض با پلن CLI روی orchestrator/session-store | هر دو پلن options/متودها را extend می‌کنند؛ ترتیب اجرا توصیه‌شده: **U1 → C1..C5 → U2..** یا بالعکس، اما C4 و U5 نباید هم‌زمان شروع شوند |

## ترتیب اجرا توصیه‌شده (ترکیبی)

`U1` (باگ واقعی، کوچک) → فازهای CLI (C1–C5) → `U2, U3, U4` → `C4` **یا** `U5` (هر دو clarification — اول CLI که تست‌ها آسان‌ترند، UI روی همان callback می‌نشیند) → `U6, U7, U8`.

## جدول پیشرفت

| فاز | وضعیت | نتیجه / انحراف |
|---|---|---|
| U1 config parity | ⬜ | |
| U2 registry | ⬜ | |
| U3 run overrides | ⬜ | |
| U4 preview | ⬜ | |
| U5 clarification | ⬜ | |
| U6 usage + tasks | ⬜ | |
| U7 label + follow | ⬜ | |
| U8 docs + regression | ⬜ | |

**Baseline:** 451/451 تست (27 فایل) · **هدف انتها:** ~451 + ≥۳۶ تست جدید
