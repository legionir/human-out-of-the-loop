/**
 * Minimal local LLM stub (OpenAI Responses API) for the sandbox.
 *
 * Rebuilt after the sandbox restart wiped the original harness.  It is
 * deliberately small: enough to plan, run and review a short plan.
 *   - structured calls -> a payload derived from the request's schema name
 *   - agent turns      -> one read_file call, then a final message
 */
import http from 'node:http';

const PORT = Number(process.env.FAKE_PORT ?? 8931);
const DELAY_MS = Number(process.env.FAKE_DELAY_MS ?? 0);

/**
 * Latency, so a scenario has a window to cancel a run that is genuinely in
 * flight:
 *   SLOW:<ms>     delay the *agent* turns only (planning stays instant)
 *   SLOWALL:<ms>  delay every response
 * `FAKE_DELAY_MS` is the process-wide default.
 */
function delayFor(promptText, isAgentTurn) {
  const all = /SLOWALL:(\d+)/.exec(promptText);
  if (all) return Number(all[1]);
  const agent = /\bSLOW:(\d+)/.exec(promptText);
  if (agent && isAgentTurn) return Number(agent[1]);
  return DELAY_MS;
}

/**
 * Fault injection — what a real provider does on a bad day:
 *   FAULT:<kind>x<n>          the first <n> agent turns fail (no `x<n>` = every one)
 *     kind = 429 | 500 | 401  HTTP error with an OpenAI-shaped error body
 *            CUT              the socket is destroyed before any byte is sent
 *            HANG             never answer (pair with --timeout-ms)
 *            EMPTY            200 with an empty `output` array
 *   BADJSON:<Schema>x<n>      the first <n> structured calls for <Schema>
 *                             (PlannerAssessment, ExecutionPlan,
 *                             AcceptanceJudgment, FinalReview) get text that
 *                             is not JSON
 * Counters are keyed by the marker text, and the stub lives for the whole
 * scenario run, so every scenario should use a marker text of its own
 * (e.g. append `#tag`: `FAULT:500x2#retry`).
 */
const faultCounts = new Map();
function takeFault(re, promptText) {
  const match = re.exec(promptText);
  if (!match) return null;
  const key = match[0];
  const limit = match.groups.n === undefined ? Infinity : Number(match.groups.n);
  const used = faultCounts.get(key) ?? 0;
  if (used >= limit) return null;
  faultCounts.set(key, used + 1);
  return match.groups;
}
const AGENT_FAULT = /\bFAULT:(?<kind>429|500|401|CUT|HANG|EMPTY)(?:x(?<n>\d+))?(?:#[\w-]+)?/;
function badJsonFor(name, promptText) {
  const re = new RegExp(String.raw`\bBADJSON:${name}(?:x(?<n>\d+))?(?:#[\w-]+)?`);
  return takeFault(re, promptText) !== null;
}

function sendHttpError(res, status) {
  const body = {
    401: { message: 'Incorrect API key provided (stub).', type: 'invalid_request_error', code: 'invalid_api_key' },
    429: { message: 'Rate limit reached (stub).', type: 'requests', code: 'rate_limit_exceeded' },
    500: { message: 'The server had an error (stub).', type: 'server_error', code: null },
  }[status];
  const headers = { 'content-type': 'application/json' };
  if (status === 429) headers['retry-after'] = '0';
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { ...body, param: null } }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DUMP = process.env.FAKE_DUMP;

function envelope(model, output) {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 10)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 40,
    },
  };
}

let seq = 0;
function messageItem(text) {
  return {
    type: 'message',
    role: 'assistant',
    id: `msg_${++seq}`,
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallItem(name, args) {
  return {
    type: 'function_call',
    id: `fc_${++seq}`,
    call_id: `call_${seq}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

/** Walk the request input and collect every text the model would "see". */
function inspectInput(input) {
  const texts = [];
  let sawToolTurn = false;
  const items = Array.isArray(input) ? input : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      texts.push(String(item ?? ''));
      continue;
    }
    if (item.type === 'function_call' || item.type === 'function_call_output') sawToolTurn = true;
    // A real model SEES tool results, including file contents.
    if (typeof item.output === 'string') texts.push(item.output);
    const content = item.content;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') texts.push(part);
        else if (part?.text) texts.push(part.text);
      }
    }
  }
  return { promptText: texts.join('\n'), sawToolTurn };
}

/**
 * Goal markers, the same vocabulary the CLI scenarios use:
 *   READ:<path> / WRITE:<path> / OVERWRITE:<path> / SEARCH:<pattern>
 * The first marker in the prompt picks the tool call for that agent turn.
 */
const usedMarkers = new Set();

const MARKERS = [
  { marker: 'READ', tool: 'read_file' },
  { marker: 'WRITE', tool: 'write_file' },
  { marker: 'OVERWRITE', tool: 'write_file' },
  { marker: 'SEARCH', tool: 'search_code' },
  { marker: 'GITSTATUS', tool: 'git_status' },
];

function markersIn(text) {
  const found = [];
  for (const { marker, tool } of MARKERS) {
    const re = new RegExp(String.raw`\b${marker}:([^\s"']+)`, "g");
    let match;
    while ((match = re.exec(text)) !== null) {
      found.push({ at: match.index, marker, tool, arg: match[1] });
    }
  }
  const mcp = /\bMCP:([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = mcp.exec(text)) !== null) {
    found.push({ at: match.index, marker: 'MCP', tool: match[1], arg: match[1] });
  }
  return found.sort((a, b) => a.at - b.at);
}

function pickToolCall(promptText, offered) {
  const available = new Set(offered);
  // A marker is consumed exactly once: a reused marker would repeat the same
  // tool call (and, for WRITE, fail on "file already exists").
  const marker = markersIn(promptText).find(
    (m) => available.has(m.tool) && !usedMarkers.has(`${m.marker}:${m.arg}`)
  );
  if (marker) usedMarkers.add(`${marker.marker}:${marker.arg}`);
  if (!marker) return null;
  if (marker.marker === 'MCP') return { name: marker.tool, args: { text: 'from-mcp' } };
  if (marker.marker === 'READ') return { name: 'read_file', args: { filePath: marker.arg } };
  if (marker.marker === 'WRITE') {
    return { name: 'write_file', args: { filePath: marker.arg, content: 'written by the e2e stub\n' } };
  }
  if (marker.marker === 'OVERWRITE') {
    return {
      name: 'write_file',
      args: { filePath: marker.arg, content: 'overwritten by the e2e stub\n', overwrite: true },
    };
  }
  if (marker.marker === 'SEARCH') return { name: 'search_code', args: { pattern: marker.arg, directory: '.' } };
  if (marker.marker === 'GITSTATUS') return { name: 'git_status', args: { directory: '.' } };
  return null;
}

function step(id, description, over = {}) {
  return {
    id,
    description,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: `${id} is handled`,
    status: 'pending',
    ...over,
  };
}

/**
 * The plan follows the goal's markers, the same way a real planner would
 * follow the goal's wording: a WRITE goal produces a step that owns
 * `write_file`.  Without this the agent turn only ever offered `read_file`
 * and a scenario could not tell "the tool was blocked" from "the tool was
 * never given the chance".
 */
function goalFromPrompt(promptText) {
  const match = /USER REQUEST:\s*\"\"\"([\s\S]*?)\"\"\"/.exec(promptText);
  return (match?.[1] ?? '').trim().split('\n')[0].trim();
}

/**
 * The plan follows the goal's markers, the way a real planner follows the
 * goal's wording: the wording reaches the steps, and a step that must write
 * owns `write_file`.  Without this the agent turns were always offered the
 * fixed `read_file` and a scenario could not tell "the tool was blocked" from
 * "the tool was never offered".
 */
function planPayload(promptText = '') {
  const goal = goalFromPrompt(promptText);
  const wanted = ['write_file', 'search_code', 'git_status'].filter((tool) =>
    markersIn(promptText).some((m) => m.tool === tool)
  );
  const tools = [...new Set([...wanted, 'read_file'])];
  const description = goal || 'Read the project README';
  return {
    goal: goal || 'stub goal',
    steps: [
      step('step-1', description, { assignedTools: tools }),
      step('step-2', description, { dependsOn: ['step-1'], assignedTools: tools }),
    ],
  };
}

function structuredPayload(name, promptText) {
  switch (name) {
    case 'PlannerAssessment':
      return { isClear: true, needsClarification: [], plan: planPayload(promptText) };
    case 'ExecutionPlan':
      return planPayload(promptText);
    case 'AcceptanceJudgment':
      return { accepted: true, reason: 'stub acceptance: the step output matches its criteria' };
    case 'FinalReview':
      return {
        planId: /plan_[A-Za-z0-9_-]+/.exec(promptText)?.[0] ?? 'plan_stub',
        goal: 'stub goal',
        outcome: 'success',
        acceptedFindings: [],
        rejectedFindings: [],
        incompleteSteps: [],
        finalSummary: 'Stub final review: every step completed and verified.',
        usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
      };
    default:
      return {};
  }
}

/**
 * Chat Completions (`/chat/completions`, any path prefix) — what most
 * OpenAI-compatible gateways implement.  Same behaviour and markers as the
 * Responses endpoint, translated to the chat wire format.
 */
async function handleChat(body, req, res) {
  if (DUMP) {
    try {
      (await import('node:fs')).appendFileSync(DUMP, JSON.stringify(body) + '\n');
    } catch {
      /* ignore */
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const texts = [];
  let sawToolTurn = false;
  for (const m of messages) {
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) sawToolTurn = true;
    if (typeof m.content === 'string') texts.push(m.content);
    else if (Array.isArray(m.content)) for (const part of m.content) if (part?.text) texts.push(part.text);
  }
  const promptText = texts.join('\n');
  const format = body.response_format;
  const schemaName = format?.type === 'json_schema' ? format.json_schema?.name : undefined;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const isAgentTurn = tools.length > 0 && !format;
  const delayMs = delayFor(promptText, isAgentTurn);
  if (delayMs > 0) await sleep(delayMs);

  const fault = isAgentTurn ? takeFault(AGENT_FAULT, promptText) : null;
  if (fault) {
    if (fault.kind === 'CUT') return void req.socket.destroy();
    if (fault.kind === 'HANG') return;
    if (fault.kind !== 'EMPTY') return void sendHttpError(res, Number(fault.kind));
  }

  let message = { role: 'assistant', content: '' };
  let finish = 'stop';
  if (fault?.kind === 'EMPTY') {
    message.content = '';
  } else if (format) {
    // json_schema or json_object: the SDK parses the message content.
    message.content = schemaName && badJsonFor(schemaName, promptText)
      ? 'Sure! Here is the result: {not valid json'
      : JSON.stringify(structuredPayload(schemaName ?? guessSchema(promptText), promptText));
  } else if (tools.length > 0) {
    const offered = tools.map((t) => t.function?.name ?? t.name);
    let call = sawToolTurn ? null : pickToolCall(promptText, offered);
    if (!call && !sawToolTurn && offered.includes('read_file')) call = { name: 'read_file', args: { filePath: 'README.md' } };
    if (call) {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call_${++seq}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
      };
      finish = 'tool_calls';
    } else {
      message.content = 'Stub agent: the step is complete and verified.';
    }
  } else {
    message.content = 'Stub response.';
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl_${++seq}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'stub',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    })
  );
}

/** Without a schema name (json_object mode) guess it from the prompt. */
function guessSchema(promptText) {
  if (/acceptance criteria/i.test(promptText)) return 'AcceptanceJudgment';
  if (/review/i.test(promptText) && /plan_/.test(promptText)) return 'FinalReview';
  return 'PlannerAssessment';
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.method === 'GET' && /\/models$/.test(req.url.split('?')[0])) {
      // Model listing (OpenAI shape) — what `/model` and the UI picker load.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: ['@aur/auto', 'stub-large', 'stub-small'].map((id) => ({ id, object: 'model', owned_by: 'stub' })),
        })
      );
      return;
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(req.url.split('?')[0])) {
      await handleChat(JSON.parse(raw || '{}'), req, res);
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const { promptText, sawToolTurn } = inspectInput(body.input);
    if (DUMP) {
      try {
        (await import('node:fs')).appendFileSync(DUMP, JSON.stringify(body) + '\n');
      } catch {
        /* ignore */
      }
    }
    const format = body.text?.format;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const delayMs = delayFor(promptText, tools.length > 0 && !format);
    if (delayMs > 0) await sleep(delayMs);
    const isAgentTurn = tools.length > 0 && !format;
    const fault = isAgentTurn ? takeFault(AGENT_FAULT, promptText) : null;
    if (fault) {
      if (fault.kind === 'CUT') return void req.socket.destroy();
      if (fault.kind === 'HANG') return; // never answer
      if (fault.kind !== 'EMPTY') return void sendHttpError(res, Number(fault.kind));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(envelope(body.model ?? 'stub', [])));
      return;
    }
    let output = [];
    if (format?.type === 'json_schema' && badJsonFor(format.name, promptText)) {
      output = [messageItem('Sure! Here is the result: {not valid json')];
    } else if (format?.type === 'json_schema') {
      output = [messageItem(JSON.stringify(structuredPayload(format.name, promptText)))];
    } else if (tools.length > 0) {
      const offered = tools.map((t) => t.name ?? t.function?.name);
      const call = sawToolTurn ? null : pickToolCall(promptText, offered);
      if (call) {
        output = [functionCallItem(call.name, call.args)];
      } else if (!sawToolTurn && offered.includes('read_file')) {
        output = [functionCallItem('read_file', { filePath: 'README.md' })];
      } else {
        let text = 'Stub agent: the step is complete and verified.';
        // Worst case: a compromised model echoes a credential it just read.
        const leaked = /OPENAI_API_KEY=([A-Za-z0-9_.\-]+)/.exec(promptText);
        if (leaked) text += ` Leaked credential: ${leaked[1]}`;
        output = [messageItem(text)];
      }
    } else {
      output = [messageItem('Stub response.')];
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(envelope(body.model ?? 'stub', output)));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`fake-llm (responses API) on http://127.0.0.1:${PORT}/v1\n`);
});
