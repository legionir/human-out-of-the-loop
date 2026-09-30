/**
 * Phase 4 Step 5 (WP-R-006): the profile-execution feature flag and the only
 * supported way to obtain an executable profile run.
 *
 * Default is OFF. While the flag is off, no profile is validated, resolved, or
 * dispatched and every entry point keeps its legacy behaviour. Even when the flag
 * is on, a profile must pass structural validation, semantic validation, and
 * digest-pinned dependency resolution before a single handler can run — invalid or
 * unknown profiles are rejected before dispatch, never silently skipped.
 */
import {
  SUPPORTED_SCHEMA_MAJOR,
  SUPPORTED_SCHEMA_MINOR,
  validateWorkflowProfileStructure,
} from './profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from './profile-semantic-validator.js';
import { WorkflowProfileLoadError, type RegisteredWorkflowProfile } from './profile-registry.js';
import { resolveWorkflowProfileDependencies, type ResolvedWorkflowProfile, type WorkflowProfileComponentSources } from './profile-resolver.js';
import { runWorkflowProfileKernel, type WorkflowKernelOptions, type WorkflowRunResult } from './profile-kernel.js';
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
}

export interface PrepareWorkflowProfileRunOptions {
  /** Untrusted profile document (raw JSON value) or a registered profile. */
  document?: unknown;
  registered?: RegisteredWorkflowProfile;
  sources: WorkflowProfileComponentSources;
  env?: EnvSource;
  /** Runtime hard cap for node visits; the strictest applicable cap wins. */
  maxNodeVisits?: number;
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

  return Object.freeze({
    profileId: profile.profile.id,
    profile: frozen,
    resolved,
    run: (runOptions: Omit<WorkflowKernelOptions, 'profile'>) => runWorkflowProfileKernel({
      ...runOptions,
      profile: frozen as WorkflowProfileDocument,
      ...(options.maxNodeVisits !== undefined ? { maxNodeVisits: options.maxNodeVisits } : {}),
    }),
  });
}
