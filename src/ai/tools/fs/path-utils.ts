/**
 * Phase 33 — path utilities, ported from the MCP reference filesystem server
 * (`servers-main/src/filesystem/path-utils.ts`).
 *
 * The reference server documents the two traps this module exists for:
 *
 *   1. A model (or a hostile file it read) can hand us a path in a shape the
 *      host does not mean the way it looks.  `~/notes` means the home
 *      directory, `C:\Users\me` on a Linux host is NOT a Windows path but a
 *      relative file name, `/c/Users/me` is a Windows drive path written the
 *      Unix way, and `/mnt/c/...` inside WSL is a perfectly valid Linux path
 *      that must never be "converted".
 *   2. Trimming/normalizing must not change what the path *means*: quotes and
 *      trailing separators are noise, `//` and `..` are not.
 *
 * Everything here is pure and platform-aware, so the security check in
 * `path-validation.ts` and the resolver in `lib.ts` can rely on it.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Converts Unix-style Windows paths (`/c/...`) to Windows format.
 *
 * WSL paths (`/mnt/...`) are returned unchanged on purpose: they are valid
 * Linux paths that Node's `fs` handles correctly inside WSL, and converting
 * them to `C:\...` would break every filesystem call.
 */
export function convertToWindowsPath(p: string): string {
  // Handle WSL paths (/mnt/c/...)
  if (p.startsWith('/mnt/')) return p;

  // Unix-style Windows paths (/c/...) — only meaningful on Windows.
  if (p.match(/^\/[a-zA-Z]\//) && process.platform === 'win32') {
    const driveLetter = p.charAt(1).toUpperCase();
    const pathPart = p.slice(2).replace(/\//g, '\\');
    return `${driveLetter}:${pathPart}`;
  }

  // Standard Windows paths, ensuring backslashes.
  if (p.match(/^[a-zA-Z]:/)) return p.replace(/\//g, '\\');

  return p;
}

/**
 * Normalize a path without changing its meaning (see the module header).
 *
 * Removes surrounding quotes/whitespace, collapses duplicate separators,
 * drops a trailing separator, and lets `path.normalize` resolve `.`/`..`.
 * Unix paths stay Unix (including `/mnt/...`), Windows drive paths stay
 * Windows with a capitalized drive letter and the right separators.
 */
export function normalizePath(p: string): string {
  // Remove surrounding quotes and whitespace
  p = p.trim().replace(/^["']|["']$/g, '');

  const isUnixPath =
    p.startsWith('/') &&
    // WSL paths always stay as they are
    (Boolean(p.match(/^\/mnt\/[a-z]\//i)) ||
      // On non-Windows platforms every absolute path is a Unix path
      process.platform !== 'win32' ||
      // On Windows, keep Unix paths that are not Windows drive paths
      (process.platform === 'win32' && !p.match(/^\/[a-zA-Z]\//)));

  if (isUnixPath) {
    return p.replace(/\/+/g, '/').replace(/(?<!^)\/$/, '');
  }

  p = convertToWindowsPath(p);

  if (p.startsWith('\\\\')) {
    // UNC paths: exactly two leading backslashes, single ones after that.
    const uncPath = p.replace(/^\\{2,}/, '\\\\');
    const restOfPath = uncPath.substring(2).replace(/\\\\/g, '\\');
    p = '\\\\' + restOfPath;
  } else {
    p = p.replace(/\\\\/g, '\\');
  }

  // A bare drive letter would normalize to "C:." and break the security check.
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(p)) {
    p = p + path.sep;
  }

  let normalized = path.normalize(p);

  // `path.normalize` can drop a leading backslash of a UNC path
  if (p.startsWith('\\\\') && !normalized.startsWith('\\\\')) {
    normalized = '\\' + normalized;
  }

  if (normalized.match(/^[a-zA-Z]:/)) {
    let result = normalized.replace(/\//g, '\\');
    if (/^[a-z]:/.test(result)) {
      result = result.charAt(0).toUpperCase() + result.slice(1);
    }
    return result;
  }

  if (process.platform === 'win32') {
    return normalized.replace(/\//g, '\\');
  }

  return normalized;
}

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}
