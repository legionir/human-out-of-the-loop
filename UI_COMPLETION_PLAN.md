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

### [🟢] فاز U1 — نتیجه (2026-09-24)

**نتیجه:** سرور حالا دقیقاً همان منابع پیکربندی CLI را می‌خواند: `loadDotEnv([projectRoot, cwd])` + `loadGlobalConfig()` در ابتدای `createApp` (قبل از ساخت Orchestrator → providerها). اولویت: option صریح > env (`HOTL_MODEL`) > global config > پیش‌فرض؛ `.env` هرگز env واقعی را overwrite نمی‌کند. `HOTL_REDACT_KEYS` (comma-list) → `redactKeys` در `OrchestratorConfig` (فیلد جدید schema) → `ObservabilityLogger` (اگر خالی باشد، defaultهای logger حفظ می‌شوند). `GET /api/health` حالا: `{ok, projectRoot, model, persistent, redactKeysCount}` — **بدون هیچ مقدار راز** (تست‌شده). `orchestrator.config` public readonly شد (health/تست‌ها). 5 تست جدید (بارگذاری .env قبل از provider، برتری env واقعی، زنجیره اولویت model سه‌مرحله‌ای، redact keys + health بدون مقدار، projectRoot از global config) = **462 تست سبز (28 فایل)** + tsc سبز.

**انحراف ثبت‌شده:** (1) `redactKeys` در `OrchestratorConfigSchema` نبود (logger از قبل support داشت) — به schema اضافه شد (additive، default `[]`). (2) `close()` حالا قبل از shutdown، `ctx.ready` را drain می‌کند — **race واقعی** بود: SIGINT (یا حذف tmp در تست) در میانه initialize → unhandled rejection؛ با drain، init یا کامل می‌شود یا خطایش می‌افتد. (3) اسم env مدل `HOTL_MODEL` (پلن فقط «env» گفته بود). (4) `globalCfg.projectRoot` هم احترام می‌شود (parity با CLI؛ پیش از HOTL_PROJECT_ROOT نبود بلکه بین آن و cwd). (5) تست «real env wins» بدون `close()`، initialize در پس‌زمینه را leak می‌کرد — با close قبل از rm رفع شد.

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

### [🟢] فاز U2 — نتیجه (2026-09-24)

**نتیجه:** `src/server/routes/registry.ts` (جدید) — ۶ endpoint با منبع داده از registryهای **in-memory** خود orchestrator (که middleware lazy-init در server.ts تضمین می‌کند قبل از هر route لود شده‌اند):
- `GET /api/models` → `[{id,provider,model,description}]` (منبع model-picker فاز U3)
- `GET /api/personas` → `[{id,name,allowedTools,description}]`
- `GET /api/skills` → `[{id,name,version,tools(resolved)}]`
- `GET /api/tools` → `[{id,name,source,category,description}]`
- `GET /api/mcp` → `{servers:[{id,name,transport,endpoint,auth}], errors:[]}`
- `POST /api/mcp/:id/test` → `{ok:true,toolIds}` | `{ok:false,error}` (404 برای id نامعتبر). منطق دقیقاً مثل CLI فاز ۲۳: `loadMcpServerConfigs` + `McpConnector` روی یک `ToolRegistry` **جدید** (probe هرگز registry زنده را تغییر نمی‌دهد).

UI: پنل جمع‌شونده «Registry» در بالای sidebar (`<details>` بومی، بدون state management) — ۵ گروه (Models/Personas/Skills/Tools/MCP) با count، لیست scroll (max-height + overflow)، و دکمه **Test** برای هر MCP server با نتیجه inline (`✔ n tool(s)` سبز / `✖ error` قرمز). داده‌ها با `loadRegistry()` در boot بارگذاری می‌شوند.

تست‌ها (9 عدد، `src/server/__tests__/u2-registry.test.ts`): shape هر ۶ endpoint با registry نمونه repo؛ 404 برای MCP غایب؛ success `{ok,toolIds}` و failure `{ok:false,error}` (200 نه 500) با mock کنترل‌شونده connector.
**Regression:** 497/497 تست سبز (30 فایل) + tsc سبز. **Smoke زنده:** HTML پنل + app.js served؛ همه endpointها 200 با داده واقعی؛ MCP test 404 صحیح.

**انحراف ثبت‌شده:** (1) success مسیر MCP در تست با `vi.mock` کنترل‌شونده روی `McpConnector` (flag hoisted `mcpMode`) شبیه‌سازی شد — سرور واقعی MCP در sandbox در دسترس نیست؛ منطق خود connector (connect/list-tools) در تست‌های فاز ۲ پوشش دارد و این‌جا فقط **wiring route** (404/config lookup/shape پاسخ/registry جدا برای probe) تست می‌شود. (2) `GET /api/mcp` در نبود configها `{servers:[],errors:[]}` می‌دهد (نه 404) تا UI render ساده بماند.

---

### [🟢] فاز U3 — نتیجه (2026-09-24)

**نتیجه:** overrideهای per-run از فرم UI/HTTP تا `AgentRuntime.run()`:
- **Orchestrator:** `RunOverrides {modelId?, agentTimeoutMs?, maxSteps?, maxReplanningAttempts?}` + `OrchestratorRunOptions.runOverrides`؛ validation با `modelRegistry.hasConfig` **قبل از هر side-effect** (نه ساخت session) و در صورت خطا `InvalidModelError` که لیست idهای معتبر را حمل می‌کند.
- **PlanRuntime (همان run، از قبل per-run ساخته می‌شود):** سه فیلد جدید `agentTimeoutMs?/maxSteps?` + `defaultModelId`/`maxReplanningAttempts` با `ov?.X ?? this.config.X` merge می‌شوند و به `createTask` هر step می‌روند.
- **TaskRuntime:** `CreateTaskOptions` دو فیلد override گرفت؛ مقادیر per-task در `taskOverrides` نگه داشته و در لحظه اجرا `overrides.X ?? this.config.X` به `runtime.run({timeoutMs, maxSteps})` پاس می‌شود (worker مشترک بین runها می‌ماند — resource-lock سالم).
- **باگ جانبی رفع‌شده (مهم):** `OrchestratorConfig.maxSteps` و فلگ CLI `--max-steps` **مرده بودند** (هیچ‌جا مصرف نمی‌شد). حالا در constructor به TaskRuntime وصل شده و واقعاً به `stepCountIs(maxSteps)` می‌رسد (+ فلگ CLI هم بدون تغییر کد CLI زنده شد).
- **سرور:** `POST /api/run` فیلدهای اختیاری `{model, timeoutMs, maxSteps(1..100 int), maxReplans(0..10 int)}` → validation سنکرون → 400 (با `validIds`) پیش از شروع run.
- **UI:** select مدل از `/api/models` (پیش‌فرض = `model` همان `/api/health` — ترتیب resolve دو درخواست بی‌اثر است)، پنل تاشوی «Advanced» (timeout/max steps/max replans، خالی = پیش‌فرض سرور)، و نام مدل انتخابی در هدر مودال پلن.

**تست‌ها (۹ عدد جدید):** `src/server/__tests__/u3-run-options.test.ts` (۶ عدد e2e با planner/execution mock): `model:'local-llama'` → مدل واقعیِ داده‌شده به `generateText` همان `llama3` است (و نه default سرور)؛ بدون فیلد → `gpt-4o` (رگرسیون)؛ id نامعتبر → 400 + `validIds` و **هیچ** plan/session/model-call؛ `timeoutMs/maxSteps` با spy روی `AgentRuntime.prototype.run` (اعداد دقیق)؛ `maxSteps:3` روی خود `stopWhen` SDK (`stepCountIs`) عددی تأیید می‌شود؛ فیلدهای عددی بدشکل → 400. `src/ai/__tests__/u3-run-options.test.ts` (۳ عدد unit): اولویت override بر config، fallback به config (wiring `maxSteps`)، و حذف کامل هر دو وقتی تنظیم نشده‌اند.
**Regression:** 506/506 تست سبز (32 فایل) + tsc سبز.

**انحراف/دامنه ثبت‌شده:** (1) مدل per-run روی **execution agentها** اعمال می‌شود (که مطابق گام ۱ همین پلن است: merge روی PlanRuntime). planner/reviewer/acceptance-checker مدلشان در constructor orchestrator bind می‌شود؛ تغییر آن‌ها per-run یک تغییر بزرگ‌تر (۳ کلاس) بود و خارج از دامنه U3 نگه داشته شد — کاندید فاز بعدی/اختیاری. (2) فیلد عددی `maxSteps` سقف ۱۰۰ و `maxReplans` سقف ۱۰ گرفت (پلن فقط «فیلد اختیاری» گفته بود) تا UI نتواند runtime را با عدد بی‌معنا ببندد؛ خارج از بازه → 400. (3) `InvalidModelError` به‌عنوان کلاس صادر می‌شود (به‌جای Error خام) تا مسیر CLI/کد دیگر هم بتواند type-check کند.

---

## فاز U3 — model و گزینه‌های run به‌ازای هر درخواست

**گام‌ها:**
1. **Orchestrator:** `run()` گزینه `runOverrides?: {modelId?, agentTimeoutMs?, maxSteps?, maxReplanningAttempts?}` — با `{...this.config, ...runOverrides}` PlanRuntime همان run ساخته می‌شود (بیلد runtime per-run از قبل این‌طور است). validation: modelId باید در `modelRegistry` باشد، وگرنه fail با لیست idهای معتبر.
2. `POST /api/run` فیلدهای اختیاری `{model, timeoutMs, maxSteps, maxReplans}` → runOverrides.
3. UI: فرم run — select **model** (از `/api/models`، پیش‌فرض = model server) + فیلدهای اختیاری تاشده «گزینه‌های پیشرفته».
4. مدل انتخابی در هدر مودال پلن نمایش داده شود (شفافیت).

**تست‌ها:** e2e mock — run با `model:'local-llama'` → mock model همان id را ببیند (spy)؛ model نامعتبر → 400 با لیست؛ timeout/maxSteps به runtime می‌رسند (spy)؛ بدون فیلدها → رفتار قدیمی (رگرسیون).

**معیارهای پذیرش:**
- [x] تغییر model per-run واقعاً model متفاوت را صدا می‌زند (تست spy عددی)
- [x] run بدون فیلدها با رفتار امروز **بی‌تفاوت** است
- [x] UI: select پر می‌شود و انتخاب به body می‌رسد
- [x] ≥۵ تست جدید سبز (۹ تست: ۶ e2e server + ۳ unit TaskRuntime)

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
- [x] تست صفر-side-effect سبز (sessions + plans هر دو بی‌تغییر)
- [x] مودال preview در UI feasibility/cycles را نشان می‌دهد
- [x] ≥۳ تست جدید سبز (۵ تست)

**فایل‌ها:** `src/server/routes/preview.ts` (جدید)، `public/{app.js,index.html}`، تست

---

### [🟢] فاز U4 — نتیجه (2026-09-24)

**نتیجه:** endpoint جدید `POST /api/preview` (`src/server/routes/preview.ts`، mount در `src/server.ts`):
- ورودی `{message}` (خالی/غیر-string → 400 بدون فراخوانی planner).
- موفق: `200 {ok:true, planId:null, plan, planText, feasibility, cycles}`.
- goal نامفهوم (planner `isClear:false`): `400 {error, questions[]}` — سؤال‌های **خام** planner (نه ۵۰۰، نه پیام فرمت‌شده).
- plan غیرقابل‌اجرا (feasibility/cycle): `200 {ok:false, plan, feasibility, cycles, error}` — چون این «نتیجه‌ی planning» است نه خطای درخواست؛ UI همان plan رد‌شده را render می‌کند.
- **صفر side-effect** تضمین‌شده: مسیر `previewPlan` نه session می‌سازد، نه interaction ثبت می‌کند، نه در planStore می‌نویسد، نه اجرا می‌کند.

**تغییر orchestrator (additive):** `previewPlan` علاوه بر `{ok,plan,planText,error}` حالا `needsClarification[]`، `feasibility` و `cycles` هم برمی‌گرداند (سه فیلد اختیاری؛ مصرف‌کننده‌های قبلی — CLI `--dry-run` — بدون تغییر رفتار).

**UI:** دکمه «Plan only» کنار Run؛ مودال در حالت preview: بنر زرد «Preview — nothing was saved…»، بلوک feasibility/cycles (✔/✖ + مسیر cycle)، جدول plan از خود پاسخ (بدون fetch)، ردیف Confirm/Reject مخفی و به‌جایش «Close preview»؛ هوک `decidePlan` در حالت preview بی‌اثر است.

**تست‌ها (۵ عدد، `src/server/__tests__/u4-preview.test.ts`):** خروجی کامل + `planId:null` و اثبات صفر-نوشتن (sessions=[]، plans=[]، محتوای `.ai-runtime` قبل/بعد یکسان، `generateText` صدا زده نشده)؛ تکرار preview → باز هم صفر state؛ goal نامفهوم → 400 با questions + صفر state؛ plan غیرقابل‌اجرا → 200 `{ok:false}` با feasibility.errors؛ بدنه خالی → 400 بدون فراخوانی planner.
**Regression:** 511/511 تست سبز (33 فایل) + tsc سبز. **Smoke زنده:** markup/app.js سرو می‌شوند؛ `POST /api/preview` روی سرور واقعی پاسخ 400+`questions` (planner بدون API key در sandbox در حالت clarification برمی‌گردد) و plans/sessions بدون تغییر.

**انحراف ثبت‌شده:** (1) برای نمایش feasibility/cycles لازم بود `previewPlan` گسترش یابد (پلن فقط «`orchestrator.previewPlan(message)` → `{plan, feasibility, cycles}`» را گفته بود) — تغییر additive و بدون شکستن CLI. (2) خطای planner (مثل نبود API key) در سرور به‌شکل 400+`questions` برمی‌گردد چون از مسیر `isClear:false` همین planner می‌آید؛ در CLI همان متن در خروجی dry-run چاپ می‌شود — رفتار یکسان، فقط status متفاوت با «خطای زیرساخت».

---

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
- [x] e2e کامل ۲-round clarification → confirm → done سبز
- [x] state machine: `planning → awaiting-clarification → planning → awaiting-confirmation → running` در تست polling قابل مشاهده
- [x] guard draft-plan فاز ۲۴ رگرسیون‌شده سبز (بدون تغییر در مسیر resume؛ تست‌های فاز ۲۴ سبز ماندند)
- [x] ≥۴ تست جدید سبز (۶ تست)

**فایل‌ها:** `src/ai/orchestrator.ts` (اگر C4 نباشد)، `src/server/routes/run.ts` (+state)، `src/server/sse.ts` (event جدید)، `public/app.js`، تست

---

### [🟢] فاز U5 — نتیجه (2026-09-24)

**نتیجه:** حلقه clarification تعاملی بدون تغییر در `sse.ts`/`stream.ts` (hub بر اساس key کار می‌کند و کلید می‌تواند runId باشد):
- **state جدید:** `awaiting-clarification` در `RunStateKind` + سه فیلد `clarificationQuestions/clarificationRound/clarificationResolver` در `RunState`؛ resolver هرگز روی wire سریالاِیز نمی‌شود.
- **`POST /api/run`:** `clarificationCallback` (همان امضای C4) → state = awaiting-clarification + انتشار رویداد SSE **`clarification`** روی **کانال runId** (`GET /api/stream/<runId>`) چون در این لحظه هیچ planId وجود ندارد (plan هنوز ساخته نشده)؛ payload: `{runId, questions, attempt, planId?}`.
- **`POST /api/runs/:runId/clarification`:** `{answers:{q:a}}` (همه‌ی سؤال‌ها باید non-empty باشند وگرنه `400 {missing}`) یا `{decline:true}` (= لغو run با semantics C4). `404` برای run ناشناس، `409` وقتی run در آن state نیست.
- **`GET /api/runs/:runId`:** در حالت انتظار، `clarificationQuestions` را هم برمی‌گرداند → کلاینتی که رویداد SSE را از دست داده (race بین POST و subscribe) با polling همان فرم را می‌سازد.
- **UI:** مودال سؤال‌ها (هر سؤال یک textarea، متن با `textContent` — ایمن در برابر HTML تزریقی مدل)، دکمه «Send answers» و «Don't answer (cancel run)»؛ SSE کانال run بلافاصله بعد از `POST /api/run` وصل می‌شود؛ دکمه‌ی Cancel در header در این state هم همان decline را می‌فرستد؛ بعد از ارسال، خط `clarified (round n)` در timeline.
- **رفع باگ واقعی (orchestrator):** اگر planner «unclear با صفر سؤال» برگرداند (مثلاً نبود API key)، قبلاً یک round خالی clarification باز می‌شد که کاربر هیچ راهی برای پاسخ به آن نداشت. حالا `needsClarification.length === 0` بلافاصله به گزارش failure (همان مسیر قبلی با متن خطاها) می‌رود. این رفتار CLI را هم بهتر می‌کند (prompt خالی نمایش داده نمی‌شود).

**تست‌ها (۶ عدد، `src/server/__tests__/u5-clarification.test.ts`):** زنجیره کامل run → awaiting-clarification → پاسخ‌ها → reviewer planner واقعاً prompt حاوی `CLARIFICATIONS FROM USER` و متن پاسخ‌ها می‌گیرد → awaiting-confirmation → confirm → done؛ رویداد زنده SSE روی کانال runId (round 2 با `attempt:2` و `questions` و `runId`)؛ decline → outcome cancelled؛ validation کامل پاسخ‌ها (400 با `missing` + بی‌اثر بودن درخواست‌های ناقص) + 409 + 404؛ «unclear بدون سؤال» → failure مستقیم بدون round؛ سقف round (۳) → failure با `3 clarification round(s)`.
**Regression:** 517/517 تست سبز (34 فایل) + tsc سبز. **Smoke زنده:** markup مودال + کد app.js سرو می‌شوند؛ روی سرور واقعی: run → `awaiting-clarification` → `decline` → `outcome: cancelled`.

**انحراف ثبت‌شده:** (1) کانال SSE رویداد clarification = **runId** (نه planId) — در لحظه‌ی پرسش هنوز planId وجود ندارد؛ payload شامل `runId` است و `planId` فقط اگر موجود باشد. (2) race «انتشار رویداد پیش از subscribe» با polling state حل شد (فیلد `clarificationQuestions` روی GET). (3) فاز یک endpoint کاربردی تر (decline) هم گرفت تا دکمه‌ی «پاسخ ندهم» طبق پلن واقعاً run را لغو کند.

---

---

## فاز U6 — usage + taskهای live

**گام‌ها:**
1. **usage:** `GET /api/usage?planId=` — از `usageAggregator.getPlanUsage(planId)` (getter عمومی کوچک در Orchestrator) + `GET /api/usage` (aggregated + شمارنده planها در این server). UI: خط usage در جزئیات plan + تب/بانر «مصرف این server».
2. **taskها:** `GET /api/runs/:runId/tasks` — از TaskRuntime همان run (status/summary/usage per task + running/pending counts) + `POST /api/runs/:runId/tasks/:taskId/cancel` (cancelTask — **همان پروسه، پس واقعی است**).
3. UI: در پانل run فعال — لیست taskها با badge وضعیت + دکمه Cancel روی تکلیف + شمارنده‌ها؛ بعد از `run:done` جدول نهایی taskها (از رویدادهای timeline).

**تست‌ها:** usage mock = جمع دقیق usageهای mock (عدد)؛ task list وسط run (mock execution آهسته) وضعیت درستی نشان می‌دهد؛ cancel تکلیف → task cancelled + run با بقیه ادامه/تکمیل؛ usage بعد از restart server خالی (رسم کردن رفتار document شده).

**معیارهای پذیرش:**
- [ ] `/api/usage?planId` اعداد = جمع usage mockها (تست عددی)
- [x] cancel task واقعاً آن task را لغو می‌کند (spy روی TaskRuntime)
- [x] UI task list + cancel button در smoke
- [x] ≥۵ تست جدید سبز (۵ تست)

**فایل‌ها:** `src/ai/orchestrator.ts` (getter)، `src/server/routes/{run,usage}.ts`، `public/app.js`، تست

---

### [🟢] فاز U6 — نتیجه (2026-09-24)

**نتیجه:** endpointهای جدید در `src/server/routes/usage.ts` (mount در `src/server.ts`):
- `GET /api/usage?planId=P` → `{planId, promptTokens, completionTokens, totalTokens, taskCount}` از `usageAggregator.getPlanUsage(P)`؛ `GET /api/usage` → summary سراسری همین پروسه (شامل `byPlan`/`byAgent`)؛ `planId` خالی → 400.
- `GET /api/runs/:runId/tasks` → `{runId, planId, tasks[], counts{total,pending,running,completed,failed,cancelled}}`؛ taskها بر اساس `task.planId` همان planِ run فیلتر میشوند (TaskRuntime بین runها مشترک است — تصمیم U3 برای سالم ماندن resource lock). خروجی wire فقط summary دارد (بدون prompt/result کامل) تا transcript نشت نکند.
- `POST /api/runs/:runId/tasks/:taskId/cancel` → cancel واقعی در همان پروسه (`TaskRuntime.cancelTask` → abort در-flight `generateText`)؛ scope-check: task فقط از طریق runِ مالک plan قابل لغو است (وگرنه 404)، task ترمینالشده → 409.

**UI:** پنل «Tasks» بالای chat (فقط در جریان run): شمارندهها (`n/m done · k running · …`)، خط usage همان plan، badge وضعیت (⏳⚙︎✔✖⏹) و دکمهی Cancel برای taskهای pending/running. شمارندهی «Server usage» در sidebar footer (هر ۳۰ ثانیه + بعد از هر run). بعد از اتمام run جدول نهایی باقی میماند؛ «New session» پنل را ریست میکند.

**تستها (۵ عدد، `src/server/__tests__/u6-usage-tasks.test.ts`):** جمع دقیق توکنهای mock (۲ task × ۱۵ = ۳۰؛ هم per-plan، هم aggregate، و plan ناشناس = صفر)؛ لیست taskها با status/planStepId/usage و شمارندههای درست و بدون نشتی prompt؛ **cancel واقعی وسط run** (spy روی `TaskRuntime.prototype.cancelTask` + `counts.running === 1` در لحظهی لغو + رسیدن run به پایان + 409 برای لغو مجدد)؛ scope (task یک run از طریق run دیگر → 404)؛ in-memory بودن aggregator (سرور تازه = صفر).
**Regression:** 522/522 تست سبز (35 فایل) + tsc سبز. **Smoke زنده:** `/api/usage` (+ 400 برای planId خالی)، `/api/runs/:id/tasks` با shape درست، 404 برای run/task ناشناس.

**انحراف ثبتشده:** (1) پلن «getter عمومی کوچک در Orchestrator» را گفته بود — `orchestrator.usageAggregator` از قبل `public readonly` بود، پس getter جدید لازم نشد (کمترین تغییر). (2) taskها بر اساس `planId` فیلتر میشوند نه با reference per-run — همان معماری مشترک TaskRuntime (U3). (3) endpoint aggregate بدون query (که پلن خواسته بود) بهصورت `GET /api/usage` پیاده شد.


---

## فاز U7 — session label + observability follow

**گام‌ها:**
1. `PATCH /api/sessions/:id {label?}` → (addLabel از C3 اگر موجود نباشد، اینجا تعریف می‌شود) → session بازمحورده. UI: rename inline در sidebar (دو کلیک / آیکون مداد).
2. `GET /api/observability/stream?planId=` — SSE از همان لاگ (heartbeat + tail اولیه + خطوط جدید با fs.watch — reuse الگوی `followLog`). UI: دکمه «Follow log» در جزئیات plan (اختیاری-پیشرفته، در منوی plan).
3. `DELETE /api/sessions/:id` label را هم پاک کند (هم‌الگویی) — رگرسیون.

**تست‌ها:** PATCH label persist (store reload) + label خالی/طولانی ۴۰۰؛ stream: خطوط اولیه + خط جدید بعد از log (تست با نوشتن همزمان) + abort تمیز؛ delete با label رگرسیون.

**معیارهای پذیرش:**
- [x] label بعد از restart server حفظ است (persist تست‌شده)
- [x] SSE follow حداقل ۱ خط جدید را می‌فرستد (تست race-free)
- [x] ≥۴ تست جدید سبز

**فایل‌ها:** `src/server/routes/{sessions,stream}.ts`، `public/app.js`، `src/ai/runtime/session-store.ts` (اگر C3 نباشد)، تست

---

### [🟢] فاز U7 — نتیجه (2026-09-24)

**نتیجه:**
- `PATCH /api/sessions/:id {label}` → همان `sessionStore.setLabel` فاز C3 (یک implementation مشترک CLI/UI)؛ label trim می‌شود، `""` پاکش می‌کند، `>120` کاراکتر → 400، session ناشناس → 404. persist سنکرون است (`saveSession` → `session.json`) و تست با store تازه از دیسک تأییدش می‌کند.
- `DELETE /api/sessions/:id` حالا `label: null` را در پاسخ برمی‌گرداند و تست رگرسیون ثابت می‌کند label با session می‌رود (store فایل را پاک می‌کند).
- `GET /api/observability/stream[?planId]` — SSE با **همان `followLog` CLI** (`src/cli/commands/logs.ts`؛ فقط `readEntries` export شد تا یک implementation مشترک باشد): پیام‌های `entry` برای backlog محدود (۵۰ خط آخر، فیلتر planId)، سپس `tail-end` و بعد خطوط جدید زنده از `fs.watch` (با re-sync روی truncation/rotation) + heartbeat ۱۵ ثانیه‌ای.
- **UI:** rename اینلاین در sidebar (آیکون ✎ روی hover، `window.prompt`، سپس refresh؛ عنوان header هم label را نشان می‌دهد)، و پنل تاشوی «Observability log» بالای chat با دکمه‌های Follow/Stop و Clear (EventSource؛ اگر run فعالی planId داشته باشد خودکار روی همان plan فیلتر می‌شود).

**تست‌ها (۵ عدد، `src/server/__tests__/u7-label-follow.test.ts`):** set/persist (با `FileSessionStore` تازه از دیسک) + trim + پاک‌کردن؛ ۴ حالت خطا (بدنه‌ی بی‌label، label غیر-string، >120، session ناشناس) و بی‌اثر بودنشان؛ DELETE + regression label؛ استریم: backlog فیلترشده (خط plan دیگر نمی‌آید) + `tail-end` + **خط جدید زنده بدون reconnect** (تست race-free با polling) + abort تمیز؛ `planId` بدشکل → 400.
**Regression:** 527/527 تست سبز (36 فایل) + tsc سبز. **Smoke زنده:** PATCH واقعی (200 + label)، 400/404، استریم با `tail-end` و 400 برای planId خالی.

**انحراف ثبت‌شده:** (1) `readEntries` از `src/cli/commands/logs.ts` export شد (additive) تا منطق parse/tail تک‌نسخه بماند. (2) rename با `window.prompt` انجام می‌شود (پلن «rename inline» گفته بود) — بدون input درون‌خطی، سازگار با سبک vanilla و کم‌ریسک؛ UX آن یک کامنت بالای تابع مستند شده است. (3) پنل log برای فیلتر خودکار به planId همان run فعال وصل می‌شود (پلن فقط «دکمه Follow log در جزئیات plan» گفته بود؛ اینجا پنل مستقل با فیلتر خودکار پیاده شد).


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
| U1 config parity | 🟢 | کامل شد 2026-09-24 — نتایج در زیر |
| U2 registry | 🟢 | کامل شد 2026-09-24 — ۶ endpoint + پنل Registry در sidebar؛ ۹ تست؛ انحراف: تست success مسیر MCP با mock کنترل‌شونده connector (سرور واقعی MCP در sandbox وجود ندارد؛ منطق connector در فاز ۲ تست شده) |
| U3 run overrides | 🟢 | کامل شد 2026-09-24 — `RunOverrides` تا `AgentRuntime.run()`؛ ۹ تست؛ باگ جانبی: `OrchestratorConfig.maxSteps`/`--max-steps` که مرده بودند وصل شدند |
| U4 preview | 🟢 | کامل شد 2026-09-24 — `POST /api/preview` (planId:null، صفر side-effect) + دکمه «Plan only» و مودال read-only با feasibility/cycles؛ ۵ تست |
| U5 clarification | 🟢 | کامل شد 2026-09-24 — state `awaiting-clarification` + endpoint پاسخ‌ها + رویداد SSE روی کانال runId + مودال سؤال‌ها؛ ۶ تست؛ باگ رفع‌شده: round خالی وقتی planner «unclear بدون سؤال» برمی‌گرداند |
| U6 usage + tasks | 🟢 | کامل شد 2026-09-24 — `/api/usage[?planId]` + `/api/runs/:id/tasks` + cancel واقعی task؛ پنل Tasks و شمارندهی Server usage در UI؛ ۵ تست |
| U7 label + follow | 🟢 | کامل شد 2026-09-24 — `PATCH /api/sessions/:id` + rename اینلاین؛ `GET /api/observability/stream` (reuse `followLog`) + پنل Follow log؛ ۵ تست |
| U8 docs + regression | ⬜ | |

**Baseline:** 451/451 تست (27 فایل) · **هدف انتها:** ~451 + ≥۳۶ تست جدید
