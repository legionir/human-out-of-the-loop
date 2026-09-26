/**
 * R0-08 — a project's own `registry/mcp-servers/*.json` spawns a stdio
 * process (and may send arbitrary env vars named by `tokenEnvVar`/
 * `keyEnvVar` to any URL) on the very first `initialize()` of a project —
 * even for a single chat question. A malicious cloned repo must not get
 * code execution just because someone ran `hootl` in it.
 *
 * This module tracks which project roots the operator has explicitly
 * trusted (persisted in the global CLI config, `~/.human-out-of-the-loop/
 * config.json`), independent of any one CLI command.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TrustConfig {
  /** Absolute, normalized project root paths the operator has trusted. */
  trustedProjects?: string[];
}

function normalize(root: string): string {
  return path.resolve(root);
}

/** True if `root` is in the trusted list (path-normalized comparison). */
export function isProjectTrusted(root: string, config: TrustConfig): boolean {
  const target = normalize(root);
  const list = config.trustedProjects ?? [];
  return list.some((p) => normalize(p) === target);
}

/** Returns a config with `root` added to `trustedProjects` (idempotent). */
export function withTrustedProject(root: string, config: TrustConfig): TrustConfig {
  const target = normalize(root);
  const list = config.trustedProjects ?? [];
  if (list.some((p) => normalize(p) === target)) return config;
  return { ...config, trustedProjects: [...list, target] };
}

/** Best-effort read of just the trusted-projects list, never throws. */
export function loadTrustedProjects(configPath: string): string[] {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TrustConfig;
    return parsed.trustedProjects ?? [];
  } catch {
    return [];
  }
}
