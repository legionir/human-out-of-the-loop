/**
 * Phase 4 (WP-R-005): the single predicate/port-domain contract shared by the
 * semantic validator (static) and the workflow kernel (runtime).
 *
 * Predicates are data over one declared top-level port: no expression string,
 * eval, callback, or executable content is ever evaluated.
 */
import type { WorkflowPredicate } from './profile-types.js';

export const PORT_POINTER = /^\/([a-zA-Z][a-zA-Z0-9_-]{0,63})$/;

/** Sentinel for a port that the source node did not produce (optional output absent). */
export const ABSENT = Symbol('absent-output');

export function equalScalar(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function scalarMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'file':
    case 'artifact':
    case 'any': return true;
    default: return false;
  }
}

/** Pure predicate evaluation; identical for static domain checks and runtime routing. */
export function predicateMatches(predicate: WorkflowPredicate, candidate: unknown): boolean {
  if (candidate === ABSENT) return predicate.operator === 'not-exists';
  const value = predicate.value as any;
  switch (predicate.operator) {
    case 'exists': return true;
    case 'not-exists': return false;
    case 'equals': return equalScalar(candidate, value);
    case 'not-equals': return !equalScalar(candidate, value);
    case 'in': return Array.isArray(value) && value.some((item) => equalScalar(candidate, item));
    case 'not-in': return Array.isArray(value) && !value.some((item) => equalScalar(candidate, item));
    case 'greater-than': return typeof candidate === 'number' && candidate > value;
    case 'greater-or-equal': return typeof candidate === 'number' && candidate >= value;
    case 'less-than': return typeof candidate === 'number' && candidate < value;
    case 'less-or-equal': return typeof candidate === 'number' && candidate <= value;
    case 'contains':
      return typeof candidate === 'string' ? candidate.includes(value) : Array.isArray(candidate) && candidate.includes(value);
    default: return false;
  }
}

/** Read one top-level port value from a node's outputs. */
export function readPort(outputs: Readonly<Record<string, unknown>>, pointer: string): unknown {
  const name = PORT_POINTER.exec(pointer)?.[1];
  if (!name) return ABSENT;
  return Object.hasOwn(outputs, name) ? outputs[name] : ABSENT;
}

/** Evaluate one predicate against a node's resolved output ports. */
export function evaluatePredicate(predicate: WorkflowPredicate, outputs: Readonly<Record<string, unknown>>): boolean {
  return predicateMatches(predicate, readPort(outputs, predicate.path));
}

/** Domain of a port: its declared enum, or both boolean values. */
export function domainFor(port: { type: string; enum?: unknown[] }): unknown[] | undefined {
  if (Array.isArray(port.enum)) return port.enum;
  if (port.type === 'boolean') return [false, true];
  return undefined;
}

/** Routing domain also accounts for an absent optional output. */
export function routingDomainFor(port: { type: string; enum?: unknown[]; required?: boolean }): unknown[] | undefined {
  const domain = domainFor(port);
  if (!domain) return undefined;
  return port.required === true ? domain : [...domain, ABSENT];
}
