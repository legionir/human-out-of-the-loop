# K-02 — windows-leg CI

`.github/workflows/ci.yml` already matrices `windows-latest` / `macos-latest` / `ubuntu-latest`
and Node 22/24. This environment is Linux-only; the owner closes K-02 by confirming the
latest `ci.yml` run on `windows-latest` is green on GitHub Actions.
