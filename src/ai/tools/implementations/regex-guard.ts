/**
 * ReDoS guard for user/model-supplied regex patterns (phase 18 — SEC-01).
 *
 * JS regex engines use backtracking, so patterns with nested
 * quantifiers (e.g. `(a+)+`, `(\w+)*`) can take exponential time on
 * non-matching input (catastrophic backtracking).  This module
 * statically detects that class of patterns without executing them.
 *
 * Detection rule: a group whose body contains a quantifier and which
 * is itself quantified is unsafe:
 *   (a+)+   →  unsafe
 *   (a*)*   →  unsafe
 *   ([a-z]+)+ → unsafe
 *   (?:a|b)+ → safe (body has no quantifier)
 *   (a)+    →  safe
 *
 * Combined with a hard pattern-length limit this provides a practical
 * guard for `search_code` without adding a native dependency.
 */

const BRACE_QUANT = /^\{\d+(,\d*)?\}/;

/** Quantifier characters that can follow a group close. */
function isQuantifierChar(c: string | undefined): boolean {
  return c === '*' || c === '+' || c === '?';
}

/**
 * Returns true if the pattern contains a quantified group whose body
 * also contains a quantifier (catastrophic backtracking risk).
 */
export function isUnsafeRegex(pattern: string): boolean {
  const n = pattern.length;
  let i = 0;
  // Stack entry: does the current group's body already contain a quantifier?
  const stack: boolean[] = [];
  let inClass = false;

  while (i < n) {
    const c = pattern[i];

    // Escape sequence — skip both characters
    if (c === '\\') {
      i += 2;
      continue;
    }

    if (inClass) {
      if (c === ']') inClass = false;
      i += 1;
      continue;
    }

    // Character class: ( ) + * ? inside [ ] are literals
    if (c === '[') {
      inClass = true;
      i += 1;
      continue;
    }

    if (c === '(') {
      stack.push(false);
      i += 1;
      // Consume group modifier after "?": (?: (?:name) (?= (?<! etc.
      if (pattern[i] === '?') {
        const next = pattern[i + 1];
        if (next === ':' || next === '=' || next === '!') {
          i += 2;
        } else if (next === '<') {
          // (?<name> or (?<= / (?<!  — consume up to the closing >
          const close = pattern.indexOf('>', i + 1);
          if (close === -1) return false; // malformed; RegExp will throw later
          i = close + 1;
        }
        continue;
      }
      continue;
    }

    if (c === ')') {
      const bodyHadQuantifier = stack.pop() ?? false;
      i += 1;
      const next = pattern[i];
      if (bodyHadQuantifier && (isQuantifierChar(next) || next === '{')) {
        if (next === '{') {
          if (BRACE_QUANT.test(pattern.slice(i))) return true;
        } else {
          return true;
        }
      }
      continue;
    }

    // Quantifier inside a group body (applied to an atom or class)
    if (isQuantifierChar(c) || (c === '{' && BRACE_QUANT.test(pattern.slice(i)))) {
      if (stack.length > 0) {
        stack[stack.length - 1] = true;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return false;
}

/**
 * Hard length cap for search patterns (SEC-01).  A legitimate code
 * search pattern never needs to exceed this.
 */
export const MAX_PATTERN_LENGTH = 200;
