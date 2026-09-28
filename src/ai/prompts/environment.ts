import { collectEnvironmentFacts, type EnvironmentFacts } from '../environment-context.js';
export type { EnvironmentFacts, EnvironmentClock, ShellFamily } from '../environment-context.js';

/** The machine facts formatted as concise prompt bullets. */
export function environmentBullets(facts: EnvironmentFacts = collectEnvironmentFacts()): string[] {
  const lines: string[] = [
    `- platform: ${facts.platform} — ${facts.osName} (${facts.arch}), node ${facts.nodeVersion}`,
    `- current time: ${facts.now.formatted.slice(0, 10)} (${facts.now.timeZone}, ${facts.now.utcOffset})`,
    `- default shell: ${facts.shell}${facts.shellFamily === 'posix' ? ' (POSIX sh syntax)' : ''}` +
      `${facts.shellFamily === 'powershell' ? ' (PowerShell syntax, not sh)' : ''}`,
    `- path separator: "${facts.pathSeparator}" — build paths with node:path (path.join('src', 'index.ts') → '${facts.pathJoinExample}'); a hard-coded "\\" only works on Windows and a hard-coded "/" only on POSIX`,
    `- line endings: ${facts.lineEnding} is normal here; do not rewrite a file's endings just because they differ`,
  ];

  if (facts.shellFamily === 'posix') {
    lines.push('- POSIX commands (ls, cat, grep, sed, chmod, rm -rf) are available; Windows commands (dir, type, findstr, copy) are not');
  } else {
    lines.push('- Windows commands (dir, type, findstr, copy, Remove-Item) are available; POSIX commands (ls, cat, grep, chmod, rm -rf) may not exist');
  }
  if (facts.isLinux) {
    lines.push('- GNU userland (grep -P, sed -i, find -printf) is available; the filesystem is case-sensitive');
  }
  if (facts.isMac) {
    lines.push("- BSD userland, not GNU: `sed -i` needs an explicit suffix (`sed -i ''`), `grep -P` does not exist; the default filesystem is case-INSENSITIVE and returns NFD-normalised names");
  }
  if (facts.isWindows) {
    lines.push('- Windows: paths and environment variables are case-insensitive; reserved names (CON, NUL, AUX, COM1, LPT1) cannot be used as file names');
  }
  if (facts.wslDistro) {
    lines.push(`- WSL (${facts.wslDistro}): this is Linux, Windows drives appear under /mnt/c, and the shell is a Linux shell — not cmd.exe`);
  }
  return lines;
}

/** Environment block for system prompts without a project-context section. */
export function buildEnvironmentContext(facts?: EnvironmentFacts): string {
  return [
    'ENVIRONMENT (the machine this runtime runs on — commands and paths must match it):',
    ...environmentBullets(facts),
  ].join('\n');
}
