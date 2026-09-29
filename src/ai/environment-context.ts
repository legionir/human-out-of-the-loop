import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { localTimeZone, timeInZone } from './tools/time/tz.js';

export type ShellFamily = 'posix' | 'cmd' | 'powershell' | 'unknown';

/** The instant + zone the block reports. */
export interface EnvironmentClock {
  formatted: string;
  timeZone: string;
  utcOffset: string;
  dayOfWeek: string;
  isDST: boolean;
}

export interface EnvironmentFacts {
  platform: NodeJS.Platform;
  osName: string;
  osVersion: string;
  osRelease: string;
  arch: string;
  nodeVersion: string;
  shell: string;
  shellFamily: ShellFamily;
  pathSeparator: string;
  pathJoinExample: string;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  wslDistro?: string;
  caseSensitive: boolean;
  lineEnding: 'LF' | 'CRLF';
  now: EnvironmentClock;
}

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
  if (platform === 'win32') return env.PSModulePath ? 'powershell' : 'cmd';
  return 'posix';
}

function detectShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') return env.PSModulePath ? 'PowerShell' : (env.ComSpec ?? 'cmd.exe');
  if (env.SHELL) return env.SHELL;
  return '/bin/sh';
}

/** Collect host facts; arguments are injectable for platform-specific tests. */
export function collectEnvironmentFacts(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EnvironmentFacts {
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  const wslDistro = isLinux ? env.WSL_DISTRO_NAME : undefined;

  let osName: string;
  if (isWindows) osName = os.version() || `Windows (${os.release()})`;
  else if (isMac) osName = `macOS (Darwin ${os.release()})`;
  else if (isLinux) osName = linuxPrettyName() ?? `Linux (${os.release()})`;
  else osName = `${platform} (${os.release()})`;

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

/** Prompt-formatting exports remain here for compatibility. */
export { environmentBullets, buildEnvironmentContext } from './prompts/environment.js';
