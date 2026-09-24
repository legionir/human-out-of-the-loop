# پلن اجرایی نسخه ۲ — Hardening v2 + CLI + UI (فازهای ۱۸ تا ۲۵)

**تاریخ:** 2026-09-23
**مبنع:** 
- `CODE_QUALITY_AUDIT.md` (B1-B12, S1-S6, P1-P12, Q1-Q10)
- `DEEP_AUDIT_PATH_BUGS.md` (14 مورد)
- `CODE_QUALITY_AUDIT_DEEP_DIVE.md` (12 مورد)
- `messages.md` (تاریخچه بحث CLI/UI/Session)

**وضعیت فعلی:** 17/17 فاز 🟢، 334 تست سبز، اما 40+ باگ/بهبود شناسایی شده
**پیشرفت (2026-09-24):** **تمام فازهای این پلن (۱۸–۲۶) کامل 🟢** و پلن‌های تکمیلی CLI (C1–C5) و UI (U1–U8) نیز کامل — **527 تست سبز (۳۶ فایل)**، tsc سبز، smoke زنده CLI + UI.
**سیاست Breaking:** ✅ مجاز (طبق تصمیم کاربر) — `randomUUID()`, حذف `globalEventBus` fallback, الزامی شدن `projectRoot`

---

## ۱. طبقه‌بندی کامل (Deduplicated — 42 مورد یکتا)

### 🔴 دسته A: Path Security & Workspace Isolation — 9 مورد (P0 بحرانی)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| PATH-01 | B3, A1, 1 | `read-file.ts:13` | `validateWorkspacePath(filePath)` بدون `projectRoot` → fallback `process.cwd()` | 🔴 P0 |
| PATH-02 | B3, A1, 2 | `write-file.ts:13` | مشابه PATH-01 | 🔴 P0 |
| PATH-03 | B1, A2, 3 | `search-code.ts:51` | `path.resolve(process.cwd(), dir)` بدون هیچ validation + `path.relative(process.cwd())` leak | 🔴 P0 |
| PATH-04 | B2, A3, 4 | `git-status.ts:20` | `path.resolve(process.cwd(), dir)` بدون validation | 🔴 P0 |
| PATH-05 | Deep 5, F | `skill-registry.ts:112` | `path.resolve(skillDir, instr)` بدون boundary check — `../../etc/passwd` از JSON | 🟠 P1 |
| PATH-06 | Deep 6, Q4 | `plan-store.ts:47`, `session-store.ts:54` | `replace(/[^...]/g,'_')` → collision (`plan:1` == `plan_1`) | 🟡 P2 |
| PATH-07 | S2 | `path-security.ts:13` | `path.resolve` symlink را دنبال نمی‌کند — bypass via symlink | 🟠 P1 |
| PATH-08 | S3 | `path-security.ts:14` | Windows case-insensitive bypass | 🟡 P2 |
| PATH-09 | A, 5 | `path-security.ts:36` | `workspaceRoot ?? process.cwd()` باید الزامی شود، نه optional | 🟠 P1 |

**ریشه مشترک:** عدم تزریق `projectRoot` از `OrchestratorConfig`

---

### 🔴 دسته B: Config Wiring & Dual Source — 8 مورد (P0 بحرانی)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| CFG-01 | Q6, Deep E, 7 | `orchestrator.ts:239` | هاردکد `localToolDefs` vs `bootstrapTools()` که `registry/tools/*.json` را می‌خواند — Law 16 نقض | 🟠 P1 |
| CFG-02 | B7 | `orchestrator.ts:159-170` | `bootstrapCatalogTools` دوبار صدا زده می‌شود | 🟡 P2 |
| CFG-03 | Deep B1 | `orchestrator.ts:149` | `maxDelegationDepth` ذخیره می‌شود اما استفاده نمی‌شود | 🔴 P0 |
| CFG-04 | Deep B2 | `orchestrator.ts:289` | `DelegationGuard` هرگز instantiate نمی‌شود → `delegate_task` بدون guard | 🔴 P0 |
| CFG-05 | Deep C | `orchestrator.ts:148` | `agentTimeoutMs` ذخیره می‌شود اما به `AgentRuntime` پاس داده نمی‌شود (همیشه 120s) | 🟠 P1 |
| CFG-06 | Deep D | `orchestrator.ts:179` | `RateLimiter` با `new RateLimiter()` بدون config — `maxConcurrentPerProvider`, `maxRetries`, `baseBackoffMs`, `maxBackoffMs` از `OrchestratorConfig` خوانده نمی‌شود | 🟡 P2 |
| CFG-07 | Deep D | `CONFIGURATION.md` vs `OrchestratorConfig` | فیلدهای مستند شده (`maxSteps`, `contextBudgetChars`, `connectTimeoutMs`, `maxConcurrentPerProvider`, ...) در تایپ `OrchestratorConfig` نیستند | 🟡 P2 |
| CFG-08 | 2.3 | `openai-provider.ts:15`, `anthropic-provider.ts:14`, `mcp-connector.ts:53` | `process.env` مستقیم — per-Orchestrator env injection ندارد | 🟡 P2 |

---

### 🔴 دسته C: Singleton & Global State — 2 مورد (P0)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| SING-01 | Deep 8 | `event-bus.ts:148`, `task-runtime.ts:142`, `agent-runtime.ts:79` | `globalEventBus` مشترک بین تمام Orchestratorها → ایزولاسیون شکسته | 🟠 P1 |
| SING-02 | Deep 9 | `agent-runtime.ts:301` | `agentRuntime` singleton مشترک | 🟡 P2 |

---

### 🔴 دسته D: ID Generation & Collision — 6 مورد (P1)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| ID-01 | Deep 10 | `session.ts:52` | `session_${now}_${Math.random()}` → collision + predictable | 🟡 P2 |
| ID-02 | Deep 10 | `session.ts:63` | `interaction_${Date.now()}_${Math.random()}` | 🟡 P2 |
| ID-03 | Deep 10 | `plan.ts:113` | `plan_${Date.now()}` → collision در re-planning سریع | 🟡 P2 |
| ID-04 | Deep 11 | `delegate-task.ts:203` | `dynamic_${persona}_${Date.now()}` | 🟡 P2 |
| ID-05 | task-control-tools | `task-control-tools.ts:43` | `pending_${agentId}_${Date.now()}` | 🟡 P2 |
| ID-06 | plan-generator | `plan-generator.ts:66`, `planner.ts:138` | `plan_${Date.now()}` | 🟡 P2 |

**فیکس واحد:** همه → `randomUUID()` از `node:crypto`

---

### 🔴 دسته E: Persistence & Atomicity — 4 مورد (P0)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| PERS-01 | B12 | `plan-store.ts:52`, `session-store.ts:75` | `writeFileSync` مستقیم → concurrency corrupt | 🔴 P0 |
| PERS-02 | B12 | `session-store.ts:74` | `saveSession` ورودی را mutate می‌کند (`lastActiveAt`) | 🟡 P2 |
| PERS-03 | P5 | `plan-store.ts:62`, `session-store.ts:68` | `JSON.parse(JSON.stringify())` برای deep clone → slow + Date از دست می‌رود | 🟡 P2 |
| PERS-04 | - | `plan-store.ts`, `session-store.ts` | بدون file locking | 🟡 P2 |

---

### 🟠 دسته F: Timer & Resource Leaks — 3 مورد (P1)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| LEAK-01 | B5 | `mcp-connector.ts:168` | `setTimeout` بدون `clearTimeout` در `connectServer` | 🟠 P1 |
| LEAK-02 | B6 | `agent-runtime.ts:110` | `setTimeout` بدون `clearTimeout` در `run()` | 🟠 P1 |
| LEAK-03 | P6 | `mcp-connector.ts:138` | `import('@ai-sdk/mcp')` dynamic در هر `connectServer` | 🟡 P2 |

---

### 🟠 دسته G: Correctness & Logic — 8 مورد (P1)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| CORR-01 | B4 | `base-registry.ts:60` | `tryRegister` هرگز `ZodError` برنمی‌گرداند (always undefined) | 🟠 P1 |
| CORR-02 | B8 | `orchestrator.ts:shutdown` | `destroy()` قبل از `waitForAll()` → events از دست می‌روند | 🟠 P1 |
| CORR-03 | B9 | `usage-aggregator.ts:49` | `planId: task.planStepId` → `byPlan` همیشه اشتباه | 🟠 P1 |
| CORR-04 | B10 | `acceptance-checker.ts:31` | Race condition — گوش دادن به `agent:completed` هم‌زمان با `TaskRuntime` | 🟠 P1 |
| CORR-05 | B11 | `streaming-manager.ts:108` | `planId: event.taskId` → کلاینت فکر می‌کند planId=taskId | 🟠 P1 |
| CORR-06 | Q9 | `plan.ts:isPlanTerminal` | فقط `done`/`failed` terminal است، `cancelled` نیست | 🟡 P2 |
| CORR-07 | Q8 | `review.ts` | `usage` optional اما orchestrator همیشه set می‌کند | 🟢 P2 |
| CORR-08 | Q3 | `task-control-tools.ts:25` | `instanceof Object` همیشه true → overload گیج‌کننده | 🟡 P2 |

---

### 🟠 دسته H: Security Extended — 6 مورد (P1)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| SEC-01 | B1 | `search-code.ts:52` | ReDoS via `new RegExp(pattern)` | 🔴 P0 |
| SEC-02 | S6 | `search-code.ts:73` | silent skip unreadable files → hides permission errors | 🟡 P2 |
| SEC-03 | S4 | `mcp-connector.ts:82` | `sanitiseError` فقط tokenهای >8 کاراکتر را redact می‌کند | 🟠 P1 |
| SEC-04 | S5 | `observability-logger.ts:115` | `redactPayload` فقط exact match → `myApiKey` redact نمی‌شود | 🟠 P1 |
| SEC-05 | Deep 13 | `read-file.ts:18`, `write-file.ts:31` | return absolute path → info leak به LLM | 🟡 P2 |
| SEC-06 | Deep 14 | `search-code.ts:64` | `path.relative(process.cwd())` leak + wrong root | 🟡 P2 |

---

### 🟡 دسته I: Performance — 8 مورد (P2)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| PERF-01 | P1 | `plan-runtime.ts:274` | `countDependents` O(R*(V+E)) per iteration → memoize | 🟠 P1 |
| PERF-02 | P2 | `agent-factory.ts:336` | `JSON.stringify` برای cache comparison | 🟡 P2 |
| PERF-03 | P3 | `task-runtime.ts:196` | `filter(pending)` کل tasks هر بار O(n) → maintain pending Set | 🟡 P2 |
| PERF-04 | P4 | `observability-logger.ts:112` | `appendFileSync` sync blocking → buffered async | 🟠 P1 |
| PERF-05 | P7 | `search-code.ts:22` | `walkDir` همه فایل‌ها را جمع می‌کند قبل از match → no early exit | 🟡 P2 |
| PERF-06 | P8 | `plan-store.ts:67`, `session-store.ts:83` | `readdirSync` هر بار برای list | 🟢 P2 |
| PERF-07 | P12 | `tool-registry.ts:78` | `getToolsByIds` هر بار new object → LRU cache | 🟢 P2 |
| PERF-08 | P10 | `event-bus.ts:100` | `Set` dedup allocation در hot path | 🟢 P2 |

---

### 🔵 دسته J: Code Quality — 8 مورد (P2)

| ID | منبع | فایل | توضیح | شدت |
|----|------|------|--------|-----|
| QUAL-01 | Q1 | `agent-runtime.ts:204,225`, `orchestrator.ts:294`, ... | `any` 12 مورد در runtime | 🟡 P2 |
| QUAL-02 | Q2 | `observability-logger.ts:137`, `event-bus.ts:120`, `acceptance-checker.ts:49`, `orchestrator.ts:96` | `console.log/error` مستقیم → باید logger | 🟡 P2 |
| QUAL-03 | P11 | `planner.ts:144` | dead code `parseJsonResponse` | 🟢 P2 |
| QUAL-04 | Q10 | `tools/index.ts` | barrel incomplete | 🟢 P2 |
| QUAL-05 | Q5 | `orchestrator.ts` | `OrchestratorConfig` بدون Zod validation | 🟠 P1 |
| QUAL-06 | Q7 | `task-runtime.ts`, `agent-runtime.ts` | بدون `AbortSignal` برای cancellation واقعی | 🟠 P1 |
| QUAL-07 | P9 | `rate-limiter.ts:90` | `Math.random()` برای jitter → flaky tests | 🟡 P2 |
| QUAL-08 | - | - | ID collision قبلاً در دسته D | - |

---

### 🟢 دسته K: Missing Features — CLI & UI

| ID | منبع | توضیح | شدت |
|----|------|------|-----|
| FEAT-01 | messages.md | هیچ CLI اجرایی وجود ندارد — فقط `createCliConfirmCallback` | 🔴 P0 (برای UX) |
| FEAT-02 | messages.md | هیچ UI گرافیکی — فقط library | 🟡 P1 |
| FEAT-03 | messages.md | Session/Chat History بک‌اند دارد اما API REST ندارد | 🟡 P1 |

---

## ۲. پلن اجرایی — فازهای ۱۸ تا ۲۵ (هر فاز در یک execution stage کامل)

### اصول ثابت (از قوانین اصلی):
- هر فاز دقیقاً به ترتیب شماره، گام‌ها به ترتیب، هر فاز در یک stage کامل
- هیچ نیازمندی از 18 نیازمندی اصلی حذف نشود
- Breaking changes مجاز (طبق تصمیم کاربر) — migration note در هر فاز
- معیار پذیرش هر فاز قبل از رفتن به بعدی تأیید شود

---

### [🟢] فاز ۱۸: P0 Path Security & Workspace Isolation — کامل شد 2026-09-23

**نتیجه:** 4 factory (`createReadFileTool`/`createWriteFileTool`/`createSearchCodeTool`/`createGitStatusTool`) با تزریق `projectRoot`؛ `validateWorkspacePath` بدون fallback به process.cwd()؛ ReDoS guard (`regex-guard.ts` + حد 200 کاراکتر)؛ boundary check در `SkillRegistry`؛ return relative path در همه toolها. 18 تست جدید (`phase18.test.ts`) + 334 تست قبلی = 352 سبز، `tsc` سبز، grep `process.cwd()` در implementations = 0.
**انحراف ثبت‌شده (مورد سؤال ۵):** به جای dependency `safe-regex`، یک دیتکتور inline «nested quantifier» در `regex-guard.ts` پیاده شد (بدون dependency جدید، قابل تست؛ کلاس `(a+)+` که ۹۹٪ حمله‌های ReDoS واقعی هستند را می‌گیرد).

**هدف:** رفع تمام باگ‌های مسیر که منجر به data-loss یا bypass امنیتی می‌شوند.

#### گام ۱: Factory Injection برای Toolهای FS
- `src/ai/tools/implementations/read-file.ts` → `createReadFileTool(projectRoot: string)`
- `write-file.ts` → `createWriteFileTool(projectRoot: string)`
- `search-code.ts` → `createSearchCodeTool(projectRoot: string)` + حذف `process.cwd()`
- `git-status.ts` → `createGitStatusTool(projectRoot: string)`
- `path-security.ts`: `workspaceRoot` را اجباری کن (بدون default `process.cwd()`)

#### گام ۲: Path Validation کامل در search_code و git_status
- `search_code`: `validateWorkspacePath(directory, projectRoot)` + ReDoS guard (`pattern.length <= 200` + `safe-regex` check یا `RE2` یا حداقل timeout)
- `git_status`: همین + فقط اجازه داخل `projectRoot`
- `search_code`: `path.relative(projectRoot, file)` به جای `process.cwd()`

#### گام ۳: SkillRegistry Boundary Check
- `skill-registry.ts:112`: بعد از `path.resolve(skillDir, instr)` چک `isPathWithinWorkspace(mdPath, skillDir)`

#### گام ۴: Return Relative Path (Info Leak Fix)
- `read_file`, `write_file` → `filePath: path.relative(projectRoot, resolved)` به جای absolute

#### گام ۵: تست واحد + Hardening
- تست جدید: `Orchestrator({ projectRoot: '/a' })` + `process.cwd()='/tmp'` → Tool باید `/a` را استفاده کند، نه `/tmp`
- تست: `search_code` با `directory: '/etc'` → `PATH_TRAVERSAL_BLOCKED`
- تست: `skill.json` با `instructions: '../../../etc/passwd'` → throw

**معیار پذیرش:**
- هیچ `process.cwd()` در `src/ai/tools/implementations/` باقی نمانده (grep صفر)
- `search_code` و `git_status` با مسیر خارج از `projectRoot` بلاک می‌شوند
- `SkillRegistry` با `../../` throw می‌کند
- تمام 334 تست قبلی سبز + 5 تست جدید سبز
- `tsc --noEmit` سبز

---

### [🟢] فاز ۱۹: P0 Config Wiring, Singleton Removal, Atomic Persistence — کامل شد 2026-09-23

**نتیجه:** `eventBus` در `TaskRuntimeConfig` و `AgentRunOptions` الزامی شد (fallback‌های `?? globalEventBus` حذف)؛ `TaskRuntime` بدون config → `new AgentRuntime()` تازه (نه singleton)؛ `DelegationGuard` instantiate و به `delegate_task` وصل شد (`maxDelegationDepth` اعمال می‌شود)؛ `agentTimeoutMs` از OrchestratorConfig → TaskRuntime → `AgentRuntime.run`؛ `RateLimiter` با config ساخته می‌شود (۴ فیلد جدید در `OrchestratorConfig`)؛ `atomicWriteFileSync` (tmp+uuid+rename) در PlanStore/SessionStore + `structuredClone` + `saveSession` دیگر ورودی را mutate نمی‌کند؛ `bootstrapTools(registry/tools, registry, projectRoot)` جایگزین `localToolDefs` هاردکد شد (Law 16) و bootstrap catalog تکراری حذف شد. 13 تست جدید (`phase19.test.ts`) — 365 تست سبز، tsc سبز.

**هدف:** رفع دوگانگی پیکربندی و شکست ایزولاسیون.

#### گام ۱: حذف Global Singleton Fallback
- `event-bus.ts`: `globalEventBus` را deprecated کن (کامنت) — `Orchestrator` همیشه `new EventBus()` بسازد
- `agent-runtime.ts`: `agentRuntime` singleton را deprecated — `TaskRuntime` همیشه `new AgentRuntime()` اگر config ندهد
- `orchestrator.ts:142-144`: 
```ts
this.eventBus = new EventBus();
this.agentRuntime = new AgentRuntime();
```

#### گام ۲: Wire کردن DelegationGuard و Timeoutها
- `orchestrator.ts:initialize()`:
```ts
const delegationGuard = new DelegationGuard({ maxDepth: this.config.maxDelegationDepth, personaRegistry: this.personaRegistry });
this.delegationGuard = delegationGuard;
```
- پاس دادن به `delegate-task` deps: `delegationGuard`, `currentDelegationDepth: 0`
- `AgentRuntime` constructor: `timeoutMs` از `OrchestratorConfig.agentTimeoutMs`
- `TaskRuntime` باید `agentTimeoutMs` را به `AgentRuntime.run()` پاس دهد

#### گام ۳: Wire کردن RateLimiter Config
- `OrchestratorConfig` را گسترش بده: `maxConcurrentPerProvider`, `maxRetries`, `baseBackoffMs`, `maxBackoffMs`
- `RateLimiter` را با config بساز: `new RateLimiter({ maxConcurrentPerProvider: ..., ... })`

#### گام ۴: Atomic Write در PlanStore/SessionStore
- utility `atomicWriteFile(filePath, data)`:
```ts
const tmp = filePath + '.tmp.' + randomUUID();
fs.writeFileSync(tmp, data);
fs.renameSync(tmp, filePath);
```
- `saveSession` دیگر ورودی را mutate نکند — clone بساز، بعد `lastActiveAt` set کن
- `MemoryStore`: `structuredClone` به جای `JSON.parse(JSON.stringify())`

#### گام ۵: رفع هاردکد Tool Defs (Law 16)
- حذف `localToolDefs` هاردکد در `orchestrator.ts:239`
- استفاده از `bootstrapTools(path.join(registryDir, 'tools'), this.toolRegistry)`
- حذف دوبار صدا زدن `bootstrapCatalogTools`

**معیار پذیرش:**
- `grep -R \"globalEventBus\" src/ai --include=\"*.ts\" | grep -v \"__tests__\" | grep \"?? global\"` صفر
- دو `Orchestrator` با دو `projectRoot` متفاوت، EventBus مشترک ندارند (تست جدید)
- `DelegationGuard` در `orchestrator.ts` instantiate می‌شود و در تست delegation depth > max → `DELEGATION_DENIED`
- `agentTimeoutMs` واقعاً اعمال می‌شود (تست با timeout کوتاه → TIMEOUT)
- `PlanStore` atomic write: تست با concurrent writes → هیچ corrupt
- `tsc` + 334+ تست سبز

---

### [🟢] فاز ۲۰: P1 Correctness & Security Extended — کامل شد 2026-09-23

**نتیجه:** `tryRegister` حالا `ZodError` واقعی را بازمی‌گرداند (`RegistryValidationError`)؛ `shutdown()` اول `waitForAll()` و بعد unsubscribe می‌کند (تست: task در حال اجرا طی shutdown کامل می‌شود و usage ثبت می‌شود)؛ `Task.planId` جدید + `planId/planStepId` روی همه `AgentEvent`ها → `UsageAggregator.byPlan` و `StreamingManager` planId/stepId واقعی (ProgressEvent شامل هر سه `planId`/`stepId`/`taskId`)؛ **AcceptanceChecker بازطراحی شد**: دیگر EventBus listener ندارد — hook صریح `runAcceptanceChecks` در `PlanRuntime` بعد از هر `syncStepStatuses` (تست race با 10 task موازی: هر acceptance دقیقاً یک‌بار)؛ `clearTimeout` در `finally` برای `McpConnector.connectServer` و `AgentRuntime.run` (تست fake-timers: 0 pending timer)؛ `path-security`: چک symlink با `realpathSync` (فرار از workspace با symlink فایل/دایرکتوری بلاک می‌شود) + مقایسه case-insensitive در Windows؛ آستانه redact فرگمان‌های کوتاه در `sanitiseError` از 8 به 4؛ `redactPayload` substring match. 23 تست جدید (`phase20.test.ts`) + بازنویسی تست‌های event-driven phase11 به مدل hook = 389 تست سبز، tsc سبز.
**انحراف ثبت‌شده:** (1) برای گام ۵ (CORR-05) به جای map جداگانه در StreamingManager، `planId/planStepId` مستقیم روی `AgentEvent` thread شد (تصویه‌تر؛ ProgressEvent شامل هر دو `planId` و `taskId` هم می‌شود — گزینه دوم معیارپذیری). (2) `wireAcceptanceChecker`/`plan-runtime-hooks.ts` حذف شد (dead code پس از hook صریح). (3) CORR-08 (`instanceof Object`) که در گام‌های فاز ۲۰ صریح نبود، در همین فاز به‌عنوان type guard واقعی (`isBareTaskRuntime`) فیکس شد.

**هدف:** رفع باگ‌های منطقی و امنیتی باقی‌مانده P0/P1.

#### گام ۱: base-registry tryRegister
- `tryRegister` باید `parsed.error` را برگرداند، نه `err instanceof ZodError`

#### گام ۲: Orchestrator.shutdown Order
- `await waitForAll()` قبل از `destroy()`

#### گام ۳: UsageAggregator planId Fix
- `Task` اسکیما فیلد `planId?: string` اضافه کن
- `PlanRuntime.dispatchStep` هنگام `createTask`، `planId` را پاس بده
- `UsageAggregator.record` از `task.planId` بخواند، نه `planStepId`

#### گام ۴: AcceptanceChecker Race Fix
- به جای subscribe به EventBus، یک hook صریح در `PlanRuntime` بعد از `syncStepStatuses`:
```ts
// plan-runtime.ts
private async afterStepSync(plan, step) {
  const task = this.taskRuntime.getResult(step.taskId);
  const judgment = await this.acceptanceChecker.checkStep(step, task);
  ...
}
```
- `AcceptanceChecker` دیگر EventBus listener نداشته باشد، فقط `checkStep()` public

#### گام ۵: StreamingManager planId Fix
- `StreamingManager` باید `taskId → planId` map را از `PlanRuntime` بگیرد، نه `taskId` را به عنوان `planId` استفاده کند
- یا `ProgressEvent` شامل هر دو `planId` و `taskId` باشد

#### گام ۶: Timer Leak Fix
- `McpConnector.connectServer`: `const timer = setTimeout(...); try { await race } finally { clearTimeout(timer) }`
- `AgentRuntime.run`: همین

#### گام ۷: Security Extended
- `path-security.ts`: `realpathSync` برای symlink check (یا `fs.realpathSync` + `isPathWithinWorkspace` روی realpath)
- Windows case-insensitive: `process.platform === 'win32' ? toLowerCase() : ...`
- `sanitiseError`: تمام مقادیر env با طول >4 redact شوند، بدون شرط `>8`
- `redactPayload`: substring match: `lowerKey.includes('apikey') || lowerKey.includes('token') || ...`

**معیار پذیرش:**
- `tryRegister` با schema نامعتبر → `reason: 'validation'` + `zodError` defined
- `shutdown()` → tasks کامل می‌شوند قبل از unsubscribe
- `UsageAggregator.byPlan[planId]` درست پر می‌شود (تست جدید)
- `AcceptanceChecker` race: تست با 10 task موازی → همه acceptance check می‌شوند
- `StreamingManager` planId درست
- Timer leak: تست با fake timers → no pending timers after success
- Symlink: تست با symlink به `/etc` → blocked
- `tsc` + تست‌ها سبز

---

### [🟢] فاز ۲۱: P2 Performance Optimization — کامل شد 2026-09-23

**نتیجه:** `PERF-01`: `countDependents` (BFS جداگانه per ready-step) با یک DFS memoized روی گراف معکوس جایگزین شد — `computeTransitiveDependentCounts` در هر `getReadyStepsPrioritized` یک‌بار اجرا می‌شود؛ بنچمارک: 125 step / 50 ready → بازدیدهای `plan.steps` از 127 (فرمول پایین؛ comparator واقعی sort BFS را چند بار تکرار می‌کرد) به **4** رسید (معیار <500 با 125× حاشیه). `PERF-02`: `AgentCache` حالا sha256 روی `stableStringify(def)` (JSON canonical با مرتب‌سازی کلیدها) store می‌کند — get روی def با 10KB payload به‌طور میانگین **<0.2ms** (معیار <1ms) و hit به ترتیب کلیدها invariant است (با `JSON.stringify` قبلی miss می‌شد). `PERF-03`: `pendingIds`/`runningIds` Set در `TaskRuntime` — شمارنده‌ها O(1) و `scheduleNext` فقط روی pending iterate می‌کند؛ بنچمارک: 1000 task (997 pending، 3 running، lock conflict) → `scheduleNext` **<0.5ms** (معیار <2ms). `PERF-04`: fd reuse — `openSync` یک‌بار + `writeSync` per entry (سینک و دوام حفظ شد؛ گزینه دومِ خودِ پلن)؛ 1000 event در **<10ms** (معیار <100ms)؛ `close()` idempotent اضافه شد و از `Orchestrator.shutdown()` صدا زده می‌شود. `PERF-05`: `walkDir` دو-فازی حذف شد — `searchFiles` تک-گذر با early exit سه‌سطحی (entry، per-entry، per-line)؛ بنچمارک با readdir mock: درخت 2 دایرکتوری (1 فایل + 100 فایل) با `maxResults:1` → **دقیقاً 1 readFile** (قبلاً 101) و دایرکتوری دوم اصلاً list نمی‌شود. `PERF-07`: LRU `toolsCache` (cap 64) در `getToolsByIds` با key = `ids.join(',')` — hit همان reference را برمی‌گرداند، eviction بعد از 64 کامبو، و `registerImplementation` کل cache را clear می‌کند. 13 تست جدید (`phase21.test.ts`) = **402 تست سبز** + tsc سبز.
**انحراف ثبت‌شده:** (1) `PERF-01` به‌جای precompute یک‌بار در ابتدای `execute()` (متن گام ۱)، memoization در هر فراخوانی `getReadyStepsPrioritized` است — set وابسته‌ها با کامل‌شدن stepها تغییر می‌کند، بنابراین بازمحاسبه per-loop-iteration صحت دارد و همچنان O(V+E) با 4 بازدید `plan.steps`. (2) `PERF-04` گزینه async `createWriteStream` نرفت؛ گزینه دومِ خودِ پلن (fd reuse + `writeSync`) انتخاب شد تا دوام سینک (crash after log → entry روی disk) حفظ شود. (3) `PERF-06` (readdirSync list) و `PERF-08` (dedup emit) در دسته I هستند ولی گام فاز ۲۱ نیستند → در فاز ۲۱ بدون تغییر ماندند و در **فاز ۲۷** بسته شدند (`eaa8aa9`, `ca96332`).

**هدف:** بهبود پرفورمنس بدون تغییر رفتار.

#### گام ۱: PlanRuntime.countDependents Memoization
- Precompute `dependentsCount` یکبار در ابتدای `execute()` via reverse graph:
```ts
const dependentsMap = new Map<string, Set<string>>(); // stepId → all transitive dependents
// DFS memo
```

#### گام ۲: AgentCache Hash
- به جای `JSON.stringify(def)` → `createHash('sha256').update(stableStringify(def)).digest('hex')`
- یا version field اگر `def.version` اضافه شود

#### گام ۳: TaskRuntime Pending Set
- `private pendingIds = new Set<string>()`, `runningIds = new Set<string>()`
- `scheduleNext` فقط روی `pendingIds` iterate کند

#### گام ۴: ObservabilityLogger Buffered Async
- `createWriteStream` با buffering + queue، یا `fs.openSync` + `writeSync` با fd reuse
- `readAll()` همچنان sync برای تست‌ها، اما write async

#### گام ۵: search_code Early Exit
- `walkDir` به صورت generator یا callback که به محض `maxResults` رسید، recursion را قطع کند

#### گام ۶: ToolRegistry LRU Cache
- `private toolsCache = new Map<string, Record<string, Tool>>()` با key = `ids.join(',')`

**معیار پذیرش:**
- بنچمارک: 200 step با 50 ready → `countDependents` از 10k بازدید به <500
- `AgentCache` get با def بزرگ (10KB) <1ms (قبلاً ~5ms با stringify)
- `TaskRuntime` با 1000 task pending → `scheduleNext` <2ms
- `ObservabilityLogger` با 1000 events → <100ms (قبلاً ~800ms sync)
- تمام تست‌ها سبز

---

### [🟢] فاز ۲۲: Code Quality & Maintainability — کامل شد 2026-09-23

**نتیجه:** `Step 1`: `any` در runtime از 8 خط به **0** رسید (معیار <3) — دو نقطه ذکرشده در پلن (`agent-runtime`, `orchestrator.ts`) + سه متغیر کش SDK در `models/providers/*` + guard ساختاری در `task-control-tools.ts`. نکته: در AI SDK v7، `step.toolCalls` خودش تایپ‌شده است (`TypedToolCall[]`) — اصلاً نیازی به `ToolCallPart`/type guard نبود؛ `usage` با `LanguageModelUsage` تایپ شد با fallback برای mockهای شکل قدیمی (`promptTokens`). `Step 2`: `console.*` در runtime از 4 به **0** — `EventBus` یک sink اختیاری `onSubscriberError` دارد (Orchestrator آن را به `ObservabilityLogger.logSystemError` وصل می‌کند)؛ callback تأیید CLI و حالت `consoleOutput` لجر مستقیم روی `process.stdout.write` می‌نویسند (کانال user-facing، بدون console API)؛ fallback شکست-write در لجر silent شده (بهترین تلاش، crash نه). `Step 3`: `parseJsonResponse` dead code + import زائد `z` حذف. `Step 4`: `OrchestratorConfigSchema` (zod) دقیقاً مطابق پلن — constructor با مقدار نامعتبر `ZodError` throw می‌کند (12 کیس تست‌شده)؛ defaults schema اعمال می‌شوند. `Step 5`: `AgentRunOptions.signal` → `generateText({abortSignal})`؛ `TaskRuntime` یک `AbortController` per running task دارد؛ `cancelTask` روی task در حال اجرا **واقعی** abort می‌کند (تست با mock که signal را honor می‌کند: promise reject می‌شود، status 'cancelled' باقی می‌ماند و با failure اجرا-abortشده overwrite نمی‌شود)؛ `classifyError` کد `ABORTED` را برمی‌گرداند. `Step 6`: `isPlanTerminal` حالا statusهای terminal سطح-plan (`completed`/`failed-partial`/`cancelled`) را بدون بررسی stepها terminal می‌داند (قبل: plan لغوشده با stepهای pending resumable به نظر می‌رسید) + `Review.usage` required با default صفر (`emptyReviewUsage`) در همه builders (final-reviewer ×2، orchestrator ×4، تست‌ها). `Step 7`: `FilePlanStore`/`FileSessionStore` — filename = `sha256(id).slice(0,16) + '.json'`؛ تصادف `a/b` با `a_b` رفع شد (تست: 2 فایل مجزا + list() هر دو id را برمی‌گرداند) و traversal خارج از دایرکتوری store غیرممکن شد. 14 تست جدید (`phase22.test.ts`) شامل source-scan دائمی (console=0، any<3) = **416 تست سبز** + tsc سبز.
**انحراف ثبت‌شده:** (1) Step 1: به‌جز دو نقطه پلن، متغیرهای `providers/*` و `task-control-tools` هم فیکس شدند تا معیار <3 با حاشیه‌ای کافی و ماندگار باشد. (2) Step 2: برای «صفر بودن console» ، حالت `consoleOutput` و prompt تعاملی CLI روی `process.stdout.write` ماندند (حذفشان feature را می‌کُشید؛ console API نه) و `EventBus` به‌جای console.error از callback تزریقی استفاده می‌کند. (3) Step 4: فیلد `onProgress` (callback، از فاز ۱۹) در اسکیمای پلن نبود — به type تنظیمات با validation ساختاری اضافه شد؛ default `runtimeDir` چون وابسته به `projectRoot` است، در constructor محاسبه می‌شود نه در schema. (4) Step 7: map جداگانه `id → filename` نگه‌داری نشد — hash تابع خالص id است و map state اضافی برای sync می‌ساخت؛ `list()` فیلد `id` را از JSON هر فایل می‌خواند. (5) دو تست phase19 به قرارداد جدید تنظیم شدند: `maxBackoffMs` از 200 به 1000 (کف schema) و filename `p1.json` به شکل hash شده.

**هدف:** کاهش tech debt.

#### گام ۱: حذف any در Runtime
- `agent-runtime.ts:204`: `import type { ToolCallPart } from 'ai'` + type guard
- `orchestrator.ts:294`: `ResolvedAgent` به جای `any`
- هدف: `grep -R \"as any|: any\" src/ai --include=\"*.ts\" | grep -v __tests__ | wc -l` < 3

#### گام ۲: حذف console.* مستقیم
- `event-bus.ts:120`, `acceptance-checker.ts:49`, `observability-logger.ts:137`, `orchestrator.ts:96` → همه به `ObservabilityLogger`

#### گام ۳: Dead Code
- `planner.ts:parseJsonResponse` حذف

#### گام ۴: Zod Validation برای OrchestratorConfig
```ts
export const OrchestratorConfigSchema = z.object({
  projectRoot: z.string().min(1),
  persistent: z.boolean().default(false),
  runtimeDir: z.string().optional(),
  maxConcurrentTasks: z.number().int().min(1).max(100).default(5),
  maxConcurrentPerProvider: z.number().int().min(1).max(50).default(5),
  maxReplanningAttempts: z.number().int().min(0).max(10).default(3),
  agentTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxDelegationDepth: z.number().int().min(0).max(5).default(1),
  maxRetries: z.number().int().min(0).max(10).default(3),
  baseBackoffMs: z.number().int().min(100).default(1000),
  maxBackoffMs: z.number().int().min(1000).default(30000),
  maxSteps: z.number().int().min(1).max(100).default(20),
  contextBudgetChars: z.number().int().min(1000).default(120000),
  connectTimeoutMs: z.number().int().min(1000).default(10000),
  defaultModelId: z.string().default('gpt-4o'),
});
```

#### گام ۵: AbortSignal برای Cancellation
- `AgentRuntime.run({ signal?: AbortSignal })`
- `TaskRuntime.cancelTask` → `abortController.abort()`
- `generateText({ abortSignal })`

#### گام ۶: isPlanTerminal + review.ts
- `isPlanTerminal` شامل `cancelled` و `failed-partial`
- `review.ts` usage required با default

#### گام ۷: FileStore Collision Fix
- `filePath` با hash: `createHash('sha256').update(planId).digest('hex').slice(0,16) + '.json'` + نگهداری `id → filename` map

**معیار پذیرش:**
- `any` در runtime <3
- `console.*` در runtime صفر
- `OrchestratorConfig` با مقدار نامعتبر → ZodError throw در constructor
- `cancelTask` برای running task → واقعاً `generateText` abort می‌شود (تست با mock)
- `tsc` + تست‌ها سبز

---

### [🟢] فاز ۲۳: CLI — Full Featured مانند Claude Code CLI — کامل شد 2026-09-24

**نتیجه:** CLI کامل ساخته شد و با `bin: {"human-out-of-the-loop": "./dist/src/cli.js"}` قابل نصب است (shebang حفظ می‌شود؛ جریان consumer واقعی — `npm install` پکیج در پروژه دیگر + اجرای `node_modules/.bin/human-out-of-the-loop` — تست شد). وابستگی‌ها: `commander ^15`, `chalk ^6`, `ora ^9.4`, `inquirer ^14.2` (نسخه‌های stable جاری؛ `ora` نصب شد ولی خروجی progress به سبک Claude Code با خطوط stateful پیاده‌سازی شد — spinner نوار-تقدمی به معنای واقعی همان شمارنده `step x/y` است). ساختار دقیقاً مطابق پلن: `src/cli.ts` (entry + commander program) + `src/cli/commands/{run,sessions,plans,mcp,logs}.ts` + `src/cli/utils/{confirm,streaming,config,output}.ts`. `run "goal"` تمام پرچم‌های پلن را دارد: `--project-root --persistent --model --session --yes --verbose --dry-run` + `--timeout-ms --max-steps`. Dry-run از طریق روش عمومی جدید `Orchestrator.previewPlan()` (clarify→plan→feasibility→cycle؛ بدون persistence/confirm/execute). تأیید تعاملی با inquirer (جدول پلن + Yes/No + feedback)؛ `--yes` برای CI؛ non-TTY بدون `--yes` سریع با پیام راهنما خطا می‌دهد (hang نمی‌کند). Progress: `ProgressEvent`های `StreamingManager` به خطوط رنگ‌دار ترمینال (done سبز / failed قرمز / running زرد) با شمارنده `[x/y]` — برای این کار `totalSteps` به payload رویداد `plan:started` اضافه شد. `plans cancel` مستقیماً روی `FilePlanStore`+`CancellationManager` کار می‌کند (بدون Orchestrator سنگین) و با تغییر `isPlanTerminal` فاز ۲۲، وضعیت `cancelled` ذخیره‌شده برای resume اعتبار دارد. `plans resume` ابتدا `initialize()` می‌کند (registryها در آن load می‌شوند). `logs [--plan X] [--tail N] [--follow]` روی `.ai-runtime/observability.jsonl` فیلتر/تیل/فلاویوی می‌کند (follow با `fs.watch` + resync truncation؛ تابع `followLog` جدا شده تا تست‌پذیر باشد). `mcp list|test` روی `registry/mcp-servers/*.json` (auto-discovery از projectRoot). Config: `~/.human-out-of-the-loop/config.json` (persistent/defaultModel) + `.env` در projectRoot/cwd (هرگز env واقعی را overwrite نمی‌کند)؛ اولویت: flag > env > config. Exit codeها: 0 success/partial، 1 failure، 1 usage error (commander). 23 تست جدید (`cli.test.ts`) — e2e واقعی از طریق `main()` commander با mock مدل: dry-run بدون execute، `run --yes` کامل تا report + persistence + observability، non-TTY fail-fast، sessions list/show/delete، plans list/show/cancel/resume (resume step معلق باقی‌مانده را واقعاً execute می‌کند)، mcp list، logs tail/filter/follow-stream، global config persistent + .env precedence = **439 تست سبز (26 فایل)** + tsc سبز.
**انحراف ثبت‌شده:** (1) پلن `bin: "./dist/cli.js"` نوشته بود اما با `rootDir: "."` خروجی tsc در `dist/src/cli.js` قرار می‌گیرد — bin به مسیر واقعی اشاره می‌کند (بدون تغییر layout build). (2) `previewPlan()` در پلن نبود اما dry-run به آن نیاز داشت — روش عمومی جدید روی Orchestrator (همان پایپلاین run تا نقطه تأیید، بدون ذخیره). (3) `plan:started` پیش‌تر payload نداشت — `totalSteps` اضافه شد تا شمارنده `[x/y]` CLI کار کند (تغییر additive، مصرف‌کننده‌های قدیمی payload را می‌خوانند). (4) commander با `exitOverride` خودش خطا را چاپ می‌کند — لایه CLI دوباره چاپ نمی‌کند (وگرنه هر خطا دو بار می‌آمد). (5) `plans resume` بدون `initialize()` کار نمی‌کرد (registryها خالی: «Persona coder not found») — CLI صریحاً initialize می‌کند. (6) guard اجرای مستقیم entry با `realpathSync(argv[1])` مقایسه می‌شود — node entry نقطه‌اتصال ESM را realpath می‌کند ولی argv[1] لینک نمادین `.bin` را نگه می‌دارد؛ با مقایسه ساده، bin در consumer بی‌صدا exit 0 می‌شد. (7) npm از root-bin خود پکیج را در `node_modules/.bin` لینک نمی‌کند (رفتار استاندارد npm) — داخل ریپو `npx --no-install` کار نمی‌کند ولی consumer واقعی (تست‌شده) درست است. (8) تست‌ها keyهای API dummy می‌گذارند چون PROVIDER FACTORY هنگام ساخت مدل presence env var را لازم دارد (خود requestها mock هستند).

**هدف:** ساخت CLI کامل، نه فقط confirm.

**تصمیم کاربر:** CLI کامل مانند Claude Code CLI، ولی فعلاً باگ projectRoot فیکس شود و یک فاز کامل برای CLI ایجاد شود.

#### گام ۱: ساختار CLI
- `src/cli.ts` (entry)
- `src/cli/commands/run.ts`
- `src/cli/commands/sessions.ts`
- `src/cli/commands/plans.ts`
- `src/cli/commands/mcp.ts`
- `src/cli/utils/confirm.ts` (از `createCliConfirmCallback` موجود)
- `src/cli/utils/streaming.ts` (SSE → terminal spinner)
- `package.json`: `"bin": { "human-out-of-the-loop": "./dist/cli.js" }`, `#!/usr/bin/env node`

#### گام ۲: دستورات (مشابه Claude Code CLI)

```bash
# اجرای اصلی
human-out-of-the-loop run "Build login page" --project-root ./my-app --persistent --model gpt-4o

# با session
human-out-of-the-loop run "Continue" --session session_123 --project-root ./my-app

# مدیریت session
human-out-of-the-loop sessions list
human-out-of-the-loop sessions show session_123
human-out-of-the-loop sessions delete session_123

# مدیریت plan
human-out-of-the-loop plans list
human-out-of-the-loop plans show plan_abc
human-out-of-the-loop plans cancel plan_abc
human-out-of-the-loop plans resume plan_abc

# MCP
human-out-of-the-loop mcp list
human-out-of-the-loop mcp test <server-id>

# streaming + observability
human-out-of-the-loop logs --plan plan_abc --follow
human-out-of-the-loop logs --tail 100
```

#### گام ۳: UX مانند Claude Code
- Spinner برای هر step (ora یا custom)
- Progress bar برای کل Plan
- رنگ‌بندی: `chalk` — done سبز، failed قرمز، running زرد
- Confirm با `inquirer` یا `enquirer` — نمایش خلاصه Plan با جدول
- `--yes` flag برای auto-confirm (برای CI)
- `--verbose` برای نمایش tool calls
- `--dry-run` برای فقط Planning بدون اجرا

#### گام ۴: پیکربندی CLI
- `~/.human-out-of-the-loop/config.json` برای defaults
- `.env` support برای API keys
- `registry/` auto-discovery از `projectRoot`

#### گام ۵: تست CLI
- تست با `execa` یا mock — اجرای `run` با mock model → باید بدون crash تا report برود

**معیار پذیرش:**
- `npx human-out-of-the-loop run "test goal" --project-root ./ --dry-run` → Plan نمایش داده می‌شود، بدون اجرا
- `npx human-out-of-the-loop run "test" --yes --project-root ./` → بدون سوال، اجرا تا انتها (Human-Out-Of-Loop)
- `sessions list` → لیست sessionهای `.ai-runtime/sessions/`
- `plans list` → لیست planها
- `logs --follow` → streaming زنده
- `tsc` + تست‌ها سبز

---

### [🟢] فاز ۲۴: UI ساده — Express + SSE + HTML (قابل ارتقا) — کامل شد 2026-09-24

**نتیجه:** UI کامل و ساده (بدون React، طبق تصمیم کاربر) با `npm run server` روی http://localhost:3000 بالا می‌آید (زنده تست شد: health، HTML، static assets، sessions). ساختار دقیقاً طبق پلن: `src/server.ts` (factory + entry) + `src/server/sse.ts` (hub per-plan) + `src/server/routes/{sessions,plans,stream,run}.ts` + `src/server/types.ts` + `public/{index.html,app.js,style.css}`. همه 11 endpoint پلن پیاده و تست‌شده: sessions list/get/delete، plans list/get/cancel/resume/confirm، `GET /api/stream/:planId` (SSE واقعی — heartbeat، resync-safe)، `POST /api/run` + `GET /api/runs/:runId` (state machine: planning → awaiting-confirmation → running → done/error)، `GET /api/observability?planId&tail`. Frontend: sidebar sessionها (Continue from previous با کلیک)، chat history از interactions، input + Run (Ctrl+Enter)، checkbox «run without confirmation» (حالت HOOL)، **Plan modal با جدول steps** (persona/skills/tools/resources/acceptance) + دکمه Confirm/Reject + feedback، live timeline از SSE (رنگ‌بندی done/failed/running مطابق پلن)، report نهایی با render مارک‌داون امن (escape-first)، دکمه Cancel run. `express ^5.2.1` (stable جاری)؛ `supertest` + `tsx` devDependencies. امنیت (گام ۴): `projectRoot` فقط از config سرور (env `HOTL_PROJECT_ROOT`/flag) — تست صریح که تزریق `projectRoot` در body بی‌اثر است و store در روت attacker ساخته نمی‌شود؛ SSE فقط `toolName` دارد (بدون args — Law 14)؛ credentialها هرگز serialize نمی‌شوند. 11 تست جدید (`server.test.ts`) با supertest + fetch بومی برای SSE — e2e کامل با mock مدل: auto-run تا report + persistence، reject-confirm → cancelled بدون execute، SSE زنده `plan:started…plan:completed` + بررسی JSON payload، cancel/resume/observability/sessions، static frontend = **450 تست سبز (27 فایل)** + tsc سبز.
**انحراف ثبت‌شده:** (1) پلن endpoint «run state» نداشت؛ flow تعاملی بدون آن غیرقابل‌پیاده‌سازی بود (UI باید planId را پیش از confirm پیدا کند) — `POST /api/run` با 202 + `runId` و `GET /api/runs/:runId` اضافه شد. (2) امضای `confirmCallback` یک پارامتر اختیاری دوم `plan` گرفت (additive؛ CLI و callbackهای قدیمی بی‌تأثیر). (3) plan حالا در زمان **ساخت** (پیش از confirm) persist می‌شود تا مودال و plans list آن را ببینند؛ planهای rejectشده با status `draft` می‌مانند — عاقبت، `resumePlan` روی planهای `draft` refuse می‌کند (plan تأییدنشده executable نمی‌شود). (4) express 5 نصب شد (async handlers به‌طور خودی rejection را forward می‌کنند). (5) `npm run server` از `tsx` (devDep) روی src اجرا می‌شود؛ نسخه کامپایل‌شده `node dist/src/server.js` هم کار می‌کند. (6) گام ۵ «eventsource mock» با fetch بومی Node 22 + stream reader پیاده شد (بدون dependency اضافی). (7) دایرکتوری static با walk-up تا `public/index.html` پیدا می‌شود (عمق `src/` و `dist/src/` فرق دارد).

**هدف:** UI ساده ولی extensible، طبق تصمیم کاربر.

#### گام ۱: ساختار
- `src/server.ts` (Express server)
- `src/server/routes/sessions.ts`
- `src/server/routes/plans.ts`
- `src/server/routes/stream.ts` (SSE)
- `src/server/routes/run.ts`
- `public/index.html` (vanilla JS + SSE, بدون React برای سادگی اولیه)
- `public/app.js`
- `public/style.css`

#### گام ۲: API

```
GET  /api/sessions → list
GET  /api/sessions/:id → get
DELETE /api/sessions/:id
GET  /api/plans → list
GET  /api/plans/:id → get
POST /api/plans/:id/cancel
POST /api/plans/:id/resume
GET  /api/stream/:planId → SSE (text/event-stream)
POST /api/run → { message, sessionId?, projectRoot?, confirm: boolean }
GET  /api/observability?planId=&tail=
```

#### گام ۳: Frontend ساده (قابل ارتقا به React)

`index.html`:
- Sidebar: لیست Sessionها (از `/api/sessions`)
- Main: Chat history (interactions) + input box
- Plan confirmation modal: نمایش جدول steps با persona/tools/resources + دکمه Confirm/Cancel/Feedback
- Live progress: SSE → append به timeline (step started/completed/failed)
- Final report: markdown render

بدون React برای فاز ۲۴ — فقط vanilla JS + `fetch` + `EventSource` — تا dependency کم باشد و قابل ارتقا به Next.js در فاز ۲۵+ باشد.

#### گام ۴: امنیت UI
- تمام Tool args در SSE نمایش داده نشوند (فقط toolName) — Law 14
- Credentialها هرگز به frontend نروند
- Path traversal در API: `projectRoot` از query param نه، فقط از server config

#### گام ۵: تست
- تست API با `supertest`
- تست SSE با `eventsource` mock

**معیار پذیرش:**
- `npm run server` → http://localhost:3000 بالا می‌آید
- کاربر می‌تواند goal بنویسد → Plan modal می‌آید → Confirm → streaming زنده → report نهایی
- Session history قابل مشاهده و قابل ادامه (`Continue from previous`)
- `cancel_plan` از UI کار می‌کند
- هیچ credential در Network tab دیده نمی‌شود

---

### [🟢] فاز ۲۵: Final Hardening, Docs, Delivery — کامل شد 2026-09-24

**هدف:** مستندسازی تمام تغییرات breaking + scope audit نهایی.

#### گام ۱: مستندسازی Breaking Changes
- `src/ai/README.md` → بخش Migration Guide از 17 به 25
- `CHANGELOG.md` جدید: لیست تمام breaking changes (ID → randomUUID, globalEventBus removal, projectRoot mandatory)

#### گام ۲: به‌روزرسانی CONFIGURATION.md
- تمام فیلدهای جدید `OrchestratorConfig` با Zod schema + defaults
- جدول env vars + ceilings به‌روز

#### گام ۳: به‌روزرسانی CONTRIBUTING.md
- نحوه افزودن Tool جدید با factory pattern (`createMyTool(projectRoot)`)
- نحوه افزودن CLI command جدید

#### گام ۴: تست جامع نهایی
- `tsc --noEmit` سبز
- `vitest run` → 334 + ~50 تست جدید (برای P0/P1) سبز
- تست e2e با CLI + UI

#### گام ۵: Scope Audit نهایی
- جدول 18 نیازمندی + 42 باگ جدید → نگاشت به فازهای 18-25

**معیار پذیرش (بررسی‌شده):**
- [x] تمام 42 مورد در یکی از فازهای 18-25 قرار گرفته‌اند — جدول «Scope Audit نهایی» در `src/ai/CONFIGURATION.md` (دسته‌ی A–K → فاز + وضعیت + شواهد؛ PERS-04 در فاز ۲۷ نیز فیکس شد و دیگر مورد بازی ندارد)
- [x] مستندات معماری با پیاده‌سازی نهایی منطبق — Migration Guide در `src/ai/README.md`، جدول کامل `OrchestratorConfigSchema` در `CONFIGURATION.md` (تصحیح الگوی قدیمی Tool در `CONTRIBUTING.md` به factory pattern فاز ۱۸)
- [x] CLI و UI قابل اجرا بدون خواندن Runtime — بخش Web UI + جدول endpointها در `README.md`؛ command reference CLI به‌روز
- [x] تمام متغیرها/سقف‌ها مستند — envهای provider/MCP/سرور (`HOTL_*`) + جدول سقف‌ها شامل `maxSteps`, `maxClarificationRounds`, `redactKeys`, `random` (jitter)

**نتیجه:** `CHANGELOG.md` جدید (نسخه ۲۵.۰.۰) شامل ۱۰ breaking change با مسیر مهاجرت + Added/Fixed/Verified؛ Migration Guide 17→25/26 در `src/ai/README.md`؛ `CONFIGURATION.md` با جدول ۱۹ فیلد config (بازه‌ی Zod + پیش‌فرض + الزام) و Scope Audit نهایی ۴۲ مورد؛ `CONTRIBUTING.md` با factory pattern ابزار، افزودن CLI command و افزودن endpoint وب؛ `README.md` با بخش Web UI/endpoint/flowها.
**نهایی‌سازی hardening در همین فاز:** `RateLimiterConfig.random` تزریق‌پذیر شد (QUAL-07 — تست‌های backoff deterministic) و `loadMcpSdk()` در `mcp-connector` memoized شد (LEAK-03 — دیگر در هر connect یک `import()` تازه اجرا نمی‌شود).
**تست و verify:** `npx tsc --noEmit` سبز؛ `npx vitest run` → **527/527 سبز در ۳۶ فایل**؛ smoke CLI (۱۳ command واقعی: `--help`, `models`, `personas`, `skills`, `tools`, `mcp list`, `sessions list`, `plans list`, `logs`, `usage`, `tasks list` → exit 0؛ command ناشناس → exit 1؛ `run --dry-run` بدون API key → خطای تمیز exit 1) و smoke UI روی :3000 (همه‌ی endpointها + یک run واقعی تا `awaiting-clarification` → `cancelled`).
**انحراف ثبت‌شده:** (1) «config» در فهرست commandهای CLI پلن نبود — CHANGELOG با فهرست واقعی (`run/sessions/plans/mcp/models/personas/skills/tools/usage/tasks/logs`) تصحیح شد. (2) شمارش «۴۲» پلن با ردیف‌های ریز دسته‌بندی (۶۵ ID) یکی نیست؛ جدول audit هر دو را پوشش می‌دهد و این ناسازگاری صریحاً در `CONFIGURATION.md` مستند شده. (3) `run --dry-run`/`run` بدون API key در sandbox قابل تکمیل نیست — مسیر موفق e2e در تست‌های mock پوشش دارد.

---

### موارد باقی‌مانده (بازبینی نهایی ۲۰۲۶-۰۹-۲۴ — پس از فاز ۲۵)

همه‌ی فازهای این پلن (۱۸–۲۶) 🟢 هستند؛ این فهرست صریح، تنها چیزهایی است که **در همین پلن باقی مانده** و هیچ‌کدام از آن‌ها در دامنه‌ی پلن‌های تکمیلی CLI/UI نبوده‌اند:

| مورد | منبع در پلن | شدت | وضعیت |
|---|---|---|---|
| PERS-04 — بدون file locking بین‌پروسه‌ای | جدول E | 🟡 P2 | ✅ بسته شد (`b415f7b`) — `withFileLockSync` (قفل `O_EXCL` + pid/timestamp + stale/pid-dead takeover + re-entrant + تایم‌اوت تایپ‌دار) روی `FilePlanStore.save/delete` و `FileSessionStore.saveSession/deleteSession` و read-modify-write ها |
| CFG-08 — خواندن مستقیم `process.env` در providerها و mcp-connector (بدون env injection per-Orchestrator) | جدول B | 🟡 P2 | ✅ بسته شد (`e7f1399`) — `EnvSource` در `src/ai/env.ts`؛ `OrchestratorConfig.env` → `ModelRegistry({env})` → `ProviderFactory.create(config, env)` + `McpConnector({env})`/`bootstrapMcpServers(..., env)`؛ پیش‌فرض `process.env` (بدون تغییر رفتار) |
| SEC-02 — `search_code` فایل‌های غیرقابل‌خواندن را بی‌صدا رد می‌کند (خطای دسترسی دیده نمی‌شود) | جدول H | 🟡 P2 | ✅ بسته شد (`ba3de55`) — خروجی `skippedCount` + `skipped[]` (سقف ۲۰ رکورد) شامل فایل و دایرکتوری غیرقابل‌خواندن |
| PERF-06 — `list()` در `FilePlanStore`/`FileSessionStore`: هر بار `readdirSync` + خواندن و parse همه‌ی فایل‌ها | جدول I | 🟢 P2 | ✅ بسته شد (`eaa8aa9`) — ایندکس `idByFile`: هر فایل فقط یک‌بار parse می‌شود؛ list گرم صفر خواندن I/O دارد |
| PERF-08 — `EventBus.emit` در هر emit یک `Set` جدید برای dedup می‌سازد | جدول I | 🟢 P2 | ✅ بسته شد (`ca96332`) — fast path بدون allocation + بافر dedup به‌ازای عمق (re-entrancy-safe)؛ ۱۰۰۰ emit → یک بافر |
| سوال ۵ بخش ۴ (ReDoS) | بخش ۴ | — | ✅ بسته شد با راه‌حل جانشین: `safe-regex`/`re2` اضافه نشد؛ `regex-guard.ts` سفارشی (تشخیص nested quantifier) + سقف طول الگو (۲۰۰ کاراکتر) بدون timeout اجرایی |
| یادداشت فاز ۲۴: ارتقای UI به Next.js/React | فاز ۲۴ | — | 🔵 آینده/اختیاری — UI نسخه‌ی فعلی vanilla ماند (طبق تصمیم کاربر) و پلن UI (U1–U8) کامل است |

### [🟡] فاز ۳۰ (تأییدشده — در حال اجرا): شکاف‌های آمادگی «استفاده‌ی واقعی» — Requires Verification

**فایل مرجع:** `READINESS_AUDIT.md` (ترتیب اولویت، شواهد، معیار پذیرش و Execution Log هر ۱۰ مورد). اجرا از **P2** شروع می‌شود؛ P1 (provider واقعی) مسدود است تا کاربر مسیر (الف)/(ب) را انتخاب کند.

**پیشرفت:** P2 (بازیابی پس از crash) 🟢 — باگ N (لینک پلن↔سشن و بستن interaction بازمانده) رفع شد؛ ۵ تست در `phase30.test.ts` (نسخه ۲۷.۲.۱). **P3 (اثر واقعی ابزارها + sandbox) 🟢 — باگ O (شکست ابزار کاملاً نامرئی بود و پلن SUCCESS کاذب می‌داد) رفع شد؛ ۹ تست در `phase30-p3.test.ts` (نسخه ۲۷.۲.۲).** P1 مسدود (نیازمند انتخاب مسیر توسط کاربر)؛ سراغ P4 می‌رویم.

**رَونوشت:** همان ۱۰ موردی که در ادامه فهرست شده‌اند، به‌ترتیب اولویت P1..P10 در `READINESS_AUDIT.md` نگهداری و وضعیت‌شان به‌روزرسانی می‌شود: 

**مبنا:** پرسش کاربر «آیا سیستم ۱۰۰٪ آماده است؟» پس از فاز ۲۹. پاسخ صریح: **نه** — موارد زیر با شواهد فعلی تأیید نشده‌اند، پس طبق قاعده‌ی «بدون حدس» به‌عنوان Unknown ثبت می‌شوند (نه به‌عنوان سالم). هر مورد در صورت تأیید کاربر به فاز مستقل با معیار پذیرش تبدیل می‌شود.

| # | مورد تأییدنشده | چرا Unknown است (شواهد) | معیار پذیرش پیشنهادی |
|---|---|---|---|
| ۱ | اجرا با provider واقعی (OpenAI/Anthropic) | هیچ تستی به شبکه نمی‌زند: ۲۱ فایل تست `ai` را mock می‌کنند؛ کل e2e فاز ۲۹ با استاب محلی Responses API بود | یک run واقعی با کلید واقعی: plan→confirm→execute، صحت شمارش توکن و streaming، پیام خطای درست در 401/429/5xx |
| ۲ | timeout و سقف گام‌ها روی مدل واقعاً کند/حلقه‌ای | مسیر `abortSignal`/TimeoutError فقط واحد تست شده (phase7/19/20/22/27)؛ در e2e استاب همیشه فوری پاسخ می‌دهد | مدل کند (delay تزریقی): abort تمیز، `plan:step-failed` قابل‌فهم، re-planning یا شکست کنترل‌شده، بدون hang |
| ۳ | بازیابی پس از crash (kill -9 وسط اجرا) + `plans resume` | صفر تست برای SIGKILL؛ `resumePlan` هیچ تست واحدی ندارد؛ فقط «resume پلن نیمه‌تمام» با mock در cli.test.ts | kill -9 وسط اجرا → `hootl plans resume <id>` ادامه از آخرین وضعیت پایدار، بدون plan/session خراب (قفل و atomic-write فعلی هم‌زمان آزموده شود) |
| ۴ | دو اجرای هم‌زمان روی یک پروژه | `file-lock.ts` واحد تست شده (PERS-04) ولی هیچ‌گاه e2e دو‌پروسه‌ای آزمایش نشده | دو run موازی: بدون overwrite/corrupt در plans/sessions/log، خطای واضح در تداخل |
| ۵ | MCP واقعی (stdio و http) | `mcp test` فقط روی یک registry با URL مرده تست شد (شکست درست)؛ هیچ سرور MCP واقعی وصل نشده | `mcp test` روی یک سرور واقعی stdio + یک http؛ ابزار MCP در یک run واقعی استفاده شود |
| ۶ | اهداف بزرگ/طولانی (چند-مرحله‌ای، زمینه‌ی بزرگ، replan واقعی) | استاب همیشه یک پلن ۲ مرحله‌ای ساده می‌دهد؛ e2e فقط مسیر خوش‌بینانه‌ی کوچک را دید | پلن ۸–۱۲ مرحله‌ای با وابستگی واقعی؛ شکست واقعی یک step → replan؛ رفتار حافظه/زمینه |
| ۷ | اثرات واقعی ابزارها در run | در e2e فقط `read_file` استفاده شد (write_file/git_status/search_code در run نه) | run واقعی که `write_file` + `search_code` + `git_status` را اجرا کند و sandbox مسیرها را در عمل نشان دهد |
| ۸ | محیط‌ها: Windows/Git-Bash/WSL، Node > 22، بدون TTY/CI | همه‌ی آزمون‌ها روی Linux + Node 22 + PTY | ماتریس محیط (حداقل Linux+macOS، Node 22 و 24، اجرای CI بدون TTY) |
| ۹ | UI/سرور پس از تغییرات فاز ۲۹ | smoke قدیمی (فاز ۲۸) بود؛ پس از این تغییرات UI دوباره آزموده نشد | جریان کامل UI: preview → approve → progress (SSE) → usage/tasks |
| ۱۰ | امنیت در برابر محتوای خصمانه | بازبینی‌های SEC فاز ۲۰ انجام شد ولی سناریوی واقعی (prompt-injection از فایل، تلاش خروج از sandbox، نشت credential در لاگ زیر بار واقعی) آزموده نشده | تست‌های تزریقی هدفمند + بازبینی مسیرهای نوشتن |

**دلیل ساختاری این شکاف‌ها (یافته‌ی اصلی فاز ۲۹):** ۵ از ۱۱ باگ یافت‌شده در runtime بود (`orchestrator`, `plan-runtime`, `agent-factory`, `observability-logger`, `streaming-manager`) و همه دقیقاً روی **درزِ بین ماژول‌ها** بودند — اتصال «step → ابزار agent»، «وضعیت پایدار → حلقه‌ی اجرا»، «redaction ↔ ماندگاری usage»، «نقشه‌برداری خطای planner → پیام CLI». مجموعه‌ی ۵۸۵ تستی سبز بود در حالی که `hootl run` تعاملی حتی یک بار هم تا آخر نمی‌رفت؛ یعنی «سبز بودن تست‌های ماژولی» معادل «آماده بودن سیستم» نیست و آمادگی باید با run واقعی سنجیده شود.

### [🟢] فاز ۲۹: تست ورک‌فلو‌های CLI با تعامل واقعی ترمینال — کامل شد (۲۰۲۶-۰۹-۲۴)

**مبنا (درخواست کاربر):** «بصورت مجزا و کامل ورک‌فلو دستورات cli رو تست کن. درصورت امکان عینا مثل کاربری که با ترمینال تعامله» — یعنی هر دستور جداگانه، در یک PTY واقعی، با پرسش‌ها و کلیدهای واقعی.

**روش (هارنس، بیرون از ریپو در `/tmp/e2e`):** (۱) استاب LLM محلی روی `http://127.0.0.1:8931/v1` که همان **Responses API** را جواب می‌دهد (Assessment/Plan/Acceptance/FinalReview/tool-call)؛ (۲) درایور PTY با `pty.fork()` تا فرزند **controlling terminal** واقعی داشته باشد (Ctrl-C = SIGINT، ISIG/ICANON مثل ترمینال)؛ (۳) پروژه‌ی نمونه با رجیستری لایه‌ای، `.env` و MCP دمو؛ (۴) ۳۰+ سناریو (happy path، خطا، تعاملی) با transcript خام.

| # | باگ پیداشده در تعامل واقعی | ریشه | رفع (فایل) |
|---|---|---|---|
| ۱ | **`hootl run` بدون `--yes` در ترمینال crash می‌کرد**: `Prompt type "list" is not registered` | inquirer v14 نوع `list` را حذف/تغییرنام داده به `select` | `type: 'select'` + تست نگهبان که نوع‌های prompt را با رجیستری inquirer چک می‌کند (`src/cli/utils/confirm.ts`, `phase29.test.ts`) |
| ۲ | خطای planning با لیست سؤال خالی، پیام بی‌محتوا چاپ می‌کرد: `⚠️ Clarification needed:` و سؤال‌ها هیچ | `PlanningResult.errors` نادیده گرفته می‌شد | پیام `🛑 Planning failed: <error>` + outcome `failure` (`src/ai/orchestrator.ts`) |
| ۳ | `--max-steps 0` و `--timeout-ms 500` خروجی خام ZodError می‌دادند | اعتبارسنجی نبود؛ به `OrchestratorConfigSchema` می‌رسید | pre-flight با محدوده‌های همان اسکیما + `formatZodError` → exit 2 (`src/cli/commands/run.ts`) |
| ۴ | `--model ghost-model` تا planner می‌رفت و مبهم شکست می‌خورد | نبودِ بررسی pre-flight | چک `modelRegistry.hasConfig` پس از `initialize()` → لیست idهای معتبر + exit 2 (`run.ts`) |
| ۵ | **ابزارهای declared روی step هرگز به agent نمی‌رسیدند** (`Tools: read_file` نمایش داده می‌شد ولی `assignedTools` هیچ‌جا خوانده نمی‌شد) | `AgentDefinition` فیلد tool نداشت و فقط skillها ابزار می‌دادند | `toolIds` در `AgentDefinitionSchema` + گنجاندن در `requestedToolIds` با همان فیلتر persona + پاس‌دادن `assignedTools` در `buildAgentForStep` (`schemas/agent-definition.ts`, `agents/agent-factory.ts`, `runtime/plan-runtime.ts`) |
| ۶ | `hootl usage` و ستون TOKENS در `tasks` عدد را `***REDACTED***` نشان می‌دادند | الگوی redaction «token» کلیدهای شمارنده‌ی عددی (`promptTokens/totalTokens`) را هم می‌گرفت | معافیت مقادیر **عددی** با پسوند `tokens`؛ رشته‌ها/آبجکت‌ها همچنان redact می‌شوند (`runtime/observability-logger.ts`) |
| ۷ | شمارنده‌ی پیشرفت از حد می‌گذشت: `✔ [4/2]` روی پلن ۲ مرحله‌ای | `plan:step-completed` دو بار emit می‌شد (چرخه‌ی step + `agent:completed`) | رویدادهای سطح agent با `agentLevel: true` علامت‌گذاری و از شمارش خارج شدند (جزئیات فقط با `--verbose`) (`runtime/streaming-manager.ts`, `cli/utils/streaming.ts`) |
| ۸ | `hootl plans show <id>` JSON خام چاپ می‌کرد، در حالی که description می‌گوید steps/personas/tools | پیاده‌سازی ناقص | نمای انسانی (status هر step، persona/tools/depends/accept/result) + `--json` برای خروجی ماشینی (`cli/commands/plans.ts`, `cli.ts`) |
| ۹ | `sessions label` نوشتنِ بی‌مصرف بود؛ label در هیچ فهرستی دیده نمی‌شد | `sessions list` ستون label نداشت | ستون `LABEL` در `sessions list` (`cli/commands/sessions.ts`) |
| ۱۰ | `--session <id-nameوجود>` بی‌صدا پذیرفته می‌شد: اجرا «موفق» ولی هیچ interactionی ذخیره نمی‌شد و id غلط در خلاصه چاپ می‌شد | نبودِ بررسی وجود session | pre-flight: نبود session → پیام + exit 2 (`run.ts`) |
| ۱۱ | `hootl run ""` تا planner می‌رفت و خطای schema می‌داد | نبودِ بررسی goal خالی | `The goal must not be empty.` + exit 2 (`run.ts`) |
| ۱۲ | `logs --tail 0` کل لاگ را چاپ می‌کرد (`slice(-0) === slice(0)`) و `--tail abc` بی‌صدا هیچ | معناشناسی `tail` در JS + نبود اعتبارسنجی | `0` = بدون خط اولیه (برای `--follow`)، مقدار غیرعددی/منفی → exit 2 (`cli/commands/logs.ts`) |
| ۱۳ | محدوده‌ی `--max-steps`/`--timeout-ms`/`--tail` در help مستند نبود | متن help قدیمی | محدوده‌ها به متن optionها اضافه شد (`cli.ts`) |
| ۱۴ | **`hootl plans cancel` یک پلن در حال اجرا را متوقف نمی‌کرد** (دو ترمینال): cancel موفق برمی‌گشت و روی disk ذخیره می‌شد، ولی پروسه‌ی در حال اجرا آن را نادیده می‌گرفت، تا آخر می‌رفت و وضعیت `cancelled` را با `completed` بازنویسی می‌کرد | حلقه‌ی `PlanRuntime.execute()` فقط فلگ in-process را می‌دید؛ بین دو دور اجرا store را دوباره نمی‌خواند و `persist`های خودش وضعیت کاربر را overwrite می‌کردند | (الف) خواندن وضعیت پایدار در ابتدای هر دور حلقه، (ب) بررسی همان وضعیت پیش از محاسبه‌ی وضعیت نهایی (cancel در حین اجرای آخرین step)، (ج) در `persist()`: وضعیت `cancelled` روی disk معتبر است و بازنویسی نمی‌شود؛ نتیجه: `❌ Plan cancelled. 1/2 steps completed.`، outcome `CANCELLED`، exit 1 (`runtime/plan-runtime.ts`) |

**پوشش ورک‌فلوها (همه با PTY واقعی و exit code راستی‌آزمایی‌شده):** `--version`/`--help`/`help <cmd>`؛ `run` در چهار حالت (تعاملی Enter=تأیید، ↓+Enter=رد + feedback، clarification چند دور با پاسخ‌دهی، `--yes`) به‌همراه `--dry-run` (بدون هیچ اجرا؛ فقط `observability.jsonl` از initialize)، `--persistent`, `--verbose`, `--label`, `--session <id>`, `--project-root` از cwd دیگر و فلگ‌های عددی؛ `sessions list|show|label|delete`؛ `plans list|show|cancel|resume` (شامل حالت‌های terminal/ناموجود)؛ `logs` (`--plan`, `--tail`, `--follow` + Ctrl-C)؛ `usage`/`usage --plan`؛ `tasks list|show` (+`--json`)؛ `models|personas|skills|tools` (`--json`, لایه‌ها, `HOTL_NO_PACKAGE_REGISTRY=1`, پروژه‌ی بدون رجیستری)؛ `mcp list|test`؛ و مسیرهای خطا (exit 1/2 با پیام قابل‌فهم).

**تست:** فایل جدید `src/cli/__tests__/phase29.test.ts` (۱۴ تست: pre-flightها، surfaced planning error، شمارنده، redaction عددی، نمای پلن، نگهبان نوع prompt، `--tail`، و cancellation بین‌پروسه‌ای با store جعلی که مثل ترمینال دوم وضعیت را `cancelled` می‌کند — آزمون جهت‌دار: بدون رفع، تست با `expected 'failed-partial' to be 'cancelled'` می‌شکند). کل suite: **۵۸۵ تست در ۳۹ فایل**، `tsc` پاک. نسخه → `27.2.0`؛ باینری سراسری `hootl` بازسازی و دوباره نصب شد.

**انحراف ثبت‌شده:** (۱) باگ ۵ (ابزارهای step) خارج از «تست CLI» بود ولی تست تعاملی آن را آشکار کرد (خروجی «No tools used» و نبود `tools` در درخواست به مدل) → کوچک‌ترین رفع سازگار با معماری اعمال شد. (۲) باگ ۸ و ۹ تغییر رفتار قابل‌مشاهه‌ی CLI هستند (نمای انسانی plans show و ستون label) و تست قبلی `plans show prints the full plan JSON` به دو تست (نمای انسانی + `--json`) تبدیل شد. (۳) دو مورد اولیه‌ی «Ctrl-C باعث بسته‌نشدن `logs --follow`» و «^C در پرامپت‌ها» ابتدا باگ محصول به‌نظر می‌رسید؛ بررسی نشان داد هارنس PTY کنترل‌ترمینال نداشت → درایور به `pty.fork()` ارتقا یافت و رفتار درست تأیید شد (باگ محصول نبود).

### [🟢] فاز ۲۸: `hootl` + رجیستری لایه‌ای + راهنمای کامل CLI — کامل شد (۲۰۲۶-۰۹-۲۴)

**مبنا (درخواست کاربر):** (۱) دستور `hootl` که در هر مسیری از ترمینال اجرا شود و همان مسیر را root پروژه بگیرد؛ (۲) برای رجیستری، **هم** رجیستری پروژه و **هم** رجیستری داخلی پکیج لود شوند (گلوبال + لوکال)؛ (۳) راهنمای CLI خیلی کامل شود، بدون نمونه‌کد.

| گام | موضوع | نتیجه |
|---|---|---|
| ۱ | `hootl` | `bin` در `package.json` دو ورودی دارد (`hootl` و `human-out-of-the-loop`, هر دو → `dist/src/cli.js`)؛ نام نمایشی help از `argv[1]` تشخیص داده می‌شود (`detectBinName`) و `--version` نسخه‌ی پکیج را چاپ می‌کند (`27.1.0`) |
| ۲ | رجیستری لایه‌ای | ماژول `src/ai/registries/layout.ts` (`packageRoot`, `registryLayersFor`, `describeRegistryLayers`, `hasProjectRegistry`)؛ ترتیب لود: package → project با `override`؛ اعمال در `Orchestrator.initialize()` (personas/tools/skills/models/agents.json/MCP)، دستورهای `models|personas|skills|tools` و `mcp list|test` |
| ۳ | اولویت‌دهی | `Registry.replace()` + گزینه‌ی `override` در loader و همه‌ی لودرها؛ id تکراری در لایه‌ی پروژه جایگزین لایه‌ی پکیج می‌شود، بقیه‌ی ورودی‌های پکیج باقی می‌مانند |
| ۴ | خاموش‌کردن لایه‌ی گلوبال | `HOTL_NO_PACKAGE_REGISTRY=1` → رجیستری صرفاً لوکال (و در نبود آن، خطای راهنما با exit 2) |
| ۵ | شفافیت لایه‌ها | هر دستور introspection خط `registry: package (built-in) + project (.)` را چاپ می‌کند (در حالت `--json` فقط JSON خالص) |
| ۶ | راهنمای کامل CLI | هر دستور و زیردستور: description واقعی + appendix کامل (چرخه‌ی run، تعامل/غیرتعاملی، حالت‌های plan/session، قواعد MCP و credential، معنای log/tasks/usage، exit codeها، اولویت تنظیمات، لایه‌های رجیستری، project-root و محل state) |
| ۷ | انحراف ثبت‌شده (فیکس لازم) | `--help` روی زیردستورها از قرارداد exit-code رد می‌شد: `commander` فقط روی همان commandی که `exitOverride()` صدا زده اعمال می‌کند و مستقیم `process.exit` می‌کرد → override حالا بازگشتی روی کل درخت اعمال می‌شود (تست‌پذیر و exit code درست) |
| ۸ | انحراف ثبت‌شده (فیکس لازم) | تست قبلی «exit 2 وقتی registry/ وجود ندارد» با رفتار جدید ناسازگار بود؛ به دو تست تبدیل شد: «لایه‌ی پکیج از یک پروژه‌ی خالی لیست می‌شود (exit 0)» و «بدون هیچ لایه‌ای exit 2 با پیام No registry found» |
| ۹ | تحمل لایه‌ی ناقص | لایه‌ای که فقط بعضی زیرپوشه‌ها را دارد (مثلاً فقط models) اکنون مجاز است؛ ورودی نامعتبر همچنان خطا می‌دهد (`assertEntriesValid` در Orchestrator + گزینه‌های `required`/`override` در `bootstrapTools`) |

**تست:** ۲۱ تست جدید در `src/cli/__tests__/phase28.test.ts` (help سطح بالا/هر دستور، نام باینری، نسخه، alias پکیج، لایه‌ها، override/افزودن در چهار نوع رجیستری، MCP لایه‌ای، Orchestrator با رجیستری خالی/کامل/ناقص/خراب). کل suite: **۵۶۸ تست در ۳۸ فایل**، `tsc` پاک، و smoke واقعی با نصب سراسری (`npm install -g .`) در یک پروژه‌ی دلخواه.

### [🟢] فاز ۲۷: بستن باقی‌مانده‌های P2 — کامل شد (۲۰۲۶-۰۹-۲۴)

**مبنا:** «اینارو ببند» — بستن دقیق ۵ مورد جدول بالا با کمترین تغییر و تست مستقیم؛ هر مورد مستقل و قابل تعریف در `src/ai/__tests__/phase27.test.ts`.

**نتیجه:** هر ۵ مورد بسته شد (کامیت‌های `ba3de55`, `eaa8aa9`, `ca96332`, `e7f1399`, `b415f7b`)؛ ۱۸ تست فاز ۲۷، کل suite ۵۴۵ تست در ۳۷ فایل، `tsc` پاک. جدول بالا (موارد باقی‌مانده) هیچ مورد باز P2 باقی نمی‌گذارد — تنها موارد باقی‌مانده در کل پروژه: ReDoS بسته‌شده با راه‌حل جانشین و ارتقای اختیاری UI (هر دو آبی/آینده).

| گام | مورد | نتیجه |
|---|---|---|
| ۱ | SEC-02 | `ba3de55` — `search_code` فایل/دایرکتوری‌های غیرقابل‌خواندن را با `skippedCount` + `skipped[]` (سقف `SKIPPED_REPORT_LIMIT = 20`) گزارش می‌کند؛ مسیر دایرکتوری که قبلاً `return` بی‌صدا بود هم پوشش داده شد |
| ۲ | PERF-06 | `eaa8aa9` — ایندکس `idByFile` در `FilePlanStore`/`FileSessionStore`؛ list فقط فایل‌های ندیده را parse می‌کند، رکوردهای حذف‌شده را کنار می‌گذارد؛ نوشتن خود store ایندکس را گرم می‌کند |
| ۳ | PERF-08 | `ca96332` — `EventBus.emit` بدون allocation در مسیرهای رایج؛ بافر dedup به‌ازای عمق، آزادسازی در `finally` |
| ۴ | CFG-08 | `e7f1399` — `EnvSource` تزریق‌پذیر (`src/ai/env.ts`) + `OrchestratorConfig.env` + thread به `ModelRegistry`، providerها، `McpConnector`، `bootstrapMcpServers`؛ پیش‌فرض همه‌جا `process.env` |
| ۵ | PERS-04 | `b415f7b` — `src/ai/runtime/file-lock.ts`؛ قفل `O_EXCL` با متادیتای pid، انتظار محدود (`FileLockTimeoutError` با holder)، re-entrant، و تصاحب قفل‌های رهاشده (mtime کهنه یا pid مرده) |
| ۶ | کشف ضمن smoke (خارج از ۵ مورد) | `b415f7b`+ — providerها از `require()` برهنه در پکیج ESM استفاده می‌کردند؛ در `tsx`/CLI/server هر instantiate با «@ai-sdk/openai is not installed» شکست می‌خورد (shim ویتست آن را پنهان می‌کرد). فیکس حداقلی: `createRequire(import.meta.url)` در هر سه provider + تست رگرسیون ESM (spawn با `node --import tsx`) که بدون فیکس fail می‌شود |

**تصمیم طراحی CFG-08 (تصحیح by-design قبلی):** مدل credential تغییر نکرد (مقدارها فقط از env)، اما «منبع env» قابل تعویض شد تا چند Orchestrator در یک پروسه credentialهای جدا داشته باشند؛ ماژول در `src/ai/` (نه `runtime/`) قرار گرفت تا گیت معماری «Registry مستقل از Runtime» نقض نشود و fallback صریح `process.env` در providerها باقی بماند تا گیت DevOps همچنان برقرار باشد (ثبت به‌عنوان انطباق با گیت‌های موجود، نه تغییر تست).

> **تصحیح audit (۲۰۲۶-۰۹-۲۴):** جدول Scope Audit در `src/ai/CONFIGURATION.md` در دو نقطه دقیق نبود — ردیف CFG-08 اشتباهاً ✅ با شاهد مربوط به catalog ابزارها ثبت شده بود (در واقع باز/by-design است) و PERF-06/PERF-08 هر چند در نتیجه‌ی فاز ۲۱ به‌عنوان خارج از دامنه مستند شده بودند، در جدول audit به‌شکل ✅ تجمیعی دیده می‌شدند. جدول تصحیح شد و این فهرست صریح جای آن ابهام را می‌گیرد.

### [🟢] فاز ۲۶: ID Migration به randomUUID() — کامل شد 2026-09-24

**مبنا:** یافته verify (بخش ۷) — دسته D (سربرگ 🔴) در هیچ فازی فیکس نشده بود؛ `plan_${Date.now()}` بدون جزء تصادفی + filename `sha256(id)` فاز ۲۲ = overwrite احتمالی دو plan در یک میلی‌ثانیه.

**نتیجه:** ۷ نقطه تولید ID به `prefix_randomUUID()` (node:crypto) تغییر کرد:
1. `schemas/session.ts` — `session_${randomUUID()}` (ID-01)
2. `schemas/session.ts` — `interaction_${randomUUID()}` (ID-02)
3. `schemas/plan.ts` — `plan_${randomUUID()}` (ID-03)
4. `planning/planner.ts` — fallback `plan_${randomUUID()}` (ID-06)
5. `planning/plan-generator.ts` — fallback `plan_${randomUUID()}` (ID-06)
6. `tools/implementations/delegate-task.ts` — `dynamic_${persona}_${randomUUID()}` (ID-04)
7. `tools/implementations/task-control-tools.ts` — `pending_${agentId}_${randomUUID()}` (ID-05)
8. (بافور، برای یکسان‌سازی) `runtime/agent-runtime.ts` — فالبک `call-${randomUUID()}`

پیشوند (`plan_`/`session_`/…) برای خوانایی لاگ‌ها نگه داشته شد؛ جزء تصادفی UUIDv4 غیرقابل‌پیش‌بینی و collision-free است. 6 تست جدید (`phase26.test.ts`): collision 5000 plan + 5000 session + 2000 interaction در loop تنگ (با `Date.now()` collision تضمین‌شده بود)، فرمت UUIDv4، **source-scan** ماندگار (هیچ `_ ${Date.now()}` / `_ ${Math.random()}` در src/ai باقی نمانده)، round-trip FilePlanStore با idهای UUID. **457 تست سبز (28 فایل)** + tsc سبز.

**انحراف ثبت‌شده:** (1) به‌جای `randomUUID()` خالص (متن «فیکس واحد»)، `prefix_uuid` انتخاب شد — شناسایی سریع نوع رکورد در لاگ/فایل‌ها بدون هیچ هزینه (breaking: قالب ID جدید؛ IDهای قدیمی روی disk نامتأثر چون store id را از محتوای JSON می‌خواند). (2) فالبک `call-` در agent-runtime هم به همان شکل اصلاح شد (در جدول D نبود؛ جلوگیری از بازگشت به الگوی ناپایدار).

**معیار پذیرش (بررسی‌شده):**
- [x] ۰ `_ ${Date.now()}` / `_ ${Math.random()}` در src/ai (source-scan)
- [x] 5000 plan در loop تنگ → 5000 id یکتا
- [x] 457/457 تست + tsc سبز
- [x] persist/read با idهای UUID (فایل‌name hash) کار می‌کند

---

## ۳. وابستگی بین فازها

```
فاز 18 (Path) ─┐
               ├→ فاز 19 (Config + Singleton + Atomic) ─→ فاز 20 (Correctness) ─→ فاز 21 (Perf) ─→ فاز 22 (Quality)
               │                                                                          │
فاز 18 ────────┘                                                                          ├→ فاز 23 (CLI) ─┐
                                                                                          │                ├→ فاز 25 (Docs)
                                                                                          └→ فاز 24 (UI) ──┘
```

- فاز 18 باید اول باشد — چون تمام فازهای دیگر به `projectRoot` درست وابسته‌اند
- فاز 19 بعد از 18 — چون Guardها و Timeoutها به Toolهای درست نیاز دارند
- فاز 20 بعد از 19 — چون Correctness به Config درست نیاز دارد
- فاز 21 و 22 می‌توانند موازی بعد از 20 باشند، اما برای سادگی ترتیبی
- فاز 23 (CLI) و 24 (UI) بعد از 18-22 — چون به Runtime پایدار نیاز دارند
- فاز 25 آخر

---

## ۴. سوالات باقی‌مانده (نیاز به تصمیم قبل از شروع فاز 18)

1. **CLI dependency:** آیا `commander` + `chalk` + `ora` + `inquirer` به `dependencies` اضافه شوند یا فقط `devDependencies`؟ (پیشنهاد: dependencies)
2. **Server dependency:** `express` به dependencies اضافه شود؟ (پیشنهاد: بله، optional peer)
3. **ID migration:** برای `.ai-runtime` موجود با IDهای قدیمی (`plan_123456789`)، آیا اسکریپت migration بنویسیم یا فقط document کنیم که باید پوشه پاک شود؟ (با توجه به allow_breaking، پیشنهاد: document + `rm -rf .ai-runtime`)
4. **UI framework:** برای فاز 24، vanilla JS کافی است یا از ابتدا React + Vite؟ (طبق تصمیم کاربر: vanilla برای شروع ولی قابل ارتقا — پیشنهاد: vanilla با structure که بعداً به React تبدیل شود)
5. **ReDoS library:** برای `search_code` از `safe-regex` استفاده کنیم یا `re2` (native)؟ `re2` امن‌تر اما نیاز به native build دارد. پیشنهاد: `safe-regex` + length limit + timeout

---

## ۵. تخمین حجم کار

| فاز | تعداد باگ | خطوط کد تخمینی | تست جدید | زمان تخمینی |
|-----|-----------|----------------|----------|--------------|
| 18 | 9 | ~400 | 5 | 1 stage |
| 19 | 10 | ~500 | 8 | 1 stage |
| 20 | 14 | ~600 | 10 | 1 stage |
| 21 | 8 | ~300 | 3 | 1 stage |
| 22 | 8 | ~400 | 5 | 1 stage |
| 23 | FEAT-01 | ~800 | 5 | 1 stage |
| 24 | FEAT-02,03 | ~700 | 5 | 1 stage |
| 25 | Docs | ~300 | 0 | 1 stage |
| **جمع** | **42+3** | **~4000** | **~41** | **8 stages** |

---

## ۶. چک‌لیست نهایی — اطمینان از عدم جاافتادگی

- [x] تمام B1-B12 از CODE_QUALITY_AUDIT.md پوشش داده شدند
- [x] تمام S1-S6 پوشش داده شدند
- [x] تمام P1-P12 پوشش داده شدند
- [x] تمام Q1-Q10 پوشش داده شدند
- [x] تمام 14 مورد DEEP_AUDIT_PATH_BUGS.md پوشش داده شدند
- [x] تمام 12 مورد CODE_QUALITY_AUDIT_DEEP_DIVE.md پوشش داده شدند (6 مورد تکراری، 6 مورد جدید CFG-03 تا CFG-08)
- [x] FEAT-01,02,03 از messages.md پوشش داده شدند
- [x] Breaking changes مجاز اعمال شد
- [x] CLI کامل مانند Claude Code CLI در فاز 23
- [x] UI ساده Express+SSE+HTML قابل ارتقا در فاز 24
- [x] هر فاز معیار پذیرش دارد
- [x] وابستگی فازها مشخص است

**هیچ موردی از قلم نیفتاده است.**

---

## ۷. نتیجه بررسی نهایی 🔴/🟠 (verify — 2026-09-24)

بررسی تک‌تک ۲۸ آیتم با بج 🔴/🟠 مقابل کد فعلی (commit `bd10d4e`) — نه صرفاً اتکا به «نتیجه» فازها:

| دسته | آیتم‌ها | وضعیت verify | شواهد |
|---|---|---|---|
| A Path | PATH-01..04 🔴, PATH-05/07/09 🟠 | ✅ ۷/۷ فیکس | factoryها با `projectRoot`؛ ۰ `process.cwd()` در implementations (یک hit = متن پیام خطا PATH-09)؛ `realpathSync` در path-security:49؛ `workspaceRoot` mandatory (throw, خط 62)؛ boundary skill-registry:117 |
| B Config | CFG-03/04 🔴, CFG-01/05 🟠 | ✅ ۴/۴ فیکس | ۰ `localToolDefs`، `bootstrapTools` orchestrator:309؛ `new DelegationGuard` خط 228؛ `agentTimeoutMs` → TaskRuntime:28 |
| C Singleton | SING-01 🟠 | ✅ فیکس | ۰ `?? globalEventBus`، ۰ singleton `agentRuntime` |
| **D ID** | (سربرگ 🔴؛ آیتم‌ها 🟡 P2) | ✅ **۶/۶ فیکس (فاز ۲۶)** | همه به `prefix_randomUUID()`؛ source-scan + تست collision 5000-id در `phase26.test.ts`؛ ۷ نقطه (شامل فالبک `call-` در agent-runtime) |
| E Persistence | PERS-01 🔴 | ✅ فیکس | `atomicWriteFileSync` (tmp+uuid+rename) در هر دو store (plan-store:61, session-store:83)؛ PERS-02/03 ✅ (structuredClone + snapshot)؛ PERS-04 ✅ در فاز ۲۷ (`src/ai/runtime/file-lock.ts` — قفل `O_EXCL` بین‌پروسه‌ای روی نوشتن storeها) |
| F Leaks | LEAK-01/02 🟠 | ✅ ۲/۲ فیکس | `clearTimeout` در finally: mcp-connector:275، agent-runtime:201 |
| G Correctness | CORR-01..05 🟠 | ✅ ۵/۵ فیکس | `parsed.error.issues` base-registry:62؛ `waitForAll`(777) قبل `destroy`(784)؛ `task.planId` aggregator:81؛ hook صریح `runAcceptanceChecks` + ۰ subscription در checker؛ `event.planId` streaming:169 |
| H Security Ext | SEC-01 🔴, SEC-03/04 🟠 | ✅ ۳/۳ فیکس | regex-guard (nested-quantifier + MAX_PATTERN_LENGTH)؛ آستانه `>4` mcp-connector:93,104؛ substring match observability:407 |
| I Perf | PERF-01/04 🟠 | ✅ ۲/۲ فیکس | `computeTransitiveDependentCounts` (memoized) plan-runtime:387؛ fd reuse `openSync/writeSync` observability:124,162 |
| J Quality | QUAL-05/06 🟠 | ✅ ۲/۲ فیکس | `OrchestratorConfigSchema` (zod) orchestrator:56-66؛ `abortSignal` → `generateText` agent-runtime:231 |
| K Features | FEAT-01 🔴 | ✅ فیکس | CLI کامل (فاز ۲۳) + UI/REST (فاز ۲۴) — live verify شده |
| فاز ۲۵ | (سربرگ 🔴؛ آیتم‌ها: QUAL-07, LEAK-03) | ✅ کامل شد | `CHANGELOG.md` + Migration Guide + Scope Audit نهایی؛ `RateLimiterConfig.random` تزریق‌پذیر (QUAL-07)؛ `loadMcpSdk()` memoized (LEAK-03)؛ 527/527 تست + tsc سبز + smoke CLI/UI |

### یافته کلیدی: دسته D باز است → ✅ رفع شد در فاز ۲۶ (2026-09-24)

با آنکه بج هر آیتم 🟡 P2 است، سربرگ دسته 🔴 است و هنگام verify **هیچ‌کدام از ۶ مورد فیکس نشده بودند**. ریسک واقعی:
- `plan_${Date.now()}` بدون هیچ جزء تصادفی (ID-03/06) + فایل‌name فاز ۲۲ = `sha256(id)` → **دو plan در یک میلی‌ثانیه = همان فایل = overwrite/دست‌روداده داده**
- `session_/interaction_` با 6 کاراکتر base36 تصادفی — predictable + collision در بار بالا

**مقرّر شد و اجرا شد:** فاز ۲۶ — «ID migration به `randomUUID()`» (7 نقطه + تست collision). Breaking مجاز طبق سیاست؛ IDهای قدیمی روی disk نامتأثر (store id را از محتوا می‌خواند).

