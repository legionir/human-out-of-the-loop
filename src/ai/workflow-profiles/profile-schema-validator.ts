import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { fileURLToPath } from 'node:url';
import type { WorkflowProfileDocument, WorkflowProfileDiagnostic, WorkflowProfileValidationResult } from './profile-types.js';

export const SUPPORTED_SCHEMA_MAJOR = 1;
export const SUPPORTED_SCHEMA_MINOR = 0;

function canonicalPackageRoot(): string | undefined {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
        // Stop at the nearest package boundary. Never walk past an unrelated or
        // malformed package manifest and accidentally load an ancestor's Schema.
        return manifest?.name === 'human-out-of-the-loop' ? directory : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readCanonicalSchema(): Record<string, unknown> {
  const root = canonicalPackageRoot();
  if (!root) throw new Error('[workflow-profile] Cannot locate the human-out-of-the-loop package root to load canonical JSON Schema');
  const schemaPath = path.join(root, 'docs', 'workflow-profiles', 'workflow-profile.schema.json');
  try {
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`[workflow-profile] Cannot load canonical Schema at ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const WORKFLOW_PROFILE_SCHEMA = readCanonicalSchema();

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // The canonical Schema uses conditional `then` fragments that intentionally
  // refine parent object types and required fields; keep all other strict
  // checks while disabling these two incompatible strict-mode diagnostics.
  strictTypes: false,
  strictRequired: false,
  validateSchema: true,
  messages: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

const schemaValidationErrors = ajv.validateSchema(WORKFLOW_PROFILE_SCHEMA);
if (schemaValidationErrors !== true) {
  throw new Error(`[workflow-profile] Canonical Schema is invalid: ${JSON.stringify(ajv.errors ?? [])}`);
}

const validate: ValidateFunction = ajv.compile(WORKFLOW_PROFILE_SCHEMA);

function getProfileId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const profile = (value as Record<string, unknown>).profile;
  if (!profile || typeof profile !== 'object') return undefined;
  const id = (profile as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function structuralDiagnostics(
  errors: ErrorObject[] | null | undefined,
  profileId?: string,
  file?: string,
  value?: unknown,
): WorkflowProfileDiagnostic[] {
  return (errors ?? []).map((error) => {
    const params = error.params as Record<string, unknown>;
    const property = typeof params.additionalProperty === 'string'
      ? params.additionalProperty
      : typeof params.missingProperty === 'string'
        ? params.missingProperty
        : undefined;
    const basePath = error.instancePath || '';
    const diagnosticPath = property ? `${basePath}/${escapePointerToken(property)}` || '/' : basePath || '/';
    const nodeMatch = /^\/workflow\/nodes\/(\d+)(?:\/|$)/.exec(diagnosticPath);
    const edgeMatch = /^\/workflow\/edges\/(\d+)(?:\/|$)/.exec(diagnosticPath);
    const document = value && typeof value === 'object' ? value as Record<string, any> : undefined;
    const nodeIndex = nodeMatch ? Number(nodeMatch[1]) : undefined;
    const edgeIndex = edgeMatch ? Number(edgeMatch[1]) : undefined;
    const nodeId = nodeIndex === undefined ? undefined : document?.workflow?.nodes?.[nodeIndex]?.id;
    const detail = property ? ` (${property})` : '';
    return {
      stage: 'structural',
      code: `schema.${error.keyword}`,
      message: `${error.message ?? 'Schema validation failed'}${detail}`,
      file,
      profileId,
      path: diagnosticPath,
      nodeId: typeof nodeId === 'string' ? nodeId : undefined,
      edgeIndex,
    };
  });
}

/** Parse and validate the canonical JSON Schema contract only. Semantic checks are intentionally separate. */
class DuplicateJsonMemberError extends Error {
  constructor(public readonly memberPath: string) {
    super(`Duplicate JSON object member at ${memberPath}`);
    this.name = 'DuplicateJsonMemberError';
  }
}

class JsonScanLimitError extends Error {
  constructor() { super('JSON nesting exceeds the duplicate-key scanner depth limit'); this.name = 'JsonScanLimitError'; }
}

const MAX_JSON_SCAN_DEPTH = 128;

/** JSON.parse silently keeps the last duplicate object key; reject duplicates before it loses port/config information. */
function assertNoDuplicateJsonMembers(text: string): void {
  let index = 0;
  const whitespace = (): void => { while ([9, 10, 13, 32].includes(text.charCodeAt(index))) index++; };
  const stringToken = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error('Expected JSON string');
    index++;
    while (index < text.length) {
      const character = text[index]!;
      if (character.charCodeAt(0) === 92) { index += 2; continue; }
      index++;
      if (character === '"') return text.slice(start, index);
    }
    throw new Error('Unterminated JSON string');
  };
  const parseValue = (memberPath: string, depth = 0): void => {
    if (depth > MAX_JSON_SCAN_DEPTH) throw new JsonScanLimitError();
    whitespace();
    if (text[index] === '"') { stringToken(); return; }
    if (text[index] === '[') {
      index++;
      whitespace();
      if (text[index] === ']') { index++; return; }
      let item = 0;
      for (;;) {
        parseValue(`${memberPath}/${item++}`, depth + 1);
        whitespace();
        if (text[index] === ']') { index++; return; }
        if (text[index] !== ',') throw new Error('Malformed JSON array');
        index++;
      }
    }
    if (text[index] === '{') {
      index++;
      whitespace();
      if (text[index] === '}') { index++; return; }
      const keys = new Set<string>();
      for (;;) {
        whitespace();
        const token = stringToken();
        const key = JSON.parse(token) as string;
        const escapedKey = key.replaceAll('~', '~0').replaceAll(String.fromCharCode(47), '~1');
        const childPath = `${memberPath}/${escapedKey}`;
        if (keys.has(key)) throw new DuplicateJsonMemberError(childPath);
        keys.add(key);
        whitespace();
        if (text[index] !== ':') throw new Error('Malformed JSON object');
        index++;
        parseValue(childPath, depth + 1);
        whitespace();
        if (text[index] === '}') { index++; return; }
        if (text[index] !== ',') throw new Error('Malformed JSON object');
        index++;
      }
    }
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 9 || code === 10 || code === 13 || code === 32 || text[index] === ',' || text[index] === ']' || text[index] === '}') break;
      index++;
    }
  };
  try { parseValue(''); } catch (error) {
    if (error instanceof DuplicateJsonMemberError || error instanceof JsonScanLimitError) throw error;
    // JSON.parse below remains the authority for malformed syntax.
  }
}

export function validateWorkflowProfileJson(text: string, file?: string): WorkflowProfileValidationResult {
  let value: unknown;
  try {
    // JSON.parse establishes syntax validity first. The duplicate-member scan
    // then rejects otherwise-valid JSON without taking precedence over syntax errors.
    value = JSON.parse(text) as unknown;
    assertNoDuplicateJsonMembers(text);
  } catch (error) {
    if (error instanceof DuplicateJsonMemberError) {
      return { ok: false, diagnostics: [{ stage: 'parse', code: 'json.duplicate-key', message: error.message, file, path: error.memberPath }] };
    }
    if (error instanceof JsonScanLimitError) {
      return { ok: false, diagnostics: [{ stage: 'parse', code: 'json.depth-limit', message: error.message, file, path: '/' }] };
    }
    return {
      ok: false,
      diagnostics: [{
        stage: 'parse',
        code: 'json.invalid',
        message: error instanceof Error ? error.message : String(error),
        file,
      }],
    };
  }

  const profileId = getProfileId(value);
  const schemaVersion = value && typeof value === 'object'
    ? (value as Record<string, unknown>).schemaVersion
    : undefined;
  const match = typeof schemaVersion === 'string'
    ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(schemaVersion)
    : null;
  if (!match || Number(match[1]) !== SUPPORTED_SCHEMA_MAJOR || Number(match[2]) !== SUPPORTED_SCHEMA_MINOR) {
    return {
      ok: false,
      diagnostics: [{
        stage: 'schema-version',
        code: 'schema-version.unsupported',
        message: `Unsupported or malformed schemaVersion ${JSON.stringify(schemaVersion)}; supported contract is ${SUPPORTED_SCHEMA_MAJOR}.${SUPPORTED_SCHEMA_MINOR}.x`,
        file,
        profileId,
        path: '/schemaVersion',
      }],
    };
  }

  if (!validate(value)) {
    return { ok: false, diagnostics: structuralDiagnostics(validate.errors, profileId, file, value) };
  }

  return {
    ok: true,
    profile: value as WorkflowProfileDocument,
    diagnostics: [],
  };
}

export function isJsonCompatibleValue(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let encodedBytes = 0;
  const addBytes = (amount: number): boolean => {
    encodedBytes += amount;
    return encodedBytes <= 1_048_576;
  };
  try {
    while (pending.length) {
      const item = pending.pop()!;
      const current = item.value;
      nodes++;
      if (nodes > 100_000 || item.depth > 128) return false;
      if (current === null) { if (!addBytes(4)) return false; continue; }
      if (typeof current === 'string') {
        if (current.length > 1_048_576 || !addBytes(Buffer.byteLength(JSON.stringify(current)!))) return false;
        continue;
      }
      if (typeof current === 'boolean') { if (!addBytes(current ? 4 : 5)) return false; continue; }
      if (typeof current === 'number') {
        if (!Number.isFinite(current) || !addBytes(JSON.stringify(current)!.length)) return false;
        continue;
      }
      if (typeof current !== 'object') return false;
      const object = current as object;
      if (seen.has(object)) return false; // JSON documents are trees, not aliased/cyclic object graphs.
      seen.add(object);
      const array = Array.isArray(object);
      const prototype = Object.getPrototypeOf(object);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(object);
      if (keys.some((key) => typeof key !== 'string')) return false;
      if (array) {
        const length = (object as unknown[]).length;
        if (keys.length !== length + 1 || !keys.includes('length') || !addBytes(2 + Math.max(0, length - 1))) return false;
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
          pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      } else {
        if (!addBytes(2 + Math.max(0, keys.length - 1))) return false;
        for (const key of keys as string[]) {
          if (key.length > 1_048_576 || !addBytes(Buffer.byteLength(JSON.stringify(key)!) + 1)) return false;
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
          pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      }
    }
    return true;
  } catch {
    // Proxies and objects with hostile reflection traps are not JSON values.
    return false;
  }
}

/** Reusable structural-only validator for internal parity tests. */
export function validateWorkflowProfileStructure(value: unknown): WorkflowProfileDiagnostic[] {
  const invalidValueDiagnostic: WorkflowProfileDiagnostic = {
    stage: 'structural', code: 'json.value-invalid',
    message: 'Profile input must be a plain, acyclic JSON value containing only own data properties', path: '/',
  };
  try {
    if (!isJsonCompatibleValue(value)) return [invalidValueDiagnostic];
    if (!validate(value)) return structuralDiagnostics(validate.errors, getProfileId(value), undefined, value);
    return [];
  } catch {
    // A Proxy may pass descriptor-based shape checks but throw when Ajv reads
    // its properties. Treat any hostile reflective/get trap as invalid input;
    // the public structural boundary must return diagnostics, never raw errors.
    return [invalidValueDiagnostic];
  }
}
