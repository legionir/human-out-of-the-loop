/**
 * Phase 8 Step 3 (WP-R-008): the shipped authoring examples stay valid.
 *
 * Two examples are documented in `docs/workflow-profiles/PHASE8_AUTHORING.md` and must keep
 * working as the contract evolves:
 *
 *   - `examples/answer-only.example.json`      — the smallest useful custom profile: it can
 *     never execute anything, so a reader can see the minimum that is still meaningful.
 *   - `examples/bounded-review-fix.example.json` — the full work profile: digest-bound
 *     confirmation, delegated execution, review, and exactly one bounded re-plan loop.
 *
 * Unlike the schema/semantic fixtures next to them (which carry placeholder digests on purpose),
 * these examples pin real component content, so this suite runs the whole authoring path the CLI
 * exposes: load → schema/semantic validation → dependency resolution → discovery → selection.
 * A registry edit that invalidates a pin fails here, and the fix is to re-pin the example in the
 * same change (exactly what an author has to do) — `profiles validate <file>` prints the digest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { loadWorkflowProfileFile, WorkflowProfileLoadError } from '../workflow-profiles/profile-registry.js';
import { resolveWorkflowProfileDependencies } from '../workflow-profiles/profile-resolver.js';
import { createWorkflowProfileComponentSources } from '../workflow-profiles/profile-sources.js';
import { discoverWorkflowProfiles } from '../workflow-profiles/profile-discovery.js';
import { loadProfileRegistries, profilesValidateCommand } from '../../cli/commands/profiles.js';
import { useIsolatedHome, type HomeHandle } from '../../test-utils/isolated-home.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXAMPLES = path.join(REPO_ROOT, 'docs', 'workflow-profiles', 'examples');
const ANSWER_ONLY = path.join(EXAMPLES, 'answer-only.example.json');
const BOUNDED = path.join(EXAMPLES, 'bounded-review-fix.example.json');

/** Sources built exactly like the CLI's validate path builds them. */
function sourcesFor(projectRoot: string) {
  const { personaRegistry, skillRegistry, modelRegistry, toolRegistry } = loadProfileRegistries(projectRoot);
  return createWorkflowProfileComponentSources({
    registries: { personas: personaRegistry, skills: skillRegistry, models: modelRegistry },
    toolCatalog: { hasDefinition: (id: string) => toolRegistry.getDefinition(id) !== undefined },
  });
}

describe('Phase 8 — authoring examples', () => {
  let home: HomeHandle;

  beforeEach(() => { home = useIsolatedHome('phase8-examples-'); });
  afterEach(() => { home.restore(); });

  it.each([ANSWER_ONLY, BOUNDED])('the CLI validates %s', async (file) => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await profilesValidateCommand(file, { projectRoot: REPO_ROOT })).toBe(0);
    } finally {
      out.mockRestore();
    }
  });

  it('both examples load and resolve their real dependency pins (resolution throws otherwise)', () => {
    for (const file of [ANSWER_ONLY, BOUNDED]) {
      const registered = loadWorkflowProfileFile(file, 'user-selected');
      // Resolution is fail-closed: a single diagnostic throws instead of returning a profile.
      const resolved = resolveWorkflowProfileDependencies(registered.profile, sourcesFor(REPO_ROOT));
      expect(resolved.profileId).toBe(registered.profile.profile.id);
      expect(resolved.dependencies.length).toBe(registered.profile.dependencies.length);
      // The declared pin and the digest of the content that was actually resolved are identical
      // for every dependency — that is what makes the example trustworthy to copy.
      expect(resolved.dependencies.every((dependency) =>
        /^sha256:[0-9a-f]{64}$/.test(dependency.contentDigest) && dependency.contentDigest === dependency.declaredDigest,
      )).toBe(true);
    }
  });

  it('the answer-only example cannot reach execution or review at all', () => {
    const document = loadWorkflowProfileFile(ANSWER_ONLY, 'user-selected').profile;
    const kinds = document.workflow.nodes.map((node) => node.kind);
    expect(kinds).not.toContain('execute');
    expect(kinds).not.toContain('review');
    expect(kinds).not.toContain('condition');
    // Every end node is reachable and mapped: the profile's result contract is complete.
    const ends = document.workflow.nodes.filter((node) => node.kind === 'end').map((node) => node.id).sort();
    expect(document.result.map((entry) => entry.fromNode).sort()).toEqual(ends);
    // No hidden execution surface: the example names no toolsets and no denied tools.
    expect(document.policies.tools.allowedToolsets).toEqual([]);
  });

  it('the bounded review/fix example has one bounded re-plan loop that fails when exhausted', () => {
    const document = loadWorkflowProfileFile(BOUNDED, 'user-selected').profile;
    const loops = document.workflow.edges.filter((edge) => edge.loop);
    expect(loops).toHaveLength(2);
    const reviewFix = loops.find((edge) => edge.label === 'review-fix');
    expect(reviewFix).toBeDefined();
    expect(reviewFix!.from).toBe('review');
    expect(reviewFix!.to).toBe('plan');
    expect(reviewFix!.loop!.maxIterations).toBe(1);
    expect(reviewFix!.loop!.onExhausted.strategy).toBe('fail');
    // The loop is entered only on `revise` — `pass` and `reject` leave the graph.
    expect(reviewFix!.when).toEqual({ path: '/decision', operator: 'equals', value: 'revise' });
    // Every loop is bounded: at least one iteration, a counter and an exhausted policy.
    for (const edge of loops) {
      expect(edge.loop!.maxIterations).toBeGreaterThanOrEqual(1);
      expect(edge.loop!.counterId.length).toBeGreaterThan(0);
      expect(['fail', 'handoff', 'ask-user']).toContain(edge.loop!.onExhausted.strategy);
    }
    // The executed plan is confirmed before the side effect (digest-bound approval is present).
    const approval = document.workflow.nodes.find((node) => node.id === 'confirm')!;
    expect(approval.kind).toBe('approval');
    expect(approval.config.bindsTo).toBe('planText');
    expect(approval.config.approvalType).toBe('side-effect');
  });

  it('a changed pin is caught: the example only passes while the pinned content matches', () => {
    const registered = loadWorkflowProfileFile(ANSWER_ONLY, 'user-selected');
    const stale = structuredClone(registered.profile) as typeof registered.profile;
    stale.dependencies[0]!.digest = `sha256:${'0'.repeat(64)}`;
    let thrown: unknown;
    try {
      resolveWorkflowProfileDependencies(stale, sourcesFor(REPO_ROOT));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowProfileLoadError);
    expect((thrown as WorkflowProfileLoadError).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('dependency.digest-mismatch');
  });

  it('a user can discover and select both examples by file', () => {
    for (const [file, id] of [[ANSWER_ONLY, 'example.answer-only'], [BOUNDED, 'example.bounded-review-fix']] as const) {
      const discovered = discoverWorkflowProfiles({ projectRoot: REPO_ROOT, file });
      expect(discovered.diagnostics).toEqual([]);
      expect(discovered.profiles.map((entry) => entry.profile.profile.id)).toContain(id);
      // Which is exactly what `hootl run --profile-file <path>` does before it starts anything.
      expect(discovered.profiles.find((entry) => path.resolve(entry.file) === path.resolve(file))!.scope)
        .toBe('user-selected');
    }
  });
});
