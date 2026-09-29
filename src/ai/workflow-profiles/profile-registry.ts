import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_SCHEMA_MAJOR, SUPPORTED_SCHEMA_MINOR, validateWorkflowProfileJson, validateWorkflowProfileStructure } from './profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from './profile-semantic-validator.js';
import type {
  WorkflowProfileDiagnostic,
  WorkflowProfileDocument,
  WorkflowProfileScope,
} from './profile-types.js';

export const MAX_WORKFLOW_PROFILE_BYTES = 1_048_576;

const WORKFLOW_PROFILE_SCOPES: ReadonlySet<string> = new Set(['builtin', 'project', 'user-selected']);

function assertWorkflowProfileScope(scope: unknown, file?: string): asserts scope is WorkflowProfileScope {
  if (typeof scope === 'string' && WORKFLOW_PROFILE_SCOPES.has(scope)) return;
  const message = `Invalid workflow profile scope ${JSON.stringify(scope)}; expected builtin, project, or user-selected`;
  throw new WorkflowProfileLoadError(message, [{
    stage: 'read', code: 'scope.invalid', message, file,
  }]);
}

export interface RegisteredWorkflowProfile {
  readonly profile: Readonly<WorkflowProfileDocument>;
  readonly scope: WorkflowProfileScope;
  readonly file: string;
}

export class WorkflowProfileLoadError extends Error {
  constructor(message: string, public readonly diagnostics: WorkflowProfileDiagnostic[]) {
    super(message);
    this.name = 'WorkflowProfileLoadError';
  }
}

export class WorkflowProfileRegistry {
  private readonly byId = new Map<string, RegisteredWorkflowProfile>();

  register(entry: RegisteredWorkflowProfile): void {
    assertWorkflowProfileScope((entry as { scope?: unknown }).scope, typeof entry?.file === 'string' ? entry.file : undefined);
    const id = entry.profile.profile.id;
    const structuralDiagnostics = validateWorkflowProfileStructure(entry.profile).map((diagnostic) => ({ ...diagnostic, file: entry.file }));
    if (structuralDiagnostics.length) {
      throw new WorkflowProfileLoadError(`Structurally invalid workflow profile "${entry.file}"`, structuralDiagnostics);
    }
    const version = entry.profile.schemaVersion;
    const match = typeof version === 'string' ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version) : null;
    if (!match || Number(match[1]) !== SUPPORTED_SCHEMA_MAJOR || Number(match[2]) !== SUPPORTED_SCHEMA_MINOR) {
      throw new WorkflowProfileLoadError(`Unsupported workflow profile schema version ${JSON.stringify(version)}`, [{
        stage: 'schema-version', code: 'schema-version.unsupported',
        message: `Supported contract is ${SUPPORTED_SCHEMA_MAJOR}.${SUPPORTED_SCHEMA_MINOR}.x`,
        profileId: id, file: entry.file, path: '/schemaVersion',
      }]);
    }
    const semanticDiagnostics = validateWorkflowProfileSemantics(entry.profile).map((diagnostic) => ({ ...diagnostic, file: entry.file }));
    if (semanticDiagnostics.length) {
      throw new WorkflowProfileLoadError(`Semantically invalid workflow profile "${entry.file}"`, semanticDiagnostics);
    }
    if (this.byId.has(id)) {
      throw new WorkflowProfileLoadError(`Duplicate workflow profile id "${id}"`, [{
        stage: 'semantic', code: 'registry.duplicate-id', message: `Duplicate workflow profile id "${id}"`,
        profileId: id, file: entry.file, path: '/profile/id',
      }]);
    }
    const immutableProfile = deepFreeze(structuredClone(entry.profile));
    this.byId.set(id, Object.freeze({ ...entry, profile: immutableProfile }));
  }

  get(id: string): RegisteredWorkflowProfile | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  list(): ReadonlyArray<RegisteredWorkflowProfile> { return Object.freeze(Array.from(this.byId.values())); }
  get size(): number { return this.byId.size; }
}

export interface WorkflowProfileDirectoryOptions {
  /** The root is supplied by the caller; this module intentionally invents no project path convention. */
  directory: string;
  scope: WorkflowProfileScope;
  /** Project profile files are not read unless the caller passes an explicit opt-in. */
  projectOptIn?: boolean;
}

function sameFileObject(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function changedDuringOpen(file: string): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError(`Workflow profile path changed while being opened: ${file}`, [{
    stage: 'read', code: 'file.changed-during-open', message: 'Profile path must continue to identify the same regular file that was checked before opening', file,
  }]);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Read no more than the approved cap plus one byte, even if the file changes after stat(). */
export function readWorkflowProfileUtf8(file: string): string {
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(file);
  } catch (error) {
    throw new WorkflowProfileLoadError(`Cannot access workflow profile "${file}": ${error instanceof Error ? error.message : String(error)}`, [{
      stage: 'read', code: 'file.unreadable', message: error instanceof Error ? error.message : String(error), file,
    }]);
  }
  if (!linkStat.isFile()) throw new WorkflowProfileLoadError(`Workflow profile is not a regular file: ${file}`, [{
    stage: 'read', code: 'file.not-regular', message: 'Profile path must be a regular file, not a symlink or directory', file,
  }]);

  let fd: number;
  try {
    // O_NOFOLLOW closes the lstat/open symlink race where supported. The
    // before/after identity checks below also reject replacement races on
    // platforms where the flag is unavailable.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, flags);
  } catch (error) {
    throw new WorkflowProfileLoadError(`Cannot open workflow profile "${file}": ${error instanceof Error ? error.message : String(error)}`, [{
      stage: 'read', code: 'file.unreadable', message: `Cannot open profile file: ${error instanceof Error ? error.message : String(error)}`, file,
    }]);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new WorkflowProfileLoadError(`Workflow profile is not a regular file: ${file}`, [{
      stage: 'read', code: 'file.not-regular', message: 'Profile path must be a regular file', file,
    }]);
    let currentPathStat: fs.Stats;
    try {
      currentPathStat = fs.lstatSync(file);
    } catch {
      throw changedDuringOpen(file);
    }
    if (!sameFileObject(linkStat, stat) || !sameFileObject(stat, currentPathStat)) throw changedDuringOpen(file);
    if (stat.size > MAX_WORKFLOW_PROFILE_BYTES) throw tooLarge(file, stat.size);

    const buffer = Buffer.allocUnsafe(MAX_WORKFLOW_PROFILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_WORKFLOW_PROFILE_BYTES) throw tooLarge(file, length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch (error) {
      throw new WorkflowProfileLoadError(`Profile is not valid UTF-8: ${file}`, [{
        stage: 'utf8', code: 'utf8.invalid', message: error instanceof Error ? error.message : 'Invalid UTF-8 byte sequence', file,
      }]);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function tooLarge(file: string, actualBytes: number): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError(`Workflow profile exceeds the ${MAX_WORKFLOW_PROFILE_BYTES}-byte limit (${actualBytes} bytes): ${file}`, [{
    stage: 'read', code: 'file.too-large', message: `Profile is ${actualBytes} UTF-8 bytes; maximum is ${MAX_WORKFLOW_PROFILE_BYTES}`, file, path: '/',
  }]);
}

export function loadWorkflowProfileFile(file: string, scope: WorkflowProfileScope): RegisteredWorkflowProfile {
  assertWorkflowProfileScope(scope, file);
  const text = readWorkflowProfileUtf8(file);
  const structural = validateWorkflowProfileJson(text, file);
  if (!structural.ok || !structural.profile) throw new WorkflowProfileLoadError(`Invalid workflow profile "${file}"`, structural.diagnostics);
  const semanticDiagnostics = validateWorkflowProfileSemantics(structural.profile).map((diagnostic) => ({ ...diagnostic, file }));
  if (semanticDiagnostics.length) throw new WorkflowProfileLoadError(`Semantically invalid workflow profile "${file}"`, semanticDiagnostics);
  return Object.freeze({ profile: deepFreeze(structural.profile), scope, file });
}

/**
 * Discover JSON files only under an explicit caller-supplied directory. The
 * project scope is fail-closed unless projectOptIn=true. A single bad file
 * rejects the whole directory so callers can never accidentally use a partial
 * or ambiguous profile set.
 */
export function loadWorkflowProfilesFromDirectory(options: WorkflowProfileDirectoryOptions): WorkflowProfileRegistry {
  const { directory, scope, projectOptIn = false } = options;
  assertWorkflowProfileScope(scope, directory);
  if (scope === 'project' && projectOptIn !== true) {
    throw new WorkflowProfileLoadError('Project workflow profiles require explicit opt-in before discovery', [{
      stage: 'read', code: 'project-profile.opt-in-required', message: 'Project profile directory was not read because explicit opt-in is required', file: directory,
    }]);
  }
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (error) {
    throw new WorkflowProfileLoadError(`Cannot access workflow profile directory "${directory}": ${error instanceof Error ? error.message : String(error)}`, [{
      stage: 'read', code: 'directory.unavailable', message: error instanceof Error ? error.message : String(error), file: directory,
    }]);
  }
  if (!directoryStat.isDirectory()) throw new WorkflowProfileLoadError(`Workflow profile path is not a directory: ${directory}`, [{
    stage: 'read', code: 'directory.not-directory', message: 'Profile discovery root must be a real directory, not a file or symlink', file: directory,
  }]);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new WorkflowProfileLoadError(`Cannot read workflow profile directory "${directory}": ${error instanceof Error ? error.message : String(error)}`, [{
      stage: 'read', code: 'directory.unreadable', message: error instanceof Error ? error.message : String(error), file: directory,
    }]);
  }

  const jsonEntries = entries.filter((entry) => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  const registry = new WorkflowProfileRegistry();
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  for (const entry of jsonEntries) {
    const file = path.join(directory, entry.name);
    if (!entry.isFile()) {
      diagnostics.push({ stage: 'read', code: 'file.not-regular', message: 'Discovered .json profile entry must be a regular file; symlinks and nested directories are not followed', file });
      continue;
    }
    try {
      registry.register(loadWorkflowProfileFile(file, scope));
    } catch (error) {
      diagnostics.push(...(error instanceof WorkflowProfileLoadError ? error.diagnostics : [{ stage: 'read' as const, code: 'file.load-failed', message: error instanceof Error ? error.message : String(error), file }]));
    }
  }
  if (diagnostics.length) throw new WorkflowProfileLoadError(`Workflow profile discovery failed with ${diagnostics.length} diagnostic(s)`, diagnostics);
  return registry;
}

export interface WorkflowProfileSelectionOptions {
  requestedProfileId?: string;
  projectOptIn?: boolean;
  projectDefaultProfileId?: string;
  builtInDefaultProfileId?: string;
}

/** Selects exactly one profile; it does not merge or compose profile data. */
export function selectWorkflowProfile(
  registry: WorkflowProfileRegistry,
  options: WorkflowProfileSelectionOptions,
): RegisteredWorkflowProfile {
  const requireEligible = (id: string, reason: string): RegisteredWorkflowProfile => {
    const selected = registry.get(id);
    if (!selected) throw new WorkflowProfileLoadError(`Cannot select ${reason} profile "${id}": it was not discovered`, [{
      stage: 'semantic', code: 'selection.profile-missing', message: `Profile "${id}" is not registered`, profileId: id, path: '/profile/id',
    }]);
    if (selected.scope === 'project' && options.projectOptIn !== true) throw new WorkflowProfileLoadError('Project workflow profiles require explicit opt-in', [{
      stage: 'read', code: 'project-profile.opt-in-required', message: 'The selected project profile is not eligible without explicit opt-in', profileId: id, file: selected.file,
    }]);
    return selected;
  };

  if (options.requestedProfileId !== undefined) return requireEligible(options.requestedProfileId, 'explicitly selected');
  if (options.projectOptIn === true && options.projectDefaultProfileId !== undefined) {
    const projectDefault = requireEligible(options.projectDefaultProfileId, 'project default');
    if (projectDefault.scope !== 'project') throw new WorkflowProfileLoadError(`Project default profile "${options.projectDefaultProfileId}" is not project-scoped`, [{
      stage: 'semantic', code: 'selection.default-not-project',
      message: 'A project default must be registered from the project scope', profileId: options.projectDefaultProfileId,
      file: projectDefault.file, path: '/profile/id',
    }]);
    return projectDefault;
  }
  if (options.builtInDefaultProfileId) {
    const fallback = requireEligible(options.builtInDefaultProfileId, 'built-in default');
    if (fallback.scope !== 'builtin') throw new WorkflowProfileLoadError(`Fallback profile "${fallback.profile.profile.id}" is not built-in`, [{
      stage: 'semantic', code: 'selection.default-not-builtin', message: 'Built-in fallback must come from the built-in scope', profileId: fallback.profile.profile.id, file: fallback.file,
    }]);
    return fallback;
  }
  throw new WorkflowProfileLoadError('No workflow profile could be selected', [{
    stage: 'semantic', code: 'selection.no-profile', message: 'No explicit, opted-in project, or built-in default profile is available',
  }]);
}
