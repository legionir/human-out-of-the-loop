/**
 * Phase 28: registry layering (project + package).
 *
 * A project may ship its own `registry/` (personas, tools, skills, models,
 * MCP servers, agents.json).  That is the "local" layer and always wins over
 * the "global" layer — the `registry/` that ships with this package — so the
 * CLI works from ANY directory while still allowing per-project overrides.
 *
 * Layer order is deliberate: the package layer loads FIRST and the project
 * layer SECOND, with `override: true`, so a project entry with the same id
 * replaces the packaged default while every other packaged entry stays
 * available.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type RegistryScope = 'package' | 'project';

export interface RegistryLayer {
  /** Absolute path to the `registry/` directory of this layer. */
  dir: string;
  scope: RegistryScope;
  /** Absolute path to the layer root (the directory containing `registry/`). */
  root: string;
}

export interface RegistryLayerOptions {
  /**
   * Skip the packaged (global) layer and use only the project's own
   * registry.  Defaults to the `HOTL_NO_PACKAGE_REGISTRY` env var
   * (`1`/`true` → skip) — useful for hermetic runs and tests.
   */
  includePackageLayer?: boolean;
  /** Environment used to read `HOTL_NO_PACKAGE_REGISTRY` (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The `registry/` subdirectory name (single source of truth). */
export const REGISTRY_DIRNAME = 'registry';

/**
 * Locate the directory of this package — the one containing both
 * `package.json` and `registry/`.  The lookup walks up from this module
 * so it works in every layout:
 *
 *   - source checkouts: `<repo>/src/ai/registries/layout.ts`
 *   - builds:          `<repo>/dist/src/ai/registries/layout.js`
 *   - installed/global: `<prefix>/lib/node_modules/human-out-of-the-loop/…`
 *
 * Returns `undefined` when no packaged registry can be found (the caller
 * then simply runs with the project layer only).
 */
export function packageRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const hasManifest = fs.existsSync(path.join(dir, 'package.json'));
    const hasRegistry = fs.existsSync(path.join(dir, REGISTRY_DIRNAME));
    if (hasManifest && hasRegistry) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/** Absolute path to the packaged registry, or undefined when unavailable. */
export function packageRegistryDir(): string | undefined {
  const root = packageRoot();
  return root ? path.join(root, REGISTRY_DIRNAME) : undefined;
}

/** True when the project ships its own registry directory. */
export function hasProjectRegistry(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, REGISTRY_DIRNAME));
}

/**
 * Resolve the ordered registry layers for a project.
 *
 * Always returns at least one entry when either layer exists; the array is
 * ordered from LOWEST to HIGHEST precedence (package → project).
 */
export function registryLayersFor(
  projectRoot: string,
  options: RegistryLayerOptions = {}
): RegistryLayer[] {
  const env = options.env ?? process.env;
  const envSaysSkip = /^(1|true|yes)$/i.test(env.HOTL_NO_PACKAGE_REGISTRY ?? '');
  const includePackage =
    options.includePackageLayer ?? !envSaysSkip;

  const layers: RegistryLayer[] = [];
  const pkgRoot = packageRoot();
  const projectDir = path.join(projectRoot, REGISTRY_DIRNAME);
  const projectIsPackageRoot =
    pkgRoot !== undefined && path.resolve(pkgRoot) === path.resolve(projectRoot);

  if (includePackage && pkgRoot && !projectIsPackageRoot) {
    layers.push({
      dir: path.join(pkgRoot, REGISTRY_DIRNAME),
      scope: 'package',
      root: pkgRoot,
    });
  }

  if (fs.existsSync(projectDir)) {
    layers.push({ dir: projectDir, scope: 'project', root: projectRoot });
  }

  return layers;
}

/**
 * Human-readable one-liner describing the active layers (CLI diagnostics).
 * Example: `registry: project (./app) + package (built-in)`.
 */
export function describeRegistryLayers(layers: RegistryLayer[], cwd = process.cwd()): string {
  if (layers.length === 0) return 'registry: none found';
  return (
    'registry: ' +
    layers
      .map((layer) => {
        if (layer.scope === 'package') return 'package (built-in)';
        const rel = path.relative(cwd, layer.root) || '.';
        return `project (${rel})`;
      })
      .join(' + ')
  );
}
