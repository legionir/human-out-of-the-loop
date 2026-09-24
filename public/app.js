/* Human Out of the Loop — vanilla frontend (no frameworks).
 * Talks to the Express API: /api/run, /api/sessions, /api/plans,
 * /api/stream/:planId (SSE).  Upgrade path to React/Next: each
 * function below maps to a component/hook 1:1.
 */
'use strict';

// ─── Tiny API helper ─────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  }
  return body;
}

// ─── DOM refs ────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const sessionListEl = $('#session-list');
const chatEl = $('#chat');
const goalInput = $('#goal-input');
const runBtn = $('#run-btn');
const autoConfirmEl = $('#auto-confirm');
const newSessionBtn = $('#new-session-btn');
const cancelRunBtn = $('#cancel-run-btn');
const runControlsEl = $('#run-controls');
const runStateEl = $('#run-state');
const sessionTitleEl = $('#session-title');
const emptyStateEl = $('#empty-state');
const modalEl = $('#plan-modal');
const planSummaryEl = $('#plan-summary');
const planTableWrap = $('#plan-table-wrap');
const planFeedbackEl = $('#plan-feedback');
const planConfirmBtn = $('#plan-confirm-btn');
const planRejectBtn = $('#plan-reject-btn');
const toastEl = $('#toast');

// ─── State ───────────────────────────────────────────────────────

const state = {
  sessionId: null, // null = new session
  run: null, // { runId, planId, es, pollTimer, timelineEl, assistantEl }
  modalPlanId: null,
};

// ─── Utilities ───────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Minimal, safe markdown rendering (HTML is escaped FIRST, then a
 * small subset is applied): fenced code, inline code, bold, italic,
 * headings, lists, paragraphs.
 */
function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const parts = escaped.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += `<pre class="code-block"><code>${parts[i].replace(/^\n/, '').replace(/\n$/, '')}</code></pre>`;
      continue;
    }
    const lines = parts[i].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const inline = (s) =>
        s
          .replaceAll(/`([^`]+)`/g, '<code>$1</code>')
          .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replaceAll(/\*([^*]+)\*/g, '<em>$1</em>');
      const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (h) {
        const level = Math.min(h[1].length + 2, 6); // # → h3 in this context
        html += `<h${level}>${inline(h[2])}</h${level}>`;
      } else if (/^[-*]\s+/.test(trimmed)) {
        html += `<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
      } else if (/^─+\s*$/.test(trimmed) || /^═+\s*$/.test(trimmed)) {
        html += '<hr />';
      } else {
        html += `<p>${inline(line)}</p>`;
      }
    }
  }
  return html;
}

function showToast(message, isError = true) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 4000);
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

// ─── Sessions ────────────────────────────────────────────────────

async function loadSessions(selectId = state.sessionId) {
  let sessions = [];
  try {
    sessions = await api('/api/sessions');
  } catch (err) {
    showToast(`Sessions unavailable: ${err.message}`);
    return;
  }
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === selectId ? ' active' : '');
    li.innerHTML = `
      <div class="session-id">${escapeHtml(s.id)}</div>
      <div class="session-meta">
        <span class="outcome ${escapeHtml(s.lastOutcome || '')}">${escapeHtml(s.lastOutcome || 'no interactions')}</span>
        <span class="session-count">${s.interactionCount} interaction${s.interactionCount === 1 ? '' : 's'}</span>
      </div>
      ${s.lastSummary ? `<div class="session-summary" title="${escapeHtml(s.lastSummary)}">${escapeHtml(s.lastSummary.slice(0, 80))}</div>` : ''}
    `;
    li.addEventListener('click', () => openSession(s.id));
    sessionListEl.appendChild(li);
  }
}

async function openSession(id) {
  stopRun(); // leave any in-flight UI run state (server-side run continues)
  state.sessionId = id;
  state.sessionTitle = id;
  sessionTitleEl.textContent = id;
  await loadSessions(id);
  renderInteractions();
}

async function renderInteractions() {
  if (!state.sessionId) {
    chatEl.innerHTML = '';
    chatEl.appendChild(emptyStateEl);
    return;
  }
  let session;
  try {
    session = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
  } catch (err) {
    showToast(`Could not load session: ${err.message}`);
    return;
  }
  chatEl.innerHTML = '';
  if (session.interactions.length === 0) {
    chatEl.appendChild(emptyStateEl);
    return;
  }
  for (const interaction of session.interactions) {
    appendUserBubble(interaction.userRequest);
    const assistantEl = appendAssistantBubble(null);
    const outcome = interaction.outcome === 'pending' ? 'working…' : interaction.outcome;
    assistantEl.querySelector('.bubble-meta').textContent = outcome;
    if (interaction.reviewSummary) {
      assistantEl.querySelector('.bubble-body').innerHTML = renderMarkdown(interaction.reviewSummary);
    }
  }
  scrollChat();
}

function appendUserBubble(text) {
  emptyStateEl.remove();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chatEl.appendChild(div);
  scrollChat();
  return div;
}

function appendAssistantBubble(kind) {
  emptyStateEl.remove();
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `
    <div class="bubble">
      <div class="bubble-meta">${kind || 'working…'}</div>
      <div class="bubble-body"></div>
      <div class="timeline"></div>
    </div>`;
  chatEl.appendChild(div);
  scrollChat();
  return div;
}

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ─── Run lifecycle ───────────────────────────────────────────────

async function startRun() {
  const message = goalInput.value.trim();
  if (!message) {
    showToast('Type a goal first.');
    return;
  }
  runBtn.disabled = true;
  goalInput.value = '';
  appendUserBubble(message);
  const assistantEl = appendAssistantBubble('planning…');
  assistantEl.querySelector('.bubble-meta').textContent = 'planning…';

  let accepted;
  try {
    accepted = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        message,
        // Omit (don't send null) when starting a fresh session
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        confirm: autoConfirmEl.checked,
      }),
    });
  } catch (err) {
    finishRunUi();
    showToast(`Run failed: ${err.message}`);
    return;
  }

  state.run = {
    runId: accepted.runId,
    planId: null,
    es: null,
    pollTimer: null,
    assistantEl,
    done: false,
  };
  showRunControls('planning…');
  pollRun();
}

function pollRun() {
  const run = state.run;
  if (!run || run.done) return;

  api(`/api/runs/${run.runId}`)
    .then((s) => {
      if (!state.run || state.run.runId !== run.runId) return; // superseded
      if (s.planId && s.planId !== run.planId) {
        run.planId = s.planId;
        connectStream(run);
      }
      if (s.state === 'awaiting-confirmation') {
        showRunControls('awaiting your confirmation');
        openPlanModal(run);
      } else if (s.state === 'running') {
        closePlanModal();
        showRunControls('running…');
      } else if (s.state === 'done') {
        finishRun(s, assistantElFor(run));
      } else if (s.state === 'error') {
        finishRunUi();
        showToast(`Run error: ${s.error}`);
        run.done = true;
        return;
      }
      run.pollTimer = setTimeout(pollRun, 800);
    })
    .catch((err) => {
      if (!run.done) showToast(`Poll failed: ${err.message}`);
      if (!run.done) run.pollTimer = setTimeout(pollRun, 2000);
    });
}

function assistantElFor(run) {
  return run.assistantEl;
}

function connectStream(run) {
  if (run.es || !run.planId) return;
  const es = new EventSource(`/api/stream/${encodeURIComponent(run.planId)}`);
  run.es = es;

  const timeline = run.assistantEl.querySelector('.timeline');
  const addLine = (cls, text) => {
    const div = document.createElement('div');
    div.className = `tl ${cls}`;
    div.textContent = text;
    timeline.appendChild(div);
    scrollChat();
  };

  es.addEventListener('plan:started', (e) => {
    run.assistantEl.querySelector('.bubble-meta').textContent = 'running…';
    addLine('started', `▶ plan started`);
    try {
      const d = JSON.parse(e.data);
      if (d.message) addLine('info', d.message);
    } catch { /* ignore */ }
  });
  es.addEventListener('plan:step-started', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('started', `▶ ${msg}`);
  });
  es.addEventListener('plan:step-completed', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('done', `✔ ${msg}`);
  });
  es.addEventListener('plan:step-failed', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('failed', `✖ ${msg}`);
  });
  es.addEventListener('plan:replanning', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('replan', `↻ ${msg}`);
  });
  es.addEventListener('task:tool-call', (e) => {
    let tool = '';
    try { tool = JSON.parse(e.data).toolName ?? ''; } catch { /* raw */ }
    addLine('tool', `· tool: ${tool || 'call'}`);
  });
  es.addEventListener('plan:completed', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('done', `✅ ${msg}`);
  });
  es.addEventListener('plan:failed', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('failed', `❌ ${msg}`);
  });
  es.addEventListener('plan:cancelled', (e) => {
    let msg = e.data;
    try { msg = JSON.parse(e.data).message ?? e.data; } catch { /* raw */ }
    addLine('cancelled', `🛑 ${msg}`);
  });
  es.addEventListener('run:done', () => {
    // The poller picks up the final report; nothing to do here.
  });
  es.onerror = () => {
    // EventSource retries automatically; if the stream is gone the
    // poller still converges on the run's terminal state.
  };
}

async function finishRun(s, assistantEl) {
  const run = state.run;
  if (run && run.done) return;
  if (run) run.done = true;
  finishRunUi();
  closePlanModal();

  const meta = assistantEl.querySelector('.bubble-meta');
  const body = assistantEl.querySelector('.bubble-body');
  meta.textContent = `outcome: ${s.outcome}`;
  meta.classList.add(s.outcome || '');
  if (s.report) body.innerHTML = renderMarkdown(s.report);
  scrollChat();
  loadSessions(state.sessionId);
}

function finishRunUi() {
  runBtn.disabled = false;
  hideRunControls();
  if (state.run) {
    clearTimeout(state.run.pollTimer);
    if (state.run.es) state.run.es.close();
    state.run = null;
  }
}

function stopRun() {
  finishRunUi();
  closePlanModal();
}

function showRunControls(text) {
  runControlsEl.classList.remove('hidden');
  runStateEl.textContent = text;
}

function hideRunControls() {
  runControlsEl.classList.add('hidden');
}

async function cancelRun() {
  const run = state.run;
  if (!run || !run.planId) {
    showToast('Nothing to cancel yet.');
    return;
  }
  try {
    await api(`/api/plans/${encodeURIComponent(run.planId)}/cancel`, { method: 'POST' });
    showRunControls('cancelling…');
  } catch (err) {
    showToast(`Cancel failed: ${err.message}`);
  }
}

// ─── Plan confirmation modal ─────────────────────────────────────

async function openPlanModal(run) {
  state.modalPlanId = run.planId;
  planSummaryEl.textContent = run.planText || '';
  planTableWrap.innerHTML = 'Loading plan…';
  modalEl.classList.remove('hidden');

  try {
    const plan = await api(`/api/plans/${encodeURIComponent(run.planId)}`);
    renderPlanTable(plan);
  } catch (err) {
    planTableWrap.innerHTML = `<p class="muted">Plan table unavailable: ${escapeHtml(err.message)}</p>`;
  }
}

function renderPlanTable(plan) {
  if (!plan || !Array.isArray(plan.steps)) {
    planTableWrap.innerHTML = '';
    return;
  }
  const cols = ['#', 'Step', 'Persona', 'Skills', 'Tools', 'Resources', 'Acceptance'];
  const rows = plan.steps.map((s, i) => [
    String(i + 1),
    s.description,
    s.assignedPersona,
    (s.assignedSkills || []).join(', '),
    (s.assignedTools || []).join(', '),
    (s.claimedResources || []).join(', '),
    s.acceptanceCriteria,
  ]);
  const table = document.createElement('table');
  table.className = 'plan-table';
  table.innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows
      .map(
        (r) =>
          `<tr>${r.map((c, i) => (i === 1 || i === 6
            ? `<td class="wide">${escapeHtml(c)}</td>`
            : `<td>${escapeHtml(c)}</td>`)).join('')}</tr>`,
      )
      .join('')}</tbody>`;
  planTableWrap.innerHTML = '';
  planTableWrap.appendChild(table);
}

function closePlanModal() {
  modalEl.classList.add('hidden');
  state.modalPlanId = null;
  planFeedbackEl.value = '';
}

async function decidePlan(confirmed) {
  if (!state.modalPlanId) return;
  const feedback = planFeedbackEl.value.trim();
  const btn = confirmed ? planConfirmBtn : planRejectBtn;
  btn.disabled = true;
  try {
    await api(`/api/plans/${encodeURIComponent(state.modalPlanId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmed, feedback: feedback || undefined }),
    });
    closePlanModal();
  } catch (err) {
    showToast(`Decision failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ─── Wire-up ─────────────────────────────────────────────────────

runBtn.addEventListener('click', () => void startRun());
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void startRun();
  }
});
newSessionBtn.addEventListener('click', () => {
  stopRun();
  state.sessionId = null;
  sessionTitleEl.textContent = 'New session';
  chatEl.innerHTML = '';
  chatEl.appendChild(emptyStateEl);
  loadSessions(null);
});
cancelRunBtn.addEventListener('click', () => void cancelRun());
planConfirmBtn.addEventListener('click', () => void decidePlan(true));
planRejectBtn.addEventListener('click', () => void decidePlan(false));

// ─── U2: Registry panel ─────────────────────────────────────────
// Collapsible introspection of the runtime's registries. Data comes
// from /api/{models,personas,skills,tools,mcp}; the MCP group has a
// per-server Test button (POST /api/mcp/:id/test) with an inline
// success/error result.

function regItem(code, text, dim) {
  const li = document.createElement('li');
  li.className = 'registry-item';
  const c = document.createElement('code');
  c.textContent = code;
  li.appendChild(c);
  if (text) {
    const span = document.createElement('span');
    span.className = 'registry-desc';
    span.textContent = text;
    li.appendChild(span);
  }
  if (dim) {
    const d = document.createElement('span');
    d.className = 'registry-dim';
    d.textContent = dim;
    li.appendChild(d);
  }
  return li;
}

function fillList(el, rows) {
  el.textContent = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'registry-empty';
    li.textContent = '— none —';
    el.appendChild(li);
    return;
  }
  for (const r of rows) el.appendChild(r);
}

async function testMcp(id, btn, resultEl) {
  btn.disabled = true;
  btn.textContent = '…';
  resultEl.textContent = 'testing…';
  resultEl.className = 'mcp-result';
  try {
    const r = await api(`/api/mcp/${encodeURIComponent(id)}/test`, { method: 'POST' });
    if (r.ok) {
      resultEl.textContent = `✔ ${r.toolIds.length} tool(s)`;
      resultEl.classList.add('ok');
    } else {
      resultEl.textContent = `✖ ${r.error}`;
      resultEl.classList.add('fail');
    }
  } catch (e) {
    resultEl.textContent = `✖ ${e.message}`;
    resultEl.classList.add('fail');
  }
  btn.disabled = false;
  btn.textContent = 'Test';
}

async function loadRegistry() {
  const groups = {};
  const countsEl = $('#registry-counts');
  try {
    const [models, personas, skills, tools, mcp] = await Promise.all([
      api('/api/models'),
      api('/api/personas'),
      api('/api/skills'),
      api('/api/tools'),
      api('/api/mcp').catch(() => ({ servers: [], errors: ['failed to load MCP configs'] })),
    ]);

    groups.models = models.map((m) => regItem(m.id, m.description, `${m.provider}:${m.model}`));
    groups.personas = personas.map((p) => regItem(p.id, p.description, `${p.allowedTools.length} tools`));
    groups.skills = skills.map((s) => regItem(s.id, `v${s.version}`, `${s.tools.length} tools`));
    groups.tools = tools.map((t) => regItem(t.id, t.description, t.category || t.source));

    // MCP: item + Test button + inline result
    const mcpRows = mcp.servers.map((s) => {
      const li = document.createElement('li');
      li.className = 'registry-item mcp-item';
      const c = document.createElement('code');
      c.textContent = s.id;
      const d = document.createElement('span');
      d.className = 'registry-desc';
      d.textContent = `${s.name} · ${s.transport}`;
      const btn = document.createElement('button');
      btn.className = 'btn small mcp-test-btn';
      btn.textContent = 'Test';
      const result = document.createElement('span');
      result.className = 'mcp-result';
      btn.addEventListener('click', () => void testMcp(s.id, btn, result));
      li.append(c, d, btn, result);
      return li;
    });
    if (mcp.errors && mcp.errors.length) {
      for (const e of mcp.errors) {
        const li = document.createElement('li');
        li.className = 'registry-empty';
        li.textContent = e;
        mcpRows.push(li);
      }
    }
    groups.mcp = mcpRows;

    fillList($('#registry-models'), groups.models);
    fillList($('#registry-personas'), groups.personas);
    fillList($('#registry-skills'), groups.skills);
    fillList($('#registry-tools'), groups.tools);
    fillList($('#registry-mcp'), groups.mcp);

    // Show counts on each group summary + the header
    const counts = {
      models: models.length,
      personas: personas.length,
      skills: skills.length,
      tools: tools.length,
      mcp: mcp.servers.length,
    };
    document.querySelectorAll('.registry-group-summary').forEach((sum) => {
      const k = sum.dataset.kind;
      const n = counts[k];
      if (typeof n === 'number') {
        sum.textContent = `${sum.textContent.replace(/\s*\(\d+\)\s*$/, '')} (${n})`;
      }
    });
    countsEl.textContent = `${counts.models + counts.personas + counts.skills + counts.tools} items`;
  } catch (e) {
    countsEl.textContent = '';
    fillList($('#registry-models'), [regItem('error', e.message)]);
  }
}

// Initial load
loadSessions();
loadRegistry();
api('/api/health')
  .then((h) => {
    $('#sidebar-footer').textContent = `root: ${h.projectRoot}`;
  })
  .catch(() => {
    $('#sidebar-footer').textContent = 'server unreachable';
  });
