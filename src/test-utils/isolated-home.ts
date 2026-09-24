/**
 * Point "the user's home" at a temporary directory for a test.
 *
 * `os.homedir()` is not `process.env.HOME` everywhere: on Windows it reads
 * `USERPROFILE` (falling back to `HOMEDRIVE`+`HOMEPATH`), so a test that only
 * sets `HOME` silently keeps using the real home directory of the machine
 * running it — green on Linux and macOS, red on Windows, for the wrong reason.
 *
 * Set both, restore both.  Usage:
 *
 *   const home = useIsolatedHome();          // returns the temp dir
 *   …
 *   restoreHome();
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HomeHandle {
  /** The temporary home directory (a fresh one per call). */
  home: string;
  /** Restore the previous HOME/USERPROFILE/HOMEDRIVE/HOMEPATH values. */
  restore: () => void;
}

const KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;

export function useIsolatedHome(prefix = 'isolated-home-'): HomeHandle {
  const previous = new Map<string, string | undefined>();
  for (const key of KEYS) previous.set(key, process.env[key]);

  // Windows: HOMEDRIVE+HOMEPATH must not win over the directory we set.
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  return {
    home,
    restore: (): void => {
      for (const key of KEYS) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
