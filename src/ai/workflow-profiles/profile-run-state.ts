/**
 * Phase 6 (WP-R-007): the versioned, crash-safe run state and its resume rules.
 *
 * State carries everything a resume needs and nothing that grants authority:
 * the profile id/version plus a hash of the canonical profile bytes, the schema
 * and runtime versions, the resolved dependency pins, the current node, the
 * outputs/loop counters/budget counters, the approvals (with the digest each
 * one approved) and the linked plan/session. Before any work resumes the state
 * is re-verified against the live profile, dependencies, and runtime version —
 * any mismatch stops the run BEFORE a side effect — and a state that was left
 * with a pending effect is never retried automatically.
 *
 * **Unknown / Requires Verification (recorded, not resolved):** the existing
 * stores (`PlanStore`, the checkpoint store) persist *results*, not an
 * intent/effect/commit journal, so they cannot prove whether an interrupted
 * step's side effect reached the outside world. This module therefore treats
 * every persisted "effect started" marker as ambiguous and refuses automatic
 * continuation. A real journal belongs to the Runtime contract that is still an
 * open pre-integration gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../runtime/atomic-write.js';
import { canonicalJson } from './profile-digest.js';
import { contentDigest } from './untrusted-content.js';
import { isProcessAlive, lockIdentity, readLockInfo, type LockInfo } from '../runtime/file-lock.js';
import { detectAuthorityIncrease, type AuthoritySnapshot } from './profile-access-guard.js';
import type { WorkflowBudgetUsage } from './profile-budget.js';
import type { ProfileDependency, WorkflowProfileDocument } from './profile-types.js';

/** Dependency kinds a v1 profile can pin. */
export type ProfileDependencyKind = ProfileDependency['kind'];
import type { WorkflowRunResult, WorkflowRunStatus } from './profile-kernel.js';

export const PROFILE_RUN_STATE_VERSION = 1;

/**
 * The pin actually recorded for a resolved dependency: kind, id, the version the
 * source exposed (if any), and the content digest that was verified. A resume
 * compares these, never the profile's declaration alone.
 */
export interface StoredDependencyPin {
  kind: ProfileDependencyKind;
  id: string;
  version?: string;
  digest: string;
}

/** Map resolved dependencies onto their stored pins. */
export function storedDependencyPins(
  dependencies: ReadonlyArray<{ kind: ProfileDependencyKind; id: string; declaredVersion?: string; resolvedVersion?: string; contentDigest?: string; declaredDigest?: string }>,
): StoredDependencyPin[] {
  return dependencies.map((dependency) => ({
    kind: dependency.kind,
    id: dependency.id,
    ...(dependency.resolvedVersion ?? dependency.declaredVersion ? { version: dependency.resolvedVersion ?? dependency.declaredVersion } : {}),
    digest: dependency.contentDigest ?? dependency.declaredDigest ?? '',
  }));
}

export interface WorkflowProfileApprovalRecord {
  nodeId: string;
  status: 'approved' | 'denied' | 'expired' | 'cancelled';
  /** The digest the decision approved, when the node bound one. */
  digest?: string;
  boundPort?: string;
  atMs: number;
}

/** Marker written BEFORE a side effect and cleared after it is committed. */
export interface WorkflowProfilePendingEffect {
  nodeId: string;
  attemptId: string;
  intent: string;
  startedAtMs: number;
}

export interface WorkflowProfileRunState {
  stateVersion: number;
  runId: string;
  profileId: string;
  profileVersion?: string;
  /** `sha256:<hex>` over the canonical profile bytes. */
  profileHash: string;
  schemaVersion: string;
  /** Host-declared runtime version; a resume must match it. */
  runtimeVersion: string;
  /** Resolved dependency pins; a resume must match all of them. */
  dependencies: StoredDependencyPin[];
  status: WorkflowRunStatus | 'interrupted';
  /**
   * Set when a run paused on the `ask-user` limit: the run is waiting for the
   * user, keeps every counter, and may be resumed — it is not terminal.
   */
  awaitingUser?: boolean;
  currentNodeId: string;
  nodeSequence: string[];
  visits: number;
  loopCounters: Record<string, number>;
  budget: WorkflowBudgetUsage;
  /** Declared authority the run started with; a resume may never widen it. */
  authority: AuthoritySnapshot;
  approvals: WorkflowProfileApprovalRecord[];
  /**
   * The file the profile was explicitly selected from, when it came from one (`--profile-file`).
   * Recorded so a resume can re-read the same content; the profile *hash* guard is what makes that
   * safe — tampering with this field cannot substitute different content.
   */
  profileFile?: string;
  planId?: string;
  sessionId?: string;
  pendingEffect?: WorkflowProfilePendingEffect;
  /**
   * F-7: the inputs the recorded current node was given when the run paused, so a resume can hand
   * them back. Absent for a run that was killed before any node ran (it resumes at the start node
   * with the caller's input) and for records written before this field existed.
   */
  nodeInputs?: Record<string, unknown>;
  updatedAtMs: number;
}

export interface CreateRunStateOptions {
  runId: string;
  profile: WorkflowProfileDocument;
  dependencies: ReadonlyArray<StoredDependencyPin>;
  runtimeVersion: string;
  startNodeId: string;
  /** Declared authority of this attempt; recorded so a resume can prove it never widened. */
  authority?: AuthoritySnapshot;
  /** The file this profile was explicitly selected from, when it came from one. */
  profileFile?: string;
  planId?: string;
  sessionId?: string;
  now?: number;
}

/** Hash of the exact profile bytes a run was started from. */
export function workflowProfileHash(profile: WorkflowProfileDocument): string {
  return contentDigest(canonicalJson(profile));
}

export function createWorkflowProfileRunState(options: CreateRunStateOptions): WorkflowProfileRunState {
  const now = options.now ?? Date.now();
  return {
    stateVersion: PROFILE_RUN_STATE_VERSION,
    runId: options.runId,
    profileId: options.profile.profile.id,
    ...(options.profile.profile.version ? { profileVersion: options.profile.profile.version } : {}),
    profileHash: workflowProfileHash(options.profile),
    schemaVersion: options.profile.schemaVersion,
    runtimeVersion: options.runtimeVersion,
    dependencies: options.dependencies.map((dependency) => ({ ...dependency })),
    status: 'interrupted',
    currentNodeId: options.startNodeId,
    nodeSequence: [],
    visits: 0,
    loopCounters: {},
    budget: { visits: 0, durationMs: 0, modelCalls: 0, toolCalls: 0 },
    authority: options.authority
      ? { toolIds: [...options.authority.toolIds], budget: { ...options.authority.budget }, approvalStrictness: options.authority.approvalStrictness }
      : { toolIds: [], budget: {}, approvalStrictness: 0 },
    approvals: [],
    ...(options.profileFile ? { profileFile: options.profileFile } : {}),
    ...(options.planId ? { planId: options.planId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    updatedAtMs: now,
  };
}

export interface RecordRunResultOptions {
  result: WorkflowRunResult;
  /** `ask-user` maps to a resumable pause instead of a terminal status. */
  awaitingUser?: boolean;
  nodeSequence?: ReadonlyArray<string>;
  approvals?: ReadonlyArray<WorkflowProfileApprovalRecord>;
  planId?: string;
  sessionId?: string;
  /**
   * F-13: the delegated execution reported back during this attempt, so the `pendingEffect` marker
   * is cleared in this same write — the write that also persists the progress the effect belongs
   * to. A crash before it leaves both the marker and the un-advanced progress behind, which is the
   * fail-closed pair the resume gate refuses.
   */
  effectOutcomeKnown?: boolean;
  now?: number;
}

/** Fold a finished run into its state record for the next load/resume. */
export function applyRunResultToState(
  state: WorkflowProfileRunState,
  options: RecordRunResultOptions,
): WorkflowProfileRunState {
  const now = options.now ?? Date.now();
  const { awaitingUser: _previous, ...carried } = state;
  const paused = options.awaitingUser === true;
  const { nodeInputs: _previousInputs, pendingEffect: _previousEffect, ...rest } = carried;
  const pausedInputs = paused ? options.result.resumeInputs : undefined;
  return {
    ...rest,
    // F-13: the marker survives every intermediate write; only a settle that also persists the
    // progress may drop it.
    ...(options.effectOutcomeKnown !== true && state.pendingEffect !== undefined
      ? { pendingEffect: state.pendingEffect }
      : {}),
    status: paused ? 'interrupted' : options.result.status,
    ...(paused ? { awaitingUser: true } : {}),
    // F-7: only a resumable pause keeps the pause inputs; a finished run does not need them.
    ...(pausedInputs ? { nodeInputs: { ...pausedInputs } } : {}),
    // F-15: the node the kernel stopped at, when it reported one — a limit pause before a node is
    // visited names that node, and its `nodeInputs` are that node's own mapped values. Falling
    // back to the last visited node keeps older records and terminal runs unchanged.
    currentNodeId: options.result.resumeNodeId ?? options.nodeSequence?.at(-1) ?? state.currentNodeId,
    nodeSequence: [...(options.nodeSequence ?? state.nodeSequence)],
    visits: options.result.visits,
    loopCounters: { ...options.result.loopCounters },
    budget: { ...options.result.budget },
    approvals: [...state.approvals, ...(options.approvals ?? [])],
    ...(options.planId ? { planId: options.planId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    updatedAtMs: now,
  };
}

/**
 * Append one approval decision to the run record. Audit data only: nothing reads these
 * records back as authority (a resume re-runs the approval node), so recording a stale
 * digest can never authorize work.
 */
export function appendApprovalRecord(
  state: WorkflowProfileRunState,
  approval: Omit<WorkflowProfileApprovalRecord, 'atMs'> & { atMs?: number },
  now?: number,
): WorkflowProfileRunState {
  const atMs = approval.atMs ?? now ?? Date.now();
  return {
    ...state,
    approvals: [...state.approvals, { ...approval, atMs }],
    updatedAtMs: atMs,
  };
}

/**
 * Mark that an effect is about to run. Written and flushed before the effect, so
 * a crash between the marker and its clearance is detectable as ambiguity.
 */
export function markPendingEffect(
  state: WorkflowProfileRunState,
  effect: Omit<WorkflowProfilePendingEffect, 'startedAtMs'> & { startedAtMs?: number },
): WorkflowProfileRunState {
  return {
    ...state,
    pendingEffect: { ...effect, startedAtMs: effect.startedAtMs ?? Date.now() },
    updatedAtMs: Date.now(),
  };
}

export function clearPendingEffect(state: WorkflowProfileRunState): WorkflowProfileRunState {
  const { pendingEffect: _pending, ...rest } = state;
  return { ...rest, updatedAtMs: Date.now() };
}

// ─── Store ────────────────────────────────────────────────────────

/**
 * F-4: the exclusive right to continue one stored run. A resume takes the lease before anything
 * executes; a second live process is refused (`resume.locked`), and a lease whose holder died is
 * taken over (same self-healing rule as the file locks the other stores use).
 */
export interface WorkflowProfileRunLease {
  /** Give the lease back; idempotent per handle. */
  release(): void;
}

export interface WorkflowProfileRunStateStore {
  save(state: WorkflowProfileRunState): void;
  load(runId: string): WorkflowProfileRunState | undefined;
  list(): string[];
  delete(runId: string): void;
  /**
   * Try to take the run's lease. Returns `undefined` when another live process holds it. Stores
   * that cannot be shared between processes (in-memory) always grant a no-op lease.
   */
  tryLease?(runId: string): WorkflowProfileRunLease | undefined;
}

/**
 * In-process bookkeeping for the file store's leases, so a nested prepare inside the same process
 * shares the lease instead of stealing it from itself (mirrors `heldLocks` in `file-lock.ts`).
 */
const heldRunLeases = new Map<string, number>();

function hashedFileName(id: string): string {
  return contentDigest(id).slice('sha256:'.length, 'sha256:'.length + 32) + '.json';
}

/** Crash-safe store: every write goes through the existing atomic temp+rename helper. */
export class FileWorkflowProfileRunStateStore implements WorkflowProfileRunStateStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(runId: string): string {
    return path.join(this.dir, hashedFileName(runId));
  }

  save(state: WorkflowProfileRunState): void {
    atomicWriteFileSync(this.pathFor(state.runId), JSON.stringify(state, null, 2));
  }

  load(runId: string): WorkflowProfileRunState | undefined {
    const file = this.pathFor(runId);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowProfileRunState;
    if (parsed.stateVersion !== PROFILE_RUN_STATE_VERSION) return undefined;
    return parsed;
  }

  /**
   * Every readable record, in file-name order.
   *
   * `list()` deliberately returns *file names* (the store is storage-only), so a caller that wants
   * records cannot load them back by name — the file name is a hash of the run id, not the run id.
   * A record that cannot be parsed is skipped: one corrupt file must not make a listing unusable.
   */
  loadAll(): WorkflowProfileRunState[] {
    const states: WorkflowProfileRunState[] = [];
    for (const name of this.list()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as WorkflowProfileRunState;
        if (parsed.stateVersion === PROFILE_RUN_STATE_VERSION) states.push(parsed);
      } catch {
        // Unreadable record: skipped, and the rest of the listing still works.
      }
    }
    return states;
  }

  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
  }

  delete(runId: string): void {
    const file = this.pathFor(runId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  private leasePathFor(runId: string): string {
    return `${this.pathFor(runId)}.lease`;
  }

  private leaseHandle(leasePath: string): WorkflowProfileRunLease {
    return {
      release: () => {
        const depth = heldRunLeases.get(leasePath) ?? 0;
        if (depth <= 1) {
          heldRunLeases.delete(leasePath);
          try {
            fs.unlinkSync(leasePath);
          } catch {
            // Already gone (a self-healed predecessor, or a racing release): nothing to do.
          }
          return;
        }
        heldRunLeases.set(leasePath, depth - 1);
      },
    };
  }

  /**
   * Remove a lease we judged stale WITHOUT deleting a lease another process took in the meantime.
   *
   * F-14: the simple check-then-unlink could delete a fresh lease created between the check and the
   * unlink, letting two runners hold the same run. The removal is a rename to a tombstone, and the
   * tombstone's identity (inode + contents, see `lockIdentity`) is compared with the one that was
   * judged stale; on a mismatch the fresh lease is linked back and the caller refuses. This is the
   * same trick `breakStaleLock` uses for the runtime's file locks.
   */
  private breakStaleLease(leasePath: string, staleIdentity: string | undefined): boolean {
    if (staleIdentity === undefined) return true; // already gone — just retry the open
    const tomb = `${leasePath}.${randomUUID()}.stale`;
    try {
      fs.renameSync(leasePath, tomb);
    } catch {
      return false;
    }
    if (lockIdentity(tomb) !== staleIdentity) {
      try {
        fs.linkSync(tomb, leasePath);
      } catch {
        // Someone else holds the path now — the fresh holder keeps its lease.
      }
      try {
        fs.unlinkSync(tomb);
      } catch {
        // ignore
      }
      return false;
    }
    try {
      fs.unlinkSync(tomb);
    } catch {
      // ignore
    }
    return true;
  }

  tryLease(runId: string): WorkflowProfileRunLease | undefined {
    const leasePath = this.leasePathFor(runId);
    const depth = heldRunLeases.get(leasePath);
    if (depth !== undefined) {
      // Re-entrant within this process: the same lease is shared, never duplicated on disk.
      heldRunLeases.set(leasePath, depth + 1);
      return this.leaseHandle(leasePath);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(leasePath, 'wx');
        try {
          const info: LockInfo = { pid: process.pid, acquiredAt: Date.now() };
          fs.writeSync(fd, JSON.stringify(info));
        } finally {
          fs.closeSync(fd);
        }
        heldRunLeases.set(leasePath, 1);
        return this.leaseHandle(leasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // The identity is captured BEFORE the holder is judged: it must describe the lease this
        // attempt decided was stale. Capturing it later would bless whatever lease is on disk at
        // break time — including a fresh one another process just took — as "the stale one".
        const staleIdentity = lockIdentity(leasePath);
        const holder = readLockInfo(leasePath);
        // A live holder — us in another process, or a real concurrent runner — keeps the lease.
        // Our own pid is handled above through the in-process map; reaching here with our pid means
        // a leaked file, which a fresh attempt may take over.
        if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) return undefined;
        // The holder is dead (or this is our own leaked file): break the lease by identity, so a
        // lease another process created since the read survives and the caller fails closed.
        if (!this.breakStaleLease(leasePath, staleIdentity)) return undefined;
      }
    }
    return undefined;
  }
}

export class MemoryWorkflowProfileRunStateStore implements WorkflowProfileRunStateStore {
  private readonly states = new Map<string, WorkflowProfileRunState>();

  save(state: WorkflowProfileRunState): void {
    this.states.set(state.runId, JSON.parse(JSON.stringify(state)) as WorkflowProfileRunState);
  }

  load(runId: string): WorkflowProfileRunState | undefined {
    const state = this.states.get(runId);
    return state ? (JSON.parse(JSON.stringify(state)) as WorkflowProfileRunState) : undefined;
  }

  list(): string[] {
    return [...this.states.keys()].sort();
  }

  delete(runId: string): void {
    this.states.delete(runId);
  }

  /** Single-process store: there is no other runner to exclude. */
  tryLease(): WorkflowProfileRunLease {
    return { release: () => {} };
  }
}

// ─── Verification and resume ──────────────────────────────────────

export interface ResumeExpectation {
  profile: WorkflowProfileDocument;
  dependencies: ReadonlyArray<StoredDependencyPin>;
  runtimeVersion: string;
  /** Authority the caller is about to grant; must not exceed the stored snapshot. */
  authority?: AuthoritySnapshot;
}

export interface WorkflowProfileResumeDiagnostic {
  code:
    | 'resume.profile-missing'
    | 'resume.profile-changed'
    | 'resume.schema-version-changed'
    | 'resume.runtime-version-changed'
    | 'resume.dependency-missing'
    | 'resume.dependency-changed'
    | 'resume.authority-increase'
    | 'resume.ambiguous-effect'
    | 'resume.inputs-missing'
    | 'resume.already-terminal';
  message: string;
}

export type WorkflowProfileResumeAction =
  | 'resume'
  | 'refuse-integrity'
  | 'refuse-ambiguous-effect'
  | 'refuse-missing-inputs'
  | 'already-terminal';

export interface WorkflowProfileResumeDecision {
  action: WorkflowProfileResumeAction;
  diagnostics: WorkflowProfileResumeDiagnostic[];
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['success', 'rejected', 'handoff', 'cancelled', 'failure']);

function pinOf(dependency: StoredDependencyPin): string {
  return `${dependency.kind}:${dependency.id}:${dependency.digest}`;
}

/**
 * Decide whether a stored run may continue. Integrity is checked before anything
 * else; a pending effect refuses automatic continuation regardless of integrity.
 */
export function evaluateWorkflowProfileResume(
  state: WorkflowProfileRunState | undefined,
  expectation: ResumeExpectation,
): WorkflowProfileResumeDecision {
  if (!state) {
    return { action: 'refuse-integrity', diagnostics: [{ code: 'resume.profile-missing', message: 'No stored run state for this run id' }] };
  }
  const diagnostics: WorkflowProfileResumeDiagnostic[] = [];
  if (state.profileId !== expectation.profile.profile.id) {
    diagnostics.push({ code: 'resume.profile-missing', message: `Stored run belongs to profile "${state.profileId}", not "${expectation.profile.profile.id}"` });
  }
  if (state.profileHash !== workflowProfileHash(expectation.profile)) {
    diagnostics.push({ code: 'resume.profile-changed', message: 'Profile content changed since the run started' });
  }
  if (state.schemaVersion !== expectation.profile.schemaVersion) {
    diagnostics.push({ code: 'resume.schema-version-changed', message: `Schema version changed from ${state.schemaVersion} to ${expectation.profile.schemaVersion}` });
  }
  if (state.runtimeVersion !== expectation.runtimeVersion) {
    diagnostics.push({ code: 'resume.runtime-version-changed', message: `Runtime version changed from ${state.runtimeVersion} to ${expectation.runtimeVersion}` });
  }
  const expected = new Map(expectation.dependencies.map((dependency) => [pinOf(dependency), dependency]));
  for (const stored of state.dependencies) {
    const current = expected.get(pinOf(stored));
    if (!current) {
      const sameId = expectation.dependencies.find((dependency) => dependency.kind === stored.kind && dependency.id === stored.id);
      diagnostics.push(sameId
        ? { code: 'resume.dependency-changed', message: `Dependency ${stored.kind}:${stored.id} no longer matches its pinned digest` }
        : { code: 'resume.dependency-missing', message: `Dependency ${stored.kind}:${stored.id} is no longer available` });
    }
  }
  if (diagnostics.length > 0) return { action: 'refuse-integrity', diagnostics };
  if (expectation.authority && detectAuthorityIncrease(state.authority, expectation.authority).length > 0) {
    diagnostics.push({
      code: 'resume.authority-increase',
      message: `The policy for this run is wider than the one it started with: ${detectAuthorityIncrease(state.authority, expectation.authority).join('; ')}`,
    });
  }
  if (diagnostics.length > 0) return { action: 'refuse-integrity', diagnostics };
  if (state.pendingEffect) {
    return {
      action: 'refuse-ambiguous-effect',
      diagnostics: [{
        code: 'resume.ambiguous-effect',
        message: `Node "${state.pendingEffect.nodeId}" started effect ${state.pendingEffect.attemptId} and its outcome was never committed; it is not retried automatically`,
      }],
    };
  }
  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    return { action: 'already-terminal', diagnostics: [{ code: 'resume.already-terminal', message: `Run already finished with status ${state.status}` }] };
  }
  // F-7: a pause that happened inside the graph can only continue when the inputs that node was
  // waiting on were stored; resuming it without them would fail on missing inputs. A run that was
  // killed before any node ran still sits at its start node and resumes with the caller's input.
  if (state.currentNodeId !== expectation.profile.workflow.startNode && !state.nodeInputs) {
    return {
      action: 'refuse-missing-inputs',
      diagnostics: [{
        code: 'resume.inputs-missing',
        message: `Run paused at node "${state.currentNodeId}" without recorded inputs; it cannot be resumed from that node`,
      }],
    };
  }
  return { action: 'resume', diagnostics: [] };
}
