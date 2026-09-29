import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { packageRoot } from '../registries/layout.js';
import type { WorkflowProfileDocument, WorkflowProfileDiagnostic, WorkflowProfileValidationResult } from './profile-types.js';

export const SUPPORTED_SCHEMA_MAJOR = 1;
export const SUPPORTED_SCHEMA_MINOR = 0;

function readCanonicalSchema(): Record<string, unknown> {
  const root = packageRoot();
  if (!root) throw new Error('[workflow-profile] Cannot locate package root to load canonical JSON Schema');
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
  const parseValue = (memberPath: string): void => {
    whitespace();
    if (text[index] === '"') { stringToken(); return; }
    if (text[index] === '[') {
      index++;
      whitespace();
      if (text[index] === ']') { index++; return; }
      let item = 0;
      for (;;) {
        parseValue(`${memberPath}/${item++}`);
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
        parseValue(childPath);
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
    if (error instanceof DuplicateJsonMemberError) throw error;
    // JSON.parse below remains the authority for malformed syntax.
  }
}

export function validateWorkflowProfileJson(text: string, file?: string): WorkflowProfileValidationResult {
  let value: unknown;
  try {
    assertNoDuplicateJsonMembers(text);
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof DuplicateJsonMemberError) {
      return { ok: false, diagnostics: [{ stage: 'parse', code: 'json.duplicate-key', message: error.message, file, path: error.memberPath }] };
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

/** Reusable structural-only validator for internal parity tests. */
export function validateWorkflowProfileStructure(value: unknown): WorkflowProfileDiagnostic[] {
  if (!validate(value)) return structuralDiagnostics(validate.errors, getProfileId(value), undefined, value);
  return [];
}
