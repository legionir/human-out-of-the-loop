/**
 * Phase 3 (WP-R-003): deterministic dependency-digest contract.
 *
 * A profile dependency pin is `sha256:<64 hex>` over a *typed envelope* so that
 * identical content under a different kind/id can never satisfy the same pin,
 * and so the digest is reproducible from the resolved component alone:
 *
 *   envelope = "hootl.workflow-profile.dependency.v1\n" + kind + "\n" + id + "\n" + canonicalJson(content)
 *   digest   = "sha256:" + hex(sha256(utf8(envelope)))
 *
 * Canonical JSON rules (deliberately minimal, no general-purpose JSON library):
 *   - objects: keys sorted by UTF-16 code-unit order; `undefined` members are omitted;
 *   - arrays: element order preserved;
 *   - strings/numbers/booleans/null: `JSON.stringify` scalar form;
 *   - non-finite numbers, functions, symbols, bigints, class instances with a
 *     non-plain prototype, cycles and aliases are rejected (not JSON content).
 *
 * This module performs no I/O and executes no component code; it only hashes the
 * content the resolver actually hands to the workflow.
 */
import { createHash } from 'node:crypto';

export const DEPENDENCY_DIGEST_ENVELOPE_VERSION = 'hootl.workflow-profile.dependency.v1';
export const DEPENDENCY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class DigestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestInputError';
  }
}

/** Deterministic JSON serialization of a JSON-compatible value. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (current: unknown, depth: number): string => {
    if (depth > 128) throw new DigestInputError('Content nesting exceeds the digest depth limit');
    if (current === null) return 'null';
    switch (typeof current) {
      case 'string':
        return JSON.stringify(current);
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) throw new DigestInputError('Content contains a non-finite number');
        return JSON.stringify(current);
      case 'object': {
        const object = current as object;
        if (seen.has(object)) throw new DigestInputError('Content contains a cycle or aliased object');
        seen.add(object);
        try {
          if (Array.isArray(object)) {
            return `[${object.map((item) => encode(item, depth + 1)).join(',')}]`;
          }
          const prototype = Object.getPrototypeOf(object);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new DigestInputError('Content contains a non-plain object');
          }
          const parts: string[] = [];
          for (const key of Object.keys(object).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor) throw new DigestInputError(`Content member "${key}" could not be inspected`);
            if (descriptor.get || descriptor.set) throw new DigestInputError(`Content member "${key}" is an accessor, not data`);
            if (descriptor.value === undefined) continue;
            parts.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
          }
          return `{${parts.join(',')}}`;
        } finally {
          seen.delete(object);
        }
      }
      default:
        throw new DigestInputError(`Content contains an unsupported ${typeof current} value`);
    }
  };
  return encode(value, 0);
}

/** Exact bytes hashed for a dependency pin; exported so tests can assert the contract. */
export function dependencyDigestEnvelope(kind: string, id: string, content: unknown): string {
  if (typeof kind !== 'string' || kind.length === 0) throw new DigestInputError('Dependency kind must be a non-empty string');
  if (typeof id !== 'string' || id.length === 0) throw new DigestInputError('Dependency id must be a non-empty string');
  return `${DEPENDENCY_DIGEST_ENVELOPE_VERSION}\n${kind}\n${id}\n${canonicalJson(content)}`;
}

/** `sha256:<hex>` digest of the exact resolved component content. */
export function dependencyDigest(kind: string, id: string, content: unknown): string {
  const hash = createHash('sha256').update(dependencyDigestEnvelope(kind, id, content), 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Content projection for a resolved component: every own enumerable field of the
 * validated source record, with the skill's `instructions` replaced by the text
 * that was actually resolved from disk. Unknown/extra fields are deliberately
 * kept, so that a content change always breaks the pin.
 */
export function componentProjection(record: Record<string, unknown>): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    projection[key] = value;
  }
  return projection;
}
