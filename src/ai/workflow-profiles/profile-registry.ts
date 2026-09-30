import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_SCHEMA_MAJOR, SUPPORTED_SCHEMA_MINOR, validateWorkflowProfileJson, validateWorkflowProfileStructure } from './profile-schema-validator.js';
import { validateWorkflowProfileSemantics } from './profile-semantic-validator.js';
import type {
  WorkflowProfileDiagnostic,
  WorkflowProfileDocument,
  WorkflowProfileScope,
  ValidatedWorkflowProfileDocument,
} from './profile-types.js';

export const MAX_WORKFLOW_PROFILE_BYTES = 1_048_576;

const WORKFLOW_PROFILE_SCOPES: ReadonlySet<string> = new Set(['builtin', 'project', 'user-selected']);

function isRecord(value: unknown): value is Record<string, any> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return false;
    }
    return true;
  } catch { return false; }
}

const UNSAFE_BOUNDARY_VALUE = Symbol('unsafe-boundary-value');

function ownDataValue(record: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    // Let the public boundary's normal type/shape validation turn this sentinel
    // into a structured diagnostic rather than leaking a Proxy trap exception.
    return UNSAFE_BOUNDARY_VALUE;
  }
}

function invalidInput(stage: 'read' | 'semantic', code: string, message: string, file?: string): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError(message, [{ stage, code, message, file }]);
}

function assertWorkflowProfileScope(scope: unknown, file?: string): asserts scope is WorkflowProfileScope {
  if (typeof scope === 'string' && WORKFLOW_PROFILE_SCOPES.has(scope)) return;
  const message = 'Invalid workflow profile scope; expected builtin, project, or user-selected';
  throw new WorkflowProfileLoadError(message, [{
    stage: 'read', code: 'scope.invalid', message, file,
  }]);
}

function projectOptInRequired(file?: string): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError('Project workflow profiles require explicit opt-in before loading or registration', [{
    stage: 'read', code: 'project-profile.opt-in-required', message: 'Project profile content was not loaded or registered because explicit opt-in is required', file,
  }]);
}

export interface WorkflowProfileRegistration {
  /** Untrusted input; register() revalidates before it is exposed. */
  readonly profile: WorkflowProfileDocument;
  readonly scope: WorkflowProfileScope;
  readonly file: string;
}

export interface RegisteredWorkflowProfile {
  readonly profile: ValidatedWorkflowProfileDocument;
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
  private readonly projectOptIn: boolean;

  constructor(options: { projectOptIn?: boolean } = {}) {
    if (!isRecord(options)) throw invalidInput('read', 'registry.options-invalid', 'Registry options must be an object with an optional boolean projectOptIn value');
    const projectOptIn = ownDataValue(options, 'projectOptIn');
    if (projectOptIn !== undefined && typeof projectOptIn !== 'boolean') {
      throw invalidInput('read', 'registry.options-invalid', 'Registry options must be an object with an optional boolean projectOptIn value');
    }
    this.projectOptIn = projectOptIn === true;
  }

  register(entry: WorkflowProfileRegistration): void {
    try { this.registerUnchecked(entry); }
    catch (error) {
      if (error instanceof WorkflowProfileLoadError) throw error;
      throw invalidInput('read', 'registry.entry-invalid', `Registry entry could not be safely inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private registerUnchecked(entry: WorkflowProfileRegistration): void {
    if (!isRecord(entry)) {
      throw new WorkflowProfileLoadError('Invalid workflow profile registry entry', [{
        stage: 'read', code: 'registry.entry-invalid', message: 'Registry entry must be an object containing scope, file, and profile',
      }]);
    }
    const rawFile = ownDataValue(entry, 'file');
    const scope = ownDataValue(entry, 'scope');
    const profile = ownDataValue(entry, 'profile');
    const file = typeof rawFile === 'string' && rawFile.length > 0 ? rawFile : undefined;
    if (file === undefined) {
      throw new WorkflowProfileLoadError('Invalid workflow profile registry entry', [{
        stage: 'read', code: 'registry.entry-invalid', message: 'Registry entry must include a non-empty file identifier',
      }]);
    }
    assertWorkflowProfileScope(scope, file);
    if (scope === 'project' && this.projectOptIn !== true) throw projectOptInRequired(file);
    const structuralDiagnostics = validateWorkflowProfileStructure(profile).map((diagnostic) => ({ ...diagnostic, file }));
    if (structuralDiagnostics.length) {
      throw new WorkflowProfileLoadError(`Structurally invalid workflow profile "${file}"`, structuralDiagnostics);
    }
    const validProfile = profile as WorkflowProfileDocument;
    // Read profile-controlled values only after structural validation, so a malformed
    // in-memory caller cannot escape as a raw TypeError before diagnostics are formed.
    const id = validProfile.profile.id;
    const version = validProfile.schemaVersion;
    const match = typeof version === 'string' ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version) : null;
    if (!match || Number(match[1]) !== SUPPORTED_SCHEMA_MAJOR || Number(match[2]) !== SUPPORTED_SCHEMA_MINOR) {
      throw new WorkflowProfileLoadError(`Unsupported workflow profile schema version ${typeof version === 'string' ? version : '<missing or invalid>'}`, [{
        stage: 'schema-version', code: 'schema-version.unsupported',
        message: `Supported contract is ${SUPPORTED_SCHEMA_MAJOR}.${SUPPORTED_SCHEMA_MINOR}.x`,
        profileId: id, file, path: '/schemaVersion',
      }]);
    }
    const semanticDiagnostics = validateWorkflowProfileSemantics(validProfile).map((diagnostic) => ({ ...diagnostic, file }));
    if (semanticDiagnostics.length) {
      throw new WorkflowProfileLoadError(`Semantically invalid workflow profile "${file}"`, semanticDiagnostics);
    }
    if (this.byId.has(id)) {
      throw new WorkflowProfileLoadError(`Duplicate workflow profile id "${id}"`, [{
        stage: 'semantic', code: 'registry.duplicate-id', message: `Duplicate workflow profile id "${id}"`,
        profileId: id, file, path: '/profile/id',
      }]);
    }
    const immutableProfile = deepFreeze(structuredClone(validProfile)) as ValidatedWorkflowProfileDocument;
    this.byId.set(id, Object.freeze({ profile: immutableProfile, scope, file }));
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
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
  } catch (error) {
    throw new WorkflowProfileLoadError(`Cannot open workflow profile "${file}": ${error instanceof Error ? error.message : String(error)}`, [{
      stage: 'read', code: 'file.unreadable', message: `Cannot open profile file: ${error instanceof Error ? error.message : String(error)}`, file,
    }]);
  }
  let decoded: string | undefined;
  let primaryError: unknown;
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
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch (error) {
      throw new WorkflowProfileLoadError(`Profile is not valid UTF-8: ${file}`, [{
        stage: 'utf8', code: 'utf8.invalid', message: error instanceof Error ? error.message : 'Invalid UTF-8 byte sequence', file,
      }]);
    }
  } catch (error) {
    primaryError = error;
  }
  try { fs.closeSync(fd); }
  catch (error) { if (primaryError === undefined) primaryError = error; }
  if (primaryError instanceof WorkflowProfileLoadError) throw primaryError;
  if (primaryError !== undefined) {
    const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new WorkflowProfileLoadError(`Cannot read workflow profile "${file}": ${message}`, [{
      stage: 'read', code: 'file.read-failed', message, file,
    }]);
  }
  return decoded!;
}

function tooLarge(file: string, actualBytes: number): WorkflowProfileLoadError {
  return new WorkflowProfileLoadError(`Workflow profile exceeds the ${MAX_WORKFLOW_PROFILE_BYTES}-byte limit (${actualBytes} bytes): ${file}`, [{
    stage: 'read', code: 'file.too-large', message: `Profile is ${actualBytes} UTF-8 bytes; maximum is ${MAX_WORKFLOW_PROFILE_BYTES}`, file, path: '/',
  }]);
}

export function loadWorkflowProfileFile(
  file: string,
  scope: WorkflowProfileScope,
  options: { projectOptIn?: boolean } = {},
): RegisteredWorkflowProfile {
  if (typeof file !== 'string' || file.length === 0) throw invalidInput('read', 'file.path-invalid', 'Profile file path must be a non-empty string');
  if (!isRecord(options)) throw invalidInput('read', 'file.options-invalid', 'Profile load options must be an object with an optional boolean projectOptIn value', file);
  const projectOptIn = ownDataValue(options, 'projectOptIn');
  if (projectOptIn !== undefined && typeof projectOptIn !== 'boolean') {
    throw invalidInput('read', 'file.options-invalid', 'Profile load options must be an object with an optional boolean projectOptIn value', file);
  }
  assertWorkflowProfileScope(scope, file);
  if (scope === 'project' && projectOptIn !== true) throw projectOptInRequired(file);
  const text = readWorkflowProfileUtf8(file);
  const structural = validateWorkflowProfileJson(text, file);
  if (!structural.ok || !structural.profile) throw new WorkflowProfileLoadError(`Invalid workflow profile "${file}"`, structural.diagnostics);
  const semanticDiagnostics = validateWorkflowProfileSemantics(structural.profile).map((diagnostic) => ({ ...diagnostic, file }));
  if (semanticDiagnostics.length) throw new WorkflowProfileLoadError(`Semantically invalid workflow profile "${file}"`, semanticDiagnostics);
  return Object.freeze({ profile: deepFreeze(structural.profile) as ValidatedWorkflowProfileDocument, scope, file });
}

/**
 * Discover JSON files only under an explicit caller-supplied directory. The
 * project scope is fail-closed unless projectOptIn=true. A single bad file
 * rejects the whole directory so callers can never accidentally use a partial
 * or ambiguous profile set.
 */
export function loadWorkflowProfilesFromDirectory(options: WorkflowProfileDirectoryOptions): WorkflowProfileRegistry {
  if (!isRecord(options)) throw invalidInput('read', 'directory.options-invalid', 'Directory loader options must be an object');
  const directoryValue = ownDataValue(options, 'directory');
  const scopeValue = ownDataValue(options, 'scope');
  const projectOptInValue = ownDataValue(options, 'projectOptIn');
  const directory = directoryValue;
  const scope = scopeValue;
  const projectOptIn = projectOptInValue === undefined ? false : projectOptInValue;
  if (typeof directory !== 'string' || directory.length === 0) throw invalidInput('read', 'directory.path-invalid', 'Profile discovery directory must be a non-empty string');
  if (projectOptIn !== undefined && typeof projectOptIn !== 'boolean') throw invalidInput('read', 'directory.opt-in-invalid', 'projectOptIn must be a boolean', directory);
  assertWorkflowProfileScope(scope, directory);
  if (scope === 'project' && projectOptIn !== true) throw projectOptInRequired(directory);
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
  const registry = new WorkflowProfileRegistry({ projectOptIn: scope === 'project' && projectOptIn === true });
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  for (const entry of jsonEntries) {
    const file = path.join(directory, entry.name);
    if (!entry.isFile()) {
      diagnostics.push({ stage: 'read', code: 'file.not-regular', message: 'Discovered .json profile entry must be a regular file; symlinks and nested directories are not followed', file });
      continue;
    }
    try {
      registry.register(loadWorkflowProfileFile(file, scope, { projectOptIn }));
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
  if (!(registry instanceof WorkflowProfileRegistry)) {
    throw invalidInput('semantic', 'selection.registry-invalid', 'Profile selection requires a WorkflowProfileRegistry instance');
  }
  if (!isRecord(options)) throw invalidInput('semantic', 'selection.options-invalid', 'Profile selection options must be an object');
  const selection = options as unknown as Record<string, unknown>;
  const requestedProfileId = ownDataValue(selection, 'requestedProfileId');
  const projectOptIn = ownDataValue(selection, 'projectOptIn');
  const projectDefaultProfileId = ownDataValue(selection, 'projectDefaultProfileId');
  const builtInDefaultProfileId = ownDataValue(selection, 'builtInDefaultProfileId');
  if (projectOptIn !== undefined && typeof projectOptIn !== 'boolean') {
    throw invalidInput('semantic', 'selection.opt-in-invalid', 'projectOptIn must be a boolean');
  }
  for (const [key, id] of Object.entries({
    requestedProfileId,
    projectDefaultProfileId,
    builtInDefaultProfileId,
  })) {
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      throw invalidInput('semantic', 'selection.profile-id-invalid', `${key} must be a non-empty string when provided`);
    }
  }
  const requestedId = requestedProfileId as string | undefined;
  const projectDefaultId = projectDefaultProfileId as string | undefined;
  const builtInDefaultId = builtInDefaultProfileId as string | undefined;
  const requireEligible = (id: string, reason: string): RegisteredWorkflowProfile => {
    const selected = registry.get(id);
    if (!selected) throw new WorkflowProfileLoadError(`Cannot select ${reason} profile "${id}": it was not discovered`, [{
      stage: 'semantic', code: 'selection.profile-missing', message: `Profile "${id}" is not registered`, profileId: id, path: '/profile/id',
    }]);
    if (selected.scope === 'project' && projectOptIn !== true) throw new WorkflowProfileLoadError('Project workflow profiles require explicit opt-in', [{
      stage: 'read', code: 'project-profile.opt-in-required', message: 'The selected project profile is not eligible without explicit opt-in', profileId: id, file: selected.file,
    }]);
    return selected;
  };

  if (requestedId !== undefined) return requireEligible(requestedId, 'explicitly selected');
  if (projectOptIn === true && projectDefaultId !== undefined) {
    const projectDefault = requireEligible(projectDefaultId, 'project default');
    if (projectDefault.scope !== 'project') throw new WorkflowProfileLoadError(`Project default profile "${projectDefaultId}" is not project-scoped`, [{
      stage: 'semantic', code: 'selection.default-not-project',
      message: 'A project default must be registered from the project scope', profileId: projectDefaultId,
      file: projectDefault.file, path: '/profile/id',
    }]);
    return projectDefault;
  }
  if (builtInDefaultId) {
    const fallback = requireEligible(builtInDefaultId, 'built-in default');
    if (fallback.scope !== 'builtin') throw new WorkflowProfileLoadError(`Fallback profile "${fallback.profile.profile.id}" is not built-in`, [{
      stage: 'semantic', code: 'selection.default-not-builtin', message: 'Built-in fallback must come from the built-in scope', profileId: fallback.profile.profile.id, file: fallback.file,
    }]);
    return fallback;
  }
  throw new WorkflowProfileLoadError('No workflow profile could be selected', [{
    stage: 'semantic', code: 'selection.no-profile', message: 'No explicit, opted-in project, or built-in default profile is available',
  }]);
}
