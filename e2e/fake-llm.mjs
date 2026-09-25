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
  // Phase 33 — the reference filesystem toolset.
  { marker: 'EDIT', tool: 'edit_file' },
  { marker: 'TREE', tool: 'directory_tree' },
  { marker: 'MOVE', tool: 'move_file' },
  // Phase 34 — batch writing and VS Code-style search.
  { marker: 'SCAFFOLD', tool: 'write_multiple_files' },
  { marker: 'SCAFFOLDDRY', tool: 'write_multiple_files' },
  { marker: 'GREP', tool: 'search_code' },
  // Phase 35 — the last two reference tools.
  { marker: 'MEDIA', tool: 'read_media_file' },
  { marker: 'MEDIABIN', tool: 'read_media_file' },
  { marker: 'SIZES', tool: 'list_directory_with_sizes' },
  // Phase 36 — the glob scan at editor level.
  { marker: 'FIND', tool: 'search_files' },
  { marker: 'FINDDIR', tool: 'search_files' },
  // Phase 38 — time and structured reasoning.
  { marker: 'CLOCK', tool: 'get_current_time' },
  { marker: 'TZCONVERT', tool: 'convert_time' },
  // (`THINK:` is taken by the phase-32 thinking-delta fixture, so the
  // reasoning-step marker is `REASON:`.)
  { marker: 'REASON', tool: 'sequentialthinking' },
  // Phase 39 — project memory: one marker per tool, so a single scenario can
  // walk the whole set.
  { marker: 'MEMADD', tool: 'create_entities' },
  { marker: 'MEMLINK', tool: 'create_relations' },
  { marker: 'MEMNOTE', tool: 'add_observations' },
  { marker: 'MEMFIND', tool: 'search_nodes' },
  { marker: 'MEMOPEN', tool: 'open_nodes' },
  { marker: 'MEMFORGET', tool: 'delete_observations' },
  { marker: 'MEMUNLINK', tool: 'delete_relations' },
  { marker: 'MEMDROP', tool: 'delete_entities' },
  { marker: 'MEMGRAPH', tool: 'read_graph' },
  // Phase 40 — the web, read as Markdown.
  { marker: 'FETCH', tool: 'fetch' },
  { marker: 'FETCHRAW', tool: 'fetch' },
  { marker: 'FETCHFORBID', tool: 'fetch' },
  { marker: 'FETCHGUARD', tool: 'fetch' },
  // Phase 41 — git, read-only.
  { marker: 'GITDIFF', tool: 'git_diff' },
  { marker: 'GITLOG', tool: 'git_log' },
  { marker: 'GITSHOW', tool: 'git_show' },
  { marker: 'GITBRANCH', tool: 'git_branch_list' },
  { marker: 'GITREMOTE', tool: 'git_remote_list' },
  // Phase 42 — git, writing (branch, stage, commit, push) and the guards.
  { marker: 'GITBRANCHCREATE', tool: 'git_create_branch' },
  { marker: 'GITADD', tool: 'git_add' },
  { marker: 'GITCOMMIT', tool: 'git_commit' },
  { marker: 'GITPUSH', tool: 'git_push' },
  { marker: 'GITHARD', tool: 'git_reset' },
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

function pickToolCall(promptText, offered, chained = false) {
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
  if (marker.marker === 'GITSTATUS') return { name: 'git_status', args: { directory: '.', porcelain: 'v2', branch: true } };
  // Phase 41 — the read-only git set.  The argument selects the mode.
  if (marker.marker === 'GITDIFF') {
    const mode = marker.arg;
    return {
      name: 'git_diff',
      args:
        mode === 'staged'
          ? { directory: '.', staged: true }
          : mode === 'worktree'
            ? { directory: '.', path: 'notes/changed.txt' }
            : { directory: '.', target: mode },
    };
  }
  if (marker.marker === 'GITLOG') {
    return { name: 'git_log', args: { directory: '.', maxCount: Number(marker.arg) || 5, format: 'json' } };
  }
  if (marker.marker === 'GITSHOW') return { name: 'git_show', args: { directory: '.', revision: marker.arg } };
  if (marker.marker === 'GITBRANCH') {
    return { name: 'git_branch_list', args: { directory: '.', all: marker.arg === 'all' } };
  }
  if (marker.marker === 'GITREMOTE') return { name: 'git_remote_list', args: { directory: '.' } };
  // Phase 42 — the write set.  GITPUSH carries the *mode*: `upstream` pushes the
  // current branch and tracks it, `main` asks for the protected branch (which
  // the tool must refuse), GITHARD asks for a hard reset with no confirmation.
  if (marker.marker === 'GITBRANCHCREATE') {
    return { name: 'git_create_branch', args: { directory: '.', name: marker.arg } };
  }
  if (marker.marker === 'GITADD') {
    return { name: 'git_add', args: { directory: '.', files: [marker.arg] } };
  }
  if (marker.marker === 'GITCOMMIT') {
    return { name: 'git_commit', args: { directory: '.', message: `add ${marker.arg} from e2e` } };
  }
  if (marker.marker === 'GITPUSH') {
    return marker.arg === 'main'
      ? { name: 'git_push', args: { directory: '.', remote: 'origin', branch: 'main' } }
      : {
          name: 'git_push',
          args: { directory: '.', remote: 'origin', ...(marker.arg === 'upstream' ? { setUpstream: true } : {}) },
        };
  }
  if (marker.marker === 'GITHARD') {
    return { name: 'git_reset', args: { directory: '.', mode: 'hard' } };
  }
  // Phase 33 — the reference filesystem toolset.  EDIT replaces a fixed
  // placeholder so the scenario can assert a line-based edit, not a rewrite;
  // MOVE carries `source|destination`.
  if (marker.marker === 'EDIT') {
    return {
      name: 'edit_file',
      args: {
        path: marker.arg,
        edits: [{ oldText: 'e2e-placeholder', newText: 'e2e-edited' }],
      },
    };
  }
  if (marker.marker === 'TREE') return { name: 'directory_tree', args: { path: marker.arg } };
  // SCAFFOLD:<dir> — a two-file scaffold; the second file carries the probe the
  // GREP marker then searches for, so one scenario can prove both directions.
  if (marker.marker === 'SCAFFOLD' || marker.marker === 'SCAFFOLDDRY') {
    const files = [
      { path: `${marker.arg}/index.ts`, content: "export * from './helper.js';\n" },
      { path: `${marker.arg}/helper.ts`, content: 'export const scaffoldMarker = "scaffold-marker";\n' },
    ];
    return marker.marker === 'SCAFFOLDDRY'
      ? { name: 'write_multiple_files', args: { files, dryRun: true } }
      : { name: 'write_multiple_files', args: { files } };
  }
  // GREP:<pattern> — the VS Code-style search: a path filter, context lines and
  // a per-file ceiling, so the result must carry columns and context back.
  if (marker.marker === 'GREP') {
    return {
      name: 'search_code',
      args: {
        pattern: marker.arg,
        pathPattern: '\\.ts$',
        contextLines: 1,
        maxMatchesPerFile: 5,
        maxResults: 10,
      },
    };
  }
  // CLOCK:<IANA zone>|now — the clock, optionally for a specific zone.
  if (marker.marker === 'CLOCK') {
    return marker.arg === 'now'
      ? { name: 'get_current_time', args: {} }
      : { name: 'get_current_time', args: { timezone: marker.arg } };
  }
  // TZCONVERT:<source>|<time>|<target> — one wall-clock conversion.
  if (marker.marker === 'TZCONVERT') {
    const [sourceTimeZone, time, targetTimeZone] = marker.arg.split('|');
    return {
      name: 'convert_time',
      args: { sourceTimeZone, time, targetTimeZone, date: '2026-07-01' },
    };
  }
  // REASON:<session> — one reasoning step per call, in a named session.
  if (marker.marker === 'REASON') {
    return {
      name: 'sequentialthinking',
      args: {
        thought: `Reasoning step for ${marker.arg}: inspect, then decide.`,
        thoughtNumber: 1,
        totalThoughts: 2,
        nextThoughtNeeded: true,
        sessionId: marker.arg,
      },
    };
  }
  // Phase 39 — memory.  Arguments are `name|type` / `from|to` / a bare name;
  // the sentence each write stores is fixed so the scenario can look for text
  // that only ever exists in a tool result.
  if (marker.marker === 'MEMADD') {
    const [name, entityType] = marker.arg.split('|');
    return {
      name: 'create_entities',
      args: {
        entities: [{ name, entityType, observations: [`${name} added by the e2e stub`] }],
      },
    };
  }
  if (marker.marker === 'MEMLINK' || marker.marker === 'MEMUNLINK') {
    const [from, to] = marker.arg.split('|');
    return {
      name: marker.marker === 'MEMLINK' ? 'create_relations' : 'delete_relations',
      args: { relations: [{ from, to, relationType: 'depends_on' }] },
    };
  }
  if (marker.marker === 'MEMNOTE') {
    return {
      name: 'add_observations',
      args: { observations: [{ entityName: marker.arg, contents: ['noted by the e2e stub'] }] },
    };
  }
  if (marker.marker === 'MEMFORGET') {
    return {
      name: 'delete_observations',
      args: { deletions: [{ entityName: marker.arg, observations: ['noted by the e2e stub'] }] },
    };
  }
  if (marker.marker === 'MEMFIND') return { name: 'search_nodes', args: { query: marker.arg } };
  if (marker.marker === 'MEMOPEN') return { name: 'open_nodes', args: { names: [marker.arg] } };
  if (marker.marker === 'MEMDROP') {
    return { name: 'delete_entities', args: { entityNames: [marker.arg] } };
  }
  if (marker.marker === 'MEMGRAPH') return { name: 'read_graph', args: {} };
  // Phase 40 — fetch.  `FETCHGUARD` deliberately omits allowPrivate: the URL is
  // loopback, so the SSRF gate must refuse it while the other three succeed.
  if (marker.marker === 'FETCH' || marker.marker === 'FETCHRAW') {
    return {
      name: 'fetch',
      args: {
        url: marker.arg,
        allowPrivate: true,
        maxLength: 300,
        ...(marker.marker === 'FETCHRAW' ? { raw: true } : {}),
      },
    };
  }
  if (marker.marker === 'FETCHFORBID') {
    return { name: 'fetch', args: { url: marker.arg, allowPrivate: true } };
  }
  if (marker.marker === 'FETCHGUARD') {
    return { name: 'fetch', args: { url: marker.arg } };
  }
  // FIND:<glob> — the editor-grade glob scan: a bare name matched at any depth,
  // directories filtered out, sizes reported.
  if (marker.marker === 'FIND') {
    return {
      name: 'search_files',
      args: { pattern: marker.arg, includeDirectories: false },
    };
  }
  // FINDDIR:<glob> — the same tool, files filtered out.
  if (marker.marker === 'FINDDIR') {
    return { name: 'search_files', args: { pattern: marker.arg, includeFiles: false } };
  }
  // SIZES:<dir> — the reference's sized listing, ordered by size so the
  // scenario can see the ordering travel back to the model.
  if (marker.marker === 'SIZES') {
    return { name: 'list_directory_with_sizes', args: { path: marker.arg, sortBy: 'size' } };
  }
  // MEDIA:<file> / MEDIABIN:<file> — the same tool, twice: once on an image
  // (attached to the model call) and once on a plain binary (not attached).
  if (marker.marker === 'MEDIA' || marker.marker === 'MEDIABIN') {
    return { name: 'read_media_file', args: { path: marker.arg } };
  }
  if (marker.marker === 'MOVE') {
    const [source, destination] = marker.arg.split('|');
    if (!source || !destination) return null;
    return { name: 'move_file', args: { source, destination } };
  }
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
  const wanted = [...new Set(MARKERS.map((m) => m.tool))].filter((tool) =>
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
      // CHATREPLY: the request is a conversation, not work — the runtime must
      // answer it and never plan.  (It also proves the assessment's `kind`
      // survives the provider round trip.)
      if (/\bCHATREPLY\b/.test(promptText)) {
        return { kind: 'answer', isClear: true, needsClarification: [], answer: 'stub draft reply' };
      }
      // NEEDSCLARIFY reproduces a real provider's answer verbatim: it says the
      // request is unclear and puts the questions under a key the response
      // schema did not declare (`clarificationQuestions`).  A run must show
      // those questions, not an empty "Clarification needed:".
      // NEEDSCLARIFYNONE: "unclear" with nothing listed at all — the runtime
      // must still ask something answerable (built from the project context).
      if (/\bNEEDSCLARIFYNONE\b/.test(promptText)) {
        return { isClear: false };
      }
      if (/\bNEEDSCLARIFY\b/.test(promptText)) {
        return {
          isClear: false,
          clarificationQuestions: [
            'Which sub-project should change: multi-lang-eval or unreal-engine?',
            'What does "done" look like for it?',
          ],
        };
      }
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
  } else if (tools.length > 0 && /\bCHATREPLY\b/.test(promptText)) {
    // The chat answer: text only (no tool call), and in the language the
    // runtime asked for — if the LANGUAGE rule did not reach the model, this
    // answers in English and the scenario fails.  With CHATREAD the chat turn
    // reads the README first (a read-only tool; the journal must record it).
    const offered = tools.map((t) => t.function?.name ?? t.name);
    if (/\bCHATREAD\b/.test(promptText) && !sawToolTurn && offered.includes('read_file')) {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${++seq}`,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ filePath: 'README.md' }) },
          },
        ],
      };
      finish = 'tool_calls';
    } else {
      const base = /Persian \(فارسی\)|Arabic script/.test(promptText)
        ? 'این پروژه یک رانتایم Human-Out-Of-The-Loop است: برنامه می‌ریزد، اجرا می‌کند و گزارش می‌دهد.'
        : 'This is the stub chat answer.';
      message.content = /\bCHATREAD\b/.test(promptText) ? `${base} (README خوانده شد)` : base;
    }
  } else if (tools.length > 0) {
    const offered = tools.map((t) => t.function?.name ?? t.name);
    // `CHAIN` lets one agent turn call every marker in the prompt in order
    // (used by the phase-33 files scenario to exercise three tools in one run).
    const chained = /(^|\s)CHAIN(\s|$)/.test(promptText);
    let call = sawToolTurn && !chained ? null : pickToolCall(promptText, offered, chained);
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
  if (body.stream) {
    await streamChat(res, body.model ?? 'stub', message, finish, promptText, Boolean(body.stream_options?.include_usage));
    return;
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

// ─── streaming (SSE) ─────────────────────────────────────────────
//
// An agent turn is streamed (`streamText`) whenever the run shows the
// model's thinking: deltas are the only way a provider hands over
// reasoning *while* it is being produced.  A stub that answered a
// streaming request with a single JSON body would look like a broken
// provider, so both endpoints speak their wire format:
//
//   * Chat Completions -> `data: {...}` chunks, reasoning in
//     `choices[0].delta.reasoning_content` (what OpenAI-compatible
//     gateways send), then `data: [DONE]`;
//   * Responses -> `response.*` events, reasoning as
//     `response.reasoning_summary_text.delta`.
//
// `THINK:<text>` in the prompt makes the stub think out loud before it
// answers (`-` and `_` in the marker become spaces), which is how a
// scenario asserts that reasoning reached the terminal.

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};
/** Delay between streamed chunks (a real provider is not instant). */
const STREAM_MS = Number(process.env.FAKE_STREAM_MS ?? 5);

const sseData = (res, payload) =>
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);

const sseEvent = (res, event, payload) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

/** The `THINK:` marker's text, or null. */
function thinkingFor(promptText) {
  const match = /\bTHINK:([^\s"'#]+)/.exec(promptText);
  if (!match) return null;
  return match[1].replace(/[-_]+/g, ' ');
}

/** Split text into small pieces, the way a token stream arrives. */
function pieces(text) {
  return (text ?? '').match(/.{1,8}/gs) ?? [];
}

const USAGE_PAYLOAD = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };

/** Chat Completions streaming — `stream: true`. */
async function streamChat(res, model, message, finish, promptText, includeUsage) {
  const id = `chatcmpl_${++seq}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, SSE_HEADERS);
  const chunk = (delta, extra = {}) =>
    sseData(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null, ...extra }],
    });

  chunk({ role: 'assistant', content: '' });
  const thinking = thinkingFor(promptText);
  if (thinking) {
    for (const piece of pieces(thinking)) {
      chunk({ reasoning_content: piece });
      await sleep(STREAM_MS);
    }
  }
  if (message.tool_calls) {
    chunk({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) });
  } else if (message.content) {
    for (const piece of pieces(message.content)) {
      chunk({ content: piece });
      await sleep(STREAM_MS);
    }
  }
  sseData(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    ...(includeUsage ? { usage: USAGE_PAYLOAD } : {}),
  });
  sseData(res, '[DONE]');
  res.end();
}

/** Responses API streaming — `stream: true`. */
async function streamResponses(res, model, output, promptText) {
  const base = envelope(model, output);
  const empty = { ...base, status: 'in_progress', output: [] };
  res.writeHead(200, SSE_HEADERS);
  sseEvent(res, 'response.created', { type: 'response.created', response: base });
  sseEvent(res, 'response.in_progress', { type: 'response.in_progress', response: empty });

  let outputIndex = 0;
  const thinking = thinkingFor(promptText);
  if (thinking) {
    const itemId = `rs_${++seq}`;
    const part = (text) => ({ type: 'summary_text', text });
    sseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: base.id,
      output_index: outputIndex,
      item: { type: 'reasoning', id: itemId, summary: [] },
    });
    sseEvent(res, 'response.reasoning_summary_part.added', {
      type: 'response.reasoning_summary_part.added',
      response_id: base.id,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: part(''),
    });
    for (const piece of pieces(thinking)) {
      sseEvent(res, 'response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        response_id: base.id,
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        delta: piece,
      });
      await sleep(STREAM_MS);
    }
    sseEvent(res, 'response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      response_id: base.id,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      text: thinking,
    });
    sseEvent(res, 'response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      response_id: base.id,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: part(thinking),
    });
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: base.id,
      output_index: outputIndex,
      item: { type: 'reasoning', id: itemId, summary: [part(thinking)] },
    });
    outputIndex += 1;
  }

  for (const item of output) {
    if (item.type === 'message') {
      const text = item.content.map((c) => c.text).join('');
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        response_id: base.id,
        output_index: outputIndex,
        item: { type: 'message', id: item.id, role: 'assistant', status: 'in_progress', content: [] },
      });
      sseEvent(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        response_id: base.id,
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      });
      for (const piece of pieces(text)) {
        sseEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          response_id: base.id,
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: piece,
        });
        await sleep(STREAM_MS);
      }
      sseEvent(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        response_id: base.id,
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      });
      sseEvent(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        response_id: base.id,
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text },
      });
    } else if (item.type === 'function_call') {
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        response_id: base.id,
        output_index: outputIndex,
        item: { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: '' },
      });
      for (const piece of pieces(item.arguments)) {
        sseEvent(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          response_id: base.id,
          item_id: item.id,
          output_index: outputIndex,
          delta: piece,
        });
        await sleep(STREAM_MS);
      }
      sseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        response_id: base.id,
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: base.id,
      output_index: outputIndex,
      item,
    });
    outputIndex += 1;
  }

  sseEvent(res, 'response.completed', { type: 'response.completed', response: base });
  res.end();
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
    } else if (tools.length > 0 && /\bCHATREPLY\b/.test(promptText)) {
      // Same chat behaviour as the Chat Completions path (see handleChat):
      // text only, in the language the LANGUAGE rule names; with CHATREAD the
      // chat turn reads the README first.
      const offered = tools.map((t) => t.name ?? t.function?.name);
      if (/\bCHATREAD\b/.test(promptText) && !sawToolTurn && offered.includes('read_file')) {
        output = [functionCallItem('read_file', { filePath: 'README.md' })];
      } else {
        const base = /Persian \(فارسی\)|Arabic script/.test(promptText)
          ? 'این پروژه یک رانتایم Human-Out-Of-The-Loop است: برنامه می‌ریزد، اجرا می‌کند و گزارش می‌دهد.'
          : 'This is the stub chat answer.';
        output = [messageItem(/\bCHATREAD\b/.test(promptText) ? `${base} (README خوانده شد)` : base)];
      }
    } else if (tools.length > 0) {
      const offered = tools.map((t) => t.name ?? t.function?.name);
      const chained = /(^|\s)CHAIN(\s|$)/.test(promptText);
      const call = sawToolTurn && !chained ? null : pickToolCall(promptText, offered, chained);
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
    if (body.stream) {
      await streamResponses(res, body.model ?? 'stub', output, promptText);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(envelope(body.model ?? 'stub', output)));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`fake-llm (responses API) on http://127.0.0.1:${PORT}/v1\n`);
});
