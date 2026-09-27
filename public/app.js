/* Human Out of the Loop — vanilla frontend (no frameworks).
 * Talks to the Express API: /api/run, /api/sessions, /api/plans,
 * /api/stream/:planId (SSE).  Upgrade path to React/Next: each
 * function below maps to a component/hook 1:1.
 */
import {
  SSE_EVENT_TYPES,
  shouldOpenPlanModal,
  shouldClosePlanModalOnRunning,
  shouldOpenClarifyModal,
  isAgentLevelPayload,
  nextSessionId,
  formatReviewSummary,
  errorBubbleText,
} from './ui-logic.js';

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
// U3: per-run model and advanced execution options
const runModeEl = $('#run-mode');
const runModelEl = $('#run-model');
const runTimeoutEl = $('#run-timeout');
const runMaxStepsEl = $('#run-max-steps');
const runMaxReplansEl = $('#run-max-replans');
const previewBtn = $('#preview-btn');
const newSessionBtn = $('#new-session-btn');
const cancelRunBtn = $('#cancel-run-btn');
const runControlsEl = $('#run-controls');
const runStateEl = $('#run-state');
const sessionTitleEl = $('#session-title');
const emptyStateEl = $('#empty-state');
const modalEl = $('#plan-modal');
const planSummaryEl = $('#plan-summary');
const planModelEl = $('#plan-model');
const planTableWrap = $('#plan-table-wrap');
// U4: preview mode (read-only plan modal — no confirm, no execution)
const previewBannerEl = $('#preview-banner');
const planFeasibilityEl = $('#plan-feasibility');
const planDecisionRow = $('#plan-decision-row');
const planPreviewRow = $('#plan-preview-row');
const previewCloseBtn = $('#preview-close-btn');
const previewRunBtn = $('#preview-run-btn');
// U5: clarification modal (planner questions during planning)
const clarifyModalEl = $('#clarify-modal');
const clarifyQuestionsEl = $('#clarify-questions');
const clarifyRoundEl = $('#clarify-round');
const clarifySendBtn = $('#clarify-send-btn');
const clarifyDeclineBtn = $('#clarify-decline-btn');
// U6: live tasks + usage
const tasksPanelEl = $('#tasks-panel');
const tasksListEl = $('#tasks-list');
const tasksCountsEl = $('#tasks-counts');
const usageLineEl = $('#usage-line');
const serverUsageEl = $('#server-usage');
// U7: observability follow panel
const logFollowBtn = $('#log-follow-btn');
const logClearBtn = $('#log-clear-btn');
const logBodyEl = $('#log-body');
const planFeedbackEl = $('#plan-feedback');
const planConfirmBtn = $('#plan-confirm-btn');
const planRejectBtn = $('#plan-reject-btn');
const toastEl = $('#toast');

// ─── State ───────────────────────────────────────────────────────

const state = {
  sessionId: null, // null = new session
  run: null, // { runId, planId, es, pollTimer, timelineEl, assistantEl }
  modalPlanId: null,
  defaultModel: null,
  modalPreview: false,
  modalClarify: false,
  usageTimer: null,
  logEs: null,
  lastPreviewId: null,
  lastPreviewMessage: null,
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
      <div class="session-id">
        <span class="session-title-text">${escapeHtml(s.label || s.id)}</span>
        <button class="session-rename-btn" title="Rename session" aria-label="Rename session">✎</button>
      </div>
      ${s.label ? `<div class="session-id-sub">${escapeHtml(s.id)}</div>` : ''}
      <div class="session-meta">
        <span class="outcome ${escapeHtml(s.lastOutcome || '')}">${escapeHtml(s.lastOutcome || 'no interactions')}</span>
        <span class="session-count">${s.interactionCount} interaction${s.interactionCount === 1 ? '' : 's'}</span>
      </div>
      ${s.lastSummary ? `<div class="session-summary" title="${escapeHtml(s.lastSummary)}">${escapeHtml(s.lastSummary.slice(0, 80))}</div>` : ''}
    `;
    li.addEventListener('click', () => openSession(s.id));
    // U7: inline rename (pencil) — PATCH persists in the same store the CLI uses.
    li.querySelector('.session-rename-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      void renameSession(s.id, s.label || '');
    });
    sessionListEl.appendChild(li);
  }
}

/** U7: prompt for a new label, PATCH it, refresh the sidebar. */
async function renameSession(sessionId, currentLabel) {
  const next = window.prompt('Session label (empty clears it):', currentLabel);
  if (next === null) return; // cancelled
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: next }),
    });
    if (state.sessionId === sessionId) {
      state.sessionTitle = next.trim() || sessionId;
      sessionTitleEl.textContent = state.sessionTitle;
    }
    await loadSessions(state.sessionId);
    showToast(next.trim() ? 'Session renamed.' : 'Session label cleared.', false);
  } catch (err) {
    showToast(`Rename failed: ${err.message}`);
  }
}

async function openSession(id) {
  stopRun(); // leave any in-flight UI run state (server-side run continues)
  state.sessionId = id;
  let label = null;
  try {
    // U7: show the human label in the header when the session has one.
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    label = session.label || null;
  } catch {
    /* fall back to the raw id */
  }
  state.sessionTitle = label || id;
  sessionTitleEl.textContent = label || id;
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
      assistantEl.querySelector('.bubble-body').innerHTML = renderMarkdown(
        formatReviewSummary(interaction.reviewSummary),
      );
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

async function startRun(overrides = {}) {
  const message = (overrides.message ?? goalInput.value).trim();
  if (!message) {
    showToast('Type a goal first.');
    return;
  }
  runBtn.disabled = true;
  if (!overrides.message) goalInput.value = '';
  appendUserBubble(message);
  const assistantEl = appendAssistantBubble('planning…');
  assistantEl.querySelector('.bubble-meta').textContent = 'planning…';

  // U3: blank advanced fields mean "use the server default".
  const model = runModelEl.value;
  const timeoutMs = runTimeoutEl.value === '' ? undefined : Number(runTimeoutEl.value);
  const maxSteps = runMaxStepsEl.value === '' ? undefined : Number(runMaxStepsEl.value);
  const maxReplans = runMaxReplansEl.value === '' ? undefined : Number(runMaxReplansEl.value);
  const mode = runModeEl && runModeEl.value ? runModeEl.value : 'auto';

  let accepted;
  try {
    accepted = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        message,
        // Omit (don't send null) when starting a fresh session
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        confirm: autoConfirmEl.checked,
        ...(model ? { model } : {}),
        ...(mode ? { mode } : {}),
        ...(overrides.previewId ? { previewId: overrides.previewId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(maxReplans !== undefined ? { maxReplans } : {}),
      }),
    });
  } catch (err) {
    assistantEl.querySelector('.bubble-meta').textContent = 'error';
    assistantEl.querySelector('.bubble-body').textContent = errorBubbleText(err.message);
    finishRunUi();
    showToast(`Run failed: ${err.message}`);
    return;
  }

  state.run = {
    runId: accepted.runId,
    planId: null,
    es: null,
    runEs: null,
    pollTimer: null,
    assistantEl,
    // U3: retain the selected model so the confirmation header is explicit.
    model,
    state: 'planning',
    clarifyOpenFor: null,
    clarifySubmittedFor: null,
    planModalOpenFor: null,
    done: false,
  };
  showRunControls('planning…');
  // U6: task list + usage for this run (server-side truth, same process).
  tasksPanelEl.classList.remove('hidden');
  tasksListEl.textContent = '';
  tasksCountsEl.textContent = '';
  usageLineEl.textContent = '';
  // U5: clarification fires during PLANNING (no plan id yet) on the run
  // channel; polling is the fallback if the event is missed.
  connectRunStream(state.run);
  pollRun();
  loadTasks();
  loadServerUsage();
}

function pollRun() {
  const run = state.run;
  if (!run || run.done) return;

  api(`/api/runs/${run.runId}`)
    .then((s) => {
      if (!state.run || state.run.runId !== run.runId) return; // superseded
      run.state = s.state;
      if (s.planId && s.planId !== run.planId) {
        run.planId = s.planId;
        connectStream(run);
      }
      if (s.state === 'awaiting-clarification') {
        showRunControls('waiting for your answers…');
        openClarifyModal(run, s.clarificationQuestions || [], s.clarificationRound || 1);
      } else if (s.state === 'awaiting-confirmation') {
        showRunControls('awaiting your confirmation');
        openPlanModal(run);
      } else if (s.state === 'running') {
        if (
          shouldClosePlanModalOnRunning({
            modalPreview: state.modalPreview,
            modalPlanId: state.modalPlanId,
            runPlanId: run.planId,
          })
        ) {
          closePlanModal();
        }
        showRunControls('running…');
      } else if (s.state === 'done') {
        finishRun(s, assistantElFor(run));
      } else if (s.state === 'error') {
        const el = assistantElFor(run);
        if (el) {
          el.querySelector('.bubble-meta').textContent = 'error';
          el.querySelector('.bubble-body').textContent = errorBubbleText(s.error || 'run failed');
        }
        finishRunUi({ clearRun: false });
        showToast(`Run error: ${s.error}`);
        run.done = true;
        return;
      }
      if (s.state === 'running' || s.state === 'planning') loadTasks();
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

// ─── U6: live tasks + usage ──────────────────────────────────────

const TASK_BADGES = {
  pending: '⏳',
  running: '⚙︎',
  completed: '✔',
  failed: '✖',
  cancelled: '⏹',
};

/** Refresh the task list of the active run (no-op when nothing is running). */
async function loadTasks() {
  const run = state.run;
  if (!run) return;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(run.runId)}/tasks`);
    if (state.run !== run) return;
    renderTasks(data);
  } catch {
    /* the next poll retries */
  }
}

function renderTasks(data) {
  const c = data.counts || {};
  tasksCountsEl.textContent =
    `${c.completed ?? 0}/${c.total ?? 0} done` +
    (c.running ? ` · ${c.running} running` : '') +
    (c.pending ? ` · ${c.pending} pending` : '') +
    (c.failed ? ` · ${c.failed} failed` : '') +
    (c.cancelled ? ` · ${c.cancelled} cancelled` : '');

  tasksListEl.textContent = '';
  for (const task of data.tasks || []) {
    const li = document.createElement('li');
    li.className = `task-item ${task.status}`;

    const badge = document.createElement('span');
    badge.className = 'task-badge';
    badge.textContent = TASK_BADGES[task.status] || '•';

    const label = document.createElement('span');
    label.className = 'task-label';
    label.textContent = `${task.planStepId || task.id} · ${task.status}`;
    if (task.summary) label.title = task.summary;

    const tokens = document.createElement('span');
    tokens.className = 'task-tokens';
    tokens.textContent = task.usage ? `${task.usage.totalTokens} tok` : '';

    li.append(badge, label, tokens);
    if (task.status === 'pending' || task.status === 'running') {
      const btn = document.createElement('button');
      btn.className = 'btn small task-cancel-btn';
      btn.textContent = 'Cancel';
      btn.addEventListener('click', () => void cancelTask(task.id, btn));
      li.appendChild(btn);
    }
    tasksListEl.appendChild(li);
  }

  // Per-plan usage line (same process → authoritative for this server run).
  if (data.planId && (data.counts?.total ?? 0) > 0) {
    api(`/api/usage?planId=${encodeURIComponent(data.planId)}`)
      .then((u) => {
        usageLineEl.textContent = `${u.totalTokens} tok (${u.taskCount} task)`;
      })
      .catch(() => {
        usageLineEl.textContent = '';
      });
  }
}

async function cancelTask(taskId, btn) {
  const run = state.run;
  if (!run) return;
  btn.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(run.runId)}/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    });
    showToast(`Task ${taskId} cancelled.`, false);
    await loadTasks();
  } catch (err) {
    showToast(`Cancel failed: ${err.message}`);
    btn.disabled = false;
  }
}

/** Server-wide usage (in-memory: a restart resets it). */
async function loadServerUsage() {
  try {
    const u = await api('/api/usage');
    serverUsageEl.textContent = `${u.totalTokens} tok · ${u.taskCount} task`;
  } catch {
    serverUsageEl.textContent = '—';
  }
}

function parseSseData(e) {
  try {
    return JSON.parse(e.data);
  } catch {
    return { message: e.data };
  }
}

/** H-04: every server event name has a listener; agent-level step rows are skipped. */
function attachProgressListeners(es, run) {
  const timeline = run.assistantEl.querySelector('.timeline');
  const addLine = (cls, text) => {
    const div = document.createElement('div');
    div.className = `tl ${cls}`;
    div.textContent = text;
    timeline.appendChild(div);
    scrollChat();
  };

  for (const type of SSE_EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      if (state.run && state.run.runId !== run.runId) return;
      const d = parseSseData(e);
      if (type === 'clarification') {
        openClarifyModal(run, d.questions || [], d.attempt || 1);
        return;
      }
      if (type === 'awaiting-confirmation') {
        if (d.planId) run.planId = d.planId;
        openPlanModal(run);
        return;
      }
      if (type === 'run:done') return;
      if (isAgentLevelPayload(d) && String(type).startsWith('plan:step-')) return;
      const msg = d.message ?? e.data;
      if (type === 'plan:started') {
        run.assistantEl.querySelector('.bubble-meta').textContent = 'running…';
        addLine('started', '▶ plan started');
        if (d.message) addLine('info', d.message);
        return;
      }
      if (type === 'task:tool-call') {
        addLine('tool', `· tool: ${d.toolName || 'call'}`);
        return;
      }
      if (type === 'task:tool-error') {
        addLine('failed', `✖ tool error: ${msg}`);
        return;
      }
      if (type === 'plan:replanning' || type === 'plan:replanned') {
        addLine('replan', `↻ ${msg}`);
        return;
      }
      if (type === 'plan:cancelled') {
        addLine('cancelled', `🛑 ${msg}`);
        return;
      }
      if (type === 'plan:completed') {
        addLine('done', `✅ ${msg}`);
        return;
      }
      if (type === 'plan:failed' || type === 'plan:error') {
        addLine('failed', `❌ ${msg}`);
        return;
      }
      if (type === 'plan:step-completed') {
        addLine('done', `✔ ${msg}`);
        return;
      }
      if (type === 'plan:step-failed') {
        addLine('failed', `✖ ${msg}`);
        return;
      }
      if (type === 'plan:step-started') {
        addLine('started', `▶ ${msg}`);
        return;
      }
      if (type === 'task:status') {
        addLine('info', msg);
      }
    });
  }
  es.onerror = () => {
    // EventSource retries; the poller converges on the run state regardless.
  };
}

/** U5: run-scoped SSE channel — clarification arrives before any plan exists. */
function connectRunStream(run) {
  if (run.runEs) return;
  const es = new EventSource(`/api/stream/${encodeURIComponent(run.runId)}`);
  run.runEs = es;
  attachProgressListeners(es, run);
}

/**
 * U5: render the planner's questions.  Safe by construction: question text
 * is assigned via textContent (never innerHTML) since it originates in a
 * model response.
 */
function openClarifyModal(run, questions, round) {
  if (!questions.length) return;
  if (!shouldOpenClarifyModal(run, round)) return;
  run.clarifyOpenFor = round;
  state.modalClarify = true;
  clarifyRoundEl.textContent = `Round ${round}`;
  clarifyQuestionsEl.textContent = '';
  for (const question of questions) {
    const label = document.createElement('label');
    label.className = 'clarify-question';
    const span = document.createElement('span');
    span.textContent = question;
    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.placeholder = 'Your answer…';
    textarea.dataset.question = question;
    label.append(span, textarea);
    clarifyQuestionsEl.appendChild(label);
  }
  clarifyModalEl.classList.remove('hidden');
  const first = clarifyQuestionsEl.querySelector('textarea');
  if (first) first.focus();
}

function closeClarifyModal() {
  clarifyModalEl.classList.add('hidden');
  state.modalClarify = false;
}

/** U5: send the answers (or decline → the run is cancelled). */
async function submitClarification(decline) {
  const run = state.run;
  if (!run) return;
  const boxes = [...clarifyQuestionsEl.querySelectorAll('textarea')];
  const answers = Object.fromEntries(boxes.map((b) => [b.dataset.question, b.value.trim()]));
  if (!decline && Object.values(answers).some((a) => a === '')) {
    showToast('Answer every question — or choose "Don\'t answer".');
    return;
  }
  clarifySendBtn.disabled = true;
  clarifyDeclineBtn.disabled = true;
  try {
    const res = await api(`/api/runs/${encodeURIComponent(run.runId)}/clarification`, {
      method: 'POST',
      body: JSON.stringify(decline ? { decline: true } : { answers }),
    });
    run.clarifySubmittedFor = roundFromRun(run);
    closeClarifyModal();
    const timeline = run.assistantEl.querySelector('.timeline');
    if (timeline) {
      const div = document.createElement('div');
      div.className = 'tl clarified';
      div.textContent = decline
        ? '⏹ clarification declined — run cancelled'
        : `✦ clarified (round ${res.round}): ${Object.keys(answers).length} answer(s)`;
      timeline.appendChild(div);
      scrollChat();
    }
    showRunControls(decline ? 'cancelling…' : 'planning…');
  } catch (err) {
    showToast(`Clarification failed: ${err.message}`);
  } finally {
    clarifySendBtn.disabled = false;
    clarifyDeclineBtn.disabled = false;
  }
}

function roundFromRun(run) {
  return run.clarifyOpenFor ?? null;
}

function connectStream(run) {
  if (run.es || !run.planId) return;
  // Dual-emit already fans plan events onto the run channel (H-02).
  if (run.runEs) return;
  const es = new EventSource(`/api/stream/${encodeURIComponent(run.planId)}`);
  run.es = es;
  attachProgressListeners(es, run);
}

async function finishRun(s, assistantEl) {
  const run = state.run;
  if (run && run.done) return;
  if (run) run.done = true;
  state.sessionId = nextSessionId(s, state.sessionId);
  // H-12: load the final task table while `state.run` is still this run.
  finishRunUi({ clearRun: false });
  if (
    shouldClosePlanModalOnRunning({
      modalPreview: state.modalPreview,
      modalPlanId: state.modalPlanId,
      runPlanId: run && run.planId,
    })
  ) {
    closePlanModal();
  }

  const meta = assistantEl.querySelector('.bubble-meta');
  const body = assistantEl.querySelector('.bubble-body');
  meta.textContent = `outcome: ${s.outcome}`;
  meta.classList.add(s.outcome || '');
  if (s.report) body.innerHTML = renderMarkdown(s.report);
  scrollChat();
  loadSessions(state.sessionId);
}

function finishRunUi({ clearRun = true } = {}) {
  runBtn.disabled = false;
  hideRunControls();
  closeClarifyModal();
  if (state.run) {
    clearTimeout(state.run.pollTimer);
    state.run.pollTimer = null;
    if (state.run.es) {
      state.run.es.close();
      state.run.es = null;
    }
    if (state.run.runEs) {
      state.run.runEs.close();
      state.run.runEs = null;
    }
  }
  // U6 / H-12: final task table stays on screen; fetch before dropping run.
  void loadTasks();
  void loadServerUsage();
  if (clearRun) state.run = null;
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
  if (!run) {
    showToast('Nothing to cancel yet.');
    return;
  }
  // U5: while the planner waits for answers there is no plan to cancel —
  // declining the questions is the way out.
  if (run.state === 'awaiting-clarification') {
    await submitClarification(true);
    return;
  }
  if (!run.planId) {
    try {
      await api(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, { method: 'POST' });
      showRunControls('cancelling…');
    } catch (err) {
      showToast(`Cancel failed: ${err.message}`);
    }
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
  // U4: a preview passes { preview: true, plan, ... } — the plan object is
  // rendered directly (there is no stored plan id to fetch) and the modal
  // is read-only.
  const isPreview = run.preview === true;
  if (!isPreview && !shouldOpenPlanModal(run)) return;
  if (!isPreview) run.planModalOpenFor = run.planId;
  state.modalPreview = isPreview;
  state.modalPlanId = isPreview ? null : run.planId;
  planModelEl.textContent = run.model
    ? `Model: ${run.model}`
    : isPreview && state.defaultModel
      ? `Planner model: ${state.defaultModel}`
      : '';
  previewBannerEl.classList.toggle('hidden', !isPreview);
  planDecisionRow.classList.toggle('hidden', isPreview);
  planPreviewRow.classList.toggle('hidden', !isPreview);
  planFeedbackEl.value = '';
  renderFeasibility(isPreview ? run : null);
  planSummaryEl.textContent = run.planText || '';
  modalEl.classList.remove('hidden');

  if (isPreview) {
    planTableWrap.innerHTML = '';
    if (run.plan) renderPlanTable(run.plan);
    else planTableWrap.innerHTML = '<p class="muted">No plan could be produced.</p>';
    return;
  }

  planTableWrap.innerHTML = 'Loading plan…';
  try {
    const plan = await api(`/api/plans/${encodeURIComponent(run.planId)}`);
    renderPlanTable(plan);
  } catch (err) {
    planTableWrap.innerHTML = `<p class="muted">Plan table unavailable: ${escapeHtml(err.message)}</p>`;
  }
}

/** U4: feasibility + cycle summary for a preview (hidden when not previewing). */
function renderFeasibility(preview) {
  if (!preview || (!preview.feasibility && !preview.cycles && !preview.error)) {
    planFeasibilityEl.classList.add('hidden');
    planFeasibilityEl.textContent = '';
    return;
  }
  const lines = [];
  if (preview.feasibility) {
    lines.push(
      preview.feasibility.feasible
        ? `✔ Feasibility: every step resolves against the registries (${preview.feasibility.errors.length} issue(s))`
        : `✖ Feasibility: ${preview.feasibility.errors.length} issue(s) — ${
            preview.feasibility.errors
              .slice(0, 3)
              .map((e) => `${e.stepId}/${e.field}: ${e.message}`)
              .join(' · ')
          }`,
    );
  }
  if (preview.cycles) {
    lines.push(
      preview.cycles.hasCycle
        ? `✖ Dependency cycle: ${(preview.cycles.cyclePath || []).join(' → ')}`
        : '✔ No dependency cycles',
    );
  }
  if (preview.error) lines.push(preview.error);
  planFeasibilityEl.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  planFeasibilityEl.classList.toggle('ok', preview.ok !== false);
  planFeasibilityEl.classList.toggle('bad', preview.ok === false);
  planFeasibilityEl.classList.remove('hidden');
}

/** U4: POST /api/preview — plan only; nothing is saved, nothing runs. */
async function startPreview() {
  const message = goalInput.value.trim();
  if (!message) {
    showToast('Type a goal first.');
    return;
  }
  previewBtn.disabled = true;
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        ...(runModelEl.value ? { model: runModelEl.value } : {}),
        ...(runModeEl && runModeEl.value ? { mode: runModeEl.value } : {}),
      }),
    });
    const body = await res.json().catch(() => null);
    // 400 + questions: the planner needs clarification before planning.
    if (res.status === 400 && body && Array.isArray(body.questions)) {
      const el = appendAssistantBubble('needs clarification (preview)');
      el.querySelector('.bubble-body').innerHTML = renderMarkdown(
        `The planner needs clarification before planning:\n\n${body.questions
          .map((q) => `- ${q}`)
          .join('\n')}`,
      );
      showToast('Preview: clarification needed — see chat.');
      return;
    }
    if (body && body.answer) {
      const el = appendAssistantBubble('chat');
      el.querySelector('.bubble-meta').textContent = 'answer';
      el.querySelector('.bubble-body').innerHTML = renderMarkdown(body.answer);
      showToast('Preview: chat answer — nothing was planned.', false);
      return;
    }
    if (!res.ok || !body) {
      const errText = (body && body.error) || `${res.status} ${res.statusText}`;
      const el = appendAssistantBubble('error');
      el.querySelector('.bubble-body').textContent = errorBubbleText(errText);
      throw new Error(errText);
    }
    state.lastPreviewId = body.previewId || null;
    state.lastPreviewMessage = message;
    if (previewRunBtn) previewRunBtn.disabled = !state.lastPreviewId;
    openPlanModal({
      preview: true,
      plan: body.plan || null,
      planText: body.planText || '',
      feasibility: body.feasibility || null,
      cycles: body.cycles || null,
      error: body.error || null,
      ok: body.ok,
    });
  } catch (err) {
    showToast(`Preview failed: ${err.message}`);
  } finally {
    previewBtn.disabled = false;
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
  state.modalPreview = false;
  planFeedbackEl.value = '';
  previewBannerEl.classList.add('hidden');
  planFeasibilityEl.classList.add('hidden');
  planDecisionRow.classList.remove('hidden');
  planPreviewRow.classList.add('hidden');
}

async function decidePlan(confirmed) {
  // U4: previews are read-only — nothing to confirm.
  if (state.modalPreview || !state.modalPlanId) return;
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
previewBtn.addEventListener('click', () => void startPreview());
previewCloseBtn.addEventListener('click', closePlanModal);
if (previewRunBtn) {
  previewRunBtn.addEventListener('click', () => {
    if (!state.lastPreviewId || !state.lastPreviewMessage) {
      showToast('Preview this plan first.');
      return;
    }
    closePlanModal();
    void startRun({ message: state.lastPreviewMessage, previewId: state.lastPreviewId });
  });
}
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void startRun();
  }
});
function resetTasksPanel() {
  tasksPanelEl.classList.add('hidden');
  tasksListEl.textContent = '';
  tasksCountsEl.textContent = '';
  usageLineEl.textContent = '';
}

newSessionBtn.addEventListener('click', () => {
  stopRun();
  resetTasksPanel();
  state.sessionId = null;
  sessionTitleEl.textContent = 'New session';
  chatEl.innerHTML = '';
  chatEl.appendChild(emptyStateEl);
  loadSessions(null);
});
cancelRunBtn.addEventListener('click', () => void cancelRun());
clarifySendBtn.addEventListener('click', () => void submitClarification(false));
clarifyDeclineBtn.addEventListener('click', () => void submitClarification(true));
planConfirmBtn.addEventListener('click', () => void decidePlan(true));
planRejectBtn.addEventListener('click', () => void decidePlan(false));
logFollowBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  toggleLogFollow();
});
logClearBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  clearLogPanel();
});

// ─── U7: observability follow ────────────────────────────────────

/**
 * Stream new observability lines over SSE (`/api/observability/stream`).
 * The server sends a bounded backlog first (`tail-end` marks the boundary)
 * and then every new entry — the same `followLog` the CLI uses.
 */
function toggleLogFollow() {
  if (state.logEs) {
    state.logEs.close();
    state.logEs = null;
    logFollowBtn.textContent = 'Follow';
    return;
  }
  const planFilter = state.run && state.run.planId ? state.run.planId : null;
  const url = planFilter
    ? `/api/observability/stream?planId=${encodeURIComponent(planFilter)}`
    : '/api/observability/stream';
  const es = new EventSource(url);
  state.logEs = es;
  logFollowBtn.textContent = 'Stop';
  logBodyEl.textContent = planFilter ? `— following ${planFilter} —\n` : '— following —\n';

  es.addEventListener('entry', (e) => {
    let line = e.data;
    try {
      const d = JSON.parse(e.data);
      line = `${d.timestamp} ${String(d.level || 'info').toUpperCase()} ${d.eventType} ${d.message}`;
    } catch {
      /* raw line */
    }
    logBodyEl.textContent += `${line}\n`;
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  });
  es.addEventListener('tail-end', () => {
    logBodyEl.textContent += '— live —\n';
  });
  es.onerror = () => {
    // EventSource retries; the panel simply stays as-is meanwhile.
  };
}

function clearLogPanel() {
  logBodyEl.textContent = '—';
}

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
    // U3: the run model selector — the registry first, then whatever the
    // configured providers serve (loaded separately, it needs the network).
    state.registryModels = models;
    renderModelPicker();
    void loadRemoteModels();
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

/**
 * The model picker: registered models, plus the models the providers
 * actually serve (GET /api/models/remote).  Any of them can be run — the
 * server registers a provider model on first use.
 */
function renderModelPicker() {
  const previous = runModelEl.value;
  runModelEl.innerHTML = '';
  const group = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [value, text] of items) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      og.appendChild(option);
    }
    runModelEl.appendChild(og);
  };
  const registry = state.registryModels || [];
  group('Registry', registry.map((m) => [m.id, `${m.id} (${m.provider}:${m.model})`]));
  const remote = (state.remoteModels || []).filter((m) => !registry.some((r) => r.id === m.spec));
  const bySource = {};
  for (const m of remote) (bySource[m.source] = bySource[m.source] || []).push([m.spec, m.name]);
  for (const [source, items] of Object.entries(bySource)) group(`From ${source}`, items);

  const wanted = previous || state.defaultModel;
  if (wanted && runModelEl.querySelector(`option[value="${CSS.escape(wanted)}"]`)) {
    runModelEl.value = wanted;
  }
}

async function loadRemoteModels() {
  const status = $('#run-model-status');
  status.textContent = 'loading provider models…';
  try {
    const list = await api('/api/models/remote');
    state.remoteModels = list.models;
    renderModelPicker();
    const failed = list.errors.map((e) => `${e.source}: ${e.error}`).join(' · ');
    status.textContent = list.models.length
      ? `${list.models.length} from providers${failed ? ` · ${failed}` : ''}`
      : failed || 'no provider configured for listing';
  } catch (e) {
    status.textContent = `provider models unavailable: ${e.message}`;
  }
}

$('#run-model-refresh').addEventListener('click', () => void loadRemoteModels());

// Initial load
loadSessions();
loadRegistry();
loadServerUsage();
setInterval(loadServerUsage, 30_000);
api('/api/health')
  .then((h) => {
    $('#sidebar-footer').textContent = `root: ${h.projectRoot}`;
    // U3: select the server-configured model rather than assuming the
    // registry's first item is the default. Preserve a user's selection
    // if they changed it before this request completed.
    state.defaultModel = h.model;
    if (runModeEl && h.mode && !runModeEl.dataset.userSet) {
      runModeEl.value = h.mode;
    }
    renderModelPicker();
  })
  .catch(() => {
    $('#sidebar-footer').textContent = 'server unreachable';
  });
