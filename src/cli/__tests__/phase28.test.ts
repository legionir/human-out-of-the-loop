/**
 * Phase 28 — CLI/registry deliverables requested after the P2 closure:
 *
 *   A. `hootl` — the short binary alias + a self-describing help surface
 *      (every command and subcommand documented inside the CLI itself).
 *   B. Registry layering — the packaged ("global") registry and the
 *      project ("local") registry are BOTH loaded and merged by id, with
 *      the project layer winning.  The CLI therefore works from any
 *      directory, and a project can override or extend the built-in
 *      catalog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { main, detectBinName, createProgram } from '../../cli.js';
import {
  packageRoot,
  packageRegistryDir,
  registryLayersFor,
  describeRegistryLayers,
  hasProjectRegistry,
} from '../../ai/registries/layout.js';
import { loadRegistries } from '../utils/registries.js';
import { Orchestrator } from '../../ai/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SRC = path.join(REPO_ROOT, 'registry');

/** Read a packaged registry entry so test fixtures are schema-valid. */
function packaged(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(REGISTRY_SRC, rel), 'utf-8')) as Record<
    string,
    unknown
  >;
}

const personaFixture = (id: string, overrides: Record<string, unknown> = {}) => ({
  ...packaged(path.join('personas', `${id}.json`)),
  ...overrides,
});
const toolFixture = (id: string, overrides: Record<string, unknown> = {}) => ({
  ...packaged(path.join('tools', `${id}.json`)),
  ...overrides,
});

// ─── Helpers ─────────────────────────────────────────────────────

async function runCli(args: Array<string>): Promise<{ code: number; out: string; errOut: string }> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'human-out-of-the-loop', ...args]);
    return { code, out: chunks.join(''), errOut: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExitCode;
  }
}

/** A project directory with an OPTIONAL hand-written registry overlay. */
function makeProject(prefix: string, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return root;
}

// ─── A. CLI help surface ─────────────────────────────────────────

describe('phase 28 — help surface', () => {
  it('detectBinName only shortens the hootl alias', () => {
    expect(detectBinName(['node', '/usr/local/bin/hootl'])).toBe('hootl');
    expect(detectBinName(['node', 'hootl'])).toBe('hootl');
    expect(detectBinName(['node', '/usr/local/bin/human-out-of-the-loop'])).toBe(
      'human-out-of-the-loop'
    );
    // Dev entry points and tests keep the canonical name.
    expect(detectBinName(['node', 'src/cli.ts'])).toBe('human-out-of-the-loop');
    expect(detectBinName(['node'])).toBe('human-out-of-the-loop');
  });

  it('prints the version and exposes it on the program', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
    };
    const program = createProgram('hootl');
    expect(program.version()).toBe(pkg.version);
  });

  it('package.json exposes the hootl binary alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin.hootl).toBe(pkg.bin['human-out-of-the-loop']);
    expect(pkg.bin.hootl).toMatch(/cli\.js$/);
  });

  it('top-level help documents behaviour, layering, config and exit codes', async () => {
    const { code, out } = await runCli(['--help']);
    expect(code).toBe(0);
    for (const phrase of [
      'WHAT THIS TOOL DOES',
      'COMMAND GROUPS',
      'CONFIGURATION PRECEDENCE',
      'REGISTRY LAYERS (global + local, merged)',
      'PROJECT ROOT AND STATE',
      'EXIT CODES',
      'MORE HELP',
      'HOTL_NO_PACKAGE_REGISTRY',
      '~/.human-out-of-the-loop/config.json',
    ]) {
      expect(out).toContain(phrase);
    }
  });

  it('every command and subcommand has a real description plus a how-to appendix', async () => {
    const groups: Array<{ group?: string; sub?: string; mustContain: string[] }> = [
      { group: 'run', mustContain: ['HOW A RUN PROCEEDS', 'INTERACTIVE VS NON-INTERACTIVE', 'NOTES ON THE FLAGS'] },
      { group: 'sessions', sub: 'list', mustContain: ['SUBCOMMANDS', 'WHERE THE DATA LIVES'] },
      { group: 'sessions', sub: 'show', mustContain: ['SUBCOMMANDS'] },
      { group: 'sessions', sub: 'delete', mustContain: ['SUBCOMMANDS'] },
      { group: 'sessions', sub: 'label', mustContain: ['SUBCOMMANDS'] },
      { group: 'plans', sub: 'list', mustContain: ['SUBCOMMANDS', 'PLAN STATES'] },
      { group: 'plans', sub: 'show', mustContain: ['PLAN STATES'] },
      { group: 'plans', sub: 'cancel', mustContain: ['SUBCOMMANDS'] },
      { group: 'plans', sub: 'resume', mustContain: ['SUBCOMMANDS'] },
      { group: 'mcp', sub: 'list', mustContain: ['SUBCOMMANDS', 'CONFIGURATION'] },
      { group: 'mcp', sub: 'test', mustContain: ['CONFIGURATION'] },
      { group: 'tasks', sub: 'list', mustContain: ['SUBCOMMANDS', 'SOURCE'] },
      { group: 'tasks', sub: 'show', mustContain: ['SOURCE'] },
      { group: 'models', mustContain: ['LAYERED RESULT', 'OUTPUT', 'EXIT CODES'] },
      { group: 'personas', mustContain: ['LAYERED RESULT'] },
      { group: 'skills', mustContain: ['LAYERED RESULT'] },
      { group: 'tools', mustContain: ['LAYERED RESULT'] },
      { group: 'usage', mustContain: ['WHAT IT SHOWS'] },
      { group: 'logs', mustContain: ['WHAT IS IN THE LOG', 'BEHAVIOUR', 'SOURCE'] },
    ];

    for (const { group, sub, mustContain } of groups) {
      const args = [group!, ...(sub ? [sub] : []), '--help'];
      const { code, out } = await runCli(args);
      expect(code, `${args.join(' ')} exit code`).toBe(0);
      for (const phrase of mustContain) {
        expect(out, `${args.join(' ')} should document "${phrase}"`).toContain(phrase);
      }
    }
  });

  it('wrapper commands list their subcommands with descriptions (no blank lines)', async () => {
    for (const group of ['sessions', 'plans', 'mcp', 'tasks']) {
      const { out } = await runCli([group, '--help']);
      const commandsSection = out.slice(
        out.indexOf('Commands:'),
        out.indexOf('Commands:') + out.slice(out.indexOf('Commands:')).search(/\n\s*\n/) + 1,
      );
      const commandLines = commandsSection
        .split('\n')
        .filter((line) => /^ {2}\w/.test(line) && !line.includes('help [command]'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        // "name [options] <arg>   description" — a description must follow.
        expect(line.trim().split(/\s{2,}/).length, `undocumented subcommand: ${line}`).toBeGreaterThan(1);
      }
    }
  });

  it('exits quietly when the output pipe is closed early (EPIPE)', async () => {
    // `hootl --help | head -3` must not crash with an unhandled EPIPE.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), '--help'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errChunks: string[] = [];
    child.stderr.on('data', (chunk) => errChunks.push(String(chunk)));
    // Close the reading end BEFORE the process writes anything, so the very
    // first write hits a closed pipe (deterministic EPIPE, no timing race).
    child.stdout.destroy();

    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(errChunks.join('')).not.toContain('EPIPE');
    expect(code).toBe(0);
  });

  it('a bad option points at --help', async () => {
    const { code, errOut } = await runCli(['models', '--nope']);
    expect(code).not.toBe(0);
    expect(errOut).toContain('--help');
  });
});

// ─── B. Registry layering ────────────────────────────────────────

describe('phase 28 — registry layering', () => {
  let projectRoots: string[] = [];
  const env = { ...process.env };
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.HOTL_NO_PACKAGE_REGISTRY;

  beforeEach(() => {
    delete process.env.HOTL_NO_PACKAGE_REGISTRY;
  });

  afterEach(() => {
    for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
    projectRoots = [];
    process.env.HOTL_NO_PACKAGE_REGISTRY = env.HOTL_NO_PACKAGE_REGISTRY;
    if (env.HOTL_NO_PACKAGE_REGISTRY === undefined) delete process.env.HOTL_NO_PACKAGE_REGISTRY;
  });

  const newProject = (files: Record<string, string> = {}): string => {
    const root = makeProject('phase28-', files);
    projectRoots.push(root);
    return root;
  };

  it('locates the packaged registry next to package.json', () => {
    expect(packageRoot()).toBe(REPO_ROOT);
    expect(packageRegistryDir()).toBe(path.join(REPO_ROOT, 'registry'));
    expect(hasProjectRegistry(REPO_ROOT)).toBe(true);
  });

  it('returns the package layer for a project without registry/', () => {
    const root = newProject();
    const layers = registryLayersFor(root);
    expect(layers.map((l) => l.scope)).toEqual(['package']);
    expect(layers[0].dir).toBe(path.join(REPO_ROOT, 'registry'));
  });

  it('orders layers package → project and never duplicates the repo itself', () => {
    const root = newProject({
      'registry/models/extra.json': JSON.stringify({ id: 'extra', provider: 'local', model: 'x' }),
    });
    const layers = registryLayersFor(root);
    expect(layers.map((l) => l.scope)).toEqual(['package', 'project']);
    expect(layers[1].dir).toBe(path.join(root, 'registry'));

    // Inside the package's own repo the project layer already IS the
    // package layer — it must not appear twice.
    expect(registryLayersFor(REPO_ROOT).map((l) => l.scope)).toEqual(['project']);
  });

  it('HOTL_NO_PACKAGE_REGISTRY=1 switches to a strictly local registry', () => {
    const root = newProject({
      'registry/models/only-local.json': JSON.stringify({ id: 'only-local', provider: 'local', model: 'x' }),
    });
    expect(registryLayersFor(root, { env: { HOTL_NO_PACKAGE_REGISTRY: '1' } }).map((l) => l.scope)).toEqual([
      'project',
    ]);
    expect(registryLayersFor(root, { env: {} }).map((l) => l.scope)).toEqual(['package', 'project']);
    // …and an empty project then has no layer at all.
    const empty = newProject();
    expect(registryLayersFor(empty, { env: { HOTL_NO_PACKAGE_REGISTRY: 'true' } })).toEqual([]);
  });

  it('describes the active layers for humans', () => {
    const root = newProject();
    expect(describeRegistryLayers(registryLayersFor(root))).toContain('package (built-in)');
    expect(describeRegistryLayers([], '/tmp')).toBe('registry: none found');
  });

  it('CLI lists the built-in catalog from an empty project (exit 0 + provenance)', async () => {
    const root = newProject();
    const models = await runCli(['models', '--project-root', root, '--json']);
    expect(models.code).toBe(0);
    const parsed = JSON.parse(models.out) as Array<{ id: string }>;
    expect(parsed.map((m) => m.id).sort()).toEqual(['claude-sonnet', 'gpt-4o', 'local-llama']);

    const table = await runCli(['models', '--project-root', root]);
    expect(table.out).toContain('registry: package (built-in)');
    expect(table.out).toContain('gpt-4o');
  });

  it('a project entry overrides the packaged default and extra entries are added', async () => {
    const root = newProject({
      'registry/models/gpt-4o.json': JSON.stringify({
        id: 'gpt-4o',
        provider: 'openai',
        model: 'gpt-4o-LOCAL-OVERRIDE',
        description: 'project override',
      }),
      'registry/models/house-model.json': JSON.stringify({
        id: 'house-model',
        provider: 'local',
        model: 'house-llama',
        description: 'project only',
      }),
    });

    const { code, out } = await runCli(['models', '--project-root', root, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{ id: string; model: string }>;
    expect(parsed.map((m) => m.id).sort()).toEqual([
      'claude-sonnet',
      'gpt-4o',
      'house-model',
      'local-llama',
    ]);
    expect(parsed.find((m) => m.id === 'gpt-4o')?.model).toBe('gpt-4o-LOCAL-OVERRIDE');
    expect(parsed.find((m) => m.id === 'house-model')?.model).toBe('house-llama');

    const table = await runCli(['models', '--project-root', root]);
    expect(table.out).toContain('package (built-in) + project');
  });

  it('loadRegistries merges all four kinds with project precedence', () => {
    const root = newProject({
      'registry/personas/coder.json': JSON.stringify(
        personaFixture('coder', { name: 'Project Coder', description: 'overridden' })
      ),
      'registry/personas/house.json': JSON.stringify(
        personaFixture('coder', { id: 'house', name: 'House Persona' })
      ),
      'registry/tools/read_file.json': JSON.stringify(
        toolFixture('read_file', { name: 'Read File (project)', description: 'project override' })
      ),
    });

    const loaded = loadRegistries(root);
    expect(loaded.layers.map((l) => l.scope)).toEqual(['package', 'project']);
    // Overrides win…
    expect(loaded.personas.find((p) => p.id === 'coder')?.name).toBe('Project Coder');
    expect(loaded.tools.find((t) => t.id === 'read_file')?.name).toBe('Read File (project)');
    // …packaged siblings survive, and project-only entries are added.
    expect(loaded.personas.map((p) => p.id).sort()).toEqual([
      'architect',
      'chat',
      'coder',
      'house',
      'judge',
      'planner',
      'reviewer',
    ]);
    expect(loaded.skills.length).toBeGreaterThan(0); // from the package layer
    expect(loaded.tools.map((t) => t.id).sort()).toEqual([
      // the original four + the phases 33-35 filesystem set + phase 38's trio
      // + phase 39's nine memory tools + phase 40's fetch + phase 41's git reads
      // + phase 42's guarded git writes and PR tools
      'add_observations',
      'convert_time',
      'create_directory',
      'create_entities',
      'create_relations',
      'delete_entities',
      'delete_observations',
      'delete_relations',
      'directory_tree',
      'edit_file',
      'fetch',
      'get_current_time',
      'get_file_info',
      'git_add',
      'git_branch_list',
      'git_checkout',
      'git_commit',
      'git_create_branch',
      'git_diff',
      'git_log',
      'git_pr_comment',
      'git_pr_create',
      'git_pr_list',
      'git_pr_view',
      'git_push',
      'git_remote_list',
      'git_reset',
      'git_show',
      'git_stash',
      'git_status',
      'list_allowed_directories',
      'list_directory',
      'list_directory_with_sizes',
      'move_file',
      'open_nodes',
      'read_file',
      'read_graph',
      'read_media_file',
      'read_multiple_files',
      'search_code',
      'search_files',
      'search_nodes',
      'sequentialthinking',
      'write_file',
      'write_multiple_files',
    ]);
    expect(loaded.errors).toEqual([]);
  });

  it('personas/skills/tools introspection commands use both layers', async () => {
    const root = newProject({
      'registry/personas/house.json': JSON.stringify(
        personaFixture('coder', { id: 'house', name: 'House Persona' })
      ),
    });
    for (const cmd of ['personas', 'skills', 'tools']) {
      const { code, out } = await runCli([cmd, '--project-root', root]);
      expect(code, cmd).toBe(0);
      expect(out, cmd).toContain('registry: package (built-in) + project');
    }
    const personas = await runCli(['personas', '--project-root', root]);
    expect(personas.out).toContain('house');
    expect(personas.out).toContain('architect'); // packaged entry still listed
  });

  it('mcp list merges both layers and lets a project server override by id', async () => {
    const root = newProject({
      'registry/mcp-servers/shared.json': JSON.stringify({
        id: 'shared',
        name: 'Project copy',
        transport: 'http',
        url: 'https://project.example/mcp',
      }),
      'registry/mcp-servers/project-only.json': JSON.stringify({
        id: 'project-only',
        name: 'Project only',
        transport: 'http',
        url: 'https://only.example/mcp',
      }),
    });
    // The packaged layer ships an mcp-servers dir (only a README + .gitkeep),
    // so add a packaged-style server file to prove precedence across layers.
    const packagedServer = path.join(REGISTRY_SRC, 'mcp-servers', 'shared.json');
    const hadPackaged = fs.existsSync(packagedServer);
    if (!hadPackaged) {
      fs.writeFileSync(
        packagedServer,
        JSON.stringify({
          id: 'shared',
          name: 'Packaged copy',
          transport: 'http',
          url: 'https://packaged.example/mcp',
        }),
        'utf-8'
      );
    }
    try {
      const { code, out } = await runCli(['mcp', 'list', '--project-root', root]);
      expect(code).toBe(0);
      expect(out).toContain('project-only');
      expect(out).toContain('Project copy');
      expect(out).toContain('project.example'); // project wins the id clash
      expect(out).not.toContain('packaged.example');
    } finally {
      if (!hadPackaged) fs.rmSync(packagedServer, { force: true });
    }
  });
});

// ─── C. Orchestrator uses the layered registries ─────────────────

describe('phase 28 — Orchestrator loads both layers', () => {
  let projectRoot = '';
  let orchestrator: Orchestrator | undefined;

  afterEach(async () => {
    await orchestrator?.shutdown();
    orchestrator = undefined;
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('merges built-in and project registries, project overriding by id', async () => {
    projectRoot = makeProject('phase28-orch-', {
      'registry/personas/coder.json': JSON.stringify(
        personaFixture('coder', { name: 'Project Coder' })
      ),
      'registry/personas/house.json': JSON.stringify(
        personaFixture('coder', { id: 'house', name: 'House Persona' })
      ),
      'registry/tools/read_file.json': JSON.stringify(
        toolFixture('read_file', { name: 'Read File (project)' })
      ),
    });

    orchestrator = new Orchestrator({ projectRoot });
    await orchestrator.initialize();

    // Project override wins…
    expect(orchestrator.personaRegistry.get('coder')?.name).toBe('Project Coder');
    expect(
      orchestrator.toolRegistry.listDefinitions().find((t) => t.id === 'read_file')?.name
    ).toBe('Read File (project)');
    // …packaged entries survive (personas, tools, skills, models)…
    expect(orchestrator.personaRegistry.get('architect')).toBeDefined();
    expect(orchestrator.personaRegistry.get('house')).toBeDefined();
    expect(orchestrator.modelRegistry.getConfig('gpt-4o')).toBeDefined();
    expect(orchestrator.skillRegistry.get('code_analysis')).toBeDefined();
    // …and the overridden tool still has its bound implementation.
    expect(orchestrator.toolRegistry.getImplementation('read_file')).toBeDefined();
    expect(orchestrator.toolRegistry.getImplementation('write_file')).toBeDefined();
  });

  it('boots with NO project registry at all (built-in only)', async () => {
    projectRoot = makeProject('phase28-orch-empty-');
    orchestrator = new Orchestrator({ projectRoot });
    await orchestrator.initialize();

    expect(orchestrator.personaRegistry.list().length).toBeGreaterThan(0);
    // The four file tools plus the catalog tools added by bootstrapCatalogTools.
    expect(orchestrator.toolRegistry.listDefinitions().map((t) => t.id)).toEqual(
      expect.arrayContaining(['git_status', 'read_file', 'search_code', 'write_file'])
    );

  });

  it('honours a partial project registry (only some subdirectories)', async () => {
    projectRoot = makeProject('phase28-orch-partial-', {
      'registry/models/house-model.json': JSON.stringify({
        id: 'house-model',
        provider: 'local',
        model: 'house-llama',
      }),
    });
    orchestrator = new Orchestrator({ projectRoot });
    await orchestrator.initialize();

    expect(orchestrator.modelRegistry.getConfig('house-model')).toBeDefined();
    expect(orchestrator.modelRegistry.getConfig('gpt-4o')).toBeDefined();
    expect(orchestrator.personaRegistry.get('coder')).toBeDefined(); // packaged
  });

  it('rejects malformed project entries while tolerating missing directories', async () => {
    projectRoot = makeProject('phase28-orch-bad-', {
      'registry/personas/broken.json': '{ not json',
    });
    orchestrator = new Orchestrator({ projectRoot });
    await expect(orchestrator.initialize()).rejects.toThrow(/Invalid persona registry entries/);
  });
});
