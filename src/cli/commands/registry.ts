/**
 * C1 (CLI completion): registry introspection.
 *
 *   human-out-of-the-loop models   [--project-root DIR] [--json]
 *   human-out-of-the-loop personas [--project-root DIR] [--json]
 *   human-out-of-the-loop skills   [--project-root DIR] [--json]
 *   human-out-of-the-loop tools    [--project-root DIR] [--json]
 *
 * Lightweight by design: only the registry JSON files are read (validated
 * with the runtime schemas) — no MCP, no LLM, no Orchestrator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistries } from '../utils/registries.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface RegistryCommandOptions {
  projectRoot?: string;
  json?: boolean;
}

/** Resolve projectRoot; prints a hint and returns null when there is no registry/. */
function resolveProjectRoot(opts: RegistryCommandOptions): string | null {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  if (!fs.existsSync(path.join(root, 'registry'))) {
    err(
      color.failed(
        `No "registry/" directory in ${root}.` +
          ' Pass --project-root or run inside a project that has one.',
      ),
    );
    return null;
  }
  return root;
}

interface RenderInput<T> {
  kind: string;
  items: T[];
  rows: Array<Array<string | number>>;
  header: string[];
  errors: ReturnType<typeof loadRegistries>['errors'];
}

function render<T>(opts: RegistryCommandOptions, input: RenderInput<T>): number {
  const { kind, items, rows, header, errors } = input;
  if (items.length === 0) {
    out(color.dim(`No ${kind} registered (registry/${kind}/*.json is empty or missing).`));
  } else if (opts.json) {
    out(JSON.stringify(items, null, 2));
  } else {
    out(renderTable(header, rows));
  }
  for (const e of errors) out(color.failed(`Invalid file ${e.file}: ${e.error}`));
  return errors.length > 0 ? 1 : 0;
}

export async function modelsCommand(opts: RegistryCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  const loaded = loadRegistries(root);
  return render(opts, {
    kind: 'models',
    items: loaded.models,
    rows: loaded.models.map((m) => [m.id, m.provider, m.model, m.description ?? '']),
    header: ['ID', 'PROVIDER', 'MODEL', 'DESCRIPTION'],
    errors: loaded.errors,
  });
}

export async function personasCommand(opts: RegistryCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  const loaded = loadRegistries(root);
  return render(opts, {
    kind: 'personas',
    items: loaded.personas,
    rows: loaded.personas.map((p) => [
      p.id,
      p.name,
      p.allowedTools.length === 0 ? '(none)' : p.allowedTools.join(', '),
      p.description ?? '',
    ]),
    header: ['ID', 'NAME', 'ALLOWED TOOLS', 'DESCRIPTION'],
    errors: loaded.errors,
  });
}

export async function skillsCommand(opts: RegistryCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  const loaded = loadRegistries(root);
  return render(opts, {
    kind: 'skills',
    items: loaded.skills,
    rows: loaded.skills.map((s) => [s.id, s.name, s.version, s.tools.join(', ') || '']),
    header: ['ID', 'NAME', 'VERSION', 'TOOLS'],
    errors: loaded.errors,
  });
}

export async function toolsCommand(opts: RegistryCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  const loaded = loadRegistries(root);
  return render(opts, {
    kind: 'tools',
    items: loaded.tools,
    rows: loaded.tools.map((t) => [t.id, t.name, t.source, t.category ?? '', t.description]),
    header: ['ID', 'NAME', 'SOURCE', 'CATEGORY', 'DESCRIPTION'],
    errors: loaded.errors,
  });
}
