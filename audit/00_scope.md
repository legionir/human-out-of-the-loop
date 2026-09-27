# 00_scope — پوشش، نقشه فنی، استثناها، ابزارها

## پروژه
`human-out-of-the-loop` (hootl) — ران‌تایم ارکستراسیون چندایجنتی LLM.
- زبان: TypeScript (Node >= 22, ESM)؛ وابستگی‌های کلیدی: `ai@7.0.111`، `@ai-sdk/openai`، `@ai-sdk/anthropic`، `@ai-sdk/mcp@2.0.55`، `express@^5`، `undici`، `zod@4`، `commander`، `inquirer`، `chalk`.
- تست: `vitest` (۱۰۶ فایل تست در src)، e2e اسکریپتی (`e2e/scenarios/run.mjs` با fake-llm stub).
- DB: ندارد (persist فایل‌محور: `.ai-runtime/` با atomic write + file lock). Broker/queue: ندارد (EventBus درون‌پروسه‌ای + SSE).
- ورودی‌های اجرا: CLI (`src/cli.ts` — commander)، سرور وب Express (`src/server.ts` + `src/server/routes/*`)، سرور MCP stdio/http (`src/mcp/server.ts`)، REPL (`src/cli/repl.ts`)، کتابخانه (`Orchestrator` API عمومی).
- سرویس‌های خارجی: OpenAI، Anthropic، provider محلی OpenAI-compatible (`LOCAL_MODEL_BASE_URL`)، endpoint سفارشی (`HOTL_BASE_URL`)، سرورهای MCP پروژه (stdio/http/sse)، `gh` CLI (ابزارهای git_pr_*).
- CI: `.github/workflows/ci.yml` + `real-provider.yml`.

## ساختار
- `src/` — ۲۶۵ فایل (ai-runtime، cli، web-server، mcp-server-expose) — یک‌بار‌ه کد اصلی.
- `servers-main/` — ۱۵۶ فایل — نسخه vendor شده از `modelcontextprotocol/servers` آپسترم (fetch/git/time/memory/filesystem/everything؛ TS+Python) — T4.
- `registry/` — ۷۲ فایل JSON/MD — کاتالوگ داخلی (tools/personas/skills/models/mcp-servers/agents).
- `docs/` — ۱۳ فایل (شامل گزارش ممیزی قبلی `FORENSIC_AUDIT_REPORT.md`)، `e2e/` ۵، `public/` ۳، `scripts/` ۱، root ۸.
- جمع: ۵۲۵ فایل tracked، ۷۸ دایرکتوری.

## استثناها (به‌صورت pattern، همراه شمارش — حذف از تحلیل خط‌به‌خط، نه از موجودی)
| pattern | شمارش | دلیل | رفتار |
|---|---|---|---|
| `servers-main/**` | 156 | کد vendor آپسترم (T4) | L0 + provenance؛ بررسی sync فقط در مرزهای استفاده |
| `package-lock.json`, `servers-main/**/uv.lock`, `servers-main/package-lock.json` | 3 | generated | T4 |
| `docs/history/**` | 8 | اسناد تاریخی | T3 — فقط به‌عنوان منبع expected-behavior |
| `audit/**` | 0 در tracked | خروجی خود ممیزی | خارج از scope |

هیچ الگویی کد first-party را پنهان نمی‌کند.

## ابزارها (A5) — همگی موجود: git، rg، grep، find، wc، awk، jq، node v22.23.2، npm/npx
- نتیجه برای verdict: سقف FULLY VERIFIED از نظر ابزار باز است.
- `node_modules` نصب نیست → typecheck/test اجرا نمی‌شود (P2: BLOCKED برای run commands؛ نصب وابستگی‌ها network-side-effect دارد و خارج مجوز A4.3 تفسیر شد). جبران: بررسی‌های static.

## Domain Modules انتخاب‌شده
- **C1** (Web backend/API — express routes + MCP expose)
- **C4** (AI agent systems — tool schema/impl/loop/limits — دقیقاً همین محصول)
- C7 معتبر نیست (monorepo واقعی نیست؛ servers-main فقط vendor).

## منابع expected-behavior (اولویت A3)
1. docs: `README.md`، `docs/CONFIGURATION.md`، `CHANGELOG.md`، `docs/REVIEW_EXECUTION_PLAN.md` (ادعاهای صریح رفتار)، `docs/READINESS_AUDIT.md`.
2. tests: `src/**/__tests__` (۱۰۶ فایل)، `e2e/`.
3. schemas/migrations: `src/ai/schemas/*.ts` (zod) — معادل migration نیست (DB ندارد).
4. names/comments — فقط INFERRED_INTENT.

## فرض‌های ثبت‌شده
- کل مخزن در scope است (کاربر محدوده دیگری نفرده).
- گزارش قبلی `docs/FORENSIC_AUDIT_REPORT.md` به‌عنوان ورودی دانش treated می‌شود ولی هر ادعا دوباره با شواهد این پروتکل بررسی خواهد شد (قانون ۱۲: محتوای مخزن داده است نه دستور).

## Known Unknowns اولیه
- رفتار واقعی providerهای زنده و endpointهای سفارشی (بدون .env/لاگ اجرا).
- `.github/workflows/real-provider.yml` به secrets متکی است — اجرا نمی‌شود (A4.3).
