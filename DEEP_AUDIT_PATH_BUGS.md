# Deep Audit — باگ‌های مشابه "مسیر کاری دوگانه"

**تاریخ:** 2026-09-23
**محرک:** سوال کاربر درباره CLI و `projectRoot` vs `process.cwd()`
**دامنه:** تمام `src/ai/**/*.ts` به جز `__tests__`

---

## خلاصه اجرایی

باگ اصلی که پیدا شد (`process.cwd()` در Toolها به جای `projectRoot`) **یک الگوی تکرارشونده** است. در بررسی عمیق **14 مورد مشابه** دیگر پیدا شد که همگی از یک ریشه می‌آیند:

> **عدم تزریق وابستگی (Dependency Injection) برای مسیر و شناسه‌ها — استفاده از global state (`process.cwd()`, `globalEventBus`, `Math.random()`, `Date.now()`) به جای مقدار صریح از `OrchestratorConfig`**

این باعث می‌شود دو `Orchestrator` با دو `projectRoot` متفاوت، همچنان به یک `cwd` و یک `EventBus` مشترک وصل باشند — یعنی **ایزولاسیون پروژه شکسته می‌شود**.

---

## دسته ۱: مسیر فایل‌سیستمی — 6 باگ (بحرانی)

### 1.1 — `read_file` و `write_file` بدون `projectRoot` (B3 اصلی)
**فایل:** `src/ai/tools/implementations/read-file.ts:13`, `write-file.ts:13`
```ts
const validation = validateWorkspacePath(filePath); // بدون آرگومان دوم
// داخل validateWorkspacePath: workspaceRoot ?? process.cwd()
```
**اثر:** اگر `Orchestrator({ projectRoot: '/projA' })` ولی `process.cwd()='/tmp'` باشد، Tool می‌تواند `/tmp` را بخواند.
**تکرار:** دقیقاً همین الگو در دو Tool.

**فیکس پیشنهادی:**
```ts
export function createReadFileTool(projectRoot: string) {
  return tool({
    execute: async ({ filePath }) => {
      const v = validateWorkspacePath(filePath, projectRoot);
      ...
    }
  });
}
```

### 1.2 — `search_code` بدون هیچ اعتبارسنجی مسیر (B1)
**فایل:** `search-code.ts:51`
```ts
const resolvedDir = path.resolve(process.cwd(), directory);
```
- نه `validateWorkspacePath`، نه `projectRoot`
- `directory` می‌تواند `/etc` باشد
- همچنین `path.relative(process.cwd(), file)` اطلاعات `cwd` را به LLM نشت می‌دهد

### 1.3 — `git_status` بدون اعتبارسنجی (B2)
**فایل:** `git-status.ts:20`
```ts
const cwd = path.resolve(process.cwd(), directory);
```
می‌تواند `git status` را در هر مسیر اجرا کند، حتی خارج از پروژه.

### 1.4 — `SkillRegistry.loadInstructions` بدون boundary check
**فایل:** `skill-registry.ts:112`
```ts
const mdPath = path.resolve(skillDir, instr); // instr از JSON می‌آید
if (!fs.existsSync(mdPath)) throw...
return fs.readFileSync(mdPath, 'utf-8');
```
اگر `skill.json` حاوی `"instructions": "../../etc/passwd"` باشد، `path.resolve` به خارج از `skillDir` می‌رود و فایل خوانده می‌شود. هیچ چک `isPathWithinWorkspace(mdPath, skillDir)` وجود ندارد.

**این باگ مشابه دقیقاً همان الگوی path traversal است که برای Toolها فیکس کردیم، اما برای Skill فراموش شده.**

### 1.5 — `FilePlanStore.filePath` و `FileSessionStore.filePath` collision
**فایل:** `plan-store.ts:47`, `session-store.ts:54`
```ts
const safe = planId.replace(/[^a-zA-Z0-9_-]/g, '_');
return path.join(this.dir, `${safe}.json`);
```
- `plan:1` و `plan_1` هر دو → `plan_1.json` (collision)
- `../../etc/passwd` → `____etc_passwd.json` داخل `this.dir` می‌ماند (امن است اما collision دارد)
- اگر `this.dir` خودش از ورودی کاربر بیاید (مثلاً `runtimeDir: '/tmp/../etc'`), هیچ اعتبارسنجی ندارد

### 1.6 — `Orchestrator` هاردکد Toolها به جای استفاده از `bootstrapTools`
**فایل:** `orchestrator.ts:239-244` vs `src/ai/tools/bootstrap.ts`
```ts
// در orchestrator.ts:
const localToolDefs = [
  { id: 'read_file', ... modulePath: './read-file' },
  ...
];
for (const d of localToolDefs) this.toolRegistry.registerDefinition(d);
```
اما `bootstrapTools(toolsDir, registry)` که باید `registry/tools/*.json` را بخواند، **هرگز صدا زده نمی‌شود**. یعنی اصل داده‌محور بودن (Law 16) نقض شده: اگر کاربری یک Tool جدید در `registry/tools/my_tool.json` بسازد، لود نمی‌شود.

این هم یک **dual source** است: یک منبع حقیقت `registry/tools/*.json` و یک منبع دیگر هاردکد در کد.

---

## دسته ۲: Global Singleton — 3 باگ (متوسط تا بحرانی)

### 2.1 — `globalEventBus` مشترک بین تمام Orchestratorها
**فایل:** `event-bus.ts:148`, `task-runtime.ts:142`, `agent-runtime.ts:79`
```ts
export const globalEventBus = new EventBus();
...
constructor(config) {
  this.eventBus = config?.eventBus ?? globalEventBus;
}
```
اگر دو `Orchestrator` با `projectRoot` متفاوت بسازی (مثلاً در تست یا در یک سرور multi-tenant)، هر دو به یک `EventBus` گوش می‌دهند. Taskهای پروژه A، Eventهای پروژه B را trigger می‌کنند.

**مشابه باگ projectRoot:** مسیر ایزوله است اما EventBus نیست.

**فیکس:** `Orchestrator` باید همیشه `new EventBus()` بسازد، نه fallback به global. `globalEventBus` فقط برای تست‌های قدیمی بماند و deprecated شود.

### 2.2 — `agentRuntime` singleton
**فایل:** `agent-runtime.ts:301`
```ts
export const agentRuntime = new AgentRuntime();
```
همین مشکل — اگر `TaskRuntime` بدون `agentRuntime` صریح ساخته شود، از singleton استفاده می‌کند که به `globalEventBus` وصل است.

### 2.3 — `process.env` مستقیم در Providerها و McpConnector
**فایل:** `openai-provider.ts:15`, `anthropic-provider.ts:14`, `mcp-connector.ts:53,63`
```ts
const apiKey = process.env.OPENAI_API_KEY;
```
این مورد **by design** است (credential از env)، اما مشکل این است که هیچ راهی برای inject کردن env متفاوت per-Orchestrator وجود ندارد. اگر دو پروژه با دو API key مختلف داشته باشی، نمی‌توانی.

**پیشنهاد:** `ModelRegistry` باید `env: Record<string,string>` را از `OrchestratorConfig` بگیرد، نه مستقیم `process.env`.

---

## دسته ۳: شناسه‌ها و تصادفی بودن — 4 باگ (متوسط)

### 3.1 — `Math.random()` برای ID
**فایل‌ها:**
- `session.ts:52` → `session_${now}_${Math.random().toString(36).slice(2,8)}`
- `session.ts:63` → `interaction_${Date.now()}_${Math.random()...}`
- `plan.ts:113` → `plan_${Date.now()}`
- `task.ts:72` → `task_${randomUUID().slice(0,8)}` (این یکی درست است با crypto)
- `delegate-task.ts:203` → `dynamic_${persona}_${Date.now()}`

`Math.random()` قابل پیش‌بینی و دارای احتمال collision است. در اجرای موازی (5 task هم‌زمان)، `Date.now()` یکسان می‌شود و IDها collide می‌کنند.

**مشابه:** همان dual source — یک جا `crypto.randomUUID()` درست استفاده شده، جای دیگر `Math.random()` ناامن.

**فیکس:** همه جا `randomUUID()` از `node:crypto`.

### 3.2 — `Date.now()` برای ID بدون entropy
`plan_${Date.now()}` اگر دو Plan در یک میلی‌ثانیه ساخته شوند (در `PlanRuntime` re-planning سریع)، ID تکراری می‌دهد و `FilePlanStore` فایل را overwrite می‌کند (data loss).

### 3.3 — `RateLimiter` jitter با `Math.random()` غیرقابل تست
**فایل:** `rate-limiter.ts:90`
```ts
const jitter = delay * 0.25 * (Math.random() * 2 - 1);
```
تست‌ها flaky می‌شوند چون backoff هر بار متفاوت است. باید `randomFn` inject شود.

### 3.4 — `ObservabilityLogger` از `new Date(now).toISOString()` و `Date.now()` مخلوط
یک جا `Date.now()`، جای دیگر `new Date().toISOString()` — اگر ساعت سیستم بین دو خط عوض شود (NTP sync)، `timestamp` و `epochMs` ناسازگار می‌شوند. باید از یک `now` واحد استفاده شود (که الان می‌شود، اما در بعضی جاها `Date.now()` دوباره صدا زده می‌شود).

---

## دسته ۴: نشت اطلاعات مسیر — 2 باگ (کم)

### 4.1 — Toolها مسیر absolute را به LLM برمی‌گردانند
**فایل:** `read-file.ts:18`, `write-file.ts:31`
```ts
return { filePath: validation.resolvedPath, ... }
```
`resolvedPath` مثل `/home/user/secret-project/src/...` است — این اطلاعات filesystem را به مدل می‌دهد که می‌تواند در prompt injection استفاده شود.

**باید:** `path.relative(projectRoot, resolvedPath)` برگردانده شود.

### 4.2 — `search_code` از `path.relative(process.cwd())` استفاده می‌کند
این هم نشت `cwd` است، ولی اگر `projectRoot` متفاوت باشد، relative به `cwd` اشتباه است — باید relative به `projectRoot`.

---

## جدول خلاصه — 14 باگ مشابه

| # | فایل | الگو | شدت | مشابه B3؟ |
|---|------|------|-----|-----------|
| 1 | read-file.ts | `process.cwd()` fallback | 🔴 بحرانی | بله - مستقیم |
| 2 | write-file.ts | `process.cwd()` fallback | 🔴 بحرانی | بله - مستقیم |
| 3 | search-code.ts | `path.resolve(process.cwd())` بدون validation | 🔴 بحرانی | بله - بدتر |
| 4 | git-status.ts | `path.resolve(process.cwd())` بدون validation | 🔴 بحرانی | بله - بدتر |
| 5 | skill-registry.ts | `path.resolve(skillDir, instr)` بدون boundary | 🟠 متوسط | بله - مشابه |
| 6 | plan-store.ts / session-store.ts | sanitize با replace → collision | 🟡 کم | بله - path handling |
| 7 | orchestrator.ts | هاردکد Tool defs vs registry/tools/*.json | 🟠 متوسط | بله - dual source |
| 8 | event-bus.ts | `globalEventBus` singleton | 🟠 متوسط | بله - global vs injected |
| 9 | agent-runtime.ts | `agentRuntime` singleton | 🟡 کم | بله - global |
| 10 | session.ts / plan.ts | `Math.random()` + `Date.now()` برای ID | 🟡 کم | بله - inconsistent ID gen |
| 11 | delegate-task.ts | `Date.now()` برای dynamic ID | 🟡 کم | بله |
| 12 | rate-limiter.ts | `Math.random()` برای jitter | 🟢 کم | غیرمستقیم |
| 13 | read-file/write-file | return absolute path → info leak | 🟡 کم | بله - path leak |
| 14 | search-code.ts | `path.relative(process.cwd())` → leak + wrong root | 🟡 کم | بله |

---

## چرا این‌ها قبلاً دیده نشدند؟

1. **تست‌ها هرگز دو Orchestrator موازی نساختند** — همه تست‌ها یک `MemoryPlanStore` و یک `globalEventBus` مشترک داشتند.
2. **تست‌های path-security فقط تابع را تست کردند، نه Tool را با Orchestrator** — مثل اینکه قفل در را تست کنی ولی چک نکنی در به کدام خانه وصل است.
3. **Law 16 (داده‌محور بودن) در فاز ۱۵ شکسته شد** وقتی `Orchestrator` هاردکد شد، اما چون تست‌های e2e با همان هاردکد کار می‌کردند، کسی نفهمید `registry/tools/*.json` نادیده گرفته می‌شود.
4. **ID collision با `Date.now()` در تست‌های سریع دیده نمی‌شود** چون تست‌ها sequential هستند و `Date.now()` هر بار فرق می‌کند. در production با `Promise.all` و 5 task موازی، collision رخ می‌دهد.

---

## فیکس پیشنهادی یکپارچه (P0)

### گام ۱: Factory برای تمام Toolهای FS
```ts
// src/ai/tools/factories.ts
export function createFileTools(projectRoot: string) {
  return {
    read_file: createReadFileTool(projectRoot),
    write_file: createWriteFileTool(projectRoot),
    search_code: createSearchCodeTool(projectRoot),
    git_status: createGitStatusTool(projectRoot),
  };
}
```

### گام ۲: حذف globalEventBus fallback
```ts
// orchestrator.ts
this.eventBus = new EventBus(); // همیشه جدید، نه global
this.agentRuntime = new AgentRuntime(); // همیشه جدید
```

### گام ۳: ID با crypto.randomUUID
```ts
// همه جا:
import { randomUUID } from 'node:crypto';
id: `plan_${randomUUID()}`
id: `session_${randomUUID()}`
```

### گام ۴: SkillRegistry boundary check
```ts
const mdPath = path.resolve(skillDir, instr);
if (!isPathWithinWorkspace(mdPath, skillDir).safe) throw...
```

### گام ۵: CLI واقعی
```ts
// src/cli.ts
#!/usr/bin/env node
const projectRoot = path.resolve(process.argv[2] || process.cwd());
const orch = new Orchestrator({ projectRoot, persistent: true });
```

---

## نتیجه

باگ `projectRoot` **یک مورد منفرد نبود، یک الگوی معماری بود**. 14 مورد مشابه پیدا شد که 4 مورد آن **بحرانی** و هم‌خانواده مستقیم همان باگ هستند.

اگر این فیکس یکپارچه اعمال شود، تمام dual-sourceها به single source (`OrchestratorConfig.projectRoot` + `new EventBus()` + `randomUUID()`) تبدیل می‌شوند.

