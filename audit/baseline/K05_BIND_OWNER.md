# K-05 — non-loopback bind

After A-01 the server refuses a non-loopback bind unless a bearer token is configured.
Whether any **deployment** binds `0.0.0.0` on purpose is an operator decision (Docker/CI
host, reverse proxy). Record that decision outside the repo; no code change is required
unless the deployment violates A-01.
