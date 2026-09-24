# Deep Dive — باگ‌های هم‌خانواده مسیر کاری و پیکربندی دوگانه

**تاریخ:** 2026-09-23  
**محرک:** سوال کاربر "مسیر کاری پروژه چجوری مشخص میشه؟"  
**روش:** grep کامل برای `process.cwd()`, `path.resolve`, `projectRoot`, `DelegationGuard`, `agentTimeoutMs`, `maxDelegationDepth`

---

## خلاصه اجرایی

علاوه بر B3 که قبلاً گزارش شده بود، **۶ باگ دیگر از همان خانواده "پیکربندی ذخیره می‌شود اما استفاده نمی‌شود / منبع حقیقت دوگانه است"** پیدا شد. همه از یک الگوی مشترک می‌آیند:

> **الگو:** در `OrchestratorConfig` فیلدی تعریف می‌شود، در constructor ذخیره می‌شود، اما در `initialize()` به جایی که باید استفاده شود پاس داده نمی‌شود. در عوض، آن ماژول مقدار هاردکد یا `process.cwd()` استفاده می‌کند.

---

## 🔴 دسته A: `process.cwd()` به‌جای `projectRoot` — ۴ ابزار

### A1 — `read-file.ts` و `write-file.ts`
```ts
// path-security.ts:36
export function validateWorkspacePath(filePath, workspaceRoot?: string) {
  const root = workspaceRoot ?? process.cwd(); // ← باگ
}

// read-file.ts:17
const validation = validateWorkspacePath(filePath); // بدون projectRoot
```
**اثر:** اگر `Orchestrator({ projectRoot: '/a' })` ولی `process.cwd() = /tmp`، کاربر می‌تواند `/tmp/secret` بخواند حتی اگر `/a` محدود شده باشد. تست `hardening-security` فقط `isPathWithinWorkspace` مستقیم را تست می‌کند، نه این wrapper.

**فیکس:** Factory injection
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

### A2 — `search-code.ts`
```ts
const resolvedDir = path.resolve(process.cwd(), directory); // هیچ validation
file: path.relative(process.cwd(), file)
```
- نه `projectRoot`، نه `path-security`
- `maxResults` رعایت می‌شود اما `walkDir` کل درخت را قبل از چک می‌خواند
- `new RegExp(pattern, 'gi')` → ReDoS

### A3 — `git-status.ts`
```ts
const cwd = path.resolve(process.cwd(), directory);
```
- همین مشکل A2، بدون path-security
- `execFile('git', ['status'], { cwd })` می‌تواند هر دایرکتوری سیستم را `git status` کند، حتی خارج از پروژه

**تعداد کل `process.cwd()` در runtime (غیر تست): 4 مورد — همه در همین 4 فایل**

---

## 🔴 دسته B: `DelegationGuard` هرگز wire نشده — نقض فاز ۱۵ گام ۳

### B1 — `maxDelegationDepth` ذخیره می‌شود اما استفاده نمی‌شود
```ts
// orchestrator.ts:149
maxDelegationDepth: config.maxDelegationDepth ?? 1, // ذخیره

// اما هیچ‌جا:
new DelegationGuard({ maxDepth: this.config.maxDelegationDepth, personaRegistry: ... })
```
grep نشان می‌دهد `DelegationGuard` فقط در `agent-factory.ts` و `delegate-task.ts` import شده، اما در `orchestrator.ts` **اصلاً instantiate نشده**.

### B2 — `delegate_task` بدون guard ثبت می‌شود
```ts
// orchestrator.ts:289
const delegateDeps: DelegateTaskDeps = {
  personaRegistry,
  skillRegistry,
  toolRegistry,
  modelRegistry,
  onTaskCreated,
  resolveAgentId,
  // delegationGuard: ??? ← نیست
};
bootstrapDelegateTask(this.toolRegistry, delegateDeps);
```
در `delegate-task.ts`، چک `if (deps.delegationGuard)` وجود دارد، اما چون `undefined` است، همیشه bypass می‌شود.

**اثر امنیتی:** اگر یک Sub-Agent دارای `delegate_task` در `allowedTools` باشد (که طبق قانون باید نادر باشد اما ممکن است)، می‌تواند **بی‌نهایت بازگشتی** delegate کند و stack overflow / هزینه بی‌نهایت ایجاد کند. فاز ۱۵ گام ۳ می‌گوید "Sub-Agentها به‌طور پیش‌فرض دسترسی به `delegate_task` ندارند" اما این فقط با Guard تضمین می‌شود، نه فقط با `allowedTools`.

**فیکس:**
```ts
const delegationGuard = new DelegationGuard({
  maxDepth: this.config.maxDelegationDepth,
  personaRegistry: this.personaRegistry,
});
const delegateDeps = { ..., delegationGuard, currentDelegationDepth: 0 };
```

---

## 🔴 دسته C: `agentTimeoutMs` ذخیره می‌شود اما استفاده نمی‌شود

```ts
// orchestrator.ts:148
agentTimeoutMs: config.agentTimeoutMs ?? 120_000,

// agent-runtime.ts:47
const DEFAULT_TIMEOUT_MS = 120_000; // هاردکد
// در constructor هیچ config‌ای برای timeout نیست، فقط در run() options.timeoutMs
```

`Orchestrator` مقدار را نگه می‌دارد اما به `AgentRuntime` پاس نمی‌دهد. `TaskRuntime` هم `AgentRuntime` را بدون timeout می‌سازد. فقط در `PlanRuntime` می‌توان timeout را به صورت per-run داد، اما از `OrchestratorConfig` خوانده نمی‌شود.

**اثر:** کاربر فکر می‌کند با `new Orchestrator({ agentTimeoutMs: 30_000 })` تایم‌اوت را ۳۰ ثانیه کرده، اما در واقع همیشه ۱۲۰ ثانیه است.

**فیکس:** `AgentRuntime` باید `timeoutMs` را در constructor بگیرد یا `TaskRuntime.createTask` آن را از `OrchestratorConfig` بخواند.

---

## 🟠 دسته D: پیکربندی‌های دیگر که در `CONFIGURATION.md` مستند شده‌اند اما در `OrchestratorConfig` نیستند

در `CONFIGURATION.md` جدول سقف‌ها:
- `maxConcurrentPerProvider`
- `maxReplanningAttempts` (این یکی هست)
- `maxRetries`, `baseBackoffMs`, `maxBackoffMs`
- `maxDelegationDepth` (هست اما استفاده نمی‌شود)
- `maxSteps`, `contextBudgetChars`, `connectTimeoutMs`

اما در `OrchestratorConfig` فقط ۶ فیلد وجود دارد:
```ts
projectRoot, persistent, runtimeDir, maxConcurrentTasks, maxReplanningAttempts, defaultModelId, agentTimeoutMs, maxDelegationDepth, onProgress
```

یعنی `RateLimiter` با `new RateLimiter()` بدون هیچ config ساخته می‌شود و همیشه defaults را استفاده می‌کند، حتی اگر کاربر در `.env` یا config چیز دیگری بخواهد.

**این هم از خانواده "دوگانگی مستندات vs کد" است.**

---

## 🟠 دسته E: `bootstrapTools` vs هاردکد در `Orchestrator` — دوگانگی دیگر

```ts
// orchestrator.ts:240
const localToolDefs = [
  { id: 'read_file', ... },
  { id: 'search_code', ... },
  ...
];
for (const d of localToolDefs) this.toolRegistry.registerDefinition(d);
this.toolRegistry.registerImplementation('read_file', readFileTool);

// tools/bootstrap.ts
export function bootstrapTools(toolsDir, registry) {
  loadRegistryFromDirectory({ directory: toolsDir, ... });
  // بعد IMPLEMENTATIONS map
}
```

دو راه برای لود Toolها وجود دارد: یکی هاردکد در Orchestrator، یکی فایل‌محور در `bootstrapTools`. دومی هرگز در Orchestrator صدا زده نمی‌شود. این نقض قانون ۱۶ (data-driven) است.

**فیکس:** Orchestrator باید فقط `bootstrapTools(path.join(registryDir, 'tools'), this.toolRegistry)` را صدا بزند و `localToolDefs` حذف شود.

---

## 🟠 دسته F: `loader.ts` و `skill-registry` بدون اعتبارسنجی symlink/path

- `loadRegistryFromDirectory` هر `directory` را می‌پذیرد، بدون اینکه چک کند آیا داخل `projectRoot` است یا نه. چون Orchestrator همیشه `path.join(root, 'registry/...')` می‌دهد، در عمل امن است، اما اگر کسی مستقیماً تابع را صدا بزند، می‌تواند `/etc` را لود کند.
- `skill-registry.ts:112` `path.resolve(skillDir, instr)` — اگر `instr = '../../../etc/passwd'` باشد و `skill.json` مخرب باشد، می‌تواند فایل خارج از workspace بخواند. باید `validateWorkspacePath` روی `mdPath` هم اعمال شود.

---

## 📊 جمع‌بندی تمام باگ‌های هم‌خانواده

| # | فایل | الگو | شدت | دسته |
|---|------|------|-----|------|
| 1 | `read-file.ts` | `process.cwd()` fallback | 🔴 P0 | A |
| 2 | `write-file.ts` | `process.cwd()` fallback | 🔴 P0 | A |
| 3 | `search-code.ts` | `process.cwd()` + no path-security + ReDoS | 🔴 P0 | A+B |
| 4 | `git-status.ts` | `process.cwd()` + no path-security | 🔴 P0 | A+B |
| 5 | `path-security.ts` | `process.cwd()` as default | 🟠 P1 | A |
| 6 | `orchestrator.ts` | `maxDelegationDepth` stored but not used | 🔴 P0 | B |
| 7 | `orchestrator.ts` | `DelegationGuard` never instantiated | 🔴 P0 | B |
| 8 | `orchestrator.ts` | `agentTimeoutMs` stored but not used | 🟠 P1 | C |
| 9 | `orchestrator.ts` | `RateLimiter` without config | 🟡 P2 | D |
| 10 | `orchestrator.ts` | hardcoded `localToolDefs` vs `bootstrapTools` | 🟡 P2 | E |
| 11 | `skill-registry.ts` | `SKILL.md` path without validation | 🟠 P1 | F |
| 12 | `loader.ts` | no root validation | 🟡 P2 | F |

**تمام 12 مورد از یک ریشه هستند: "پیکربندی/مسیر در یک جا تعریف، در جای دیگر نادیده گرفته می‌شود"**

---

## ✅ چک‌لیست فیکس پیشنهادی (فاز ۱۸)

### گام ۱: Factory Injection برای همه Toolهای فایل‌سیستمی
- [ ] `createReadFileTool(projectRoot: string)`
- [ ] `createWriteFileTool(projectRoot: string)`
- [ ] `createSearchCodeTool(projectRoot: string)` + ReDoS guard + path-security
- [ ] `createGitStatusTool(projectRoot: string)` + path-security

### گام ۲: Wire کردن Guardها و Timeoutها
- [ ] `DelegationGuard` instantiation در `Orchestrator.initialize()`
- [ ] پاس دادن `delegationGuard` به `delegate-task` deps
- [ ] پاس دادن `agentTimeoutMs` به `AgentRuntime` یا `TaskRuntime`
- [ ] `RateLimiter` config از `OrchestratorConfig` بخواند

### گام ۳: حذف دوگانگی‌ها
- [ ] حذف `localToolDefs` هاردکد، استفاده از `bootstrapTools`
- [ ] حذف `bootstrapCatalogTools` دوبار صدا زدن (خط 253 و 261)
- [ ] `path-security.ts` دیگر `process.cwd()` default نداشته باشد — اجباری کند `workspaceRoot`

### گام ۴: CLI واقعی
- [ ] `src/cli.ts` با `projectRoot` از `argv` یا `process.cwd()` **فقط در CLI entry**، نه در Toolها
- [ ] `package.json` bin: `"human-out-of-the-loop": "./dist/cli.js"`

---

## چرا این‌ها قبلاً دیده نشد؟

1. **تست‌های unit ایزوله بودند:** هر Tool جداگانه تست شد، نه از طریق Orchestrator
2. **Hardening فاز ۱۶ روی `allowedTools` و `PATH_TRAVERSAL_BLOCKED` تمرکز کرد، نه روی منبع root**
3. **هیچ integration test‌ای با `projectRoot != process.cwd()` وجود نداشت**
4. **Config‌ها در `CONFIGURATION.md` مستند شدند اما در `OrchestratorConfig` تایپ نشدند — مستندات جلوتر از کد بود**

این‌ها دقیقاً همان چیزی است که قانون ۶ (هر فاز باید در برابر معیار پذیرش خودش راستی‌آزمایی شود) می‌خواست جلوگیری کند، اما معیار پذیرش فاز ۱۵ شامل "projectRoot propagation" نبود.

