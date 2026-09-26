/**
 * Phase 23 (CLI, step 4): configuration.
 *
 *   - `~/.human-out-of-the-loop/config.json` — user-level defaults
 *   - `.env` in projectRoot / cwd — API keys and env defaults
 *
 * Precedence (highest first):
 *   CLI flags > environment variables > global config file
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GlobalCliConfig {
  /** Use persistent stores (.ai-runtime) by default */
  persistent?: boolean;
  /** Default model id (OrchestratorConfig.defaultModelId) */
  defaultModel?: string;
  /** Default project root (relative paths resolve against the cwd) */
  projectRoot?: string;
  /**
   * v27.17.0: how goals are handled by default — `auto` (the planner decides
   * between a plan and a chat answer), `chat` (never plan) or `plan` (never
   * answer).  `--mode` and an `@chat`/`@plan` prefix win over it.
   */
  defaultMode?: string;
  /** R0-08: project roots the operator has explicitly trusted to run their own registry/mcp-servers. */
  trustedProjects?: string[];
}

export function globalConfigPath(): string {
  return path.join(os.homedir(), '.human-out-of-the-loop', 'config.json');
}

/** Load `~/.human-out-of-the-loop/config.json` (missing/invalid → {}). */
export function loadGlobalConfig(): GlobalCliConfig {
  try {
    const raw = fs.readFileSync(globalConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as GlobalCliConfig;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Minimal .env loader (step 4: ".env support for API keys").
 *
 * Reads KEY=VALUE lines from the given files (in order) and sets any
 * variable that is NOT already present in the environment — the real
 * environment always wins.  Never throws.
 */
export function loadDotEnv(dirs: Array<string | undefined>): void {
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, '.env');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // no .env here — fine
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip optional surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Resolve the effective CLI defaults: global config + .env loading.
 * `dirs` are .env search locations (projectRoot, then cwd).
 */
export function prepareCliEnvironment(projectRoot: string): GlobalCliConfig {
  loadDotEnv([projectRoot, process.cwd()]);
  return loadGlobalConfig();
}

/**
 * Write `~/.human-out-of-the-loop/config.json` (the interactive `/config set`).
 * Keys set to `undefined` are removed.  Throws on I/O errors so the caller
 * can report them.
 */
export function saveGlobalConfig(config: GlobalCliConfig): void {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
}
