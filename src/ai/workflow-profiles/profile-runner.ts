/**
 * Phase 4 Step 5 / Phase 6 (WP-R-006, WP-R-007): the profile-execution feature
 * flag and the only supported way to obtain an executable profile run.
 *
 * Default is OFF. While the flag is off, no profile is validated, resolved, or
 * dispatched and every entry point keeps its legacy behaviour. Even when the flag
 * is on, a profile must pass structural validation, semantic validation, and
 * digest-pinned dependency resolution before a single handler can run — invalid or
 * unknown profiles are rejected before dispatch, never silently skipped.
 *
 * Phase 6 adds the durable layer: when a state store and run id are supplied the
 * run is written before it starts and after it ends (through the existing atomic
 * write helper), a stored run is re-verified against the live profile,
 * dependencies, and runtime before continuing, and a run that was interrupted
 * with an effect in flight is refused rather than retried automatically.
 */
import { randomUUID } from 'node:crypto';
import {
  SUPPORTED_SCHEMA_MAJOR,
  SUPPORTED_SCHEMA_MINOR,
  validateWorkflowProfileStructure,
} from './profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from './profile-semantic-validator.js';
import { WorkflowProfileLoadError, type RegisteredWorkflowProfile } from './profile-registry.js';
import { resolveWorkflowProfileDependencies, type ResolvedWorkflowProfile, type WorkflowProfileComponentSources } from './profile-resolver.js';
import { runWorkflowProfileKernel, type WorkflowKernelOptions, type WorkflowRunResult } from './profile-kernel.js';
import { effectiveWorkflowBudget, type WorkflowBudgetLimits } from './profile-budget.js';
import { narrowAccessPolicy, type AuthoritySnapshot } from './profile-access-guard.js';
import { createWorkflowProfileEventEmitter, type EventSinkLike, type WorkflowProfileEventEmitter } from './profile-events.js';
import {
  appendApprovalRecord,
  applyRunResultToState,
  clearPendingEffect,
  createWorkflowProfileRunState,
  evaluateWorkflowProfileResume,
  markPendingEffect,
  storedDependencyPins,
  type WorkflowProfileRunState,
  type WorkflowProfileApprovalRecord,
  type WorkflowProfileRunStateStore,
} from './profile-run-state.js';
import type { WorkflowProfileDocument } from './profile-types.js';

/** Environment variable that opts a process into Workflow Profile execution. */
export const WORKFLOW_PROFILE_FLAG_ENV_VAR = 'HOOTL_WORKFLOW_PROFILE';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Strict opt-in: only `1` or `true` (case-insensitive) enable profile execution. */
export function isWorkflowProfileExecutionEnabled(env: EnvSource = process.env): boolean {
  return /^(1|true)$/i.test(env[WORKFLOW_PROFILE_FLAG_ENV_VAR] ?? '');
}

export function workflowProfileFlagDisabledError(): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError('Workflow Profile execution is disabled', [{
    stage: 'read',
    code: 'profile-flag.disabled',
    message: `Workflow Profile execution requires an explicit opt-in (${WORKFLOW_PROFILE_FLAG_ENV_VAR}=1); legacy behaviour is unchanged while it is off`,
  }]);
}

export interface PreparedWorkflowProfileRun {
  readonly profileId: string;
  readonly profile: Readonly<WorkflowProfileDocument>;
  readonly resolved: ResolvedWorkflowProfile;
  /** Run the kernel with the caller-supplied handlers. */
  run(options: Omit<WorkflowKernelOptions, 'profile'>): Promise<WorkflowRunResult>;
  /** The persisted state record of this run, when a state store is configured. */
  runState(): WorkflowProfileRunState | undefined;
  /** Events emitted by this run (mapped kernel events plus lifecycle records). */
  readonly events: WorkflowProfileEventEmitter;
  /**
   * Record one approval decision (node, status, bound digest) in the run state, when a
   * state store is configured. Audit data: a resumed attempt re-runs the approval node
   * and re-asks the user, so these records are never authority.
   */
  recordApproval(approval: Omit<WorkflowProfileApprovalRecord, 'atMs'> & { atMs?: number }): void;
  /**
   * Mark that a side effect is about to run. The marker is persisted BEFORE the
   * effect, so an interruption between the effect and its commit is detected on
   * the next load and refuses an automatic retry.
   */
  recordEffectStart(nodeId: string, intent: string): string;
  /** Clear the marker once the effect is known to have committed. */
  recordEffectCommitted(): void;
}

export interface PrepareWorkflowProfileRunOptions {
  /** Untrusted profile document (raw JSON value) or a registered profile. */
  document?: unknown;
  registered?: RegisteredWorkflowProfile;
  sources: WorkflowProfileComponentSources;
  env?: EnvSource;
  /** Runtime hard cap for node visits; the strictest applicable cap wins. */
  maxNodeVisits?: number;
  /** Identifies the runtime that will execute the run; a resume must match it. */
  runtimeVersion?: string;
  runId?: string;
  planId?: string;
  sessionId?: string;
  /**
   * Durable run state. Omitted ⇒ the run keeps its state in memory only (the Orchestrator supplies
   * a file-backed store for real runs); `null` explicitly means the same thing, which lets a caller
   * with a defaulted store opt out (`OrchestratorWorkflowProfileOptions.stateStore: null`).
   */
  stateStore?: WorkflowProfileRunStateStore | null;
  eventSink?: EventSinkLike;
  onDegraded?: (error: unknown) => void;
  secrets?: ReadonlyArray<string>;
  /** Runtime-permitted tool ids; the profile declaration is intersected with them. */
  runtimeToolIds?: ReadonlyArray<string>;
  /** Runtime layer of the per-dimension budget. */
  budget?: WorkflowBudgetLimits;
  /** User/session layer of the per-dimension budget. */
  sessionBudget?: WorkflowBudgetLimits;
  now?: () => number;
}

function schemaVersionDiagnostic(value: unknown): boolean {
  const version = value && typeof value === 'object' ? (value as Record<string, unknown>).schemaVersion : undefined;
  const match = typeof version === 'string' ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version) : null;
  return Boolean(match) && Number(match![1]) === SUPPORTED_SCHEMA_MAJOR && Number(match![2]) === SUPPORTED_SCHEMA_MINOR;
}

/**
 * Validate, resolve, and freeze one profile for execution. Throws
 * `WorkflowProfileLoadError` when the flag is off or the profile cannot be
 * activated; nothing is dispatched in that case.
 */
export function prepareWorkflowProfileRun(options: PrepareWorkflowProfileRunOptions): PreparedWorkflowProfileRun {
  if (!isWorkflowProfileExecutionEnabled(options.env ?? process.env)) throw workflowProfileFlagDisabledError();

  const document = options.registered?.profile ?? options.document;
  if (document === undefined) {
    throw new WorkflowProfileLoadError('No workflow profile was supplied', [{
      stage: 'read', code: 'profile.missing', message: 'prepareWorkflowProfileRun requires a document or a registered profile',
    }]);
  }
  if (!schemaVersionDiagnostic(document)) {
    throw new WorkflowProfileLoadError('Unsupported workflow profile schema version', [{
      stage: 'schema-version', code: 'schema-version.unsupported',
      message: `Supported contract is ${SUPPORTED_SCHEMA_MAJOR}.${SUPPORTED_SCHEMA_MINOR}.x`, path: '/schemaVersion',
    }]);
  }
  const structural = validateWorkflowProfileStructure(document);
  if (structural.length > 0) throw new WorkflowProfileLoadError('Structurally invalid workflow profile', structural);

  const profile = document as WorkflowProfileDocument;
  const semantic = validateWorkflowProfileSemantics(profile);
  if (semantic.length > 0) throw new WorkflowProfileLoadError('Semantically invalid workflow profile', semantic);

  const resolved = resolveWorkflowProfileDependencies(profile, options.sources);
  const frozen = Object.freeze(profile) as Readonly<WorkflowProfileDocument>;
  const now = options.now ?? (() => Date.now());
  // Phase 10 (U-2): a durable run needs an id that does not collide with the previous run of the
  // same profile, because a stored record means "resume this attempt". Without a store the id stays
  // the stable, human-readable one callers (and tests) already expect.
  const runId = options.runId ?? (options.stateStore
    ? `run-${frozen.profile.id}-${randomUUID()}`
    : `run-${frozen.profile.id}`);
  const events = createWorkflowProfileEventEmitter({
    runId,
    ...(options.eventSink ? { sink: options.eventSink } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.onDegraded ? { onDegraded: options.onDegraded } : {}),
    now,
  });
  const declaredAuthority: AuthoritySnapshot = (() => {
    // The profile's tool surface is the *content* of its pinned personas and
    // toolsets, never the raw ids: an empty declaration means the profile adds no
    // narrowing (it cannot mean "permit nothing", which would deny every tool).
    const declaredToolIds = new Set<string>();
    for (const dependency of resolved.dependencies) {
      const declared = dependency.kind === 'toolset'
        ? (dependency.content as { tools?: unknown }).tools
        : dependency.kind === 'persona'
          ? (dependency.content as { allowedTools?: unknown }).allowedTools
          : undefined;
      if (Array.isArray(declared)) for (const tool of declared) if (typeof tool === 'string') declaredToolIds.add(tool);
    }
    const approvalPolicy = (profile.policies as { approvals?: { policy?: string } } | undefined)?.approvals?.policy;
    const policy = narrowAccessPolicy([
      {
        ...(declaredToolIds.size > 0 ? { toolIds: [...declaredToolIds] } : {}),
        budget: (profile.policies as { execution?: WorkflowBudgetLimits } | undefined)?.execution,
      },
      options.runtimeToolIds ? { toolIds: options.runtimeToolIds } : undefined,
      { budget: options.budget },
      { budget: options.sessionBudget, approvalPolicy },
    ]);
    return { toolIds: policy.toolIds, budget: policy.budget, approvalStrictness: policy.approvalStrictness };
  })();
  const dependencies = storedDependencyPins(resolved.dependencies);
  const runtimeVersion = options.runtimeVersion ?? 'unversioned';
  let state: WorkflowProfileRunState | undefined = options.stateStore ? options.stateStore.load(runId) : undefined;
  /** A record that already existed means this attempt is a resume, not a first run. */
  const resumingStoredRun = state !== undefined;
  // F-4: resuming a stored attempt takes an exclusive run lease before anything executes, so two
  // live processes cannot continue the same run (a lease whose holder died is taken over by the
  // store). The lease is released when the attempt settles; a caller that prepares without ever
  // running leaves it to the process, and the next resume takes it over.
  const lease = resumingStoredRun ? options.stateStore?.tryLease?.(runId) : undefined;
  if (resumingStoredRun && options.stateStore?.tryLease && !lease) {
    throw new WorkflowProfileLoadError(`Workflow Profile run "${runId}" is being resumed by another live process`, [{
      stage: 'read', code: 'resume.locked', profileId: profile.profile.id,
      message: 'Another process holds this run\'s lease; wait for it to finish (or release it) before resuming',
    }]);
  }
  let started = false;

  const persist = (next: WorkflowProfileRunState): void => {
    state = next;
    if (!options.stateStore) return;
    try {
      options.stateStore.save(next);
    } catch (error) {
      // Fail closed: the caller must not be able to treat an unwritten state as
      // committed. Observability records the degradation before the throw.
      events.emit({ type: 'workflow.persistence.degraded', runId, atMs: now(), code: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  };

  if (options.stateStore && !state) {
    // Written before anything can run or touch an effect, so an interrupted
    // process is always visible as an interrupted run.
    persist(createWorkflowProfileRunState({
      runId,
      profile: frozen as WorkflowProfileDocument,
      dependencies,
      runtimeVersion,
      startNodeId: profile.workflow.startNode,
      authority: declaredAuthority,
      ...(options.registered?.file ? { profileFile: options.registered.file } : {}),
      ...(options.planId ? { planId: options.planId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      now: now(),
    }));
  }

  return Object.freeze({
    profileId: profile.profile.id,
    profile: frozen,
    resolved,
    events,
    runState: () => (state ? (JSON.parse(JSON.stringify(state)) as WorkflowProfileRunState) : undefined),
    run: async (runOptions: Omit<WorkflowKernelOptions, 'profile'>) => {
      if (started) {
        // One prepared run object executes at most once; a retry is always a new
        // prepare, so a terminal or in-flight attempt can never be silently reused.
        throw new WorkflowProfileLoadError(`Workflow Profile run "${runId}" cannot resume (already-terminal: this run object already executed)`, [{
          stage: 'semantic', code: 'resume.already-terminal', message: 'This prepared run already executed once', profileId: profile.profile.id,
        }]);
      }
      started = true;
      try {
        let resumeFrom: WorkflowProfileRunState | undefined;
        if (options.stateStore) {
          if (resumingStoredRun) {
            const decision = evaluateWorkflowProfileResume(state!, {
              profile: frozen as WorkflowProfileDocument,
              dependencies,
              runtimeVersion,
              authority: declaredAuthority,
            });
            if (decision.action !== 'resume') {
              for (const diagnostic of decision.diagnostics) {
                events.emit({ type: 'workflow.run.resume-refused', runId, atMs: now(), code: diagnostic.code, status: decision.action });
              }
              const reasons = decision.diagnostics.map((diagnostic) => diagnostic.code).join(', ');
              throw new WorkflowProfileLoadError(`Workflow Profile run "${runId}" cannot resume (${decision.action}: ${reasons})`, decision.diagnostics.map((diagnostic) => ({
                stage: 'semantic' as const,
                code: diagnostic.code,
                message: diagnostic.message,
                profileId: profile.profile.id,
              })));
            }
            resumeFrom = state;
          }
        }

        const resuming = resumeFrom !== undefined;
        const runProfile = resuming
          ? ({ ...frozen, workflow: { ...frozen.workflow, startNode: resumeFrom!.currentNodeId } } as WorkflowProfileDocument)
          : (frozen as WorkflowProfileDocument);

        const { onEvent: callerOnEvent, ...kernelOptions } = runOptions;
        let result: WorkflowRunResult;
      try {
          result = await runWorkflowProfileKernel({
            ...kernelOptions,
            profile: runProfile,
            onEvent: (event) => {
              events.emitKernelEvent(event);
              callerOnEvent?.(event);
            },
            // F-7: the paused node continues with the inputs it was waiting on, not the caller's
          // entry payload (which belongs to the start node).
          ...(resuming && resumeFrom!.nodeInputs ? { input: resumeFrom!.nodeInputs } : {}),
          ...(resuming ? { usage: resumeFrom!.budget, loopCounters: resumeFrom!.loopCounters, visitCount: resumeFrom!.visits } : {}),
            ...(options.maxNodeVisits !== undefined ? { maxNodeVisits: options.maxNodeVisits } : {}),
            ...(options.budget ? { budget: options.budget } : {}),
            ...(options.sessionBudget ? { sessionBudget: options.sessionBudget } : {}),
            now,
          });
        } catch (error) {
          // The kernel does not throw for run outcomes; a throw here is a defect.
          events.emit({ type: 'workflow.run.end', runId, atMs: now(), status: 'kernel-error', code: error instanceof Error ? error.name : 'unknown' });
          throw error;
        }

        if (options.stateStore && state) {
          persist(applyRunResultToState(state, {
            result,
            awaitingUser: result.limit === 'ask-user',
            nodeSequence: result.nodeSequence,
            ...(options.planId ? { planId: options.planId } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            now: now(),
          }));
        }
        return result;
      } finally {
          lease?.release();
        }
    },
    recordApproval: (approval: Omit<WorkflowProfileApprovalRecord, 'atMs'> & { atMs?: number }): void => {
      if (!state || !options.stateStore) return;
      persist(appendApprovalRecord(state, approval, now()));
    },
    recordEffectStart: (nodeId: string, intent: string): string => {
      const attemptId = `effect-${now()}-${Math.trunc(Math.random() * 1e6)}`;
      if (!state || !options.stateStore) return attemptId;
      persist(markPendingEffect(state, { nodeId, attemptId, intent, startedAtMs: now() }));
      return attemptId;
    },
    recordEffectCommitted: (): void => {
      if (!state || !options.stateStore) return;
      persist(clearPendingEffect(state));
    },
  });
}

