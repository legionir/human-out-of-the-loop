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

function planPayload() {
  return {
    goal: 'stub goal',
    steps: [
      step('step-1', 'Read the project README'),
      step('step-2', 'Write a short note', {
        dependsOn: ['step-1'],
        assignedTools: ['read_file', 'write_file'],
      }),
    ],
  };
}

function structuredPayload(name, promptText) {
  switch (name) {
    case 'PlannerAssessment':
      return { isClear: true, needsClarification: [], plan: planPayload() };
    case 'ExecutionPlan':
      return planPayload();
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

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
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
    let output = [];
    if (format?.type === 'json_schema') {
      output = [messageItem(JSON.stringify(structuredPayload(format.name, promptText)))];
    } else if (tools.length > 0) {
      const offered = tools.map((t) => t.name ?? t.function?.name);
      if (!sawToolTurn && offered.includes('read_file')) {
        output = [functionCallItem('read_file', { filePath: 'README.md' })];
      } else {
        output = [messageItem('Stub agent: the step is complete and verified.')];
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
