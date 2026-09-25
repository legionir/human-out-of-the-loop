/**
 * Phase 36 — what the runtime knows about the machine it is on.
 *
 * A model that is told "the project is at /home/x/app" still writes
 * `rm -rf build && pytest` on Windows, `sed -i 's/a/b/'` on macOS (BSD `sed`
 * needs a suffix) and `C:\\Users\\…` inside a script that runs on Linux. None of
 * that is a reasoning failure: the model was never told *which* machine it is
 * writing for, and "linux" alone does not distinguish GNU from BSD userland.
 *
 * This module turns `node:os` and the process environment into a short, stable
 * block of facts — shell, platform and its version, path separator, line
 * endings, filesystem case sensitivity — and hands it to both entry points:
 * `PROJECT CONTEXT` in the planner prompts (phase 32) and the agent system
 * prompt. The block is bullet-list text, deterministic per host, and small
 * (a few hundred characters), so it is safe to repeat on every call.
 *
 * Everything here is best-effort: `/etc/os-release` may not exist, `SHELL` may
 * be unset under a service manager, and a remote session may be WSL. Each fact
 * falls back rather than throwing, because a missing OS name must never break a
 * plan.
 */
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { localTimeZone, timeInZone } from './tools/time/tz.js';

export type ShellFamily = 'posix' | 'cmd' | 'powershell' | 'unknown';

/** The instant + zone the block reports (phase 38). */
export interface EnvironmentClock {
  /** `2026-09-25 04:12:33` in the machine's own zone. */
  formatted: string;
  /** IANA name, e.g. `Asia/Tehran`. */
  timeZone: string;
  /** `GMT+03:30`. */
  utcOffset: string;
  /** `Friday` */
  dayOfWeek: string;
  isDST: boolean;
}

export interface EnvironmentFacts {
  /** `process.platform` — 'linux' | 'darwin' | 'win32' | … */
  platform: NodeJS.Platform;
  /** Human name + version: "Windows 11 Pro", "macOS (Darwin 24.5.0)", "Debian GNU/Linux 12". */
  osName: string;
  osVersion: string;
  osRelease: string;
  arch: string;
  nodeVersion: string;
  /** The shell a command will actually be executed by, as best we can tell. */
  shell: string;
  shellFamily: ShellFamily;
  /** `path.sep` for this host. */
  pathSeparator: string;
  /** A ready example of `path.join` output on this host. */
  pathJoinExample: string;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  /** WSL distro name when the Linux we are running under is WSL. */
  wslDistro?: string;
  /**
   * Whether the filesystem is case-sensitive for *lookups*.
   * 'no' = case-insensitive (default macOS and Windows volumes) — a plan must
   * not treat `README.md` and `readme.md` as two files there.
   */
  caseSensitive: boolean;
  /** Line ending a text file usually has on this host. */
  lineEnding: 'LF' | 'CRLF';
  /** The clock, in the machine's own zone (phase 38). */
  now: EnvironmentClock;
}

/** `/etc/os-release` `PRETTY_NAME`, the friendliest Linux identification. */
function linuxPrettyName(): string | undefined {
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf-8');
    const match = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(raw);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function detectShellFamily(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellFamily {
  if (platform === 'win32') {
    // PowerShell exports PSModulePath into child processes; ComSpec is the
    // fallback for a plain cmd.exe session.
    if (env.PSModulePath) return 'powershell';
    return 'cmd';
  }
  return 'posix';
}

function detectShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return env.PSModulePath ? 'PowerShell' : (env.ComSpec ?? 'cmd.exe');
  }
  if (env.SHELL) return env.SHELL;
  // No SHELL: a container running `sh -c` is the common case.
  return '/bin/sh';
}

/**
 * Collect the facts.  `env`/`platform` are injectable so the Windows, macOS and
 * Linux branches are all testable from one host.
 */
export function collectEnvironmentFacts(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): EnvironmentFacts {
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  const wslDistro = isLinux ? env.WSL_DISTRO_NAME : undefined;

  let osName: string;
  if (isWindows) {
    osName = os.version() || `Windows (${os.release()})`;
  } else if (isMac) {
    osName = `macOS (Darwin ${os.release()})`;
  } else if (isLinux) {
    osName = linuxPrettyName() ?? `Linux (${os.release()})`;
  } else {
    osName = `${platform} (${os.release()})`;
  }

  const pathSeparator = isWindows ? '\\' : '/';
  const pathJoinExample = ['src', 'index.ts'].join(pathSeparator);

  const zone = localTimeZone();
  const clock = timeInZone(zone, new Date());

  return {
    platform,
    osName,
    osVersion: os.version(),
    osRelease: os.release(),
    arch: process.arch,
    nodeVersion: process.version,
    shell: detectShell(env, platform),
    shellFamily: detectShellFamily(env, platform),
    pathSeparator,
    pathJoinExample,
    isWindows,
    isMac,
    isLinux,
    ...(wslDistro ? { wslDistro } : {}),
    // Windows and the default macOS volume are case-insensitive; a Linux
    // filesystem is not (unless it is one of the rare ciopfs/FAT mounts).
    caseSensitive: !isWindows && !isMac,
    lineEnding: isWindows ? 'CRLF' : 'LF',
    now: {
      formatted: clock.formatted,
      timeZone: zone,
      utcOffset: clock.utcOffset,
      dayOfWeek: clock.dayOfWeek,
      isDST: clock.isDST,
    },
  };
}

/**
 * The facts as the bullets that go into a prompt.  Everything a model needs to
 * pick the right command, and nothing about *this* project (the planner adds
 * the root and the top-level entries itself).
 */
export function environmentBullets(facts: EnvironmentFacts = collectEnvironmentFacts()): string[] {
  const lines: string[] = [
    `- platform: ${facts.platform} — ${facts.osName} (${facts.arch}), node ${facts.nodeVersion}`,
    // Phase 38: the clock.  A model that does not know today's date invents it,
    // and a plan that says "the release from last week" depends on it.  The
    // `get_current_time` tool is the precise form of this; one line here keeps
    // the common case from needing a tool call at all.
    `- current time: ${facts.now.formatted} (${facts.now.timeZone}, ${facts.now.utcOffset})`,
    `- default shell: ${facts.shell}${facts.shellFamily === 'posix' ? ' (POSIX sh syntax)' : ''}` +
      `${facts.shellFamily === 'powershell' ? ' (PowerShell syntax, not sh)' : ''}`,
    `- path separator: "${facts.pathSeparator}" — build paths with node:path (path.join('src', 'index.ts') → '${facts.pathJoinExample}'); a hard-coded "\\" only works on Windows and a hard-coded "/" only on POSIX`,
    `- line endings: ${facts.lineEnding} is normal here; do not rewrite a file's endings just because they differ`,
  ];

  if (facts.shellFamily === 'posix') {
    lines.push(
      '- POSIX commands (ls, cat, grep, sed, chmod, rm -rf) are available; Windows commands (dir, type, findstr, copy) are not'
    );
  } else {
    lines.push(
      '- Windows commands (dir, type, findstr, copy, Remove-Item) are available; POSIX commands (ls, cat, grep, chmod, rm -rf) may not exist'
    );
  }

  if (facts.isLinux) {
    lines.push(
      '- GNU userland (grep -P, sed -i, find -printf) is available; the filesystem is case-sensitive'
    );
  }
  if (facts.isMac) {
    lines.push(
      "- BSD userland, not GNU: `sed -i` needs an explicit suffix (`sed -i ''`), `grep -P` does not exist; the default filesystem is case-INSENSITIVE and returns NFD-normalised names"
    );
  }
  if (facts.isWindows) {
    lines.push(
      '- Windows: paths and environment variables are case-insensitive; reserved names (CON, NUL, AUX, COM1, LPT1) cannot be used as file names'
    );
  }
  if (facts.wslDistro) {
    lines.push(
      `- WSL (${facts.wslDistro}): this is Linux, Windows drives appear under /mnt/c, and the shell is a Linux shell — not cmd.exe`
    );
  }

  return lines;
}

/**
 * The same bullets under a header, for prompts that have no PROJECT CONTEXT
 * block of their own (the agent system prompt).
 */
export function buildEnvironmentContext(facts?: EnvironmentFacts): string {
  const lines = environmentBullets(facts);
  return [
    'ENVIRONMENT (the machine this runtime runs on — commands and paths must match it):',
    ...lines,
  ].join('\n');
}
