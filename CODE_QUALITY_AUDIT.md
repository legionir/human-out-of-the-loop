# Code Quality Audit — human-out-of-the-loop (17 phases)

**Date:** 2026-09-23  
**Scope:** `src/ai/**`, `registry/**`, `package.json`, `tsconfig.json`  
**Verification:** `tsc --noEmit` 0 errors, `vitest run` 334 green (pre-audit)  
**Laws checked:** 1-18 + 18 requirements mapping

---

## Executive Summary

کدبیس از نظر **معماری و انطباق با قوانین ۱۲-۱۸** در وضعیت بسیار خوب است: تفکیک Persona/Skill/Tool رعایت شده، `allowedTools` در دو مسیر static+dynamic، Human-Out-Of-Loop بدون درخواست ادامه، Resource Lock، Priority Queue، Feasibility Gate، Persistence همه پیاده شده. ۳۳۴ تست سبز.

با این حال **۱۲ باگ امنیتی/کارکردی متوسط تا بحرانی** و **۲۱ مورد بهبود پرفورمنس/کیفیت** شناسایی شد که قبل از production باید رفع شوند. مهم‌ترین‌ها: ReDoS در `search_code`, عدم اعتبارسنجی path در `search_code` و `git_status`, تایمر لیک در `AgentRuntime` و `McpConnector`, عدم استفاده از `projectRoot` در ابزارهای فایل‌سیستمی, `planStore`/`sessionStore` بدون file-lock, و `UsageAggregator` با نگاشت اشتباه planId.

---

## 🔴 Bugs — کارکردی

### B1 — `search_code` بدون Path Security + ReDoS
**File:** `src/ai/tools/implementations/search-code.ts:22-54`
```ts
const resolvedDir = path.resolve(process.cwd(), directory);
const regex = new RegExp(pattern, 'gi');
```
- هیچ اعتبارسنجی `validateWorkspacePath` روی `directory` انجام نمی‌شود → مهاجم می‌تواند `/etc` را بخواند (برخلاف `read_file`/`write_file` که دارند).
- `pattern` مستقیم به `RegExp` می‌رود → ReDoS: الگوی `(a+)+b` می‌تواند CPU را قفل کند.
- `maxResults` به‌عنوان حد بالایی خوب است اما `walkDir` کل درخت را قبل از تطبیق می‌خواند → حتی اگر `maxResults=1` باشد، کل FS اسکن می‌شود.

**Fix:**
```ts
import { validateWorkspacePath } from './path-security.js';
const v = validateWorkspacePath(directory, projectRoot);
if (!v.safe) return { success:false, code:'PATH_TRAVERSAL_BLOCKED' };
// limit pattern length, disable backtracking, use safe-regex or RE2
if (pattern.length > 200) throw...
// یا از `ripgrep` / `fs.walk` با early exit
```

### B2 — `git_status` بدون Path Security
**File:** `git-status.ts:17`
```ts
const cwd = path.resolve(process.cwd(), directory);
```
مشابه B1 — هر مسیر دلخواه قابل اجراست. باید `validateWorkspacePath` + فقط اجازه داخل `projectRoot`.

### B3 — `read_file`/`write_file` از `process.cwd()` به‌جای `projectRoot`
**Files:** `read-file.ts:13`, `write-file.ts:13`, `path-security.ts:24`
```ts
export function validateWorkspacePath(filePath, workspaceRoot?: string) {
  const root = workspaceRoot ?? process.cwd();
```
`process.cwd()` در تست‌ها متفاوت از production است. باید `projectRoot` از Orchestrator inject شود. در غیر این صورت، تست‌های path-traversal ممکن است سبز باشند اما در runtime واقعی bypass شود اگر کاربر از دایرکتوری دیگر اجرا کند.

**Fix:** امضای ابزارها `workspaceRoot` را از closure بگیرند (مثل `createReadFileTool(root)`).

### B4 — `base-registry.ts` tryRegister هرگز ZodError برنمی‌گرداند
```ts
register() throws generic Error with issues string
tryRegister() catches and checks err instanceof ZodError → never true
```
→ فیلد `zodError` همیشه `undefined` است، حتی در خطای validation. باید `parsed.error` را مستقیم برگرداند.

### B5 — `McpConnector` timer leak
**File:** `mcp-connector.ts:168-177`
```ts
new Promise((_, reject) => setTimeout(() => reject(...), connectTimeoutMs))
```
`setTimeout` هرگز `clearTimeout` نمی‌شود. اگر client سریع وصل شود، تایمر همچنان در event loop می‌ماند تا timeout. در `connectAll` با 10 سرور، 10 تایمر معلق.

**Fix:** `const t = setTimeout(...); try { await race } finally { clearTimeout(t) }`

### B6 — `AgentRuntime` timeout leak مشابه
**File:** `agent-runtime.ts:110-114`
```ts
const timeoutPromise = new Promise<never>((_, reject) => { setTimeout(...) })
```
اگر `executionPromise` زودتر resolve شود، تایمر همچنان می‌ماند.

### B7 — `Orchestrator.initialize()` دوبار `bootstrapCatalogTools`
**File:** `orchestrator.ts:159-170`
دو بار پشت سر هم صدا می‌شود — یکبار قبل از `loadSkills` و یکبار بعد. بار اول idempotent است (skip if exists) اما بار دوم اضافی و گیج‌کننده است. باید فقط یکبار بعد از لود skillها باشد یا با کامنت توضیح.

### B8 — `Orchestrator.shutdown()` ترتیب اشتباه
```ts
this.taskRuntime.destroy(); // unsubscribes EventBus
await this.taskRuntime.waitForAll(); // now no events will update tasks
```
باید ابتدا `waitForAll` سپس `destroy`.

### B9 — `UsageAggregator` planId اشتباه
**File:** `usage-aggregator.ts:49-57`
```ts
planId: task.planStepId // این stepId است، نه planId
```
→ `byPlan` همیشه `unassigned` یا stepId خواهد بود، نه plan واقعی. باید `task` شامل `planId` جدا باشد یا از `PlanStore` نگاشت شود.

### B10 — `AcceptanceChecker` race condition
**File:** `acceptance-checker.ts:31-40`
به `agent:completed` گوش می‌دهد اما `PlanRuntime.syncStepStatuses` هم به همان رویداد وابسته است. اگر `AcceptanceChecker` قبل از `TaskRuntime.handleRunResult` اجرا شود، `getResult` هنوز `completed` نیست → early return و چک کیفیت هرگز انجام نمی‌شود. ترتیب subscribe نامشخص است (Map iteration order).

**Fix:** به جای گوش دادن به EventBus، یک hook صریح در `PlanRuntime` بعد از `syncStepStatuses` صدا بزنید.

### B11 — `StreamingManager.translateEvent` planId = taskId
**File:** `streaming-manager.ts:108`
```ts
planId: event.taskId // Will be mapped to planId by the caller
```
اما caller هرگز map نمی‌کند. → کلاینت فکر می‌کند planId = taskId است.

### B12 — `PlanStore`/`SessionStore` بدون file lock / atomic write
**Files:** `plan-store.ts:42`, `session-store.ts:50`
```ts
fs.writeFileSync(filePath, JSON.stringify(...))
```
اگر دو process هم‌زمان بنویسند، فایل corrupt می‌شود. همچنین `saveSession` ورودی را mutate می‌کند (`lastActiveAt`). باید از `writeFileSync(temp) + renameSync` برای atomicity و از `deepClone` بدون mutate استفاده کرد.

---

## 🟠 Security — طبق فاز ۱۶ گام ۳

### S1 — `search_code` و `git_status` فاقد path validation (B1,B2 تکرار اما از منظر امنیتی Critical)
- CWE-22 Path Traversal, CWE-400 ReDoS

### S2 — `path-security.ts` symlink bypass
```ts
const resolved = path.resolve(workspaceRoot, filePath);
```
`path.resolve` symlink را دنبال نمی‌کند. اگر داخل workspace یک symlink به `/etc` وجود داشته باشد، `resolved` داخل workspace به نظر می‌رسد اما `readFile` به خارج می‌رود. باید `fs.realpathSync` یا `realpath` استفاده شود (یا حداقل document شود که symlinkها باید غیرفعال باشند).

### S3 — `validateWorkspacePath` case-insensitive bypass در Windows
`startsWith(normalizedRoot + sep)` در ویندوز case-insensitive باید باشد. در لینوکس ok است اما برای portability باید `toLowerCase()` روی هر دو در ویندوز.

### S4 — `McpConnector.sanitiseError` ناقص
- فقط مقادیر header را redact می‌کند، نه env var nameها (که خودشان sensitive نیستند اما در لاگ می‌مانند — ok).
- اما اگر خطا شامل token بدون prefix باشد (مثلاً فقط `sk-...`) و طول آن <8 باشد، شرط `part.length >8` باعث عدم redact می‌شود. باید همه مقادیر env var که طول >4 دارند redact شوند بدون شرط اضافی.

### S5 — `ObservabilityLogger.redactPayload` فقط key exact match
```ts
if (this.redactKeys.has(lowerKey) || this.redactKeys.has(key))
```
اگر کلید `myApiKey` یا `openai_api_key` باشد، match نمی‌شود. باید substring/includes چک شود: `lowerKey.includes('apikey') || lowerKey.includes('token')...`

### S6 — `search_code` خطا را silent skip می‌کند
```ts
} catch { // Skip unreadable files silently }
```
این می‌تواند permission errorهای مهم را پنهان کند. حداقل باید در debug log ثبت شود.

---

## 🟡 Performance

### P1 — `PlanRuntime.countDependents` O(R * (V+E)) برای هر iteration
**File:** `plan-runtime.ts:274-293`
برای هر step آماده، BFS کامل روی گراف انجام می‌شود. اگر 50 step آماده باشد و 200 step کل، 50*200 = 10k بازدید در هر iteration. با memoization یا یکبار topological depth calculation می‌توان به O(V+E) رساند.

**بهبود:**
```ts
// precompute dependency depth once via reverse graph DFS + memo
const depthCache = new Map<string, number>();
function depth(id): number { ... }
```

### P2 — `AgentCache` از `JSON.stringify` برای مقایسه استفاده می‌کند
**File:** `agent-factory.ts:336`
`JSON.stringify` روی هر `get` → O(n) + allocation. برای defهای بزرگ (چند KB) کند است. از hash (مثلاً `object-hash` یا `stableStringify + sha256`) یا version field استفاده کنید.

### P3 — `TaskRuntime.scheduleNext` هر بار کل `tasks` را فیلتر می‌کند
**File:** `task-runtime.ts:196-200`
`Array.from(this.tasks.values()).filter(pending)` در هر schedule → O(n). با نگهداری دو Set جداگانه `pendingIds` و `runningIds` می‌توان O(1) کرد.

### P4 — `ObservabilityLogger` از `appendFileSync` استفاده می‌کند (sync blocking)
هر لاگ EventBus را block می‌کند. در اجرای 100 task با 5 tool_call هر کدام → 500 sync write. باید از `createWriteStream` با buffering یا `fs.appendFile` async + queue استفاده کرد، یا حداقل `fs.openSync` + `fs.writeSync` با fd reuse.

### P5 — `MemoryPlanStore`/`MemorySessionStore` از `JSON.parse(JSON.stringify())` برای deep clone
این الگو 2x allocation + slow + Date را به string تبدیل می‌کند. از `structuredClone` (Node 17+) استفاده کنید.

### P6 — `McpConnector.defaultCreateClient` هر بار `import('@ai-sdk/mcp')` dynamic
این import باید یکبار cache شود. در `connectAll` با 5 سرور، 5 بار import تکرار می‌شود.

### P7 — `search_code.walkDir` همه فایل‌ها را قبل از تطبیق جمع می‌کند
باید streaming walk باشد: به محض یافتن فایل، آن را بخوان و تطبیق بده، و اگر `maxResults` رسید، early exit از recursion.

### P8 — `SessionStore.listSessions` و `PlanStore.list` هر بار `readdirSync`
اگر تعداد sessionها زیاد شود (هزاران)، این O(n) I/O block می‌شود. برای production باید pagination یا index داشته باشد — فعلاً acceptable برای فاز 14 اما باید document شود.

### P9 — `RateLimiter` از `Math.random()` برای jitter
در تست‌ها non-deterministic است. باید injectable random یا seedable باشد تا تست‌ها flaky نشوند.

### P10 — `EventBus` از `Set` برای handlers + دوباره `Set` برای dedup در emit
```ts
const allHandlers = new Set<EventSubscriber>();
if (targeted) for (const h of targeted) allHandlers.add(h);
```
اگر handler هم در targeted و هم در wildcard باشد، dedup درست است اما allocation اضافی دارد. می‌توان با یک loop و check ساده بهینه کرد — کم‌اهمیت اما در hot path.

### P11 — `Planner` dead code `parseJsonResponse`
متد خصوصی استفاده‌نشده (از زمان `generateObject` منسوخ). باید حذف شود تا bundle کوچک‌تر شود.

### P12 — `ToolRegistry.getToolsByIds` هر بار object جدید می‌سازد
اگر یک agent بارها با همان toolIds ساخته شود، هر بار `Record` جدید allocate می‌شود. می‌توان LRU cache برای ترکیب‌های پرتکرار اضافه کرد.

---

## 🔵 Code Quality / Maintainability

### Q1 — استفاده گسترده از `any`
118 مورد `any` در codebase (بیشتر در تست‌ها اما 12 مورد در runtime):
- `agent-runtime.ts:204` `(step as any).toolCalls`
- `mcp-connector.ts:75` `const _exhaustive: never = auth` سپس `JSON.stringify(_exhaustive)` — این الگو درست است اما `_exhaustive` هرگز نباید به runtime برسد؛ باید قبل از آن throw شود.
- `orchestrator.ts:294` `resolved: any`

**Fix:** تایپ‌های `ai` SDK را import کنید: `import type { ToolCallPart } from 'ai'` و برای `any`های تست، `// @ts-expect-error` یا generic helper بسازید.

### Q2 — `console.log`/`console.error` مستقیم در runtime
- `observability-logger.ts:137`, `event-bus.ts:120`, `acceptance-checker.ts:49`, `orchestrator.ts:96`
باید از `ObservabilityLogger` استفاده شود، نه console مستقیم، تا redaction رعایت شود.

### Q3 — `createTask` backward compat overload گیج‌کننده
**File:** `task-control-tools.ts:25`
```ts
if (deps instanceof Object && 'createTask' in (deps as any))
```
`instanceof Object` همیشه true برای objectهاست. باید `typeof deps === 'object' && deps !== null && 'createTask' in deps` و یا بهتر: دو تابع جدا `createCreateTaskToolSimple` و `createCreateTaskToolFull`.

### Q4 — `FilePlanStore.filePath` sanitization ضعیف
```ts
planId.replace(/[^a-zA-Z0-9_-]/g, '_')
```
این باعث collision می‌شود: `plan:1` و `plan_1` هر دو به `plan_1` تبدیل می‌شوند. باید hash یا base64url استفاده شود، یا حداقل collision check.

### Q5 — عدم وجود Zod validation در `OrchestratorConfig`
`OrchestratorConfig` هیچ schema ندارد — `maxConcurrentTasks: -1` یا `projectRoot: ''` می‌تواند پاس شود و بعداً fail کند. باید `OrchestratorConfigSchema` با `z.object({ projectRoot: z.string().min(1), maxConcurrentTasks: z.number().int().min(1).max(100) ... })`.

### Q6 — `bootstrapTools` vs `Orchestrator` hardcoded tool defs
`bootstrapTools` از `registry/tools/*.json` می‌خواند اما `Orchestrator` لیست هاردکد `localToolDefs` دارد — duplication. باید فقط از `bootstrapTools` استفاده شود.

### Q7 — عدم وجود `AbortSignal` برای cancellation واقعی
`cancelTask` برای running tasks فقط status را عوض می‌کند اما `AgentRuntime.run` همچنان در حال اجراست (fetch به provider). باید `AbortController` به `generateText` پاس شود.

### Q8 — `review.ts` `usage` optional اما `orchestrator.ts` همیشه set می‌کند
ناسازگاری جزئی — باید در schema `default` یا در reviewer همیشه populate شود.

### Q9 — `plan.ts` `isPlanTerminal` فقط `done`/`failed` را terminal می‌داند
اما `cancelled` هم terminal است (در Task). باید `cancelled` هم اضافه شود یا مستند شود که cancelled steps به failed تبدیل می‌شوند.

### Q10 — `src/ai/tools/index.ts` خالی / ناقص
باید barrel export داشته باشد اما فقط 18 خط است — بررسی شود.

---

## ✅ نقاط قوت (برای حفظ)

- **Law 12:** هیچ Agent مستقیم Tool impl import نمی‌کند — فقط `bootstrap.ts` این کار را می‌کند.
- **Law 13/14:** `delegate_task` تنها راه Main→Sub و compact events + `get_task_details` رعایت شده.
- **Law 15:** `generateObject` با Zod در Planner و Reviewer.
- **Law 17:** حلقه `PlanRuntime` بدون درخواست ادامه، re-planning خودکار، cancellation تنها تعامل مجاز.
- **Law 18:** `allowedTools` در Factory و `delegate_task` و Feasibility Gate هر سه چک می‌شوند.
- **Security hardening فاز ۱۶:** `PATH_TRAVERSAL_BLOCKED`, redaction در logger و MCP connector, wildcard `*` handling.

---

## 📋 TODO List اولویت‌بندی شده

### P0 — قبل از هر production deploy
1. [ ] Fix B1: `search_code` path validation + ReDoS protection
2. [ ] Fix B2: `git_status` path validation
3. [ ] Fix B3: `read_file`/`write_file` از `projectRoot` inject شده استفاده کنند نه `process.cwd()`
4. [ ] Fix B5,B6: clearTimeout برای MCP و AgentRuntime
5. [ ] Fix B12: atomic write در PlanStore/SessionStore
6. [ ] Fix S2: symlink check با `realpathSync`
7. [ ] Fix S5: redact substring match

### P1 — هفته آینده
8. [ ] Fix B4: tryRegister ZodError
9. [ ] Fix B8: shutdown order
10. [ ] Fix B9: UsageAggregator planId mapping
11. [ ] Fix B10: AcceptanceChecker race — تبدیل به explicit hook
12. [ ] Fix B11: StreamingManager planId mapping
13. [ ] P1: countDependents memoization
14. [ ] P4: ObservabilityLogger async buffered writes
15. [ ] Q5: OrchestratorConfig Zod schema
16. [ ] Q7: AbortSignal برای cancellation

### P2 — بهبود مستمر
17. [ ] P2: TaskRuntime pending/running Sets
18. [ ] P3: AgentCache hash به جای JSON.stringify
19. [ ] P5: structuredClone به جای JSON parse/stringify
20. [ ] Q1: کاهش any به <20 مورد در runtime (نه تست)
21. [ ] Q2: حذف console.* مستقیم از runtime
22. [ ] P11: حذف dead code parseJsonResponse
23. [ ] S4: بهبود sanitiseError برای tokenهای کوتاه
24. [ ] Q4: filePath collision fix با hash

---

## 📊 متریک‌ها

| متریک | مقدار |
|-------|-------|
| کل فایل‌های TS runtime | 51 |
| کل خطوط کد runtime (بدون تست) | ~7,800 |
| تست فایل‌ها | 20 |
| تست کیس‌ها | 334 |
| `any` در runtime (غیر تست) | ~12 |
| `console.*` در runtime | 4 |
| sync fs ops در runtime | 14 (plan-store, session-store, observability, skill-registry) |
| setTimeout بدون clear | 2 |

---

## 🔍 Scope Audit — نگاشت 18 نیازمندی به فازها (تأیید نهایی)

| نیازمندی | فاز | وضعیت |
|-----------|-----|--------|
| MCP | 2 | 🟢 اما B5,S4 باقی |
| context budget | 5 | 🟢 اما P2 |
| انتخاب پویای Agent | 6 | 🟢 |
| planning | 9 | 🟢 |
| authorization (allowedTools) | 4,5,6,9,16 | 🟢 |
| feasibility gate | 9 | 🟢 |
| per-step quality | 11 | 🟢 اما B10 |
| resource lock | 8 | 🟢 |
| persistence | 10,14 | 🟢 اما B12 |
| priority queue | 10 | 🟢 اما P1 |
| qualitative failure | 11 | 🟢 |
| ابهام‌زدایی | 9 | 🟢 |
| streaming | 13 | 🟢 اما B11 |
| cancellation | 13 | 🟢 اما Q7 |
| concurrency/rate-limit | 8,13 | 🟢 |
| usage tracking | 13 | 🟢 اما B9 |
| session persistence | 14 | 🟢 اما B12 |
| observability | 14 | 🟢 اما P4,S5 |

**نتیجه:** تمام 18 نیازمندی نگاشت شده‌اند، اما 5 مورد دارای باگ‌های P0/P1 هستند که باید قبل از تحویل نهایی رفع شوند.

---

## 📝 پیشنهاد برای فاز 18 (Hardening v2)

اگر پروژه ادامه یابد، فاز 18 می‌تواند شامل موارد زیر باشد:
- اضافه کردن `projectRoot` به تمام Toolها via factory injection
- جایگزینی `fs.writeFileSync` با `atomicWrite` utility
- اضافه کردن `AbortController` به `AgentRuntime` و `TaskRuntime`
- بهبود `search_code` با `ripgrep` یا `fast-glob` + early exit
- تست‌های fuzz برای `search_code` pattern و path traversal
- بنچمارک برای `countDependents` و `scheduleNext` با 500 step

