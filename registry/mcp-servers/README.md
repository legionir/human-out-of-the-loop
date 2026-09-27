# MCP Servers Registry

Place one JSON file per MCP server here.  Example:

```json
{
  "id": "my-remote-server",
  "name": "My Remote MCP Server",
  "transport": "http",
  "url": "https://mcp.example.com",
  "auth": {
    "type": "bearer",
    "tokenEnvVar": "MY_MCP_TOKEN"
  },
  "toolPrefix": "remote_",
  "connectTimeoutMs": 10000
}
```

**Never** put credential values directly in these files.  Always
reference an environment variable via `tokenEnvVar` or `keyEnvVar`.

## The reverse direction: this runtime as a server

`hootl serve --mcp` turns this project into an MCP server, so a client (Claude
Desktop, Cursor, an IDE) receives the same tools the agent has.  Read that
sentence again before you wire it up — **it hands that client the project's
files, and with the write tools enabled, the ability to commit and push.**

- Prefer `--read-only` for any client you do not fully trust: it exposes only
  tools that cannot change anything (`read_*`, `list_*`, `search_*`, `get_*`,
  the git reads, `fetch`, the memory reads).
- Narrow further with `--allow-tools read_file,git_status`.
- Over HTTP the server binds `127.0.0.1` only and **refuses to start without a
  bearer token** (`--token` / `HOTL_MCP_TOKEN`).
- Every call is recorded in the project's Journal (`.ai-runtime/journal`), with
  `agentId: "mcp"`, so what an external client did is as auditable as what the
  agent did.

```jsonc
// a client's own config, for reference
{ "mcpServers": { "human-out-of-the-loop": {
    "command": "hootl",
    "args": ["serve", "--mcp", "--project-root", "/path/to/project", "--read-only"] } } }
```
