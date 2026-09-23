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
