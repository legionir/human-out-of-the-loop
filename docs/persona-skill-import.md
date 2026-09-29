# واردسازی Persona و Skill از مخزن `legionir/persona`

ابزار [`scripts/import-persona-library.mjs`](../../scripts/import-persona-library.mjs) تبدیل کتابخانهٔ پین‌شدهٔ Persona/Skill به قالب registry پروژهٔ HOOTL را بازتولید می‌کند. این همان importer سیستماتیکی است که برای انتقال قبلی به‌کار رفت؛ این فایل کتابخانه را به‌تنهایی کپی نمی‌کند و عمدی است که قبل از نوشتن، mapping و مجوزها را اعتبارسنجی کند.

## منبع و پیش‌نیاز

- منبع مورد انتظار: branch `arena/01a0e347-persona` از `legionir/persona`، commit `1168378305da75c97cddb586396d0da258959f14`.
- source checkout باید دستی روی همین commit تنظیم شود؛ importer آن را در provenance ثبت می‌کند، اما HEAD مخزن را خودش با Git بررسی نمی‌کند.
- target باید checkout/worktree جداگانهٔ HOOTL باشد و `registry/tools`، `registry/personas` و `registry/skills` را داشته باشد.
- شناسه‌های خروجی باید در target بدون collision باشند. اجرای تولیدی روی یک worktree/branch جدا و بازبینی diff الزامی است.

## اجرا

```sh
# ابتدا بررسی کن که source checkout روی commit پین‌شده باشد.
git -C /path/to/persona rev-parse HEAD

# اجرای importer روی worktree موقت/branch جداگانهٔ HOOTL:
node scripts/import-persona-library.mjs /path/to/persona /path/to/hootl-worktree

# پس از تولید، بدون نوشتن دوباره خروجی‌ها را راستی‌آزمایی کن:
node scripts/import-persona-library.mjs /path/to/persona /path/to/hootl-worktree --check
```

فرمان نخست باید دقیقاً این SHA را برگرداند: `1168378305da75c97cddb586396d0da258959f14`. ابتدا `--check` روی خروجی تولیدنشده موفق نمی‌شود؛ این گزینه برای مقایسهٔ خروجی‌های موجود با خروجی deterministic generator است.

## تضمین‌ها و حدود mapping

Importer ورودی‌های `personas.json`، `skills/index.json`، promptها، فایل‌های Skill و مجوز منبع را می‌خواند. برای ۲۱۸ Persona و ۲۱۸ Skill، خروجی JSON/Markdown، گزارش provenance و license را می‌سازد. پیش از نوشتن JSONها، کامل‌بودن جفت‌ها، یکتایی شناسه‌ها، تطبیق Persona/Skill، لینک‌های محلی و tool IDs را بررسی می‌کند.

ابزارها فقط از allowlist concrete موجود در HOOTL انتخاب می‌شوند؛ wildcard، Agent definition، ابزار حذف، و Git mutation مجاز نمی‌شود. دسترسی نوشتن workspace فقط برای Executorهایی ساخته می‌شود که مجوز منبع، سطح ProductionAuthority و scope IDE/Documentation صریحاً اجازه دهد. دسته‌هایی که integration متناظر HOOTL ندارند unmapped می‌مانند؛ آن‌ها را به ابزار ساختگی نگاشت نکن.

این ابزار برای ساخت دادهٔ جدید است، نه مجوز ادغام یا انتشار. پیش از استفاده، source commit، مجوز/تغییرات upstream، ساختار registry و allowlist ابزارهای HOOTL را بازبینی کن؛ سپس خروجی generator، تست‌های schema/registry و diff را اجرا و بازبینی کن. محتوای prompt و Skill منبع را دادهٔ غیرقابل‌اعتماد تلقی کن.
