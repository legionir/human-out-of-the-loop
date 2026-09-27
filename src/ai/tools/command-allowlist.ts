/**
 * Project allowlist for `run_command` / `run_tests`.
 *
 * Source (first match wins for each field):
 *   1. `.ai-runtime/commands.json`
 *   2. `HOTL_ALLOWED_COMMANDS` / `HOTL_TEST_COMMAND`
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_COMMAND_MAX_BYTES, DEFAULT_COMMAND_TIMEOUT_MS } from './spawn-argv.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh']);

export interface CommandPolicy {
  allow: string[];
  testCommand: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export function commandsConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.ai-runtime', 'commands.json');
}

export function loadCommandPolicy(projectRoot: string, env: NodeJS.ProcessEnv = process.env): CommandPolicy {
  let file: Partial<CommandPolicy> = {};
  const configPath = commandsConfigPath(projectRoot);
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<CommandPolicy>;
  } catch {
    file = {};
  }
  const envAllow = (env.HOTL_ALLOWED_COMMANDS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const envTest = (env.HOTL_TEST_COMMAND ?? '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    allow: Array.isArray(file.allow) && file.allow.length > 0 ? file.allow.map(String) : envAllow,
    testCommand:
      Array.isArray(file.testCommand) && file.testCommand.length > 0
        ? file.testCommand.map(String)
        : envTest,
    timeoutMs:
      typeof file.timeoutMs === 'number' && file.timeoutMs >= 100
        ? file.timeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes:
      typeof file.maxOutputBytes === 'number' && file.maxOutputBytes >= 64
        ? file.maxOutputBytes
        : DEFAULT_COMMAND_MAX_BYTES,
  };
}

export function commandBasename(argv0: string): string {
  return path.basename(argv0).toLowerCase();
}

export function isForbiddenShell(argv0: string): boolean {
  return SHELLS.has(commandBasename(argv0));
}

export function isCommandAllowed(argv0: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return false;
  if (isForbiddenShell(argv0)) return false;
  const base = commandBasename(argv0);
  return allow.some((entry) => commandBasename(entry) === base);
}
