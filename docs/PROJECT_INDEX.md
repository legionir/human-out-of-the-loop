# Project index — agent context without dumping the tree

**شناسه:** `docs/PROJECT_INDEX.md`  
**هدف:** ساختار پروژه همیشه در context ثابت بماند؛ نام و metadata هزاران فایل فقط وقتی وارد context شود که Agent واقعاً به آن directory نیاز دارد.

قرارداد:

```text
object = directory
files  = number of files directly inside that directory
```

دو فایل جدا — هرگز در یک JSON مخلوط نشوند:

```text
project-index/
├── structure.json    # static context
└── files.json        # on-demand metadata
```

CLI: `hootl index` (`src/ai/project-index.ts`).

---

## 1. Project Structure — بخش ثابت Context

فقط مسیرها و تعداد فایل‌های مستقیم هر پوشه:

```json
{
  "src": {
    "files": 2,
    "services": {
      "files": 100
    },
    "controllers": {
      "files": 24
    },
    "models": {
      "files": 18
    },
    "utils": {
      "files": 12
    }
  },
  "tests": {
    "files": 42,
    "integration": {
      "files": 14
    },
    "unit": {
      "files": 28
    }
  },
  "config": {
    "files": 6
  },
  "files": 3
}
```

این همان خروجی `list_tree()` است و باید در **system/developer context ثابت** بماند.

---

## 2. Directory Files — وقتی AI یک مسیر را بررسی می‌کند

```json
{
  "path": "src/services",
  "files": {
    "auth.ts": {
      "size": 4820,
      "lines": 156
    },
    "user.ts": {
      "size": 6310,
      "lines": 203
    },
    "payment.ts": {
      "size": 3940,
      "lines": 128
    }
  }
}
```

`size` بر حسب bytes است. برای context اولیه همان `size + lines` کافی است؛ فیلدهایی مثل `language` بعداً قابل اضافه‌اند.

`files.json` روی دیسک به شکل map مسیر → فایل‌ها ذخیره می‌شود:

```json
{
  "src/services": {
    "auth.ts": { "size": 4820, "lines": 156 },
    "user.ts": { "size": 6310, "lines": 203 }
  }
}
```

---

## 3. ابزارها

### `list_tree()`

ساختار کلی پروژه؛ معمولاً در Context ثابت.

```text
hootl index
```

### `list_files(path)`

فایل‌های یک directory با size و lines:

```text
hootl index --files src/services
```

### `read_file(path)` / `read_file_range(path, start_line, end_line)`

خواندن فایل کامل یا بازهٔ خطوط (`readFileRange` در ماژول).

### `search(query, path?)`

جستجوی متنی/regex بدون خواندن کل پروژه:

```text
hootl index --search TODO --path src
```

### `find_files(pattern, path?)`

پیدا کردن فایل‌ها بر اساس glob:

```text
hootl index --find "*.ts" --path src
```

---

## 4. معماری

```text
                    Project
                       │
                       ▼
              ┌─────────────────┐
              │   list_tree()   │
              └────────┬────────┘
                       │
                       ▼
          ┌──────────────────────────┐
          │ Static Context           │
          │ directories + file count │
          └────────────┬─────────────┘
                       │
                AI needs details
                       │
                       ▼
              ┌─────────────────┐
              │  list_files()   │
              └────────┬────────┘
                       │
                       ▼
          filenames + size + lines
                       │
              AI needs source
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
    read_file()              read_file_range()
          │                         │
          └────────────┬────────────┘
                       ▼
                    Source
```

---

## 5. پیاده‌سازی (عملکرد)

- `fs.readdir` با `withFileTypes: true`؛ پیمایش directoryها موازی.
- برای `size` و `lines` **stat جدا نیست**: یک `readFile`؛ `size = buffer.length`.
- سقف همزمانی پیش‌فرض ۶۴.
- نادیده: `node_modules`, `.git`, `.svn`, `.hg`, `dist`, `build`, `coverage`, `.next`, `.angular`, `.ai-runtime`، و هر نامی که با `.` شروع شود به‌جز `.env`.

نوشتن روی دیسک:

```text
hootl index --write
# → <project>/.ai-runtime/project-index/structure.json
# → <project>/.ai-runtime/project-index/files.json

hootl index --write ./project
```
