#!/usr/bin/env node
/**
 * Phase 9 Step 2 — reproducible measurement of the Workflow Profile path.
 *
 * Measures, on the built output (`npm run build` first) and without any network call:
 *
 *   1. `decision`      — the activation decision with the flag OFF (must resolve nothing) versus
 *                        ON with a selected built-in-approved profile (must prepare it).
 *   2. `validation`    — load + schema/semantic validation of the built-in default profile.
 *   3. `resolution`    — dependency resolution of that profile against the real registries.
 *   4. `discovery`     — discovery + D-WP-003 selection over a temp project with a project profile.
 *   5. `byte-cap`      — rejecting a 1,100,000-byte file versus parsing a 1,000,000-byte one, to show
 *                        the cap is enforced BEFORE parsing.
 *   6. `budget`        — a kernel run whose model budget is already spent: the handler must never be
 *                        called (counters are charged before the call, not after).
 *
 * Usage: node scripts/profile-bench.mjs [iterations]
 * Output: a markdown table on stdout, plus the environment it ran in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ITERATIONS = Number.parseInt(process.argv[2] ?? '200', 10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'src');

const { Orchestrator } = await import(path.join(DIST, 'ai', 'orchestrator.js'));
const { activateWorkflowProfile } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-activation.js'));
const { createDefaultWorkflowProfileDocument } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'default-profile.js'));
const { createWorkflowProfileComponentSources } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-sources.js'));
const { resolveWorkflowProfileDependencies } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-resolver.js'));
const { loadWorkflowProfileFile } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-registry.js'));
const { discoverWorkflowProfiles } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-discovery.js'));
const { selectWorkflowProfile } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-registry.js'));
const { loadToolsetsFromDirectory } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'toolsets.js'));
const { ToolsetRegistry } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'toolsets.js'));
const { loadProfileRegistries } = await import(path.join(DIST, 'cli', 'commands', 'profiles.js'));
const { WORKFLOW_PROFILE_FLAG_ENV_VAR } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-runner.js'));
const { createWorkflowProfileHandlers } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'node-handlers.js'));
const { componentProjection, dependencyDigest } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-digest.js'));
const digestOfPersona = (id, record) => dependencyDigest('persona', id, componentProjection(record));

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1],
    mean: Number(mean.toFixed(3)), min: sorted[0],
  };
};
const measure = (iterations, fn) => {
  for (let i = 0; i < 3; i += 1) fn(); // warm-up
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return stats(samples);
};

// ── The registry sources, built exactly like the CLI builds them ────────────
const { personaRegistry, skillRegistry, modelRegistry, toolRegistry, toolsetRegistry } = loadProfileRegistries(ROOT);
const toolCatalog = { hasDefinition: (id) => toolRegistry.getDefinition(id) !== undefined };
const sources = createWorkflowProfileComponentSources({
  registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry, toolsets: toolsetRegistry },
  toolCatalog,
});

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-bench-'));
fs.cpSync(path.join(ROOT, 'registry'), path.join(projectRoot, 'registry'), { recursive: true });

// ── A project profile to discover (smallest valid graph, real pin) ──────────
const planner = personaRegistry.get('planner');
const port = (required) => ({ type: 'string', required });
const projectProfile = {
  schemaVersion: '1.0.0',
  profile: { id: 'bench.small', name: 'Bench small', version: '1.0.0', author: 'bench' },
  dependencies: [{
    kind: 'persona', id: 'planner',
    digest: digestOfPersona('planner', planner),
  }],
  workflow: {
    startNode: 'request',
    nodes: [
      { id: 'request', kind: 'intake', goal: 'carry', inputs: { request: { type: 'object', required: false } }, outputs: { request: { type: 'object', required: true } }, config: {} },
      { id: 'done', kind: 'end', goal: 'finish', inputs: { request: { type: 'object', required: true } }, outputs: { response: { type: 'object', required: true } }, config: { outcome: 'success', emit: { response: 'request' } } },
    ],
    edges: [{ from: 'request', to: 'done', map: { request: '/request' } }],
  },
  policies: {
    execution: { maxNodeVisits: 5, maxDurationSeconds: 60, maxModelCalls: 5, maxToolCalls: 5, onLimit: 'fail' },
    tools: { allowedToolsets: [] }, approvals: { policy: 'runtime-default' },
  },
  result: [{ fromNode: 'done', port: 'response', kind: 'response', outcome: 'success' }],
};
fs.mkdirSync(path.join(projectRoot, '.hootl', 'workflow-profiles'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, '.hootl', 'workflow-profiles', 'bench.json'), JSON.stringify(projectProfile));

const rows = [];

// 1. Activation decision: flag off (nothing resolves) versus flag on (prepared).
rows.push(['decision: flag OFF (no profile resolves)', measure(ITERATIONS, () => {
  const result = activateWorkflowProfile({ env: {}, sources });
  if (result.kind !== 'legacy') throw new Error('flag off must stay legacy');
})]);
const builtInDocument = createDefaultWorkflowProfileDocument(sources);
rows.push(['decision: flag ON + selected built-in default', measure(ITERATIONS, () => {
  const result = activateWorkflowProfile({
    env: { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' },
    sources,
    selection: { document: builtInDocument },
  });
  if (result.kind !== 'profile') throw new Error(`expected a prepared profile, got ${result.kind}`);
})]);

// 2/3. Validation and resolution of the built-in default profile.
const registryPath = path.join(projectRoot, 'builtin.json');
fs.writeFileSync(registryPath, JSON.stringify(builtInDocument));
rows.push(['load + validate the built-in default (43 KB document)', measure(ITERATIONS, () => {
  loadWorkflowProfileFile(registryPath, 'user-selected');
})]);
rows.push(['resolve its dependencies against the real registries', measure(ITERATIONS, () => {
  resolveWorkflowProfileDependencies(builtInDocument, sources);
})]);

// 4. Discovery + selection over a trusted project with one profile.
rows.push(['discovery + selection (project profile, trusted)', measure(ITERATIONS, () => {
  const discovered = discoverWorkflowProfiles({ projectRoot, projectOptIn: true });
  selectWorkflowProfile(discovered.registry, {
    requestedProfileId: 'bench.small',
    projectOptIn: true,
    ...(discovered.projectDefaultProfileId ? { projectDefaultProfileId: discovered.projectDefaultProfileId } : {}),
  });
})]);

// 4b. Toolset layer load (Phase 9 H-3): a project layer with three toolsets.
const toolsetDir = path.join(projectRoot, 'registry', 'toolsets');
fs.mkdirSync(toolsetDir, { recursive: true });
for (const name of ['bench.one', 'bench.two', 'bench.three']) {
  fs.writeFileSync(path.join(toolsetDir, `${name}.json`), JSON.stringify({ id: name, version: '1.0.0', tools: ['read_file'] }));
}
rows.push(['toolset layer load (3 files) + catalog re-check', measure(ITERATIONS, () => {
  const target = new ToolsetRegistry({ tools: toolCatalog });
  const loaded = loadToolsetsFromDirectory(toolsetDir, target, { override: true, required: true });
  if (loaded.loaded !== 3 || loaded.errors.length > 0) throw new Error(`expected 3 toolsets, got ${loaded.loaded}/${loaded.errors.length}`);
})]);

// 5. Byte cap before parse: an oversize file must be refused without being parsed.
const oversize = path.join(projectRoot, 'oversize.json');
const valid = path.join(projectRoot, 'large-valid.json');
// The cap is 1,048,576 bytes: the oversize file must be over it, the reference file just under.
fs.writeFileSync(oversize, JSON.stringify({ filler: 'x'.repeat(1_100_000), schemaVersion: '1.0.0' }));
fs.writeFileSync(valid, JSON.stringify({ filler: 'x'.repeat(1_000_000), schemaVersion: '1.0.0' }));
const oversizeBytes = fs.statSync(oversize).size;
const validBytes = fs.statSync(valid).size;
const capStats = measure(Math.max(50, Math.floor(ITERATIONS / 4)), () => {
  try {
    loadWorkflowProfileFile(oversize, 'user-selected');
    throw new Error('the oversize file must be refused');
  } catch (error) {
    if (!/too large|1 MiB|1048576/i.test(String(error.message))) throw error;
  }
});
const parseStats = measure(Math.max(50, Math.floor(ITERATIONS / 4)), () => {
  JSON.parse(fs.readFileSync(valid, 'utf-8')); // the work the cap lets us skip
});
rows.push([`byte cap: refuse ${oversizeBytes} B before parse`, capStats]);
rows.push([`byte cap: parse ${validBytes} B (the work skipped)`, parseStats]);

// 6. Budget before the call: a spent model budget must prevent the handler from running.
{
  const calls = { planner: 0 };
  const handlers = createWorkflowProfileHandlers({
    planner: { async plan() { calls.planner += 1; return { kind: 'answer', answer: 'bench' }; } },
  });
  const { prepareWorkflowProfileRun } = await import(path.join(DIST, 'ai', 'workflow-profiles', 'profile-runner.js'));
  // A profile that DOES call the planner, so a spent model budget has to stop it.
  const budgetProfile = {
    ...projectProfile,
    profile: { ...projectProfile.profile, id: 'bench.plan' },
    workflow: {
      startNode: 'request',
      nodes: [
        projectProfile.workflow.nodes[0],
        {
          id: 'plan', kind: 'planner', goal: 'plan',
          inputs: { request: { type: 'object', required: false }, context: { type: 'string', required: false } },
          outputs: {
            kind: { type: 'string', required: true, enum: ['plan', 'answer', 'clarify'] },
            answer: { type: 'string', required: false },
            plan: { type: 'object', required: false },
            planText: { type: 'string', required: false },
            planDigest: { type: 'string', required: false },
            clarification: { type: 'string', required: false },
          },
          bindings: { personaRef: 'planner' }, config: { mode: 'decompose', maxPlanItems: 10 },
        },
        {
          id: 'done', kind: 'end', goal: 'finish',
          inputs: { answer: { type: 'string', required: false } },
          outputs: { response: { type: 'string', required: false } },
          config: { outcome: 'success', emit: { response: 'answer' } },
        },
      ],
      edges: [
        { from: 'request', to: 'plan', map: { request: '/request' } },
        { from: 'plan', to: 'done', default: true, map: { answer: '/answer' } },
      ],
    },
  };
  const prepared = prepareWorkflowProfileRun({
    document: budgetProfile,
    sources,
    env: { [WORKFLOW_PROFILE_FLAG_ENV_VAR]: '1' },
  });
  const runStarted = performance.now();
  const outcome = await prepared.run({
    input: { request: { goal: 'bench' } },
    handlers,
    budget: { maxModelCalls: 0, maxNodeVisits: 5, maxDurationSeconds: 60, maxToolCalls: 5 },
  }).catch((error) => ({ error }));
  const budgetMs = performance.now() - runStarted;
  const budgetStatus = outcome?.error ? 'refused' : String(outcome.status);
  rows.push([`budget: maxModelCalls=0 on a planner run (${budgetStatus})`,
    { p50: budgetMs, p95: budgetMs, max: budgetMs, mean: Number(budgetMs.toFixed(3)), min: budgetMs },
    `planner calls: ${calls.planner} (must be 0)`]);
  if (calls.planner !== 0) throw new Error('a spent budget must prevent the planner call');
  if (!outcome?.error && outcome.status === 'success') throw new Error('a spent budget must not report success');
}

// ── Report ─────────────────────────────────────────────────────────────────
const cpu = fs.readFileSync('/proc/cpuinfo', 'utf-8').split('\n').find((line) => line.startsWith('model name')) ?? `cpus: ${os.cpus().length}`;
console.log(`\nEnvironment: node ${process.version} · ${cpu.trim()} · ${os.platform()} ${os.release()} · iterations ${ITERATIONS} · project ${projectRoot}\n`);
console.log('| Measurement | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | min (ms) | Note |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const [label, s, note] of rows) {
  console.log(`| ${label} | ${s.p50.toFixed(3)} | ${s.p95.toFixed(3)} | ${s.max.toFixed(3)} | ${s.mean} | ${s.min.toFixed(3)} | ${note ?? ''} |`);
}
console.log('');
