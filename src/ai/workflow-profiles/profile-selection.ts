/**
 * Phase 8 Step 2: one selection path for every supported interface.
 *
 * `hootl run --profile <id>` and the server's `POST /api/run { profile }` must behave identically,
 * so both call this function: discovery on the documented scopes, the D-WP-003 precedence
 * (explicit > opted-in project default > built-in default), and the flag turned on **for that
 * selection only**. It never executes anything; it returns the activation options a caller passes
 * to the Orchestrator (constructor option or per-run option — the same gate either way).
 *
 * Failure is always fail-closed and always before the caller creates a session or a plan: a
 * discovery problem, an unknown id, an unreadable file, an untrusted project profile or a
 * dependency/version problem comes back as `WorkflowProfileLoadError` with diagnostics.
 */
import path from 'node:path';
import { discoverWorkflowProfiles } from './profile-discovery.js';
import { selectWorkflowProfile, WorkflowProfileLoadError } from './profile-registry.js';
import { WORKFLOW_PROFILE_FLAG_ENV_VAR } from './profile-runner.js';
import type { WorkflowProfileActivationOptions } from './profile-activation.js';

export interface WorkflowProfileSelectionRequest {
  projectRoot: string;
  /** The trust opt-in: project-scoped profiles are read only when this is true. */
  trustedProject: boolean;
  /** Explicit selection by id (highest precedence). */
  profile?: string;
  /** Explicit selection by file; a caller must have decided that reading this path is safe. */
  profileFile?: string;
}

/** The subset of the activation options a selection produces: the flag and the chosen profile. */
export type ResolvedWorkflowProfileSelection = Pick<WorkflowProfileActivationOptions, 'env' | 'selection'>;

/**
 * Resolve an explicit selection into activation options, or throw with diagnostics. The flag is
 * set in the returned `env` only — it is never written to `process.env`, so a selection cannot leak
 * into an unrelated run in the same process.
 */
export function resolveProfileSelection(
  request: WorkflowProfileSelectionRequest,
): ResolvedWorkflowProfileSelection {
  if (request.profile !== undefined && request.profileFile !== undefined) {
    throw new WorkflowProfileLoadError('profile and profileFile are mutually exclusive', [{
      stage: 'semantic', code: 'selection.conflicting-flags',
      message: 'Select one profile either by id (profile) or by file (profileFile), not both',
    }]);
  }
  const discovered = discoverWorkflowProfiles({
    projectRoot: request.projectRoot,
    projectOptIn: request.trustedProject,
    ...(request.profileFile ? { file: request.profileFile } : {}),
  });
  // A broken profile must never be silently ignored: fail before the caller starts anything.
  if (discovered.diagnostics.length > 0) {
    throw new WorkflowProfileLoadError('Workflow profile discovery found problems', [...discovered.diagnostics]);
  }
  // A file names a document, so the id comes from the discovered entry for that file.
  const fileId = request.profileFile
    ? discovered.profiles.find((entry) => path.resolve(entry.file) === path.resolve(request.profileFile!))?.profile.profile.id
    : undefined;
  if (request.profileFile && fileId === undefined) {
    throw new WorkflowProfileLoadError('The selected profile file was not registered', [{
      stage: 'read', code: 'file.not-registered',
      message: `Profile file ${path.resolve(request.profileFile)} did not register a profile`,
      file: path.resolve(request.profileFile),
    }]);
  }
  // D-WP-003: explicit selection wins; the project default only applies when the caller did not
  // name a profile and the project is trusted.
  const selection = selectWorkflowProfile(discovered.registry, {
    requestedProfileId: (request.profile ?? fileId)!,
    projectOptIn: request.trustedProject,
    ...(discovered.projectDefaultProfileId ? { projectDefaultProfileId: discovered.projectDefaultProfileId } : {}),
  });
  return {
    env: { ...process.env, [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' },
    selection: { registered: selection },
  };
}
