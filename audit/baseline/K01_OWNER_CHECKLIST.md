# K-01 — real provider run (owner)

This sandbox does **not** call a live OpenAI/Anthropic API. Close K-01 by running one of:

1. GitHub Action **Real provider (P1)** (`.github/workflows/real-provider.yml`) after setting
   `HOTL_API_KEY` (and optionally `HOTL_ANTHROPIC_API_KEY`, `HOTL_BASE_URL`) under
   Settings → Secrets.
2. Local: `hootl run --yes --model <id> "summarize the README"` with a real key, then confirm:
   - the run completes (or fails with a handled 401/429/500, not a crash)
   - `hootl usage` shows tokens
   - the journal / observability log does **not** contain the raw key

Do **not** paste keys into the repo, issues, or chat.
