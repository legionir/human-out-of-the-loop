/**
 * Phase 7 Step 2 (WP-R-008): the single activation seam between the Orchestrator and
 * Workflow Profile execution.
 *
 * Guarantees this module owns:
 *  - **Flag off ⇒ legacy, and nothing profile-related resolves.** The decision is made
 *    before any component lookup, schema check or dependency resolution; the Orchestrator
 *    simply continues on its existing path (no throw, no fallback bookkeeping).
 *  - **Flag on ⇒ the profile path, fail closed.** Nothing selected fails; a selected
 *    profile that does not validate/resolve fails with its diagnostics; an unapproved
 *    built-in default fails. There is no silent fallback to legacy and no half-run: the
 *    caller either gets a prepared run or an error.
 *  - **The built-in default needs recorded approval.** D-WP-003 makes the default the last
 *    scope in the precedence order, and Phase 7 Step 3 requires parity tests, release notes
 *    and an explicit owner approval before it may be activated. Until that approval is
 *    recorded, activating it implicitly fails closed.
 */
import { createDefaultWorkflowProfileDocument, DEFAULT_WORKFLOW_PROFILE_ID } from './default-profile.js';
import { WorkflowProfileLoadError, type RegisteredWorkflowProfile } from './profile-registry.js';
import {
  isWorkflowProfileExecutionEnabled,
  prepareWorkflowProfileRun,
  WORKFLOW_PROFILE_FLAG_ENV_VAR,
  type EnvSource,
  type PreparedWorkflowProfileRun,
  type PrepareWorkflowProfileRunOptions,
} from './profile-runner.js';
import type { WorkflowProfileComponentSources } from './profile-resolver.js';

/** Recorded approval of the built-in default profile. */
export interface BuiltInDefaultApproval {
  readonly approved: boolean;
  /** Where the approval is recorded (plan section, PR, release note). */
  readonly reference: string;
}

/**
 * The recorded state of the built-in-default gate. Phase 7 Step 3's parity evidence and the
 * owner's approval are not recorded yet, so implicit activation of the default profile must
 * fail closed. Flipping this constant is a recorded, reviewable change that must land
 * together with the parity evidence, the release notes and the owner approval.
 */
export const BUILT_IN_DEFAULT_APPROVAL: BuiltInDefaultApproval = Object.freeze({
  approved: false,
  reference: 'Phase 7 Step 3 parity gate: owner approval not recorded yet',
});

export interface WorkflowProfileActivationOptions
  extends Omit<PrepareWorkflowProfileRunOptions, 'document' | 'registered' | 'sources' | 'env'> {
  env?: EnvSource;
  /** Registries the profile's dependencies must resolve against. */
  sources: WorkflowProfileComponentSources;
  /**
   * Explicit user/operator selection. D-WP-003: an explicit selection always wins over the
   * opted-in project profile and the built-in default.
   */
  selection?: { document?: unknown; registered?: RegisteredWorkflowProfile };
  /** Set by the caller when nothing was selected and the built-in default may be used. */
  allowBuiltInDefault?: boolean;
  /** Recorded approval; defaults to {@link BUILT_IN_DEFAULT_APPROVAL}. */
  builtInDefaultApproval?: BuiltInDefaultApproval;
}

export type WorkflowProfileActivation =
  | { readonly kind: 'legacy'; readonly reason: 'flag-disabled' }
  | { readonly kind: 'profile'; readonly profileId: string; readonly prepared: PreparedWorkflowProfileRun };

function activationError(code: string, message: string, profileId?: string): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError(message, [{
    stage: 'read',
    code,
    message,
    ...(profileId ? { profileId } : {}),
  }]);
}

/**
 * Decide whether this process runs the workflow-profile path and, when it does, prepare the
 * single active profile for the run. Never returns `legacy` once the flag is on.
 */
export function activateWorkflowProfile(
  options: WorkflowProfileActivationOptions,
): WorkflowProfileActivation {
  const env = options.env ?? process.env;
  if (!isWorkflowProfileExecutionEnabled(env)) {
    return { kind: 'legacy', reason: 'flag-disabled' };
  }

  const { env: _env, sources, selection, allowBuiltInDefault, builtInDefaultApproval, ...runOptions } = options;
  if (selection && (selection.document !== undefined || selection.registered !== undefined)) {
    const prepared = prepareWorkflowProfileRun({ ...runOptions, sources, env, ...selection });
    return { kind: 'profile', profileId: prepared.profileId, prepared };
  }

  if (allowBuiltInDefault !== true) {
    throw activationError(
      'profile-activation.not-selected',
      `Workflow Profile execution is enabled (${WORKFLOW_PROFILE_FLAG_ENV_VAR}) but no profile was selected and the built-in default was not opted into`,
    );
  }

  const approval = builtInDefaultApproval ?? BUILT_IN_DEFAULT_APPROVAL;
  if (approval.approved !== true) {
    throw activationError(
      'profile-activation.not-approved',
      `The built-in default profile "${DEFAULT_WORKFLOW_PROFILE_ID}" is not approved for activation yet (${approval.reference})`,
      DEFAULT_WORKFLOW_PROFILE_ID,
    );
  }

  // Built from the same sources the resolver will use, so the pins are the content's digests;
  // a missing pin source fails closed instead of producing a placeholder pin.
  const document = createDefaultWorkflowProfileDocument(sources);
  const prepared = prepareWorkflowProfileRun({ ...runOptions, sources, env, document });
  return { kind: 'profile', profileId: prepared.profileId, prepared };
}
