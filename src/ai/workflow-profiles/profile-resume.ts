/**
 * Phase 10 Step 1 (U-2): the operator-facing side of profile run state — the directory convention,
 * a listing for humans, and the fail-closed read a resume needs.
 *
 * The store itself (`FileWorkflowProfileRunStateStore`) is deliberately storage-only: it writes and
 * reads whole records and knows nothing about policy. This module adds the three things a CLI needs
 * without duplicating any guard:
 *
 *   - one directory convention, so a run the Orchestrator wrote is the run the CLI can find
 *     (`<runtimeDir>/workflow-profile-runs`, the same `runtimeDir` every other store uses);
 *   - a summary listing (`listWorkflowProfileRuns`) that never throws on one unreadable record;
 *   - `loadResumableWorkflowProfileRun`, which refuses a missing or already-terminal record here
 *     instead of letting the runner fail later, and reports the same diagnostic codes the rest of
 *     the feature uses.
 *
 * Resume *integrity* is not decided here: whether the stored profile, dependencies, runtime version
 * and authority still match is the runner's decision (`evaluateWorkflowProfileResume`), which runs
 * before any node executes. This module only answers "is there a run to resume at all?".
 */
import path from 'node:path';
import { FileWorkflowProfileRunStateStore } from './profile-run-state.js';
import type { WorkflowProfileRunState, WorkflowProfileRunStateStore } from './profile-run-state.js';
import { WorkflowProfileLoadError } from './profile-registry.js';

/** Directory holding one JSON record per profile run, under the runtime directory. */
export const WORKFLOW_PROFILE_RUNS_DIRNAME = 'workflow-profile-runs';

export function workflowProfileRunsDir(runtimeDir: string): string {
  return path.join(runtimeDir, WORKFLOW_PROFILE_RUNS_DIRNAME);
}

export function openWorkflowProfileRunStore(runtimeDir: string): FileWorkflowProfileRunStateStore {
  return new FileWorkflowProfileRunStateStore(workflowProfileRunsDir(runtimeDir));
}

export interface WorkflowProfileRunSummary {
  runId: string;
  profileId: string;
  profileVersion?: string;
  status: WorkflowProfileRunState['status'];
  awaitingUser: boolean;
  currentNodeId: string;
  /** Nodes visited so far, in order. */
  nodeSequence: readonly string[];
  visits: number;
  sessionId?: string;
  planId?: string;
  updatedAtMs: number;
  /** A record that is not terminal and has no pending effect can be resumed. */
  resumable: boolean;
}

/** Terminal statuses: a run whose outcome is decided is history, not a candidate for resume. */
const TERMINAL: ReadonlyArray<WorkflowProfileRunState['status']> = ['success', 'failure', 'rejected', 'cancelled'];

export function isTerminalWorkflowProfileRun(status: WorkflowProfileRunState['status']): boolean {
  return TERMINAL.includes(status);
}

function toSummary(state: WorkflowProfileRunState): WorkflowProfileRunSummary {
  return {
    runId: state.runId,
    profileId: state.profileId,
    ...(state.profileVersion ? { profileVersion: state.profileVersion } : {}),
    status: state.status,
    awaitingUser: state.awaitingUser === true,
    currentNodeId: state.currentNodeId,
    nodeSequence: [...state.nodeSequence],
    visits: state.visits,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.planId ? { planId: state.planId } : {}),
    updatedAtMs: state.updatedAtMs,
    resumable: !isTerminalWorkflowProfileRun(state.status) && !state.pendingEffect,
  };
}

/**
 * Every stored run, newest first. A record that cannot be parsed is skipped rather than thrown:
 * one corrupt file must not make the whole listing unusable (the same rule discovery follows).
 */
export function listWorkflowProfileRuns(store: WorkflowProfileRunStateStore): WorkflowProfileRunSummary[] {
  // A file-backed store can enumerate its records (`loadAll`, which skips unreadable files); a
  // memory store is asked for the states it knows. A store that offers neither contributes nothing
  // rather than throwing, because a listing must never be the thing that fails.
  const states: WorkflowProfileRunState[] = typeof (store as { loadAll?: unknown }).loadAll === 'function'
    ? (store as unknown as { loadAll(): WorkflowProfileRunState[] }).loadAll()
    : [];
  return states
    .map((state) => toSummary(state))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

/**
 * Read one record for a resume. Missing and already-terminal records are refused here with the
 * runner's own diagnostic codes, so a caller gets one clear failure instead of a half-started run.
 * A record with a pending effect is returned (the *runner* refuses it as ambiguous), because the
 * decision needs the profile and authority the caller is about to supply.
 */
export function loadResumableWorkflowProfileRun(
  store: WorkflowProfileRunStateStore,
  runId: string,
): WorkflowProfileRunState {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new WorkflowProfileLoadError('A resume needs a run id', [{
      stage: 'read', code: 'resume.run-id-invalid', message: 'runId must be a non-empty string',
    }]);
  }
  const state = store.load(runId);
  if (!state) {
    throw new WorkflowProfileLoadError(`No stored Workflow Profile run "${runId}"`, [{
      stage: 'read', code: 'resume.profile-missing',
      message: 'No stored run state for this run id (see: hootl profiles runs)',
    }]);
  }
  if (isTerminalWorkflowProfileRun(state.status)) {
    throw new WorkflowProfileLoadError(`Workflow Profile run "${runId}" already finished (${state.status})`, [{
      stage: 'semantic', code: 'resume.already-terminal',
      message: 'A finished run is not resumed; start a new run instead', profileId: state.profileId,
    }]);
  }
  return state;
}
