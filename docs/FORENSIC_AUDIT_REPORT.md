# گزارش ممیزی فارنزیک کدبیس `human-out-of-the-loop` (hootl)

> **پروتکل:** اسکیل `forensic-codebase-review-audit` — صفر فرض، همه یافته‌های تأییدشده با شواهد verbatim و شماره خط راستی‌آزمایی‌شده با `grep -n`/خواندن مستقیم فایل.
> **محیط ممیزی:** شاخه `worktree-review-execution-plan`، HEAD = `5532449` (`fix(R0-10,R0-11,R0-12): scope git writes to workspace, --only commits, .ai-runtime gitignore`)، `git status` تمیز به‌جز دایرکتوری untracked `.claude/` (خارج از scope).
> **OUT OF SCOPE:** `servers-main/`، `node_modules/`، `dist/`، `docs/history/*`، `.claude/`، `.git/`.
> **زبان گزارش:** فارسی. کد و شناسه‌ها عیناً حفظ شده‌اند.
> **گستره ممیزی این گزارش فقط یافته‌های خودِ این ممیزی است** (نه نتایج ماتریس ۱۴۵یافته‌ای `docs/REVIEW_EXECUTION_PLAN.md` — آن‌ها صرفاً به‌عنوان ادعای سند ذکر می‌شوند و جایی که با کد مقایسه شد، مشخص شده است).

---

## ۱. Executive Summary (خلاصه اجرایی)

این کدبیس یک ران‌تایم ارکستراسیون چندایجنتی LLM با CLI (`hootl`) و سرور وب Express است. **هسته ران‌تایم و ابزارهای git/filesystem نشان‌دهنده رفع جدی و واقعیِ یک موج hardening قبلی است** (فاز R0 در `docs/REVIEW_EXECUTION_PLAN.md`) — این موارد در §۱۴ (نقاط قوت تأییدشده) مستندند. اما این ممیزی یک **شکاف امنیتی فعال** (فقدان احراز هویت روی سرور وب با bind پیش‌فرض `0.0.0.0`)، یک **قابلیت امنیتی ناتمام و نیمه‌سیم‌کشی‌شده** (R0-08: گیت اعتماد پروژه بدون هیچ راه‌حل CLI و بدون پوشش مسیرهای introspection)، و **۴ باگ رفتاری تأییدشده** را مستند می‌کند.

**ریسک‌های بحرانی/بالا (همه با شواهد §۳/§۴):**

| ID | عنوان | Severity |
|---|---|---|
| SEC-001 | سرور وب بدون احراز هویت + bind پیش‌فرض `0.0.0.0` — هر کسی در شبکه می‌تواند اجرای پلن/ابزار را trigger کند | HIGH |
| CONF-001 | `--trust-project` در CLI وجود ندارد؛ گیت اعتماد R0-08 نیمه‌پیاده (dead wiring با `trust.ts`) | HIGH |
| SEC-003 | مسیرهای introspection MCP (`tools --mcp`، `mcp test`، `POST /api/mcp/:id/test`) بدون بررسی `trustedProject`، سرور stdio لایه پروژه را spawn می‌کنند — دورزدن مستقیم ضمانت R0-08 | HIGH |
| SEC-002 | کانفیگ MCP فیلد `env` ندارد؛ stdio بدون env سفارشی spawn می‌شود؛ کامنت کد و ماژول ترنسپورت ادعای متضاد دارند | MEDIUM |
| BUG-001 | journal با پیش‌فرض `summary` نتیجه کامل ابزار را می‌نویسد — تناقض با هدر ماژول | MEDIUM |
| ARCH-001 | `retryableAgentRuntime` با rate-limiter ساخته می‌شود ولی هیچ‌کجا استفاده نمی‌شود (retry/429-backoff مرده) | MEDIUM |

**آمادگی production:** پیکربندی سرور وب (bind بدون auth روی 0.0.0.0) و نیمه‌پیاده‌بودن گیت اعتماد R0-08، در کنار ماتریس تست ناقص در مسیرهای آن‌ها، به این معناست که اگر این نرم‌افزار در محیط چندکاربره یا با پروژه‌های clone‌شده اجرا شود، در **اقدام به‌روزرسانی فوری** قرار دارد. حکم نهایی: **NEEDS MAJOR REMEDIATION** (§۱۷).

---

## ۲. Audit Coverage (پوشش ممیزی)

**فایل‌های ردیابی‌شده git:** ۵۱۹ فایل. تفکیک (بر اساس `git ls-files`):

| دسته | تعداد |
|---|---|
| TS production (شامل `src/**` بدون تست) | ۲۳۰ فایل / ~۴۱k خط |
| TS تست (`src/**/__tests__`) | ۱۰۶ فایل |
| `e2e/` (run.mjs، fake-llm.mjs، fixtures) | ~۶ فایل |
| `public/` (index.html، app.js، style.css) | ۳ فایل |
| `registry/` (JSON لایه پکیج: personas/tools/skills/models/mcp-servers/agents.json) | ~۲۰ فایل |
| `scripts/` (ci-test.mjs) | ۱ فایل |
| docs (CONFIGURATION.md، REVIEW_EXECUTION_PLAN.md، READINESS_AUDIT.md، README.md)، CHANGELOG، CONTRIBUTING، package.json، vitest.config.ts | ~۸ فایل |

**وضعیت بازبینی (باید با Appendix A یکی باشد):**
- بازبینی کامل فایل‌به‌فایل: هسته ارکستراسیون (`orchestrator.ts` تمام ۱۵۸۳ خط)، ران‌تایم‌ها (plan-runtime، task-runtime، agent-runtime، journal، plan-store، cancellation-manager، rate-limiter، mcp-fetch)، ابزارها (fetch، task-control-tools، mcp-connector، mcp-stdio-transport، mcp-fetch)، registries (trust)، CLI (cli.ts بخش‌های help، mcp.ts، logs.ts، registry.ts، utils/config.ts)، سرور (server.ts + routes/registry.ts + routes/run.ts)، schemas (mcp-server، plan)، frontend (app.js بخش‌های امنیتی، index.html، style.css)، e2e (fake-llm.mjs نقطه شخصا، run.mjs ساختار)، package.json.
- بازبینی نمونه‌ای/اسکن: باقی ابزارهای `src/ai/tools/implementations/*` (بازبینی R0 جلسات قبل + grep نقاط داغ)، بقیه routeها (sessions/plans/stream/usage/preview/observability-stream)، بقیه CLI commands، registry JSON، CHANGELOG/CONTRIBUTING.
- Skipped با دلیل (OUT OF SCOPE): `servers-main/` (۵۱ فایل TS)، `docs/history/*`، `dist/`، `node_modules/`، `.claude/`.

**ماتریس کامل:** Appendix A. **کارها/flowهای بازسازی‌شده:** §۱۴.

**آرتیفکت‌های مفقود (§3.3 اسکیل):** `.env` واقعی و `.env.example` وجود ندارد؛ لاگ اجرای واقعی (production) وجود ندارد. هر نتیجه‌ای که به رفتار provider واقعی یا مقادیر env واقعی وابسته است UNVERIFIED است (Appendix B).

---

## ۳. Critical Findings

**یافته CRITICAL تأییدشده‌ای در این ممیزی وجود ندارد.** نزدیک‌ترین مورد SEC-001 است که در HIGH نگه داشته شد (دلیل در خود یافته: bind روی همه اینترفیس‌ها یک انتخاب صریح در کد است و مسیر حمله نیاز به دسترسی شبکه به پورت دارد؛ در شبکه بدون اعتماد اما عملی و مستقیم است). همه یافته‌های این ممیزی در سطوح HIGH و پایین‌تر هستند.

---

## ۴. High Severity Findings

### SEC-001 — سرور وب بدون احراز هویت و با bind پیش‌فرض روی همه اینترفیس‌ها

```
ID:          SEC-001
SEVERITY:    HIGH
CATEGORY:    SEC (Security)
CONFIDENCE:  CONFIRMED

TITLE: express server بدون هیچ middleware احراز هویت/توکن اجرا می‌شود و به‌طور پیش‌فرض روی 0.0.0.0 گوش می‌دهد؛ هر کلاینتی با دسترسی شبکه می‌تواند اجرای پلن، اجرای ابزار و خواندن جریان observability را trigger کند.

LOCATION:
- File:     src/server.ts
- Symbol:   startServer / createApp
- Line(s):  199 (host)، 116–164 (app.use بدون auth)

EVIDENCE:
src/server.ts:199
    const host = options.host ?? '0.0.0.0';

src/server.ts:116
  app.use(express.json({ limit: '1mb' }));
src/server.ts:134
  app.use((req, res, next) => { ... ctx.ready ... });   // فقط lazy-init؛ هیچ auth
src/server.ts:141-148
  app.use(sessionsRouter(ctx));
  app.use(plansRouter(ctx));
  app.use(runRouter(ctx));
  app.use(streamRouter(ctx));
  app.use(registryRouter(ctx));
  app.use(previewRouter(ctx));
  app.use(usageRouter(ctx));
  app.use(observabilityStreamRouter(ctx));

src/server/routes/run.ts:32,120
  router.post('/api/run', async (req, res) => { ... });
        const result = await ctx.orchestrator.run(message.trim(), { ... });
```

PROBLEM: هیچ توکن/کلید/میان‌افزار احراز هویتی روی هیچ مسیر API وجود ندارد. سرور در عین حال روی همه اینترفیس‌ها bind می‌شود. مقایسه‌کننده درون‌کدبیسی: `hootl serve --mcp --http` **اجباری** token دارد و bind را 127.0.0.1 محدود می‌کند (help CLI، src/cli.ts:514–517).

WHY IT IS A PROBLEM: هر کلاینتی در شبکه (LAN، container network، شبکه cloud) می‌تواند `POST /api/run` را صدا بزند؛ این endpoint `orchestrator.run(...)` را اجرا می‌کند که به نوبت خود ابزارهای نوشتن فایل، اجرای دستور و git را در `projectRoot` فراخوانی می‌کند. یک UI که برای localhost طراحی شده با bind 0.0.0.0 عملاً یک API اجرای کد روی شبکه باز است.

TRIGGER: اجرای `npm run server` (یا `node dist/src/server.js`) در هر ماشینی با شبکه دسترس‌پذیر.

EXPECTED: bind پیش‌فرض 127.0.0.1 + احراز هویت توکن‌محور (الگوی هم‌کدبیس: `serve --http`).

ACTUAL: bind `0.0.0.0` + صفر auth.

IMPACT: اجرای Remote-unauthenticated برای پلن‌های عامل با ابزارهای نوشتن؛ نشت اطلاعات از APIهای observability/usage/sessions.

ROOT CAUSE: فاز UI (Phase 24) احراز هویت را scope خارج کرده و فقط برای مسیر MCP اعمال شده است.

RECOMMENDED FIX: bind پیش‌فرض → `127.0.0.1`؛ افزودن middleware توکن مشابه `serve --http` (اجباری وقتی host ≠ 127.0.0.1)؛ مستندسازی پرچم `--token`/`HOTL_SERVER_TOKEN`.

REGRESSION RISK: پایین — تغییر پیش‌فرض ممکن است دیپلوی‌های محلی با port-forward را بشکند؛ قابل مدیریت با لاگ هشدار.

RELATED FILES: src/server.ts، src/server/routes/*.ts.
RELATED WORKFLOWS: W3 (§۱۴).

### CONF-001 — `--trust-project` وجود ندارد؛ گیت اعتماد R0-08 نیمه‌پیاده با dead wiring

```
ID:          CONF-001
SEVERITY:    HIGH
CATEGORY:    CONF (Configuration) / SEC
CONFIDENCE:  CONFIRMED

TITLE: Orchestrator لایه mcp-servers پروژه را بدون trustedProject:true بوت‌استرپ نمی‌کند و به «Pass trustedProject:true (CLI: --trust-project)» ارجاع می‌دهد؛ اما پرچم --trust-project در کل CLI وجود ندارد و ماژول trust.ts هیچ فراخوان production ندارد. نتیجه: هیچ مسیر کاربری برای اعتمادکردن به یک پروژه وجود ندارد (قابلیت ناتمام R0-08) و ماژول اعتماد مرده است.

LOCATION:
- File:     src/ai/orchestrator.ts, src/cli.ts, src/cli/commands/*, src/ai/registries/trust.ts
- Symbol:   initialize (orchestrator)؛ کل CLI
- Line(s):  orchestrator.ts:689-696؛ cli.ts:228,517 (فقط help)؛ trust.ts:25,32,40

EVIDENCE:
src/ai/orchestrator.ts:689-696
    const mcpServerLayers = allMcpServerLayers.filter(
      (l) => l.scope === 'package' || this.config.trustedProject
    );
    if (mcpServerLayers.length < allMcpServerLayers.length) {
      this.observabilityLogger.logSystemError(
        'mcp-trust',
        `Skipped this project's registry/mcp-servers (untrusted project). ` +
          'Pass trustedProject:true (CLI: --trust-project) to enable it.'
      );

کل CLI — نتایج grep برای "trust":
src/cli.ts:228:        '  serve        expose THESE tools to an MCP client (--mcp; --read-only for untrusted clients)',
src/cli.ts:517:        '  Least privilege (recommended for a client you do not fully trust):',
src/cli/utils/config.ts:27-28:
  /** R0-08: project roots the operator has explicitly trusted to run their own registry/mcp-servers. */
  trustedProjects?: string[];

src/ai/registries/trust.ts:25,32,40 — توابع عمومی بدون هیچ importer:
    export function isProjectTrusted(root: string, config: TrustConfig): boolean {
    export function withTrustedProject(root: string, config: TrustConfig): TrustConfig {
    export function loadTrustedProjects(configPath: string): string[] {
```

PROBLEM: (۱) پرچم ارجاع‌شده در پیام خطا وجود ندارد؛ کاربر انسانی عملاً از این ویژگی محروم است. (۲) `GlobalCliConfig.trustedProjects` در config.ts تعریف شده اما هیچ کدی آن را می‌خواند/می‌نویسد؛ `trust.ts` سه export دارد بدون فراخوان (فقط import شده توسط خودش). (۳) نتیجه رفتاری: لایه mcp-servers پروژه **هرگز** فعال نمی‌شود مگر فراخوان برنامه‌نویس دستی `trustedProject:true` بدهد.

WHY IT IS A PROBLEM: از منظر امنیتی، پیش‌فرض بسته درست است؛ اما پیام ارجاع به پرچم ناموجود، UX را می‌شکند و نشان می‌دهد R0-08 طبق معیار پذیرش خودش («پس از اعتماد، اجرا شود») ناتمام است. سند پلن خودش هم این را تأیید می‌کند (REVIEW_EXECUTION_PLAN.md، «یادداشت اجرا»: «سیم‌کشی --trust-project در run/repl/serve ... هنوز انجام نشده»).

TRIGGER: قرار دادن `registry/mcp-servers/*.json` در پروژه و اجرای هر فرمان؛ یا جستجوی `--trust-project` در help.

EXPECTED: پرچم واقعی + persist در global config از طریق trust.ts (که دقیقاً برای همین نوشته شده).

ACTUAL: dead code + dead flag.

IMPACT: قابلیت ناتمام؛ شکست UX؛ بدهی نگهداری (دو زیرساخت موازی trust که یکی مرده است).

ROOT CAUSE: نیمه‌تمام رهاشدن فاز R0-08.

RECOMMENDED FIX: افزودن `--trust-project` به run/repl/serve + استفاده از trust.ts برای persist؛ یا حذف ارجاع پیام اگر ویژگی عمداً حذف شده.

REGRESSION RISK: پایین.
RELATED FILES: src/ai/registries/trust.ts، src/cli/utils/config.ts.
RELATED WORKFLOWS: W1 (initialize).

### SEC-003 — مسیرهای introspection MCP بدون گیت اعتماد، stdio لایه پروژه را spawn می‌کنند

```
ID:          SEC-003
SEVERITY:    HIGH
CATEGORY:    SEC
CONFIDENCE:  HIGH  (مکانیسم کامل در کد؛ فقط رفتار واقعی اتصال موفق در محیط زنده اجرا نشده — لینک ۷ §۱۲.۱)

TITLE: برخلاف initialize() که لایه mcp-servers پروژه را فیلتر اعتماد می‌کند، سه مسیر introspection بدون هیچ بررسی trustedProject، کانفیگ stdio پروژه را spawn می‌کنند: CLI `tools --mcp`، CLI `mcp test <id>`، و HTTP `POST /api/mcp/:id/test`. این دورزدن مستقیم ضمانت R0-08 است.

LOCATION:
- File:     src/cli/commands/registry.ts, src/cli/commands/mcp.ts, src/server/routes/registry.ts
- Symbol:   collectMcpTools / mcpTestCommand / POST /api/mcp/:id/test
- Line(s):  registry.ts:181-203؛ mcp.ts:28-33؛ routes/registry.ts:109-114

EVIDENCE:
src/cli/commands/registry.ts:181-203 (collectMcpTools — هیچ فیلتر scope/trust):
    const dir = path.join(root, 'registry', 'mcp-servers');
    const { configs, errors } = loadMcpServerConfigs(dir);
    ...
    const registry = new ToolRegistry();
    const connector = new McpConnector({ toolRegistry: registry });
    try {
      for (const config of configs) {
        const ok = await connector.connectServer(config);

src/cli/commands/mcp.ts:28-33 (mcpDirsFor همه لایه‌ها بدون فیلتر اعتماد):
function mcpDirsFor(opts: McpCommandOptions): string[] {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return registryLayersFor(projectRoot).map((layer) =>
    path.join(layer.dir, 'mcp-servers')
  );
}

src/server/routes/registry.ts:109-114 (POST /api/mcp/:id/test — فقط لایه پروژه، بدون trust):
  router.post('/api/mcp/:id/test', async (req, res) => {
    const dir = path.join(ctx.projectRoot, 'registry', 'mcp-servers');
    const { configs } = loadMcpServerConfigs(dir);
    const config = configs.find((c) => c.id === req.params.id);
    if (!config) {
      res.status(404).json({ ok: false, error: `MCP server "${req.params.id}" not found in registry/mcp-servers.` });
      return;
    }
    try {
      // fresh registry — a probe must not touch the live tool registry
```

PROBLEM: ضمانت R0-08 «مخزن مخرب نباید با اولین initialize اجرای دستور بگیرد» فقط روی یک مسیر اعمال شده است. یک پروژه clone‌شده با `registry/mcp-servers/x.json` از نوع stdio، با اجرای `hootl tools --mcp` یا `hootl mcp test x` یا بازکردن UI و فراخوانی probe، باعث spawn فرآیند دلخواه مهاجم می‌شود — بدون آنکه کاربر هیچ‌وقت «اعتماد» را انتخاب کرده باشد.

TRIGGER: clone پروژه مخرب → `hootl tools --mcp` / `hootl mcp test <id>` / `POST /api/mcp/:id/test`.

EXPECTED: همان فیلتر `l.scope === 'package' || trustedProject` روی این سه مسیر.

ACTUAL: بدون فیلتر.

IMPACT: دورزدن گیت اعتماد (bypass). با SEC-001 ترکیب می‌شود (probe از راه دور قابل trigger است).

ROOT CAUSE: اعمال ناهمسانی ضمانت بین initialize و مسیرهای introspection (تک-مکانیزم بودن گیت فقط در یک caller).

RECOMMENDED FIX: استخراج check اعتماد به یک تابع مشترک (همان trust.ts!) و استفاده در هر سه مسیر؛ تست regression برای هر مسیر.

REGRESSION RISK: پایین.
RELATED FILES: src/ai/tools/mcp-bootstrap.ts (loadMcpServerConfigs)، src/ai/tools/mcp-connector.ts.
RELATED WORKFLOWS: W2 (introspection).
```

---

## ۵. Medium Severity Findings

### SEC-002 — کانفیگ MCP فیلد `env` ندارد؛ spawn بدون env؛ ادعاهای متضاد در کامنت‌ها

```
ID:          SEC-002
SEVERITY:    MEDIUM
CATEGORY:    SEC / API
CONFIDENCE:  CONFIRMED

TITLE: McpServerConfigSchema فیلد env ندارد؛ defaultCreateTransport stdio را با {command, args} بدون env می‌سازد؛ اما mcp-stdio-transport.ts هم گزینه env را می‌پذیرد و هم ادعای «config.env» / «env block» را در کامنت خود دارد. ترنسپورت هرگز env سفارشی نمی‌گیرد و کامنت با کد در تناقض است.

LOCATION:
- File:     src/ai/schemas/mcp-server.ts, src/ai/tools/mcp-connector.ts, src/ai/tools/mcp-stdio-transport.ts
- Symbol:   McpServerConfigSchema / defaultCreateTransport / createStdioTransport
- Line(s):  schema: 30-45 (کل بدنه)؛ connector:157؛ transport:30-31،45-49،88-99

EVIDENCE:
src/ai/schemas/mcp-server.ts — کل بدنه McpServerConfigSchema (خطوط 30-45؛ فیلدی به نام env وجود ندارد):
  transport: z.enum(['http', 'sse', 'stdio']).default('http'),
  ...
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  auth: McpAuthSchema.default({ type: 'none' }),
  ...

src/ai/tools/mcp-connector.ts:157
    return createStdioTransport({ command: config.command, args: config.args });

src/ai/tools/mcp-stdio-transport.ts:30-31,45-49:
  /** Extra environment variables for the child (merged over process.env). */
  env?: Record<string, string | undefined>;
  ...
  * server only ever asked for `config.env`. A server never needs more than
  * `env` block.
src/ai/tools/mcp-stdio-transport.ts:88-99:
 * R0-04: the child's environment is the base allowlist plus whatever the
 * `env` block of the server config grants...
    env: { ...baseChildEnv(), ...env },

هیچ مسیری از config → env وجود ندارد (تنها createStdioTransport call بدون env است).
```

PROBLEM: ترنسپورت stdio یک مکانیزم env-allowlist کامل (R0-04: BASE_ENV_ALLOWLIST + merge env سفارشی) دارد که **هیچ‌وقت** ورودی سفارشی دریافت نمی‌کند، چون schema کانفیگ فیلد env را اصلاً نمی‌شناسد. کامنت «A server never needs more than `env` block» به فیلدی ارجاع می‌دهد که وجود ندارد.

WHY: (۱) تعارض doc/code — کد فقط سخت‌گیرتر است (اگر ترنسپورت روزی env را بگیرد باید منبعش مشخص باشد)؛ (۲) کاربرانی که سرورهای MCP به env سفارشی نیاز دارند (فراتر از BASE_ENV_ALLOWLIST و tokenEnvVar/keyEnvVar برای HTTP) مسدودند؛ (۳) ریسک آینده: اگر کسی فیلد env را به schema اضافه کند ولی از مسیر validator رد نشود، ناخواسته process.env کامل به child می‌رسد.

EXPECTED: یا فیلد `env` صریح (به‌صورت نقشه نام-متغیر-محیطی که از EnvSource resolve می‌شود، همسو با الگوی tokenEnvVar) یا حذف ادعا از کامنت.

ACTUAL: فیلد ناموجود + کامنت گمراه‌کننده.

IMPACT: MEDIUM — قابلیت ناقص + بدهی مستندسازی در نقطه حساس امنیتی.

RECOMMENDED FIX: تصمیم صریح درباره env؛ اگر اضافه می‌شود از الگوی EnvSource + allowlist merge موجود استفاده شود.

RELATED FILES: src/ai/env.ts (EnvSource).
```

### BUG-001 — journal با `includeResults: 'summary'` (پیش‌فرض) نتیجه کامل ابزار را در فایل می‌نویسد

```
ID:          BUG-001
SEVERITY:    MEDIUM
CATEGORY:    BUG (correctness / data exposure)
CONFIDENCE:  CONFIRMED

TITLE: پیش‌فرض includeResults 'summary' است، اما مسیر اصلی باJournal نتیجه کامل را وقتی !== 'none' می‌نویسد؛ حذف نتیجه برای 'summary' فقط در شاخه trim (ورودی‌های > 8KB) اتفاق می‌افتد. یعنی عملاً با پیش‌فرض، نتیجه کامل ابزار در journal می‌رود — در تناقض صریح با جدول هدر ماژول («tool results → summary, or full on request»).

LOCATION:
- File:     src/ai/runtime/journal.ts
- Symbol:   JournalWriter constructor / prepare / withJournal
- Line(s):  344، 421-422، 437-441، 532

EVIDENCE:
src/ai/runtime/journal.ts:344
    this.includeResults = options.includeResults ?? 'summary';
src/ai/runtime/journal.ts:421-422 (شاخه غیر-trim: فقط 'none' حذف می‌کند)
    if (this.includeResults === 'none' && redacted.result !== undefined) {
      delete redacted.result;
    }
src/ai/runtime/journal.ts:437-441 (فقط شاخه trim برای 'summary' حذف می‌کند)
      ...(redacted.result !== undefined && this.includeResults === 'full'
        ? { result: { preview: preview(redacted.result) } }
        : {}),
    };
    if (this.includeResults === 'summary') delete trimmed.result;
src/ai/runtime/journal.ts:532 (مسیر اصلی ورود داده — نتیجه کامل برای summary)
            ...(writer.includeResults !== 'none' ? { result: output } : {}),
src/ai/runtime/journal.ts:15 (ادعای هدر ماژول)
 * | tool results | never recorded | summary, or full on request |
```

PROBLEM: با پیش‌فرض production (`'summary'`)، هر نتیجه ابزار کوچک‌تر از 8KB به‌صورت کامل serialise می‌شود. تنها نسخه summary فقط وقتی ساخته می‌شود که ورودی/نتیجه از maxEntryBytes (پیش‌فرض 8KB) بزرگ‌تر باشد و در آن حالت هم نتیجه حذف (نه خلاصه) می‌شود.

EXPECTED (طبق هدر): حالت summary فقط یک خلاصه/پیش‌نمایش از نتیجه را ذخیره کند.

ACTUAL: نتیجه کامل.

IMPACT: MEDIUM — سطح حافظه journal (دسته‌ها/فایل‌های بزرگ‌تر از انتظار؛ هزینه retention) و سطح افشا: redaction روی result اعمال می‌شود (خط 426-429 prepare)، پس نشت credential مستقیم نیست؛ اما خروجی‌های ابزار می‌توانند داده حساس (محتوای فایل‌های پروژه، URLهای داخلی با token در query) را شامل شوند که طراحی «summary-only» قرار بود محدود کند. مصرف دیسک در اجراهای سنگین تا ~8KB×n برآورد اشتباه طراحی را نشان می‌دهد.

ROOT CAUSE: تفکیک ناقص بین شاخه معمولی و شاخه trim در prepare، و شرط نادرست در باJournal (`!== 'none'` به‌جای `=== 'full'`).

RECOMMENDED FIX: در باJournal شرط را به `includeResults === 'full'` تغییر دهید و برای summary یک preview بسازید؛ یا معنای summary را در هدر اصلاح کنید. تست‌های موجود فقط 'full' و 'none' را تست کرده‌اند (phase37-journal.test.ts:136,154) — تست 'summary' وجود ندارد.

REGRESSION RISK: پایین.
RELATED WORKFLOWS: W1/W3 (journal در همه اجراها).
```

### ARCH-001 — RetryableAgentRuntime ساخته می‌شود ولی هرگز استفاده نمی‌شود (retry/429 مرده)

```
ID:          ARCH-001
SEVERITY:    MEDIUM
CATEGORY:    ARCH / REL
CONFIDENCE:  CONFIRMED

TITLE: Orchestrator یک RetryableAgentRuntime با rate-limiter می‌سازد و آن را به‌عنوان property عمومی نگه می‌دارد، اما taskRuntime و answerRun هر دو agentRuntime خام را استفاده می‌کنند؛ rate-limit و retry/backoff عملاً در مسیر اجرای plan/chat غیرفعال است.

LOCATION:
- File:     src/ai/orchestrator.ts
- Symbol:   constructor
- Line(s):  295، 414-417، 418-422، 1297

EVIDENCE:
src/ai/orchestrator.ts:295
  readonly retryableAgentRuntime: RetryableAgentRuntime;
src/ai/orchestrator.ts:414-417
    this.retryableAgentRuntime = new RetryableAgentRuntime(
      this.agentRuntime,
      this.rateLimiter
    );
src/ai/orchestrator.ts:418-422
    this.taskRuntime = new TaskRuntime({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      eventBus: this.eventBus,
      agentRuntime: this.agentRuntime,
src/ai/orchestrator.ts:1297 (answerRun هم خام)
      const run = await this.agentRuntime.run({
```

PROBLEM: grep در کل src (خارج از تست‌ها) فقط سه رفرنس به retryableAgentRuntime دارد: تعریف property، مقداردهی در constructor، و هیچ‌کدام دیگر. یعنی rate-limiter (که همین‌طور rateLimiter جدا هم نگهداری می‌شود) و منطق retry/backoff به هیچ مسیر اجرایی وصل نیست.

EXPECTED: TaskRuntime (و answerRun) از RetryableAgentRuntime استفاده کنند یا این کلاس حذف شود.

ACTUAL: dead wiring.

IMPACT: MEDIUM — زیر 429/timeout واقعی provider، اجرای گام‌ها بدون backoff شکست می‌خورد و به مسیر replanning/failed می‌رود؛ از منظر قابلیت اطمینان، رفتار مستندشده (RetryableAgentRuntime) با رفتار واقعی یکی نیست. این مورد ریسک درست/غلط نیست بلکه قابلیت اطمینان ازدست‌رفته است.

ROOT CAUSE: احتمالاً رفع فاز CORR/PERF قبلی که در نقطه wiring نیمه‌کاره مانده.

RECOMMENDED FIX: تزریق retryableAgentRuntime به TaskRuntime؛ تست 429-mock.

REGRESSION RISK: متوسط — تغییر مسیر retry می‌تواند رفتار timeout را عوض کند؛ با تست پوشش داده شود.
RELATED FILES: src/ai/runtime/agent-runtime-retry.ts، src/ai/runtime/rate-limiter.ts.
```

### BUG-002 — finalizePlan اجازه می‌دهد مدل، id پلن را تعیین کند

```
ID:          BUG-002
SEVERITY:    MEDIUM
CATEGORY:    BUG (data integrity)
CONFIDENCE:  HIGH  (مسیر از مدل تا store در کد کامل است؛ سناریوی collide واقعی اجرا نشده)

TITLE: finalizePlan از id مدل‌ساخته استفاده می‌کند (`plan.id ?? plan_<uuid>`)؛ PlanSchema فقط min(1) می‌خواهد و FilePlanStore نام فایل را hash-of-id می‌گذارد. یک پاسخ مدل با id دلخواه (یا تکراری) در store با پلن دیگری برخورد/overwrite می‌کند.

LOCATION:
- File:     src/ai/planning/planner.ts, src/ai/schemas/plan.ts, src/ai/runtime/plan-store.ts
- Symbol:   finalizePlan / PlanSchema / FilePlanStore.filePath
- Line(s):  planner.ts:87-96؛ plan.ts:61-64 (id optional، min 1)؛ plan-store.ts:57-64

EVIDENCE:
src/ai/planning/planner.ts:87-96
export function finalizePlan(plan: Plan): Plan {
  for (const step of plan.steps) {
    step.status = 'pending';
  }
  return {
    ...plan,
    id: plan.id ?? `plan_${randomUUID()}`,
    status: 'draft',
    createdAt: plan.createdAt ?? Date.now(),
  };
}

src/ai/schemas/plan.ts:61-64
  /** Unique plan identifier */
  id: z.string().min(1).optional(),

src/ai/runtime/plan-store.ts:57-64
  private filePath(planId: string): string {
    // Phase 22 (STORE-01): hash-based filename...
    const hash = createHash('sha256').update(planId).digest('hex').slice(0, 16);
    return path.join(this.dir, `${hash}.json`);
```

PROBLEM: کامنت STORE-01 دقیقاً می‌گوید hash-based filename برای جلوگیری از cross-plan corruption است؛ اما خود id هنوز از ورودی غیرقابل‌اعتماد (خروجی مدل در generateObject) می‌آید. دو پلن با id یکسان → یک فایل → overwrite خاموش (save ساده overwrite می‌کند).

TRIGGER: مدل (یا gateway خراب/مدل جعلی در e2e) `{"id": "plan_1"}` برگرداند در دو run مختلف؛ یا ابزار attacker-چانل ورودی prompt به این id هدایت کند.

EXPECTED: id همیشه runtime-generated باشد (`plan_<uuid>` بدون fallback به مدل).

ACTUAL: fallback فقط وقتی id غایب است؛ idهای مدل‌ساخته عبور می‌کنند.

IMPACT: MEDIUM — در عمل هر دو شرط (id تکراری از مدل) نادرند، اما قاعده «id by runtime» در کامنت plan-store صراحت دارد و کد آن را نقض می‌کند. ریسک data-integrity خاموش.

RECOMMENDED FIX: در finalizePlan همیشه `id: \`plan_${randomUUID()}\`` (نادیده‌گرفتن id مدل) یا حداقل pattern-enforce `/^plan_[0-9a-f-]{36}$/`.

RELATED FILES: src/ai/planning/planner.ts:584,636 (دو caller).
```

### API-001 — ناسازگاری لایه‌بندی بین `mcp list` (لایه‌ای) و `tools --mcp`/`/api/mcp` (فقط لایه پروژه)

```
ID:          API-001
SEVERITY:    LOW
CATEGORY:    API (contract consistency)
CONFIDENCE:  CONFIRMED

TITLE: `hootl mcp list` کانفیگ‌ها را از همه لایه‌ها (package + project) merge می‌کند؛ اما `hootl tools --mcp` (collectMcpTools) و روت‌های `/api/mcp*` فقط `<root>/registry/mcp-servers` را می‌خوانند.

LOCATION:
- File:     src/cli/commands/mcp.ts, src/cli/commands/registry.ts, src/server/routes/registry.ts
- Line(s):  mcp.ts:28-33؛ registry.ts:187؛ routes/registry.ts:95,110

EVIDENCE:
src/cli/commands/mcp.ts:28-33 (لایه‌ای):
function mcpDirsFor(opts: McpCommandOptions): string[] {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return registryLayersFor(projectRoot).map((layer) =>
    path.join(layer.dir, 'mcp-servers')
  );
}
// + mcp.ts:36: /** Merge per-layer configs by id — later layers win. */

src/cli/commands/registry.ts:187 (فقط پروژه):
    const dir = path.join(root, 'registry', 'mcp-servers');

src/server/routes/registry.ts:95,110 (فقط پروژه):
    const dir = path.join(ctx.projectRoot, 'registry', 'mcp-servers');
```

PROBLEM/IMPACT: LOW — همان سرور MCP در `mcp list` دیده می‌شود ولی در `tools --mcp` و UI غایب است (اگر فقط در لایه پکیج تعریف شده باشد). اتصال contract-level بین CLI و UI ناهمسان است؛ دیباگ سخت می‌شود.

RECOMMENDED FIX: استفاده از registryLayersFor در collectMcpTools و routes.
```

### REL-001 — persist() خطاهای ذخیره پلن را بی‌صدا قورت می‌دهد

```
ID:          REL-001
SEVERITY:    LOW-MEDIUM
CATEGORY:    REL
CONFIDENCE:  CONFIRMED

TITLE: PlanRuntime.persist هر exception ذخیره را با catch خالی می‌بلعد؛ کامنت می‌گوید «In production, this goes to the observability log (Phase 14)» اما هیچ logی در کد نیست.

LOCATION:
- File:     src/ai/runtime/plan-runtime.ts
- Symbol:   persist
- Line(s):  627-645

EVIDENCE:
src/ai/runtime/plan-runtime.ts:627-645
  private persist(plan: Plan): void {
    try {
      ...
      this.config.planStore.save(plan);
    } catch {
      // Persistence failure should not crash the loop
      // In production, this goes to the observability log (Phase 14)
    }
  }
```

PROBLEM: if persist fails (دیسک پر، permission، خرابی .ai-runtime)، اجرا ادامه می‌یابد و وضعیت پلن روی دیسک از حالت حافظه عقب می‌ماند — بدون هیچ ردپایی. کامنت ادعای لاگ دارد که وجود ندارد؛ crash-recovery (resume بعد از crash) پس از چنین شکستی حالت گمراه‌کننده می‌بیند (مثلاً stepهای done نشده که در فایل قدیمی 'running' مانده‌اند).

IMPACT: silent state divergence؛ ریسک resume نادرست پس از crash واقعی.

RECOMMENDED FIX: حداقل یک warn به observabilityLogger/eventBus (زیر throttle) در catch.
```

---

## ۶. Low Severity Findings

### REL-002 — CancellationManager مراحل pending بدون taskId را لغو نمی‌کند و syncStepStatuses برای task لغوشده notify نمی‌کند

```
ID:          REL-002
SEVERITY:    LOW
CATEGORY:    REL / CONC
CONFIDENCE:  CONFIRMED (کد) / POTENTIAL برای اثر UI

TITLE: (۱) cancelPlan فقط stepهای pending با taskId را cancel می‌کند؛ stepهای pending که هنوز taskId نگرفته‌اند رد می‌شوند. (۲) syncStepStatuses برای case 'cancelled' هیچ notify() صدا نمی‌زند (برخلاف completed/failed).

EVIDENCE:
src/ai/runtime/cancellation-manager.ts:107-111
    for (const step of plan.steps) {
      if (step.status === 'pending' && step.taskId) {
        this.taskRuntime.cancelTask(step.taskId);

src/ai/runtime/plan-runtime.ts:365-369 (case cancelled — بدون notify)
        case 'cancelled':
          step.status = 'failed';
          step.failureType = 'technical';
          step.resultSummary = 'Task was cancelled';
          break;
```

IMPACT: LOW — UI/صف‌های گوش‌دهنده رخداد پایان آن step را نمی‌بینند؛ وضعیت گزارش‌گیری در نقشه UI ممکن است تا پایان پلن رنج بکشد. خود مسیر پلن غلط نمی‌شود (status به failed تنظیم می‌شود).
RECOMMENDED FIX: notify در case cancelled + بررسی pending-without-taskId در cancel.
```

### REL-003 — followLog پس از truncate ممکن است رکورد تکراری چاپ کند

```
ID:          REL-003
SEVERITY:    LOW
CATEGORY:    REL
CONFIDENCE:  CONFIRMED (مکانیسم)

TITLE: در followLog، پس از تشخیص truncate/rotate، lastShown = max(0, all.length - tail) تنظیم می‌شود؛ اگر طول فایل بعد از truncate > tail باشد، همه آن entryها دوباره چاپ می‌شوند حتی اگر همه قبلاً دیده شده بودند.

EVIDENCE:
src/cli/commands/logs.ts:156-160
    if (newSize < size) {
      // Truncated/rotated — resync to the current tail
      lastShown = Math.max(0, all.length - tail);
    }
    size = newSize;
    for (const entry of all.slice(lastShown)) onEntry(entry);
```

IMPACT: LOW — فقط noise در `logs --follow`؛ درست نیست غلط نیست (داده از دست نمی‌رود)، ولی تکرار گمراه‌کننده است. راه‌حل: مقایسه با lastShown قبلی و علامت‌گذاری رکوردهای جدید با ts>آخرین-ts.
```

### CONF-002 — loadDotEnv فقط فرمت ساده KEY=VALUE را پشتیبانی می‌کند (بدون multiline/export)

```
ID:          CONF-002
SEVERITY:    LOW
CATEGORY:    CONF
CONFIDENCE:  CONFIRMED

TITLE: پارسر .env داخلی چندخطی را پشتیبانی نمی‌کند و خطوط شروع‌شده با `export ` را از کلید بیرون نمی‌آورد؛ کلیدی که در فرمت رایج `export KEY=...` نوشته شده باشد نادیده گرفته می‌شود (به‌صورت خام `export KEY` به‌عنوان نام متغیر می‌رود اگر eq > 0 باشد — عملاً کلید 'export KEY' نامعتبر می‌شود).

EVIDENCE:
src/cli/utils/config.ts:53-83 (پارسر): split('\n')، indexOf('=')، حذف نقل‌قول‌های محصور؛ هیچ پشتیبانی multiline/export.

IMPACT: LOW — سردرد UX؛ مستندات README (§721-723) توقع .env استاندارد را می‌دهد. کلید واقعی گم می‌شود (fail-open به خطای provider که قابل‌تشخیص است).
RECOMMENDED FIX: strip leading `export `؛ یا مستندسازی صریح محدودیت.
```

### DEBT-001 — create_task در مسیر bare-runtime یک stub موفق‌نما است

```
ID:          DEBT-001
SEVERITY:    LOW
CATEGORY:    DEBT (deceptive behavior)
CONFIDENCE:  CONFIRMED

TITLE: اگر createCreateTaskTool فقط TaskRuntime بگیرد (bare runtime، بدون deps کامل)، ابزار create_task همیشه success:true برمی‌گرداند با taskId جعلی `pending_<agentId>_<uuid>` و هیچ task واقعی نمی‌سازد.

EVIDENCE:
src/ai/tools/implementations/task-control-tools.ts:43-63 (execute در خط 53)
    return tool({
      ...
      execute: async ({ agentId }: ...) => {
        return {
          success: true as const,
          taskId: `pending_${agentId}_${randomUUID()}`,
          message:
            'Task creation request received. Use delegate_task for full agent resolution.',
        };

مسیر bootstrap واقعی (task-control-bootstrap.ts:52-62) همیشه fullDeps می‌دهد؛ این شاخه compat است.
```

IMPACT: LOW — فقط اگر فراخوانی دستی با bare runtime انجام شود؛ اما success:true با «هیچ کاری نکردن» الگوی خطرناک success-faker است. RECOMMENDED FIX: برگرداندن success:false با کد DEPRECATED یا حذف شاخه compat.
```

### OPS-001 — test file fs-runner با حساسیت به ترتیب اجرا (سیگنال از B10) — UNVERIFIED

این مورد از مقایسه ساختار تست‌ها با رفتار CLI است؛ **Insufficient evidence to establish this.** → به Appendix B منتقل شد.

---

## ۷. Potential / Unverified Findings

> هیچ‌کدام از موارد زیر یافته تأییدشده نیستند. هیچ‌کدام در جدول ریسک (§۱۵) Severity عملیاتی ندارند.

**POT-001 (POTENTIAL، PERF):** `sessionListEl.innerHTML` و bubbleها در `public/app.js` از قالب template استفاده می‌کنند؛ همه مقادیر متغیر با `escapeHtml` (خط 93-99) escape شده‌اند و `renderMarkdown` (خط 107) اول escape و بعد markdown می‌سازد؛ اما مسیر `outcome` class (`escapeHtml(s.lastOutcome || '')` داخل span کلاس outcome، خطوط 174-177) و `title` attribute (خط 178) به escapeHtml متکی‌اند که `"` را هم escape می‌کند. **شواهد فعلی XSS نشان نمی‌دهد**؛ ریسک فقط این است که escapeHtml تک‌نقطه‌ای است و هر جای آینده که مقدار بدون escape داخل template برود (مثل appendAssistantBubble در خط 267 که kind ثابت است) باید دیسیپلین حفظ شود. INSUFFICIENT EVIDENCE برای یک باگ واقعی. (Appendix B)

**POT-002 (UNVERIFIED):** رفتار واقعی providerهای OpenAI/Anthropic (rate-limit واقعی، 429 handling) و endpointهای سفارشی HOTL_BASE_URL — `.env` واقعی و لاگ اجرا موجود نیست؛ همه رفتارهای وابسته به provider واقعی UNVERIFIED. (Appendix B)

**POT-003 (UNVERIFIED):** `POST /api/run` بدون auth در صورت قرارگیری پشت reverse-proxy با auth سازمانی — فرضی؛ هیچ config دیپلوی در repo نیست. (Appendix B)

**POT-004 (POTENTIAL، SEC):** اسکیمای zod برای `McpServerConfigSchema.url` فقط `z.string().url()` است — هیچ محدودیتی روی scheme (مثلاً file:// یا localhost برای http-transport) یا روی مقادیر `tokenEnvVar` وجود ندارد؛ مسیر عملیاتی ریسک نیازمند ترکیب با اعتماد پروژه و SEC-003 است؛ به‌تنهایی مسیر اثبات‌شده‌ای به نشت ندارد. INSUFFICIENT EVIDENCE. (Appendix B)

**POT-005 (UNVERIFIED):** اثر داخلیهای `@ai-sdk/mcp` و `ai@7` (نسخه‌های package.json: `@ai-sdk/mcp 2.0.55`، `ai 7.0.111`) بر رفتار SSE/timeout و تناقض احتمالی با timeoutهای سفارشی mcp-fetch — نیازمند تست واقعی با سرور SSE کند. (Appendix B)

---

## ۸. Architecture Findings

1. **ARCH-001 (تأییدشده، §۵):** dead wiring retry layer — معماری «انتخاب runtime» ناتمام؛ سازنده دو مسیر را نگه می‌دارد ولی فقط یکی را می‌بندد.
2. **ARCH-002 (INFO):** دو زیرساخت موازی برای trust: `src/ai/registries/trust.ts` (dead) و `trustedProject:boolean` در OrchestratorConfig — جدایی منطق اعتماد از persist آن (config.ts بدون reader) و هر دو از یک مسیر عبور نمی‌کنند. این با CONF-001 هم‌ریشه است؛ به‌عنوان شکل معماری همان یافته ذکر شد (کنترل duplicate در §12.5 رعایت شد).
3. **ARCH-003 (INFO):** لایه‌بندی ناهمسان بین CLI و server برای mcp (API-001) نشانه نبود یک abstraction مشترک برای «سرورهای MCP قابل‌استفاده در پروژه X» است — هر caller خودش دایرکتوری و merge policy تعیین می‌کند.
4. **ARCH-004 (INFO):** فرانت‌اند vanilla با DOM دستی + innerHTML template (public/app.js، 1198 خط) — الگوی escapeHtml متمرکز خوب است ولی نگهداری‌پذیری و ریسک آینده escape-jump (POT-001) را بالا می‌برد. INFO؛ yافته‌ای در این ممیزی اثبات نشد.

---

## ۹. Security Findings

**تأییدشده:** SEC-001 (HIGH)، CONF-001 (HIGH — وجه configuration آن)، SEC-003 (HIGH)، SEC-002 (MEDIUM)، BUG-001 (MEDIUM، وجه افشا).

**POTENTIAL:** POT-001 (XSS discipline)، POT-004 (schema constraint) — جزئیات §۷.

**نقاط قوت امنیتی تأییدشده در این ممیزی** (برای انصاف و برای جلوگیری از false-positive در ممیزی‌های بعدی — جزئیات §۱۴):

- fetch با دفاع SSRF چندلایه: pinned DNS (R0-03)، check در هر redirect hop، byte-cap با cancel stream، بدون credential forwarding؛ و **ادعای جلسات قبل درباره نشت Agent را رد می‌کنیم**: `if (pinnedAgent) void pinnedAgent.close().catch(() => undefined);` در fetch.ts:371 (داخل finally، خطوط 368-372) وجود دارد.
- stdio MCP child env: BASE_ENV_ALLOWLIST (R0-04) — البته با SEC-002 ناتمام در سمت config.
- `serve --http` با token اجباری و bind 127.0.0.1 (help CLI:512-517؛ README:258) — برخلاف SEC-001 که مسیر وب UI است.
- protected paths `.git`/`.ai-runtime`، محدودسازی git به workspace (R0-09/R0-10) و OPENAI_API_KEY فقط به api.openai.com (R0-07) — این موارد در جلسات قبلی با تست بازتولید بررسی شدند؛ در این جلسه دوباره بازبینی نشدند و به‌عنوان ادعای سند پلن با وضعیت 🟢 ثبت‌اند (Appendix B — re-verification pending برای R0-09/R0-10/R0-07 در این session).

---

## ۱۰. Reliability Findings

- **REL-001 (تأییدشده):** persist بی‌صدا — divergence بین حافظه و دیسک، بی‌ردپا. §۵.
- **REL-002 (LOW):** cancel/notify gaps. §۶.
- **REL-003 (LOW):** followLog duplicate after truncate. §۶.
- **ARCH-001 (وجه reliability):** بدون retry واقعی، 429های گذرا مستقیم به گام-شکست و replanning می‌رسند؛ در اجراهای چندگامی، این به معنای هزینه‌برشدن recovery است.
- **REL-004 (POTENTIAL):** in-flight وابسته به waitForAll در shutdown (orchestrator.shutdown، خط 1559-1568 خوانده شد): ترتیب درست است (taskها → mcp → stream → logger)؛ **اثبات رفتار در سناریوی واقعی SIGKILL نیاز به تست زنده دارد** — UNVERIFIED (Appendix B).

---

## ۱۱. Performance Findings

یافته تأییدشده عملکردی مهمی در این ممیزی ثبت نشد. موارد بررسی‌شده:

- journal با پیش‌فرض summary که عملاً full است (BUG-001) — اثر حجم دیسک/IO در اجراهای بزرگ؛ طبق §5.2 اسکیل، به‌عنوان bug ثبت شد نه perf.
- `readEntries` در logs.ts کل فایل را هربار می‌خواند (به‌خصوص در follow با هر event) — LOW/POTENTIAL (فایل log می‌تواند چند صد MB شود)؛ INSUFFICIENT EVIDENCE از اجرای واقعی برای ثبت به‌عنوان یافته (Appendix B).
- PlanStore با index idByFile (PERF-06) و lock+atomic write — الگو درست است؛ مشکل شناخته‌شده‌ای دیده نشد.

---

## ۱۲. Testing Gaps

۱۰۶ فایل تست وجود دارد؛ پوشش ساختاری خوب است، اما شکاف‌های هدفمند:

1. **TEST-001 (تأییدشده):** `e2e/fake-llm.mjs:447` همیشه `assignedPersona: 'coder'` برمی‌گرداند → هیچ سناریوی e2e مسیر persona دیگری (چت با toolهای خواندنی، پاسخ مبهم، داوری پذیرش) را با کاتالوگ واقعی نمی‌پوشاند. سند پلن (R7-01) همین را با معیار پذیرش مشخص می‌کند — در این ممیزی کد تأیید شد که هنوز برقرار است.
2. **شکاف تست BUG-001:** حالت `includeResults: 'summary'` هیچ تستی ندارد (تست‌ها فقط 'full' و 'none': phase37-journal.test.ts:136,154).
3. **شکاف تست SEC-003:** هیچ تستی وجود ندارد که asserting کند `tools --mcp` / `mcp test` / `/api/mcp/:id/test` سرور stdio پروژه غیرمطمئن را رد می‌کند (چون همین رفتار در کد هم نیست).
4. **شکاف تست CONF-001:** هیچ تست CLI‌ای برای پرچم trust (پرچم وجود ندارد).
5. **شکاف تست SEC-001:** تست‌های سرور (u2-registry، u6-usage-tasks) همه با app بدون auth تست می‌شوند؛ هیچ تستی رفتار bind یا رد درخواست بدون توکن را نمی‌سنجد (چون رفتار در کد هم نیست).
6. **شکاف تست ARCH-001:** RetryableAgentRuntime در isolate تست دارد اما هیچ تست integration‌ای 429→retry→success را از مسیر orchestrator نمی‌سنجد.
7. **شکاف تست REL-001:** هیچ تستی شکست persist (دیسک پر/locked) را شبیه‌سازی نمی‌کند.
8. **شکاف تست e2e faults:** سناریوهای fault خوب‌اند (CUT، BADJSON، EMPTY) اما هیچ سناریویی رفتار 429/timeout provider واقعی را در سطح e2e ندارد (وابسته به POT-002).

---

## ۱۳. Technical Debt

| ID | بدهی | جایگاه | چرا اهمیت دارد | Cost |
|---|---|---|---|---|
| DEBT-001 | stub موفق‌نمای create_task | task-control-tools.ts:43-63 | الگوی success-faker؛ ریسک استفاده آینده | کم |
| DEBT-002 | dead module trust.ts + پرچم ارجاع‌شده ناموجود | trust.ts / cli.ts | دو زیرساخت trust موازی؛ گیج‌کننده برای maintainer | کم |
| DEBT-003 | کامنت‌های ادعا-محور بدون تطبیق کد (journal header، persist comment، stdio env block) | journal.ts:32، plan-runtime.ts:640، mcp-stdio-transport.ts:45 | در این کدبیس کامنت‌ها بخشی از سند امنیتی‌اند؛ تناقض آنها اعتماد به اسناد را می‌شکند | کم |
| DEBT-004 | لاگ‌های «فاز X» به‌جای معنا (Phase 20/24/29/37…) در کل هسته | orchestrator.ts و runtime | نگهداری بلندمدت سخت؛ رویت کل تاریخچه در کد | متوسط |
| DEBT-005 | تناقض نسخه: package.json `version 27.17.3` و سند پلن به نسخه‌های v27.17.x در کامنت‌ها ارجاع می‌دهد ولی changelog مربوط به همان نسخه بخش‌های ناتمام (R0-08 wiring) را پوشش نمی‌دهد | package.json/CHANGELOG | ردیابی release ↔ capability | کم |

---

## ۱۴. Workflow Analysis

**فهرست workflowهای بازسازی‌شده در این ممیزی (شماره‌ها به بخش‌های مرتبط ارجاع می‌دهند):**

- **W1 — CLI run (پلن کامل):** cli.ts → Orchestrator.run (validate runOverrides → clarify loop → plan → feasibility → cycles → confirm → persist → PlanRuntime.execute → review → report). باگ‌ها: BUG-002 (id از مدل)، BUG-001 (journal)، REL-001 (persist)، ARCH-001 (بدون retry).
- **W2 — Introspection MCP:** `mcp list` (لایه‌ای، API-001) / `tools --mcp` (collectMcpTools، بدون trust، SEC-003) / `mcp test` (بدون trust، SEC-003) / `/api/mcp*` (فقط پروژه، بدون trust، SEC-003 + SEC-001).
- **W3 — Web UI run:** browser → `POST /api/run` (بدون auth، SEC-001) → همان W1 → SSE stream (بدون auth).
- **W4 — Chat/answer:** auto-mode answerRun → agentRuntime.run (بدون retry، ARCH-001) → journal (BUG-001) → report.
- **W5 — Cancel/resume:** cancelPlan (REL-002) → PlanRuntime.execute cancel-flag → resumePlan (orphan detection + task:interrupted logging — درست طراحی شده) → interaction close.
- **W6 — Shutdown:** waitForAll → mcp closeAll → streaming stop → logger close → taskRuntime.destroy (REL-004 unverified in live).

**Failure workflowهای دیده‌شده:** clarify-loop بدون callback → failure (درست)؛ planning-error خالی از سؤال → Phase 29 fallback (تأیید از e2e faults)؛ persist failure → silent (REL-001)؛ journal failure → process.emitWarning یک‌بار (درست).

---

## ۱۵. Risk Matrix

| Finding | Severity | Confidence | Likelihood | Impact | Area | Location |
|---|---|---|---|---|---|---|
| SEC-001 | HIGH | CONFIRMED | بالا (هر دیپلوی شبکه) | اجرای agent بدون auth | SEC | src/server.ts:199 |
| CONF-001 | HIGH | CONFIRMED | قطعی (ویژگی از دسترس خارج است) | قابلیت ناتمام + گیجی UX | CONF | orchestrator.ts:696؛ cli.ts |
| SEC-003 | HIGH | HIGH | بالا با clone مخرب | دورزدن گیت R0-08 | SEC | registry.ts:187؛ routes/registry.ts:110 |
| SEC-002 | MEDIUM | CONFIRMED | متوسط | قابلیت ناقص + doc/code تناقض | SEC | mcp-server.ts؛ connector:157 |
| BUG-001 | MEDIUM | CONFIRMED | قطعی (پیش‌فرض) | داده بیشتر در journal | BUG | journal.ts:344، 422، 441، 532 |
| ARCH-001 | MEDIUM | CONFIRMED | بالا هنگام 429 | retry مرده | ARCH | orchestrator.ts:414-421 |
| BUG-002 | MEDIUM | HIGH | کم | overwrite پلن | BUG | planner.ts:93، plan-store.ts:64 |
| API-001 | LOW | CONFIRMED | متوسط | ناهمخوانی CLI/UI | API | mcp.ts vs registry.ts |
| REL-001 | LOW-MED | CONFIRMED | کم (خطای دیسک) | state divergence خاموش | REL | plan-runtime.ts:627-645 |
| REL-002 | LOW | CONFIRMED | متوسط | notify گم در cancel | REL | cancellation-manager.ts:107-111؛ plan-runtime.ts:365 |
| REL-003 | LOW | CONFIRMED | کم | duplicate log lines | REL | logs.ts:156-160 |
| CONF-002 | LOW | CONFIRMED | متوسط | .env استاندارد نادیده | CONF | config.ts:53-83 |
| DEBT-001 | LOW | CONFIRMED | کم | success-faker | DEBT | task-control-tools.ts:43-63 |

---

## ۱۶. Prioritized Remediation Plan

**Immediate (پیش از هر دیپلوی/اشتراک‌گذاری):**
1. SEC-001: bind پیش‌فرض 127.0.0.1 + token middleware (الگوی serve --http). تست: درخواست بدون توکن → 401.
2. SEC-003: اعمال فیلتر اعتماد مشترک روی collectMcpTools / mcp test / /api/mcp/:id/test (+ تست هر سه مسیر).
3. CONF-001: تصمیم و اجرا: یا سیم‌کشی `--trust-project` + persist با trust.ts، یا حذف ارجاع پیام و علامت‌گذاری ویژگی به‌عنوان not-implemented.

**Short Term:**
4. BUG-001: اصلاح شرط باJournal و معنای summary + تست حالت summary.
5. REL-001: لاگ warn در persist catch (throttled).
6. ARCH-001: وصل RetryableAgentRuntime به TaskRuntime/answerRun یا حذف؛ تست 429.
7. BUG-002: id پلن همیشه runtime-generated.

**Medium Term:**
8. API-001: یک abstraction مشترک «MCP servers قابل‌استفاده» برای CLI/server.
9. SEC-002: تصمیم فیلد env (با EnvSource) یا پاکسازی کامنت.
10. REL-002/REL-003/CONF-002/DEBT-001.

**Long Term:**
11. DEBT-004: بازنویسی کامنت‌های فاز-محور به معنا-محور.
12. DEBT-005: همگام‌سازی نسخه/changelog/capability.
13. تست e2e برای personaهای غیرcoder (R7-01) + سناریوی 429 (وابسته به POT-002).

---

## ۱۷. Final Verdict

**NEEDS MAJOR REMEDIATION**

مبنای حکم، فقط یافته‌های این ممیزی است: سه یافته HIGH (SEC-001 بدون-auth سرور وب با bind 0.0.0.0؛ CONF-001 قابلیت اعتماد ناتمام با dead wiring؛ SEC-003 دورزدن گیت اعتماد در سه مسیر introspection) که هر یک با اصلاحات قابل‌دستیزی قابل‌رفع‌اند اما در وضع فعلی سطح حمله پروژه در اجرای شبکه‌ای و اجرای پروژه‌های clone‌شده را ناامن می‌کنند؛ در کنار باگ‌های MEDIUM تأییدشده (BUG-001، ARCH-001، BUG-002) که درستی داده (journal/plan id) و قابلیت اطمینان (retry) را تحت تأثیر می‌گذارند. هسته اجرا و ابزارها show strong remediation (§۱۴ نقاط قوت) و تست‌ساختار خوب است؛ اما verdict بر اساس وضعیت فعلی، نه مسیر بهبود، صادر می‌شود.

---

## ۱۸. Appendix A — Coverage Matrix

**راهنما:** R = بازبینی کامل؛ S = بازبینی اسکن/نمونه‌ای با نقطه داغ؛ O = OUT OF SCOPE. Y = یافته ثبت شد.

| # | File | Reviewed | Functions | Branches | Deps | Error Paths | Security | Perf | Tests | Workflows | Findings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | src/ai/orchestrator.ts (1583) | R | Y | Y | Y | Y | Y (trust filter) | N | refs | W1,W3,W4,W5,W6 | CONF-001, ARCH-001 |
| 2 | src/ai/runtime/plan-runtime.ts (689) | R | Y | Y | Y | Y (persist) | N | N | refs | W1,W5 | REL-001, REL-002 |
| 3 | src/ai/runtime/journal.ts (563) | R | Y | Y (prepare/trim) | Y | Y | Y (redaction) | Y | refs | W1-W4 | BUG-001 |
| 4 | src/ai/runtime/plan-store.ts (182) | R | Y | Y | Y (atomic,lock) | Y | Y (hash filename) | Y (index) | refs | W1 | BUG-002 (دریافت‌کننده) |
| 5 | src/ai/runtime/cancellation-manager.ts | R (بخش cancel) | Y | Y | Y | Y | N | N | refs | W5 | REL-002 |
| 6 | src/ai/runtime/agent-runtime.ts | S (باJournal wiring + run signature) | Y | S | Y | S | S | N | refs | W4 | BUG-001 (متصل) |
| 7 | src/ai/runtime/agent-runtime-retry.ts + rate-limiter.ts | S (ساختار) | S | N | Y | N | N | N | refs | — | ARCH-001 |
| 8 | src/ai/runtime/observability-logger.ts | S (فقط wiring) | S | N | Y | S | Y (redact keys) | N | refs | W1 | — |
| 9 | src/ai/planning/planner.ts (788) | R (finalizePlan + context) | Y | Y | Y | S | Y (id) | N | refs | W1 | BUG-002 |
| 10 | src/ai/schemas/plan.ts (220) | R (بخش‌های Plan) | Y | Y | Y | N | Y (id min1) | N | refs | W1 | BUG-002 |
| 11 | src/ai/schemas/mcp-server.ts | R | Y | Y | Y | N | Y (نبود env) | N | refs | W2 | SEC-002 |
| 12 | src/ai/tools/mcp-connector.ts | R (defaultCreateTransport + resolveAuthHeaders) | Y | Y | Y | Y | Y | N | refs | W2 | SEC-002 |
| 13 | src/ai/tools/mcp-stdio-transport.ts | R (env/allowlist) | Y | Y | Y | Y | Y | N | refs | W2 | SEC-002 |
| 14 | src/ai/tools/mcp-fetch.ts (122) | R | Y | Y | Y | Y | Y | Y (timeouts) | refs | W2 | — |
| 15 | src/ai/tools/implementations/fetch.ts (706) | R (SSRF path کامل) | Y | Y | Y | Y | Y | Y | refs | W4 | نقاط قوت؛ یافته قبلی رد شد |
| 16 | src/ai/tools/implementations/task-control-tools.ts (244) | R | Y | Y | Y | Y | N | N | refs | W1 | DEBT-001 |
| 17 | src/ai/tools/task-control-bootstrap.ts (96) | R | Y | Y | Y | N | N | N | refs | W1 | DEBT-001 (مسیر) |
| 18 | src/ai/registries/trust.ts | R | Y | Y | Y | Y | Y | N | refs | — | CONF-001, DEBT-002 |
| 19 | src/server.ts (283) | R | Y | Y | Y | Y | Y | N | refs | W3 | SEC-001 |
| 20 | src/server/routes/registry.ts | R (mcp routes) | Y | Y | Y | Y | Y | N | refs | W2 | SEC-003, API-001 |
| 21 | src/server/routes/run.ts | S (POST /api/run + clarification) | Y | S | Y | S | Y | N | refs | W3 | SEC-001 |
| 22 | src/server/routes/{sessions,plans,stream,usage,preview,observability-stream}.ts | S (signature + wiring) | S | N | Y | S | S | N | refs | W3,W5 | — |
| 23 | src/cli.ts (بخش help/usage) | S | S | N | Y | N | Y (help متن) | N | refs | W1-W2 | CONF-001 |
| 24 | src/cli/commands/mcp.ts (105) | R | Y | Y | Y | Y | Y | N | refs | W2 | API-001 |
| 25 | src/cli/commands/registry.ts (بخش mcp) | R | Y | Y | Y | S | Y | N | refs | W2 | SEC-003, API-001 |
| 26 | src/cli/commands/logs.ts (170) | R | Y | Y | Y | Y | N | Y (follow) | refs | — | REL-003 |
| 27 | src/cli/commands/{run,serve,sessions,plans,tasks,usage,journal}.ts | S (بر اساس R0 و R7 قبلی + help) | S | N | Y | S | S | N | refs | W1 | — |
| 28 | src/cli/utils/config.ts | R | Y | Y | Y | Y | Y (trust field dead) | N | refs | W1 | CONF-001, CONF-002 |
| 29 | src/mcp/server.ts | S (readOnly/allowTools) | S | N | Y | S | Y | N | refs | — | نقاط قوت (R0-05) |
| 30 | src/ai/models/* (providers، list-models، registry) | S (R0-07 قبلی) | S | N | Y | S | Y | N | refs | W1 | — |
| 31 | src/ai/tools/git/* + implementations/git-*.ts | S (R0-09/10/11 قبلی) | S | N | Y | S | Y | N | refs | W1 | نقاط قوت |
| 32 | src/ai/tools/implementations/path-security.ts | S (protected paths قبلی) | S | N | Y | S | Y | N | refs | W1 | نقاط قوت (R0-09) |
| 33 | باقی src/ai/tools/implementations/* (read/write/edit/move/search-code/web-search/time/memory/…) | S (grep نقاط داغ + بازبینی R0) | S | N | Y | S | S | N | refs | W1 | — |
| 34 | src/ai/runtime/{event-bus,streaming-manager,session-store,usage-aggregator,step-events,tool-call-log,thought-stream,secret-scrub,atomic-write,file-lock,llm-timeout,llm-usage,final-reviewer,acceptance-checker,delegation-guard,replan-merge}.ts | S (جریان event و قراردادها) | S | N | Y | S | S (secret-scrub) | N | refs | W1-W6 | — |
| 35 | src/ai/{language,env,environment-context}.ts + registries/* | S | S | N | Y | S | S | N | refs | W1 | — |
| 36 | src/ai/agents/agent-factory.ts | S (createAgent/createAgentCached) | S | N | Y | S | N | Y (cache) | refs | W1 | — |
| 37 | public/app.js (1198) | R (بخش‌های امنیتی/render) + S بقیه | Y | S | Y | S | Y | N | — | W3 | POT-001 |
| 38 | public/index.html (178) | R | — | — | Y | — | S | N | — | W3 | — |
| 39 | public/style.css (467) | R (اسکن) | — | — | — | — | — | N | — | — | — |
| 40 | e2e/fake-llm.mjs | R (persona) | Y | Y | Y | Y | N | N | — | W-test | TEST-001 |
| 41 | e2e/scenarios/run.mjs (2106) | S (ساختار سناریوها + faults) | S | S | Y | Y | S | N | — | W-test | TEST-001 (مرتبط) |
| 42 | registry/* (JSON لایه پکیج) | S (اسکن اسکیماهای موجود) | — | — | Y | — | Y | N | — | W2 | — |
| 43 | package.json، vitest.config.ts، tsconfig.json | R | — | — | Y | — | — | — | refs | — | DEBT-005 |
| 44 | README.md (864)، CHANGELOG.md، CONTRIBUTING.md | S (ادعاها vs کد) | — | — | — | — | — | — | — | — | DEBT-003/005 |
| 45 | docs/CONFIGURATION.md | S (env/MCP claims) | — | — | — | — | — | — | — | — | SEC-002 (ادعای مستند، بدون env) |
| 46 | docs/REVIEW_EXECUTION_PLAN.md (833) | S (R0/R1/R7 sections) | — | — | — | — | — | — | — | — | CONF-001 (تأیید سند) |
| 47 | docs/READINESS_AUDIT.md | O (اسکن اولیه؛ محتوای تاریخی؛ خارج از هدف این ممیزی) | — | — | — | — | — | — | — | — | — |
| 48 | servers-main/** (۵۱ فایل TS) | O (OUT OF SCOPE — دستور کاربر) | | | | | | | | | |
| 49 | docs/history/** | O (OUT OF SCOPE) | | | | | | | | | |
| 50 | dist/**، node_modules/** | O (خروجی build / وابستگی‌ها؛ manifest در scope ماند) | | | | | | | | | |
| 51 | .claude/ | O (untracked، خارج از repo scope) | | | | | | | | | |
| 52 | scripts/ci-test.mjs | S | S | N | Y | S | N | N | — | CI | — |
| 53 | .github/workflows/* | — | — | — | — | — | — | — | — | — | **NOT REVIEWED** — دایرکتوری در کارگیر git موجود نیست (فایل‌های git-tracked آن پیدا نشد؛ R7-02/R7-03 سند پلن به ci.yml ارجاع می‌دهد). Appendix B |

**جمع:** ۵۱۹ فایل tracked؛ بازبینی کامل (R): هسته + ابزارهای حساس + CLI/Server کلیدی + frontend (~۷۰ فایل مؤثر)؛ اسکن (S): ~۱۴۰؛ OUT OF SCOPE: ۶۸ (servers-main + history + dist/node_modules خارج شمارش tracked)؛ NOT REVIEWED با دلیل: `.github/workflows/*` (غایب از tracked set).

---

## ۱۹. Appendix B — Open Questions & Requested Artifacts

| # | موضوع | Known / Unknown / Missing evidence | What would confirm it |
|---|---|---|---|
| B-1 | `.env.example` و `.env` واقعی وجود ندارند | Known: پارسر .env و همه متغیرها در کد شناسایی شد. Unknown: مقادیر/کلیدهای واقعی استقرار. Missing: خود فایل‌ها یا خروجی `hootl /status` از محیط واقعی | یک `.env.example` + یک لاگ run واقعی (بدون secret) |
| B-2 | رفتار providerهای واقعی (429، SSE طولانی، reasoning wire) | Known: مسیر retry مرده (ARCH-001) و dispatcherهای mcp-fetch. Unknown: رفتار زمان اجرا با gateway واقعی. Missing: لاگ واقعی | اجرای e2e `envendpoint`/`thinking` با gateway واقعی + mock 429 |
| B-3 | `.github/workflows/ci.yml` و `real-provider.yml` در فایل‌های tracked یافت نشد | Known: R7-02/R7-03/R7-05 سند پلن به آن ارجاع می‌دهد. Missing: خود فایل‌ها | تأیید آیا workflows حذف شده‌اند یا در branch دیگرند |
| B-4 | XSS discipline فرانت (POT-001) | Known: escapeHtml متمرکز و renderMarkdown escape-first. Unknown: مسیر آینده‌ای که escape را دور بزند. Missing: تست DOM/fuzz | تست XSS با payloadهای گزارش‌شده از مدل در UI |
| B-5 | محدودیت‌های zod schema مcp (POT-004) | Known: url فقط string.url(). Unknown: سناریوی عملی سوءاستفاده بدون ترکیب با SEC-003. | تست با file:// و env-var-nameهای دلخواه + روایت حمله |
| B-6 | رفتار shutdown زیر سیگنال واقعی (REL-004) | Known: ترتیب کد درست. Unknown: SIGINT/SIGTERM واقعی با task در جریان | e2e ctrlc روی این مسیر (موجود: scenarios.ctrlc) با چند task موازی |
| B-7 | readEntries در follow با فایل بزرگ (PERF) | Known: کل فایل هربار. Unknown: اندازه واقعی log در production. | لاگ حجم واقعی + benchmark |
| B-8 | R0-07/R0-09/R0-10 در این session دوباره بازتولید نشدند | Known: کد فعلی مطابق یادداشت اجرای سند پلن تغییر یافته (commit 5532449). Missing: اجرای مجدد تست‌های hardening | `bun test src/ai/__tests__/hardening-security.test.ts` + git-* tests |
| B-9 | نسخه v27.17.3 vs چانجلاگ (DEBT-005) | Known: package.json 27.17.3؛ چانجلاگ 27.17.3 فقط Journal را پوشش می‌دهد در حالی که کامنت‌های کد فازهای 36/37 را صریح می‌گویند. | همگام‌سازی یا مستندسازی release notes کامل |
| B-10 | تعداد تست‌های README/CHANGELOG (R7-06 سند پلن) | Known: سند پلن ناهمخوانی را می‌گوید؛ در این session شمارش دقیق README:854 انجام نشد (فایل 864 خط است). | شمارش automated تست‌ها + پچ مستند |

---

## Quality Gate (§16 اسکیل) — وضعیت

- [x] همه فایل‌های relevant بازبینی/توجیه‌شده (Appendix A؛ skipهای مذکور)
- [x] توابع مهم (orchestrator.initialize/run/answerRun/previewPlan/resumePlan/shutdown، PlanRuntime، Journal، PlanStore، transportها، fetch، cancel، follow) بازبینی شدند
- [x] شاخه‌های مهم (clarify/plan/answer، trim/summary/full، cancel/notify، follow/truncate) بازبینی شدند
- [x] workflowها با مسیر موفقیت و شکست بازسازی شدند (§۱۴)
- [x] تحلیل cross-file (orchestrator↔runtime↔store، schema↔connector↔transport، CLI↔server routes)
- [x] مسیرهای خطا، امنیت، همزمانی، persistence، تست‌ها، config، runtime، بدهی، dead-code با جستجوی repo-wide (grep/C3-B7) بررسی شدند
- [x] یافته‌های تکراری ادغام شدند (ARCH-002 با CONF-001؛ PERFORMANCE جمع در BUG-001)
- [x] فرض‌های بدون پشتوانه حذف شدند — «Agent نشت» رد شد؛ OPS-001 به Appendix B منتقل شد
- [x] هر یافته CONFIRMED با نقل‌قول verbatim و شماره خط راستی‌آزمایی‌شده (sed -n/grep -n این session)
- [x] یافته‌های نامطمئن صریحاً POTENTIAL/UNVERIFIED و در §۷ + Appendix B
- [x] ادعاهای Executive Summary به ID رجوع می‌دهند
- [x] Severity/Confidence توجیه‌شده؛ fixes به ریشه می‌خورند

**حکم نهایی: NEEDS MAJOR REMEDIATION**
