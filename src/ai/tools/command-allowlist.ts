/**
 * Project allowlist for `run_command` / `run_tests`.
 *
 * Source (first match wins for each field):
 *   1. `.ai-runtime/commands.json` — project-controlled, so it is honoured
 *      only for a trusted project (R0-08: a cloned repo must not be able to
 *      run code just because someone ran hootl in it);
 *   2. `HOTL_ALLOWED_COMMANDS` / `HOTL_TEST_COMMAND` from the environment.
 *
 * An allowlist entry is matched against argv[0] exactly: a bare name
 * (`npm`) matches only a bare `npm` resolved through PATH, never
 * `./scripts/npm` — otherwise an agent could write its own `npm` and run it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_COMMAND_MAX_BYTES, DEFAULT_COMMAND_TIMEOUT_MS } from './spawn-argv.js';
import { isRootTrusted } from '../registries/trust.js';
import { SECRET_NAME_PATTERNS } from '../runtime/secret-scrub.js';

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
  if (isRootTrusted(projectRoot)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<CommandPolicy>;
    } catch {
      file = {};
    }
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

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/**
 * argv[0] is allowed when it equals an allowlist entry: a bare name only
 * matches the same bare name, a path only the same absolute path.
 */
export function isCommandAllowed(argv0: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return false;
  if (isForbiddenShell(argv0)) return false;
  if (!hasPathSeparator(argv0)) {
    return allow.some((entry) => !hasPathSeparator(entry) && entry === argv0);
  }
  if (!path.isAbsolute(argv0)) return false;
  const resolved = path.resolve(argv0);
  return allow.some((entry) => path.isAbsolute(entry) && path.resolve(entry) === resolved);
}

/**
 * The environment a command child gets: the parent's, minus every variable
 * whose NAME marks it as a credential (API keys, tokens, passwords).
 */
export function commandChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const needles = SECRET_NAME_PATTERNS.map((p) => p.toLowerCase());
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (needles.some((needle) => lower.includes(needle))) continue;
    out[key] = value;
  }
  return out;
}
