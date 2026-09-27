/**
 * Phase 33 — the containment check, ported from the MCP reference filesystem
 * server (`servers-main/src/filesystem/path-validation.ts`).
 *
 * `isPathWithinAllowedDirectories` answers exactly one question: is this
 * *absolute* path the same as, or below, one of the allowed directories?
 *
 * The details that matter (and that a naive `startsWith` gets wrong):
 *   - `/work/project-evil` must NOT count as inside `/work/project`
 *     (the separator is part of the comparison);
 *   - on Windows `C:\Work` and `c:\work\file.txt` are the same place, and a
 *     drive root (`C:\`) must not produce a double separator;
 *   - the filesystem root (`/`) is a valid allowed directory;
 *   - a null byte is never a valid path;
 *   - a relative path that stays relative after normalization is a
 *     programming error, not a "probably fine" case — the caller must have
 *     resolved it first, and this function throws rather than guessing.
 */
import path from 'node:path';

export function isPathWithinAllowedDirectories(
  absolutePath: string,
  allowedDirectories: string[]
): boolean {
  // Type validation
  if (typeof absolutePath !== 'string' || !Array.isArray(allowedDirectories)) {
    return false;
  }

  // Reject empty inputs
  if (!absolutePath || allowedDirectories.length === 0) {
    return false;
  }

  // Reject null bytes (forbidden in paths)
  if (absolutePath.includes('\x00')) {
    return false;
  }

  let normalizedPath: string;
  try {
    normalizedPath = path.resolve(path.normalize(absolutePath));
  } catch {
    return false;
  }

  if (!path.isAbsolute(normalizedPath)) {
    throw new Error('Path must be absolute after normalization');
  }

  return allowedDirectories.some((dir) => {
    if (typeof dir !== 'string' || !dir) {
      return false;
    }

    if (dir.includes('\x00')) {
      return false;
    }

    let normalizedDir: string;
    try {
      normalizedDir = path.resolve(path.normalize(dir));
    } catch {
      return false;
    }

    if (!path.isAbsolute(normalizedDir)) {
      throw new Error('Allowed directories must be absolute paths after normalization');
    }

    // Inside means the same directory or a subdirectory of it.
    if (normalizedPath === normalizedDir) {
      return true;
    }

    // Filesystem root: avoid the "//" that `dir + sep` would produce.
    if (normalizedDir === path.sep) {
      return normalizedPath.startsWith(path.sep);
    }

    // Windows drive root (e.g. "C:\"): same drive, then below it.
    if (path.sep === '\\' && normalizedDir.match(/^[A-Za-z]:\\?$/)) {
      const dirDrive = normalizedDir.charAt(0).toLowerCase();
      const pathDrive = normalizedPath.charAt(0).toLowerCase();
      return pathDrive === dirDrive && normalizedPath.startsWith(normalizedDir.replace(/\\?$/, '\\'));
    }

    return normalizedPath.startsWith(normalizedDir + path.sep);
  });
}
