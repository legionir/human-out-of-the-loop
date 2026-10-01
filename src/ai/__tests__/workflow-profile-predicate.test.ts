import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  domainFor,
  equalScalar,
  evaluatePredicate,
  predicateMatches,
  readPort,
  routingDomainFor,
  scalarMatchesType,
} from '../workflow-profiles/profile-predicate.js';
import type { WorkflowPredicate } from '../workflow-profiles/profile-types.js';

const predicate = (operator: string, value?: unknown, path = '/flag'): WorkflowPredicate => (
  { path, operator, ...(value === undefined ? {} : { value }) } as WorkflowPredicate
);

describe('Workflow Profile predicate contract', () => {
  it('reads only declared top-level ports and reports malformed pointers as absent', () => {
    const outputs = { flag: false, nested: { deeper: 1 }, list: [1, 2] };
    expect(readPort(outputs, '/flag')).toBe(false);
    expect(readPort(outputs, '/nested')).toEqual({ deeper: 1 });
    // Nested pointers, wildcards, leading-digit names, and non-pointers are not ports.
    for (const pointer of ['/nested/deeper', 'nested', '/1st', '/', '/flag/child', '', '/flag~1']) {
      expect(readPort(outputs, pointer)).toBe(ABSENT);
    }
    expect(readPort(outputs, '/missing')).toBe(ABSENT);
  });

  it('treats a missing or absent port as not-exists only', () => {
    expect(predicateMatches(predicate('not-exists'), ABSENT)).toBe(true);
    for (const operator of ['exists', 'equals', 'not-equals', 'in', 'not-in', 'greater-than', 'less-than', 'contains']) {
      expect(predicateMatches(predicate(operator, 'x'), ABSENT)).toBe(false);
    }
    const outputs: Record<string, unknown> = {};
    expect(evaluatePredicate(predicate('not-exists'), outputs)).toBe(true);
    expect(evaluatePredicate(predicate('exists'), outputs)).toBe(false);
  });

  it('evaluates null values without coercing them to any other value', () => {
    expect(predicateMatches(predicate('equals', null), null)).toBe(true);
    expect(predicateMatches(predicate('equals', null), false)).toBe(false);
    expect(predicateMatches(predicate('equals', null), 0)).toBe(false);
    expect(predicateMatches(predicate('not-equals', null), '')).toBe(true);
    expect(predicateMatches(predicate('in', [null, 'ready']), null)).toBe(true);
    expect(predicateMatches(predicate('greater-than', 1), null)).toBe(false);
    expect(predicateMatches(predicate('contains', 'a'), null)).toBe(false);
  });

  it('uses strict scalar identity: no string/number coercion and no deep equality', () => {
    expect(predicateMatches(predicate('equals', 1), '1')).toBe(false);
    expect(predicateMatches(predicate('equals', true), 1)).toBe(false);
    expect(predicateMatches(predicate('equals', 0), -0)).toBe(false);
    expect(equalScalar(Number.NaN, Number.NaN)).toBe(true);
    // Object and array ports compare by identity, not structural equality.
    const shared = { status: 'ok' };
    expect(predicateMatches(predicate('equals', shared), shared)).toBe(true);
    expect(predicateMatches(predicate('equals', { status: 'ok' }), { status: 'ok' })).toBe(false);
    expect(predicateMatches(predicate('in', [[1, 2]]), [1, 2])).toBe(false);
  });

  it('evaluates object and array ports only through the operators declared for them', () => {
    const outputs = { list: ['a', 'b'], record: { key: 'value' } };
    expect(evaluatePredicate(predicate('exists', undefined, '/list'), outputs)).toBe(true);
    expect(evaluatePredicate(predicate('contains', 'a', '/list'), outputs)).toBe(true);
    expect(evaluatePredicate(predicate('contains', 'c', '/list'), outputs)).toBe(false);
    expect(predicateMatches(predicate('equals', {}), {})).toBe(false);
    expect(predicateMatches(predicate('greater-than', 0), [1, 2])).toBe(false);
    expect(predicateMatches(predicate('in', ['x']), ['x'])).toBe(false);
    // `value` must be an array for membership operators; a malformed value never matches.
    expect(predicateMatches(predicate('in', 'x'), 'x')).toBe(false);
    expect(predicateMatches(predicate('not-in', 'x'), 'x')).toBe(false);
  });

  it('orders numbers only, and never compares incomparable values', () => {
    expect(predicateMatches(predicate('greater-than', 1), 2)).toBe(true);
    expect(predicateMatches(predicate('greater-or-equal', 2), 2)).toBe(true);
    expect(predicateMatches(predicate('less-than', 2), 1)).toBe(true);
    expect(predicateMatches(predicate('less-or-equal', 1), 1)).toBe(true);
    expect(predicateMatches(predicate('greater-than', 'a'), 'b')).toBe(false);
    expect(predicateMatches(predicate('less-than', 1), Number.NaN)).toBe(false);
    expect(predicateMatches(predicate('greater-than', Number.NaN), 5)).toBe(false);
    expect(predicateMatches(predicate('less-than', 1), true)).toBe(false);
  });

  it('matches substrings for string ports and rejects unknown operators', () => {
    expect(predicateMatches(predicate('contains', 'eed'), 'agreed')).toBe(true);
    expect(predicateMatches(predicate('contains', 'eed'), 'denied')).toBe(false);
    expect(predicateMatches(predicate('not-equals', 'ok'), 'ok')).toBe(false);
    expect(predicateMatches(predicate('not-in', ['ok', 'retry']), 'ok')).toBe(false);
    expect(predicateMatches(predicate('not-in', ['ok', 'retry']), 'reject')).toBe(true);
    expect(predicateMatches({ path: '/flag', operator: 'matches' } as unknown as WorkflowPredicate, 'ok')).toBe(false);
  });

  it('keeps port domains and type checks aligned with the declarative contract', () => {
    expect(domainFor({ type: 'boolean' })).toEqual([false, true]);
    expect(domainFor({ type: 'string', enum: ['ok', 'retry'] })).toEqual(['ok', 'retry']);
    expect(domainFor({ type: 'string' })).toBeUndefined();
    expect(routingDomainFor({ type: 'boolean', required: true })).toEqual([false, true]);
    expect(routingDomainFor({ type: 'boolean' })).toEqual([false, true, ABSENT]);
    expect(scalarMatchesType('x', 'string')).toBe(true);
    expect(scalarMatchesType(1.5, 'number')).toBe(true);
    expect(scalarMatchesType(1.5, 'integer')).toBe(false);
    expect(scalarMatchesType([], 'object')).toBe(false);
    expect(scalarMatchesType({}, 'array')).toBe(false);
    // `any` is an opaque pass-through: an `undefined` port value never reaches this
    // check (absent outputs and mappings are handled before any type comparison).
    expect(scalarMatchesType(undefined, 'any')).toBe(true);
    expect(scalarMatchesType(undefined, 'string')).toBe(false);
    expect(scalarMatchesType('anything', 'artifact')).toBe(true);
  });
});
