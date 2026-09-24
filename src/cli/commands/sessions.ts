/**
 * Phase 23 (CLI, step 2): session management.
 *
 *   human-out-of-the-loop sessions list [--project-root DIR]
 *   human-out-of-the-loop sessions show <sessionId> [--project-root DIR]
 *   human-out-of-the-loop sessions delete <sessionId> [--project-root DIR]
 *
 * Sessions live in `<projectRoot>/.ai-runtime/sessions/` (persistent
 * mode).  With an in-memory store there is nothing to list.
 */
import path from 'node:path';
import { FileSessionStore } from '../../ai/runtime/session-store.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface SessionsCommandOptions {
  projectRoot?: string;
}

function storeFor(opts: SessionsCommandOptions): FileSessionStore {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return new FileSessionStore(path.join(projectRoot, '.ai-runtime', 'sessions'));
}

export async function sessionsListCommand(
  opts: SessionsCommandOptions,
): Promise<number> {
  const store = storeFor(opts);
  const ids = store.listSessions();

  if (ids.length === 0) {
    out(color.dim('No sessions found (persistent mode stores sessions in .ai-runtime/sessions).'));
    return 0;
  }

  const rows = ids.map((id) => {
    const s = store.getSession(id);
    const last = s?.interactions[s.interactions.length - 1];
    return [
      id,
      new Date(s?.createdAt ?? 0).toISOString().slice(0, 10),
      s?.interactions.length ?? 0,
      last?.outcome ?? '-',
      (last?.reviewSummary ?? '').slice(0, 60),
    ];
  });

  out(renderTable(['SESSION ID', 'CREATED', 'INTERACTIONS', 'LAST OUTCOME', 'SUMMARY'], rows));
  return 0;
}

/** C3: `sessions label <id> <label>` — set (or clear with "") a session label. */
export async function sessionsLabelCommand(
  sessionId: string,
  label: string,
  opts: SessionsCommandOptions,
): Promise<number> {
  if (label.length > 64) {
    err(color.failed('Label must be at most 64 characters.'));
    return 2;
  }
  const store = storeFor(opts);
  const updated = store.setLabel(sessionId, label);
  if (!updated) {
    err(color.failed(`Session "${sessionId}" not found.`));
    return 1;
  }
  out(
    label
      ? color.done(`✔ Session ${sessionId} labeled "${updated.label}"`)
      : color.done(`✔ Session ${sessionId} label cleared`),
  );
  return 0;
}

export async function sessionsShowCommand(
  sessionId: string,
  opts: SessionsCommandOptions,
): Promise<number> {
  const store = storeFor(opts);
  const session = store.getSession(sessionId);
  if (!session) {
    err(color.failed(`Session "${sessionId}" not found.`));
    return 1;
  }
  out(color.bold(`Session ${session.id}${session.label ? ` — ${session.label}` : ''}`));
  out(color.dim(`Created: ${new Date(session.createdAt).toISOString()}`));
  for (const interaction of session.interactions) {
    out(color.bold(`\nInteraction ${interaction.id} (${interaction.outcome})`));
    out(`  Request: ${interaction.userRequest.slice(0, 120)}`);
    if (interaction.reviewSummary) {
      out(`  Summary: ${interaction.reviewSummary.slice(0, 200)}`);
    }
    if (interaction.planIds.length > 0) {
      out(color.dim(`  Plans: ${interaction.planIds.join(', ')}`));
    }
  }
  return 0;
}

export async function sessionsDeleteCommand(
  sessionId: string,
  opts: SessionsCommandOptions,
): Promise<number> {
  const store = storeFor(opts);
  if (!store.getSession(sessionId)) {
    err(color.failed(`Session "${sessionId}" not found.`));
    return 1;
  }
  store.deleteSession(sessionId);
  out(color.done(`Deleted session ${sessionId}.`));
  return 0;
}
