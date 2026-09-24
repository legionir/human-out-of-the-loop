/**
 * C1 (CLI completion): registry introspection.
 *
 *   human-out-of-the-loop models   [--project-root DIR] [--json]
 *   human-out-of-the-loop personas [--project-root DIR] [--json]
 *   human-out-of-the-loop skills   [--project-root DIR] [--json]
 *   human-out-of-the-loop tools    [--project-root DIR] [--json] [--mcp]
 *
 * Lightweight by design: only the registry JSON files are read (validated
 * with the runtime schemas) — no MCP, no LLM, no Orchestrator.  `tools
 * --mcp` is the opt-in exception: it connects to the configured MCP servers
 * to show the tools a run would receive from them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistries } from '../utils/registries.js';
import { describeRegistryLayers, registryLayersFor } from '../../ai/registries/layout.js';
import { color, err, out, renderTable } from '../utils/output.js';
import { loadMcpServerConfigs } from '../../ai/tools/mcp-bootstrap.js';
import { listRemoteModels, modelSources } from '../../ai/models/list-models.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { McpConnector } from '../../ai/tools/mcp-connector.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';

export interface RegistryCommandOptions {
  projectRoot?: string;
  json?: boolean;
}

export interface ToolsCommandOptions extends RegistryCommandOptions {
  /**
   * Phase 30 (P10 follow-up): connect to the MCP servers in
   * `registry/mcp-servers/` and list the tools they actually expose.
   * Without it only the static registry files are read (no processes, no
   * network) — and the tools a *run* would receive from MCP are invisible,
   * which made an MCP config impossible to verify from the CLI.
   */
  mcp?: boolean;
}

/** Dim one-line provenance line: which layers these entries came from. */
function layerNote(opts: RegistryCommandOptions): string {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  return describeRegistryLayers(registryLayersFor(root));
}

/** Resolve projectRoot; prints a hint and returns null when there is no registry/. */
/**
 * Phase 28: a project registry is no longer required — the packaged
 * registry (global) is always available and a project registry (local)
 * overrides it.  Returns null only when NEITHER layer exists.
 */
function resolveProjectRoot(opts: RegistryCommandOptions): string | null {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  if (registryLayersFor(root).length === 0) {
    err(
      color.failed(
        `No registry found for ${root}.` +
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
  if (!opts.json) out(color.dim(layerNote(opts)));
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

export interface ModelsCommandOptions extends RegistryCommandOptions {
  /** Ask the configured providers which models they serve. */
  remote?: boolean;
}

export async function modelsCommand(opts: ModelsCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  if (opts.remote) return remoteModelsCommand(root, opts);
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

export async function toolsCommand(opts: ToolsCommandOptions): Promise<number> {
  const root = resolveProjectRoot(opts);
  if (!root) return 2;
  const loaded = loadRegistries(root);
  const rows: Array<Array<string | number>> = loaded.tools.map((t) => [
    t.id,
    t.name,
    t.source,
    t.category ?? '',
    t.description,
  ]);
  const items: unknown[] = [...loaded.tools];
  let failed = 0;

  if (opts.mcp) {
    const mcp = await collectMcpTools(root);
    failed = mcp.failed;
    // Notes go to stderr when the caller asked for JSON, so the document on
    // stdout stays parseable.
    for (const note of mcp.notes) {
      if (opts.json) err(color.dim(note));
      else out(color.dim(note));
    }
    rows.push(...mcp.rows);
    items.push(...mcp.items);
  }

  const code = render(opts, {
    kind: 'tools',
    items,
    rows,
    header: ['ID', 'NAME', 'SOURCE', 'CATEGORY', 'DESCRIPTION'],
    errors: loaded.errors,
  });
  return failed > 0 ? 1 : code;
}

/**
 * Connect to every configured MCP server, list its tools, and disconnect.
 * A listing must never affect a running plan: it uses its own ToolRegistry
 * and closes every connection (and child process) again.
 */
async function collectMcpTools(root: string): Promise<{
  rows: Array<Array<string | number>>;
  items: unknown[];
  notes: string[];
  failed: number;
}> {
  const dir = path.join(root, 'registry', 'mcp-servers');
  const { configs, errors } = loadMcpServerConfigs(dir);
  const rows: Array<Array<string | number>> = [];
  const items: unknown[] = [];
  const notes: string[] = errors.map((e) => `Invalid MCP config ${e.file}: ${e.error}`);
  let failed = 0;

  if (configs.length === 0) {
    notes.push(`No MCP servers configured in ${path.relative(root, dir) || dir}.`);
    return { rows, items, notes, failed };
  }

  const registry = new ToolRegistry();
  const connector = new McpConnector({ toolRegistry: registry });
  try {
    for (const config of configs) {
      const ok = await connector.connectServer(config);
      const state = connector.getServerState(config.id);
      if (!ok) {
        failed++;
        notes.push(`✖ ${config.id} (${config.transport}) — ${state?.lastError ?? 'connection failed'}`);
        continue;
      }
      const ids = state?.toolIds ?? [];
      notes.push(`✔ ${config.id} (${config.transport}) — ${ids.length} tool(s)`);
      for (const id of ids) {
        const definition = registry.getDefinition(id);
        rows.push([id, definition?.name ?? id, `mcp:${config.id}`, 'mcp', definition?.description ?? '']);
        items.push({ ...(definition ?? { id }), mcpServerId: config.id, transport: config.transport });
      }
    }
  } finally {
    await connector.closeAll();
  }
  return { rows, items, notes, failed };
}

/** `models --remote`: the models the providers serve, usable as --model specs. */
async function remoteModelsCommand(root: string, opts: ModelsCommandOptions): Promise<number> {
  prepareCliEnvironment(root);
  const sources = modelSources(process.env);
  if (sources.length === 0) {
    err(
      color.failed('No provider to ask.') +
        color.dim(' Set HOTL_BASE_URL (+ HOTL_API_KEY), OPENAI_API_KEY or ANTHROPIC_API_KEY.'),
    );
    return 1;
  }
  const list = await listRemoteModels(process.env);
  if (opts.json) {
    out(JSON.stringify(list, null, 2));
  } else {
    if (list.models.length > 0) {
      out(renderTable(['MODEL (use with --model)', 'SOURCE'], list.models.map((m) => [m.spec, m.source])));
    }
    for (const e of list.errors) err(color.failed(`${e.source}: ${e.error}`));
  }
  return list.models.length > 0 ? 0 : 1;
}
