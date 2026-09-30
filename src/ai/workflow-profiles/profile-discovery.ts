/**
 * Phase 8 Step 1 (WP-R-008): profile discovery and authoring boundaries.
 *
 * Conventions this module owns (documented in `docs/workflow-profiles/PHASE8_AUTHORING.md`):
 *
 *   - `<projectRoot>/.hootl/workflow-profiles/*.json` — **project scope**. Never read unless the
 *     project is explicitly trusted (`projectOptIn`), exactly like the project MCP layer. A
 *     project profile is untrusted data: it cannot override a user selection, cannot widen tools
 *     or approvals, and is never executed — it is validated and then resolved like any other.
 *   - `HOOTL_WORKFLOW_PROFILES_DIR` — **user-selected scope**: a directory the operator points at
 *     explicitly (no trust needed; it is the user's own choice).
 *   - a single file passed explicitly (`--profile-file`) — **user-selected scope**, highest
 *     precedence.
 *
 * Discovery never throws on a broken file: it collects diagnostics so `profiles list` can show a
 * project's problems, while *selection* stays fail-closed (a selected profile that failed to load
 * simply is not in the registry, and selection reports `selection.profile-missing`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadWorkflowProfileFile,
  loadWorkflowProfilesFromDirectory,
  WorkflowProfileLoadError,
  WorkflowProfileRegistry,
  type RegisteredWorkflowProfile,
} from './profile-registry.js';
import type { WorkflowProfileDiagnostic } from './profile-types.js';

/** Environment variable an operator can point at their own profile directory. */
export const WORKFLOW_PROFILE_DIR_ENV_VAR = 'HOOTL_WORKFLOW_PROFILES_DIR';
/** Project-relative directory searched for project profiles (project scope, opt-in required). */
export const PROJECT_WORKFLOW_PROFILE_DIR = path.join('.hootl', 'workflow-profiles');

export interface WorkflowProfileDiscoveryOptions {
  projectRoot: string;
  /** Explicit directory (user-selected scope); missing directories are reported, not fatal. */
  directory?: string;
  /** Explicit file (user-selected scope); a missing file is a diagnostic. */
  file?: string;
  /** Project profiles are read only when this is true (the trust opt-in). */
  projectOptIn?: boolean;
  /** Overrides the environment lookup for the user-scope directory (tests). */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface WorkflowProfileDiscoveryResult {
  readonly registry: WorkflowProfileRegistry;
  /** Every profile that loaded, sorted by id. */
  readonly profiles: ReadonlyArray<RegisteredWorkflowProfile>;
  /** Files that could not be read/validated, with their diagnostics. */
  readonly diagnostics: ReadonlyArray<WorkflowProfileDiagnostic>;
  /** The project directory that was inspected (whether or not it exists). */
  readonly projectDirectory: string;
  /** The directory/profile ids of each scope that was actually read. */
  readonly sources: ReadonlyArray<{ scope: RegisteredWorkflowProfile['scope']; directory: string; present: boolean }>;
  /**
   * The only project-scoped profile id, when the opted-in project declares exactly one: that is
   * the project default of the documented precedence order. `undefined` when the project has none
   * or more than one (the caller must then select explicitly).
   */
  readonly projectDefaultProfileId?: string;
}

function diagnosticsOf(error: unknown, file: string): WorkflowProfileDiagnostic[] {
  if (error instanceof WorkflowProfileLoadError) return [...error.diagnostics];
  return [{ stage: 'read', code: 'file.load-failed', message: error instanceof Error ? error.message : String(error), file }];
}

/** True when `directory` exists and is a real directory (no symlink following). */
function directoryPresent(directory: string): boolean {
  try {
    return fs.lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover the profiles available to one project without executing anything.
 *
 * Precedence is *not* decided here — `selectWorkflowProfile` owns it (explicit user selection,
 * then the opted-in project profile, then the built-in default). Discovery only reports what
 * exists and what broke.
 */
export function discoverWorkflowProfiles(options: WorkflowProfileDiscoveryOptions): WorkflowProfileDiscoveryResult {
  const projectRoot = path.resolve(options.projectRoot);
  const env = options.env ?? process.env;
  const projectDirectory = path.join(projectRoot, PROJECT_WORKFLOW_PROFILE_DIR);
  const userDirectory = options.directory ?? env[WORKFLOW_PROFILE_DIR_ENV_VAR];
  const registry = new WorkflowProfileRegistry({ projectOptIn: options.projectOptIn === true });
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  const sources: Array<{ scope: RegisteredWorkflowProfile['scope']; directory: string; present: boolean }> = [];

  const loadDirectory = (directory: string, scope: 'project' | 'user-selected', present: boolean): void => {
    sources.push({ scope, directory, present });
    if (!present) return;
    try {
      const discovered = loadWorkflowProfilesFromDirectory({
        directory,
        scope,
        ...(scope === 'project' ? { projectOptIn: options.projectOptIn === true } : {}),
      });
      for (const entry of discovered.list()) registry.register(entry);
    } catch (error) {
      diagnostics.push(...diagnosticsOf(error, directory));
    }
  };

  loadDirectory(projectDirectory, 'project', options.projectOptIn === true && directoryPresent(projectDirectory));
  if (userDirectory) loadDirectory(path.resolve(userDirectory), 'user-selected', directoryPresent(path.resolve(userDirectory)));

  if (options.file) {
    const file = path.resolve(options.file);
    // An explicitly named file must exist: this is the user's own selection, not an optional layer.
    if (!fs.existsSync(file)) {
      diagnostics.push({ stage: 'read', code: 'file.missing', message: `Workflow profile file does not exist: ${file}`, file });
    } else {
      try {
        registry.register(loadWorkflowProfileFile(file, 'user-selected'));
      } catch (error) {
        diagnostics.push(...diagnosticsOf(error, file));
      }
    }
  }

  const profiles = Object.freeze([...registry.list()].sort((left, right) => left.profile.profile.id.localeCompare(right.profile.profile.id)));
  const projectProfiles = profiles.filter((entry) => entry.scope === 'project');
  return Object.freeze({
    registry,
    profiles,
    diagnostics: Object.freeze([...diagnostics]),
    projectDirectory,
    sources: Object.freeze(sources),
    ...(projectProfiles.length === 1 ? { projectDefaultProfileId: projectProfiles[0]!.profile.profile.id } : {}),
  });
}
