/**
 * Phase 8 Step 2 (WP-R-008): Workflow Profile introspection for the CLI.
 *
 *   human-out-of-the-loop profiles list               [--project-root DIR] [--json] [--trust-project]
 *   human-out-of-the-loop profiles validate <target>  [--project-root DIR] [--json] [--trust-project]
 *
 * `list` shows the profiles this project can select and reports every file that failed to load;
 * `validate` runs the full pre-run check — structure, semantics, schema version **and dependency
 * resolution against the live registries** — for a profile id or a file path. Nothing here executes
 * a profile, spawns MCP, or calls a model; the Orchestrator is not constructed.
 *
 * Both commands follow the existing introspection contract (see the `registry` commands): only
 * registry JSON files are read, the project layer requires the same trust opt-in it requires
 * everywhere else, and `--json` prints a machine-readable object.
 */
import path from 'node:path';
import { PersonaRegistry } from '../../ai/registries/persona-registry.js';
import { SkillRegistry, loadSkillsFromDirectory } from '../../ai/registries/skill-registry.js';
import { ModelRegistry } from '../../ai/registries/model-registry.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import { registryLayersFor } from '../../ai/registries/layout.js';
import { bootstrapTools } from '../../ai/tools/bootstrap.js';
import { resolveAndMaybePersistTrust } from '../utils/trust-project.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out, renderTable } from '../utils/output.js';
import {
  discoverWorkflowProfiles,
  PROJECT_WORKFLOW_PROFILE_DIR,
  WORKFLOW_PROFILE_DIR_ENV_VAR,
  type WorkflowProfileDiscoveryResult,
} from '../../ai/workflow-profiles/profile-discovery.js';
import { loadWorkflowProfileFile, WorkflowProfileRegistry } from '../../ai/workflow-profiles/profile-registry.js';
import { resolveWorkflowProfileDependencies } from '../../ai/workflow-profiles/profile-resolver.js';
import type { WorkflowProfileDiagnostic } from '../../ai/workflow-profiles/profile-types.js';
import { createWorkflowProfileComponentSources } from '../../ai/workflow-profiles/profile-sources.js';

export interface ProfilesCommandOptions {
  projectRoot?: string;
  json?: boolean;
  /** Persist/consult the project trust opt-in (project profiles are untrusted data). */
  trustProject?: boolean;
  /** Directory or file the operator points at instead of the project convention. */
  directory?: string;
  file?: string;
}

function renderDiagnostics(diagnostics: ReadonlyArray<WorkflowProfileDiagnostic>, json: boolean): void {
  if (diagnostics.length === 0) return;
  if (json) return;
  err(color.warn(`\n${diagnostics.length} problem(s) found:`));
  for (const diagnostic of diagnostics) {
    const where = [diagnostic.file, diagnostic.path, diagnostic.nodeId ? `node ${diagnostic.nodeId}` : undefined]
      .filter(Boolean)
      .join(' ');
    err(`  ${color.failed(diagnostic.code)} ${diagnostic.message}${where ? color.dim(` (${where})`) : ''}`);
  }
}

/** Resolve discovery inputs the same way for both commands. */
function resolveDiscovery(opts: ProfilesCommandOptions): { projectRoot: string; result: WorkflowProfileDiscoveryResult; trusted: boolean } {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  const trusted = resolveAndMaybePersistTrust(projectRoot, opts.trustProject === true);
  const result = discoverWorkflowProfiles({
    projectRoot,
    projectOptIn: trusted,
    ...(opts.directory ? { directory: opts.directory } : {}),
    ...(opts.file ? { file: opts.file } : {}),
  });
  return { projectRoot, result, trusted };
}

/**
 * The same registry layers a run reads (package → project), loaded without the Orchestrator so
 * validation stays introspection-only: no MCP connection, no model call, no plan/session writes.
 */
export function loadProfileRegistries(projectRoot: string): {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
} {
  const personaRegistry = new PersonaRegistry();
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry({ toolRegistry });
  const modelRegistry = new ModelRegistry({ env: process.env });
  for (const [index, layer] of registryLayersFor(projectRoot).entries()) {
    const override = index > 0;
    personaRegistry.loadFromDirectory(path.join(layer.dir, 'personas'), false, override);
    bootstrapTools(path.join(layer.dir, 'tools'), toolRegistry, projectRoot, { required: false, override });
    loadSkillsFromDirectory(path.join(layer.dir, 'skills'), skillRegistry, false, override);
    modelRegistry.loadConfigsFromDirectory(path.join(layer.dir, 'models'), false, override);
  }
  return { personaRegistry, skillRegistry, toolRegistry, modelRegistry };
}

export async function profilesListCommand(opts: ProfilesCommandOptions = {}): Promise<number> {
  const { projectRoot, result, trusted } = resolveDiscovery(opts);
  if (opts.json) {
    out(JSON.stringify({
      projectRoot,
      projectDirectory: result.projectDirectory,
      projectTrusted: trusted,
      sources: result.sources,
      profiles: result.profiles.map((entry) => ({
        id: entry.profile.profile.id,
        name: entry.profile.profile.name,
        version: entry.profile.profile.version,
        schemaVersion: entry.profile.schemaVersion,
        scope: entry.scope,
        file: entry.file,
        nodes: entry.profile.workflow.nodes.length,
        edges: entry.profile.workflow.edges.length,
        dependencies: entry.profile.dependencies.length,
      })),
      diagnostics: result.diagnostics,
    }, null, 2));
    return 0;
  }

  if (result.profiles.length === 0) {
    out(color.dim('No workflow profiles are available for this project.'));
  } else {
    out(renderTable(
      ['ID', 'SCOPE', 'NAME', 'VERSION', 'GRAPH', 'FILE'],
      result.profiles.map((entry) => [
        entry.profile.profile.id,
        entry.scope,
        String(entry.profile.profile.name ?? ''),
        String(entry.profile.profile.version ?? ''),
        `${entry.profile.workflow.nodes.length} nodes / ${entry.profile.workflow.edges.length} edges`,
        entry.file,
      ]),
    ));
  }
  out(color.dim(
    `\nProject directory: ${result.projectDirectory}` +
    (trusted ? '' : color.dim(` (not trusted — pass --trust-project to read it)`)) +
    `\nOperator directory: ${opts.directory ?? process.env[WORKFLOW_PROFILE_DIR_ENV_VAR] ?? '<unset: ' + WORKFLOW_PROFILE_DIR_ENV_VAR + '>'}`,
  ));
  renderDiagnostics(result.diagnostics, false);
  out(color.dim(
    '\nWorkflow Profile execution stays off until a run selects a profile explicitly (--profile).',
  ));
  // Listing is introspection: a broken project file is reported but does not make `list` fail.
  return 0;
}

export async function profilesValidateCommand(target: string, opts: ProfilesCommandOptions = {}): Promise<number> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  const trusted = resolveAndMaybePersistTrust(projectRoot, opts.trustProject === true);
  const looksLikePath = target.endsWith('.json') || target.includes('/') || target.includes(path.sep);
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  let registry;
  let profileId: string | undefined;

  if (looksLikePath) {
    const file = path.resolve(target);
    registry = new WorkflowProfileRegistry();
    try {
      const entry = loadWorkflowProfileFile(file, 'user-selected');
      registry.register(entry);
      profileId = entry.profile.profile.id;
    } catch (error) {
      const list = (error as { diagnostics?: WorkflowProfileDiagnostic[] }).diagnostics ?? [];
      diagnostics.push(...(list.length > 0 ? list : [{
        stage: 'read' as const, code: 'file.load-failed',
        message: error instanceof Error ? error.message : String(error), file,
      }]));
    }
  } else {
    const discovered = discoverWorkflowProfiles({ projectRoot, projectOptIn: trusted, ...(opts.directory ? { directory: opts.directory } : {}) });
    diagnostics.push(...discovered.diagnostics);
    registry = discovered.registry;
    const entry = registry.get(target);
    if (!entry) {
      diagnostics.push({
        stage: 'semantic', code: 'selection.profile-missing',
        message: `Profile "${target}" is not available for this project`, profileId: target,
      });
    } else {
      profileId = target;
    }
  }

  // Dependency resolution is the check that a run would perform: pins must match the content the
  // live registries expose, toolsets must name available tools, rubrics must expose their domain.
  if (profileId !== undefined) {
    const entry = registry.get(profileId);
    if (entry) {
      const { personaRegistry, skillRegistry, toolRegistry, modelRegistry } = loadProfileRegistries(projectRoot);
      try {
        resolveWorkflowProfileDependencies(entry.profile, createWorkflowProfileComponentSources({
          registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry },
          toolCatalog: { hasDefinition: (id: string) => toolRegistry.getDefinition(id) !== undefined },
        }));
      } catch (error) {
        const list = (error as { diagnostics?: WorkflowProfileDiagnostic[] }).diagnostics ?? [];
        diagnostics.push(...(list.length > 0 ? list : [{
          stage: 'semantic' as const, code: 'profile.resolve-failed',
          message: error instanceof Error ? error.message : String(error), profileId,
        }]));
      }
    }
  }

  if (opts.json) {
    out(JSON.stringify({
      target,
      profileId: profileId ?? null,
      valid: diagnostics.length === 0,
      diagnostics,
    }, null, 2));
    return diagnostics.length === 0 ? 0 : 1;
  }

  if (diagnostics.length === 0) {
    out(color.done(`✓ Workflow profile "${profileId ?? target}" is valid and all dependencies resolve.`));
    return 0;
  }
  err(color.failed(`✗ Workflow profile "${profileId ?? target}" is not usable (${diagnostics.length} problem(s)):`));
  renderDiagnostics(diagnostics, false);
  return 1;
}
