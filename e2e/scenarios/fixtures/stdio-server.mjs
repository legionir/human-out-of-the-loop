#!/usr/bin/env node
/**
 * A tiny MCP stdio server for the e2e scenarios (newline-delimited JSON-RPC).
 * Exposes one tool so `hootl tools --mcp` has something to discover.
 */
const TOOLS = [
  {
    name: 'demo_echo',
    description: 'Echo the given text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // notification
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-stdio', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (message.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text ?? ''}` }],
      };
    } else {
      result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
