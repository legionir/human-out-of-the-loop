/**
 * Phase 3 Step 1/2 (WP-R-003, WP-R-004): resolve every v1 profile dependency
 * against an existing source of truth, pinning content by exact digest.
 *
 * Sources of truth (no parallel registries are created):
 *   - persona      → the existing PersonaRegistry entry (validated Persona record)
 *   - skill        → the existing SkillRegistry resolved entry (metadata + SKILL.md text)
 *   - model-profile→ the existing ModelRegistry ModelConfig entry
 *   - toolset      → the named ToolsetRegistry added in Phase 3 Step 2
 *   - rubric       → the built-in, code-owned rubric catalogue (see D-WP-010 below)
 *
 * D-WP-010 (recorded 2026-09-30 under the owner's standing delegation for
 * conservative decisions): the repository has no user- or registry-authorable
 * rubric source, and the plan forbids inventing a parallel registry without a
 * decision. v1 therefore resolves `rubric` references against the built-in
 * catalogue that mirrors the existing review decision contract
 * (`pass | revise | reject`). User-authored rubrics are explicitly deferred to a
 * later phase that requires an owner decision; nothing here is execution
 * evidence — resolution is a static, pre-activation check.
 */
import { z } from 'zod';
import { componentProjection, dependencyDigest, DEPENDENCY_DIGEST_PATTERN } from './profile-digest.js';
import { WorkflowProfileLoadError } from './profile-registry.js';
import type { ProfileDependency, WorkflowProfileDocument, WorkflowProfileDiagnostic } from './profile-types.js';
import type { ToolCatalogLike } from './toolsets.js';

// ─── Rubric contract (built-in catalogue) ─────────────────────────

export const ReviewDecisionValues = ['pass', 'revise', 'reject'] as const;
export type ReviewDecision = (typeof ReviewDecisionValues)[number];

export const RubricSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/),
  /** The real decision domain this rubric can produce; compared with the profile's declared domain. */
  decisions: z.array(z.enum(ReviewDecisionValues)).min(1),
  criteria: z.string().min(1),
  description: z.string().optional(),
});
export type Rubric = z.infer<typeof RubricSchema>;

const BUILT_IN_RUBRIC_RECORDS: ReadonlyArray<Rubric> = Object.freeze([
  Object.freeze({
    id: 'hootl.default-review',
    version: '1.0.0',
    decisions: Object.freeze([...ReviewDecisionValues]) as ReviewDecision[],
    criteria:
      'Accept a plan result only when every plan step met its acceptance criteria and the final review found no unresolved critical finding; otherwise revise; reject when the goal cannot be met within the declared budget.',
    description: 'Built-in v1 rubric mirroring the existing acceptance/final-review decision contract.',
  }),
]);

/** Read-only catalogue of the built-in v1 rubrics. */
export class RubricCatalogue {
  private readonly rubrics = new Map<string, Rubric>();

  constructor(records: ReadonlyArray<unknown> = BUILT_IN_RUBRIC_RECORDS) {
    for (const record of records) {
      const parsed = RubricSchema.safeParse(record);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
        throw new WorkflowProfileLoadError('Invalid built-in rubric definition', [
          { stage: 'semantic', code: 'rubric.invalid', message: detail },
        ]);
      }
      const rubric = parsed.data;
      if (this.rubrics.has(rubric.id)) {
        throw new WorkflowProfileLoadError(`Duplicate rubric id "${rubric.id}"`, [
          { stage: 'semantic', code: 'rubric.duplicate-id', message: `Duplicate rubric id "${rubric.id}"`, path: '/id' },
        ]);
      }
      this.rubrics.set(rubric.id, Object.freeze(rubric));
    }
  }

  get(id: string): Rubric | undefined {
    return this.rubrics.get(id);
  }

  has(id: string): boolean {
    return this.rubrics.has(id);
  }

  list(): ReadonlyArray<Rubric> {
    return Object.freeze(Array.from(this.rubrics.values()));
  }

  get size(): number {
    return this.rubrics.size;
  }
}

export function createBuiltInRubricCatalogue(): RubricCatalogue {
  return new RubricCatalogue();
}

// ─── Source adapters ──────────────────────────────────────────────

/**
 * A read-only view over one existing registry. The host wires the real
 * registries in; the resolver never mutates them.
 */
export interface ComponentSource {
  get(id: string): unknown | undefined;
  /** Optional: lets the resolver report ambiguous ids and enumerate for checks. */
  listIds?(): ReadonlyArray<string>;
  /** Optional: lets a host mark a component as unavailable before activation. */
  isEnabled?(id: string): boolean;
}

export interface WorkflowProfileComponentSources {
  personas: ComponentSource;
  skills: ComponentSource;
  models: ComponentSource;
  toolsets: ComponentSource;
  rubrics: ComponentSource;
  /** Optional live tool catalog; when present, toolset membership is re-verified at resolve time. */
  toolCatalog?: ToolCatalogLike;
}

export interface ResolvedDependency {
  kind: ProfileDependency['kind'];
  id: string;
  declaredVersion?: string;
  declaredDigest: string;
  /** Registry version recorded from the source when one exists; never a substitute for the digest. */
  resolvedVersion?: string;
  /** Digest recomputed from the resolved content; equals `declaredDigest`. */
  contentDigest: string;
  content: Readonly<Record<string, unknown>>;
}

export interface ResolvedReviewDomain {
  nodeId: string;
  rubricId: string;
  decisions: ReadonlyArray<ReviewDecision>;
}

export interface ResolvedWorkflowProfile {
  profileId: string;
  dependencies: ReadonlyArray<ResolvedDependency>;
  reviewDomains: ReadonlyArray<ResolvedReviewDomain>;
  /** Lookup of a resolved dependency by `(kind, id)`. */
  get(kind: ProfileDependency['kind'], id: string): ResolvedDependency | undefined;
}

type ComponentSourceKey = 'personas' | 'skills' | 'toolsets' | 'rubrics' | 'models';

const SOURCE_FIELD: Record<ProfileDependency['kind'], ComponentSourceKey> = {
  persona: 'personas',
  skill: 'skills',
  toolset: 'toolsets',
  rubric: 'rubrics',
  'model-profile': 'models',
};

/**
 * Content used for the digest pin. For skills the resolved SKILL.md text replaces
 * the on-disk `instructions` reference so the pin covers the content that is
 * actually handed to the workflow.
 */
function resolvedProjection(kind: ProfileDependency['kind'], raw: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'skill') return componentProjection(raw);
  const projection = componentProjection(raw);
  const resolvedInstructions = raw.resolvedInstructions;
  if (typeof resolvedInstructions === 'string' && resolvedInstructions.length > 0) {
    projection.instructions = resolvedInstructions;
    delete projection.resolvedInstructions;
    delete projection.resolvedTools;
  }
  return projection;
}

function sameValueSet(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

/**
 * Resolve every declared dependency and each review node's decision domain.
 * Fails closed with aggregated diagnostics: nothing is returned unless every pin
 * matched the live content exactly.
 */
export function resolveWorkflowProfileDependencies(
  profile: WorkflowProfileDocument,
  sources: WorkflowProfileComponentSources,
): ResolvedWorkflowProfile {
  const diagnostics: WorkflowProfileDiagnostic[] = [];
  const resolved: ResolvedDependency[] = [];
  const byKey = new Map<string, ResolvedDependency>();
  const profileId = profile?.profile?.id ?? '<unknown>';

  const sourceFor = (kind: ProfileDependency['kind']): ComponentSource | undefined => {
    const source = sources?.[SOURCE_FIELD[kind]];
    return source && typeof source.get === 'function' ? source : undefined;
  };

  for (const [index, dependency] of (profile.dependencies ?? []).entries()) {
    const path = `/dependencies/${index}`;
    const { kind, id } = dependency;
    const source = sourceFor(kind);
    if (!source) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.source-missing', message: `No source of truth is wired for dependency kind "${kind}"`, profileId, path, });
      continue;
    }
    if (typeof dependency.digest !== 'string' || !DEPENDENCY_DIGEST_PATTERN.test(dependency.digest)) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.digest-invalid', message: `Dependency "${kind}:${id}" must pin a "sha256:<64 hex>" content digest`, profileId, path: `${path}/digest` });
      continue;
    }
    if (typeof dependency.version === 'string' && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(dependency.version)) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.version-invalid', message: `Dependency "${kind}:${id}" declares a malformed version`, profileId, path: `${path}/version` });
      continue;
    }
    if (typeof source.listIds === 'function') {
      const occurrences = source.listIds().filter((candidate) => candidate === id).length;
      if (occurrences > 1) {
        diagnostics.push({ stage: 'semantic', code: 'dependency.ambiguous', message: `Dependency "${kind}:${id}" matches ${occurrences} entries; an ambiguous component is never activated`, profileId, path });
        continue;
      }
    }
    if (typeof source.isEnabled === 'function' && source.isEnabled(id) === false) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.disabled', message: `Dependency "${kind}:${id}" is present but disabled`, profileId, path });
      continue;
    }
    const raw = source.get(id);
    if (raw === undefined || raw === null) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.missing', message: `Dependency "${kind}:${id}" was not found in its registry`, profileId, path });
      continue;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.content-invalid', message: `Dependency "${kind}:${id}" resolved to a non-object record`, profileId, path });
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (kind === 'skill' && (typeof record.resolvedInstructions !== 'string' || record.resolvedInstructions.length === 0)) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.content-invalid', message: `Skill "${id}" has no resolved instructions to pin`, profileId, path });
      continue;
    }
    if (kind === 'toolset' && typeof sources.toolCatalog?.hasDefinition === 'function') {
      const tools = Array.isArray(record.tools) ? (record.tools as unknown[]) : [];
      const unavailable = tools.filter((toolId) => typeof toolId !== 'string' || !sources.toolCatalog!.hasDefinition(toolId));
      if (unavailable.length > 0) {
        diagnostics.push({ stage: 'semantic', code: 'dependency.tool-unavailable', message: `Toolset "${id}" names tools that are not available at resolve time: ${unavailable.join(', ')}`, profileId, path });
        continue;
      }
    }

    let projection: Record<string, unknown>;
    let contentDigest: string;
    try {
      projection = resolvedProjection(kind, record);
      contentDigest = dependencyDigest(kind, id, projection);
    } catch (error) {
      diagnostics.push({
        stage: 'semantic', code: 'dependency.content-invalid', profileId, path,
        message: `Dependency "${kind}:${id}" content could not be digested: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (contentDigest !== dependency.digest) {
      diagnostics.push({
        stage: 'semantic', code: 'dependency.digest-mismatch', profileId, path: `${path}/digest`,
        message: `Dependency "${kind}:${id}" content digest ${contentDigest} does not match the pinned ${dependency.digest}`,
      });
      continue;
    }
    const resolvedVersion = typeof record.version === 'string' ? record.version : undefined;
    if (dependency.version !== undefined && resolvedVersion !== undefined && dependency.version !== resolvedVersion) {
      diagnostics.push({
        stage: 'semantic', code: 'dependency.version-mismatch', profileId, path: `${path}/version`,
        message: `Dependency "${kind}:${id}" pins version ${dependency.version} but the registry holds ${resolvedVersion}`,
      });
      continue;
    }

    const entry: ResolvedDependency = Object.freeze({
      kind, id,
      declaredVersion: dependency.version,
      declaredDigest: dependency.digest,
      resolvedVersion,
      contentDigest,
      content: Object.freeze(projection),
    });
    resolved.push(entry);
    byKey.set(`${kind}:${id}`, entry);
  }

  // Review nodes: the digest-pinned rubric's real decision domain must equal the
  // profile's declared domain and, when exposed, the `decision` port enum.
  const reviewDomains: ResolvedReviewDomain[] = [];
  for (const [index, node] of (profile.workflow?.nodes ?? []).entries()) {
    if (node?.kind !== 'review') continue;
    const nodePath = `/workflow/nodes/${index}`;
    const rubricRef = (node.config as Record<string, unknown> | undefined)?.rubricRef;
    if (typeof rubricRef !== 'string') continue;
    const rubricEntry = byKey.get(`rubric:${rubricRef}`);
    if (!rubricEntry) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.rubric-unresolved', nodeId: node.id, profileId, path: `${nodePath}/config/rubricRef`, message: `Review node "${node.id}" references rubric "${rubricRef}", which did not resolve` });
      continue;
    }
    const decisions = rubricEntry.content.decisions;
    if (!Array.isArray(decisions) || decisions.length === 0) {
      diagnostics.push({ stage: 'semantic', code: 'dependency.rubric-invalid', nodeId: node.id, profileId, path: `${nodePath}/config/rubricRef`, message: `Resolved rubric "${rubricRef}" exposes no decision domain` });
      continue;
    }
    const declared = (node.config as Record<string, unknown>).allowedDecisions;
    if (Array.isArray(declared) && !sameValueSet(declared, decisions)) {
      diagnostics.push({
        stage: 'semantic', code: 'dependency.rubric-decision-mismatch', nodeId: node.id, profileId, path: `${nodePath}/config/allowedDecisions`,
        message: `Review node "${node.id}" declares decisions [${declared.join(', ')}] but the digest-pinned rubric "${rubricRef}" produces [${decisions.join(', ')}]`,
      });
      continue;
    }
    const decisionPort = node.outputs?.decision;
    if (decisionPort && Array.isArray(decisionPort.enum) && !sameValueSet(decisionPort.enum, decisions)) {
      diagnostics.push({
        stage: 'semantic', code: 'dependency.rubric-decision-mismatch', nodeId: node.id, profileId, path: `${nodePath}/outputs/decision/enum`,
        message: `Review node "${node.id}" exposes a decision port enum [${decisionPort.enum.join(', ')}] that does not match the resolved rubric domain [${decisions.join(', ')}]`,
      });
      continue;
    }
    if (Array.isArray(declared)) {
      reviewDomains.push(Object.freeze({ nodeId: node.id, rubricId: rubricRef, decisions: Object.freeze([...(decisions as ReviewDecision[])]) }));
    }
  }

  if (diagnostics.length > 0) {
    throw new WorkflowProfileLoadError(`Workflow profile "${profileId}" failed dependency resolution with ${diagnostics.length} diagnostic(s)`, diagnostics);
  }

  return Object.freeze({
    profileId,
    dependencies: Object.freeze(resolved),
    reviewDomains: Object.freeze(reviewDomains),
    get: (kind: ProfileDependency['kind'], id: string) => byKey.get(`${kind}:${id}`),
  });
}
