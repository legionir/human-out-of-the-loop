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
import { envDefaultModelId } from './registries.js';

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

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(n|r|t|\\|")/g, (_m, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    if (ch === '\\') return '\\';
    return '"';
  });
}

function closedQuote(text: string, quote: '"' | "'"): boolean {
  if (!text.startsWith(quote)) return false;
  let escaped = false;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return true;
  }
  return false;
}

function parseQuoted(raw: string, quote: '"' | "'"): { value: string; rest: string } | undefined {
  if (!raw.startsWith(quote)) return undefined;
  let escaped = false;
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      const inner = raw.slice(1, i);
      return {
        value: quote === '"' ? unescapeDoubleQuoted(inner) : inner,
        rest: raw.slice(i + 1),
      };
    }
  }
  return undefined;
}

/**
 * G-16: parse a `.env` body.  Understands `export`, inline comments, quotes,
 * escaped `\n` inside double quotes, and multiline quoted values.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    let line = lines[i]!;
    i += 1;
    let trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^export\s+/.test(trimmed)) trimmed = trimmed.replace(/^export\s+/, '');
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) continue;
    let raw = trimmed.slice(eq + 1);
    const leading = raw.trimStart();
    const quote = leading.startsWith('"') ? '"' : leading.startsWith("'") ? "'" : null;
    if (quote) {
      raw = leading;
      while (!closedQuote(raw, quote) && i < lines.length) {
        raw += '\n' + lines[i]!;
        i += 1;
      }
      const parsed = parseQuoted(raw, quote);
      if (parsed) {
        result[key] = parsed.value;
        continue;
      }
    }
    let value = raw.trim();
    const comment = value.search(/\s+#/);
    if (comment >= 0) value = value.slice(0, comment).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Minimal .env loader (step 4: ".env support for API keys").
 *
 * Reads KEY=VALUE lines from the given files (in order) and sets any
 * variable that is NOT already present in the environment — the real
 * environment always wins.  Never throws.
 *
 * Returns the keys this call actually assigned (so `/cd` can drop them).
 */
export function loadDotEnv(dirs: Array<string | undefined>): string[] {
  const applied: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, '.env');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // no .env here — fine
    }
    const parsed = parseDotEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied.push(key);
      }
    }
  }
  return applied;
}

/** Drop keys previously applied from a project's `.env` (G-03). */
export function unsetEnvKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

export interface ResolveCliDefaultsInput {
  projectRoot?: string;
  persistent?: boolean;
  noPersistent?: boolean;
  model?: string;
  cwd?: string;
  /** Server defaults persistent to true; CLI/REPL default to false. */
  defaultPersistent?: boolean;
}

export interface ResolvedCliDefaults {
  projectRoot: string;
  persistent: boolean;
  model?: string;
  global: GlobalCliConfig;
}

/**
 * G-17: one resolution path for `run`, the REPL, `plans`, and the server.
 * Precedence: flags > env (`HOTL_PROJECT_ROOT`) > global config > cwd / default.
 */
export function resolveCliDefaults(input: ResolveCliDefaultsInput = {}): ResolvedCliDefaults {
  const cwd = input.cwd ?? process.cwd();
  const global = loadGlobalConfig();
  const projectRoot = path.resolve(
    input.projectRoot ??
      process.env.HOTL_PROJECT_ROOT ??
      (global.projectRoot ? path.resolve(cwd, global.projectRoot) : cwd),
  );
  loadDotEnv([projectRoot, cwd]);
  const persistent = input.noPersistent
    ? false
    : (input.persistent ?? global.persistent ?? input.defaultPersistent ?? false);
  const model = input.model ?? envDefaultModelId(projectRoot) ?? global.defaultModel;
  return {
    projectRoot,
    persistent,
    model,
    global,
  };
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
