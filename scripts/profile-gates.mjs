#!/usr/bin/env node
/**
 * Phase 10 Step 2: the Workflow Profile CI gate.
 *
 * The plan asks the CI gates to check the shipped `default`, `bounded` and `error-route` samples
 * against the schema and the semantic validator, and to keep the docs/examples honest. This script
 * is that gate, and it is built to be able to fail:
 *
 *   1. schema + semantics + dependency resolution for the built-in default profile (default)
 *      and for every shipped example (bounded review/fix loop, error-route, answer-only);
 *   2. the shipped JSON Schema file must be the schema the runtime actually validates with
 *      (`WORKFLOW_PROFILE_SCHEMA`), so an editor pointing at the file cannot disagree with the
 *      loader;
 *   3. negative controls: a document with an unknown top-level key and a document with a v1-excluded
 *      construct must be refused by the same validator, so a green gate means "the validator is
 *      alive and the samples pass", not "the validator never ran".
 *
 * Usage: npm run build && node scripts/profile-gates.mjs
 * Exits non-zero on the first failed check (the summary lists every check's outcome).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist', 'src');
const EXAMPLES_DIR = path.join(ROOT, 'docs', 'workflow-profiles', 'examples');
const SCHEMA_FILE = path.join(ROOT, 'docs', 'workflow-profiles', 'workflow-profile.schema.json');

if (!fs.existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first (the gate checks the built output).');
  process.exit(2);
}

const load = (relative) => import(`file://${path.join(DIST, relative)}`);
const { WORKFLOW_PROFILE_SCHEMA, validateWorkflowProfileStructure } = await load('ai/workflow-profiles/profile-schema-validator.js');
const { validateWorkflowProfileSemantics } = await load('ai/workflow-profiles/profile-semantic-validator.js');
const { resolveWorkflowProfileDependencies } = await load('ai/workflow-profiles/profile-resolver.js');
const { createWorkflowProfileComponentSources } = await load('ai/workflow-profiles/profile-sources.js');
const { createDefaultWorkflowProfileDocument } = await load('ai/workflow-profiles/default-profile.js');
const { loadProfileRegistries } = await load('cli/commands/profiles.js');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Sources built the way the CLI and the Orchestrator build them. */
function sources() {
  const { personaRegistry, skillRegistry, modelRegistry, toolRegistry, toolsetRegistry } = loadProfileRegistries(ROOT);
  return createWorkflowProfileComponentSources({
    registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry, toolsets: toolsetRegistry },
    toolCatalog: { hasDefinition: (id) => toolRegistry.getDefinition(id) !== undefined },
  });
}

/** Validate one document: schema, then semantics, then fail-closed dependency resolution. */
function validateDocument(name, document) {
  const structural = validateWorkflowProfileStructure(document);
  if (structural.length > 0) {
    record(name, false, `schema: ${structural.map((d) => d.code).join(', ')}`);
    return false;
  }
  const semantic = validateWorkflowProfileSemantics(document);
  if (semantic.length > 0) {
    record(name, false, `semantic: ${semantic.map((d) => d.code).join(', ')}`);
    return false;
  }
  try {
    const resolved = resolveWorkflowProfileDependencies(document, sources());
    const mismatched = resolved.dependencies.filter((dependency) => dependency.contentDigest !== dependency.declaredDigest);
    if (mismatched.length > 0) {
      record(name, false, `stale pins: ${mismatched.map((d) => `${d.kind}:${d.id}`).join(', ')}`);
      return false;
    }
    record(name, true, `${document.workflow.nodes.length} nodes / ${document.workflow.edges.length} edges, ${resolved.dependencies.length} dependencies resolved`);
    return true;
  } catch (error) {
    const codes = (error?.diagnostics ?? []).map((diagnostic) => diagnostic.code).join(', ');
    record(name, false, `resolution: ${codes || error?.message}`);
    return false;
  }
}

// 1. The built-in default profile (the `default` sample).
const defaultProfile = createDefaultWorkflowProfileDocument(sources());
validateDocument('default profile (built-in)', defaultProfile);

// 2. Every shipped example — bounded loop, error route, answer-only.
const examples = fs.readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith('.json')).sort();
for (const file of examples) {
  validateDocument(`example ${file}`, JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')));
}

// 3. The shipped schema file must be the schema the runtime validates with.
try {
  const shipped = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const same = JSON.stringify(shipped) === JSON.stringify(WORKFLOW_PROFILE_SCHEMA);
  record('shipped JSON Schema is the validator\'s schema', same,
    same ? `${shipped.$id} (${shipped.$schema})` : 'docs/workflow-profiles/workflow-profile.schema.json differs from WORKFLOW_PROFILE_SCHEMA');
} catch (error) {
  record('shipped JSON Schema is the validator\'s schema', false, error.message);
}

// 4. Negative controls: the validator must refuse what the contract excludes.
const unknownKey = { ...JSON.parse(JSON.stringify(defaultProfile)), subWorkflow: { ref: 'other' } };
record('negative control: an unknown top-level key is refused',
  validateWorkflowProfileStructure(unknownKey).length > 0, 'v1 has no sub-workflows');
const parallelGraph = JSON.parse(JSON.stringify(defaultProfile));
parallelGraph.workflow.nodes.push({ id: 'fan', kind: 'parallel', goal: 'fan out', inputs: {}, outputs: {}, config: {} });
record('negative control: a non-v1 node kind is refused',
  validateWorkflowProfileStructure(parallelGraph).length > 0, 'v1 is exactly seven node kinds');
const unboundedLoop = JSON.parse(JSON.stringify(defaultProfile));
const loopEdge = unboundedLoop.workflow.edges.find((edge) => edge.loop);
if (loopEdge) delete loopEdge.loop.maxIterations;
record('negative control: an unbounded loop is refused',
  validateWorkflowProfileStructure(unboundedLoop).length + validateWorkflowProfileSemantics(unboundedLoop).length > 0,
  'every loop must be bounded (the schema requires maxIterations)');
const danglingRoute = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, 'error-route.example.json'), 'utf8'))));
danglingRoute.workflow.nodes.find((node) => node.id === 'execute').onError.routeTo = 'nowhere';
record('negative control: an error route to a missing node is refused',
  validateWorkflowProfileSemantics(danglingRoute).length > 0, 'error-route.target-missing');

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
