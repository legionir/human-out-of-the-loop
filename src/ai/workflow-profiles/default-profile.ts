/**
 * Phase 7 (WP-R-008): the built-in default profile that models the current HOOTL flow.
 *
 * The document is built in code — never shipped as a JSON file with placeholder pins —
 * so every dependency digest is computed from the component content the caller actually
 * resolved. A missing component fails closed (`WorkflowProfileLoadError`); a default
 * profile with stale or placeholder digests is therefore not constructible.
 *
 * The flow modelled here is the one extracted in `docs/workflow-profiles/PHASE7_PARITY.md`
 * from the code and the characterization suites:
 *
 *   request (intake) → plan (planner: plan | answer | clarify)
 *     · answer  → answered end (success)                      [G-2: the interaction status
 *                                                              stays the entry point's job]
 *     · clarify → clarify (approval, text) → bounded loop back to plan
 *     · plan    → confirm (approval, side-effect, digest-bound decision) → execute → review
 *     · review  → finish (pass) | rejected (reject)
 *
 * What stays *outside* the profile, deliberately (Phase 1 seam decision D-WP-009): session/
 * interaction/observability (stage 0), plan/session persistence (stage 4), and inside the
 * `execute` delegation: feasibility/cycle validation, per-step agents and acceptance,
 * automatic retry/re-planning, rate limiting and partial (failed-partial) results (stage 6),
 * plus the runtime's own final report (stage 8). Cancellation is the kernel's `signal` and
 * terminal `cancelled` category; it is never routed or retried.
 *
 * Two intentional differences from the current flow are recorded for the owner (Step 3
 * requires differences to be explicit, in the plan and in the release notes):
 *  - G-5: a confirmation *denial with feedback* cannot re-plan in v1. `bindsTo` (the digest
 *    binding that makes the gate meaningful) is only allowed with `responseKind: "decision"`,
 *    whose output is an object port, and v1 predicates address exactly one top-level port of
 *    scalar type — so no route can branch on the decision's content. Feedback ends the run
 *    fail-closed exactly like a cancellation instead of starting a bounded re-plan.
 *  - G-2: the answer branch ends the profile with `success`; the `answered` interaction status
 *    is applied by the entry point when it maps the run result (see the parity doc).
 */
import { componentProjection, dependencyDigest } from './profile-digest.js';
import { WorkflowProfileLoadError } from './profile-registry.js';
import type { WorkflowProfileComponentSources } from './profile-resolver.js';
import type { WorkflowProfileDocument } from './profile-types.js';

export const DEFAULT_WORKFLOW_PROFILE_ID = 'hootl.default';
export const DEFAULT_WORKFLOW_PROFILE_NAME = 'Default HOOTL workflow';
export const DEFAULT_WORKFLOW_PROFILE_VERSION = '1.0.0';
/** Persona that plans and answers — the persona the current flow passes to the planner. */
export const DEFAULT_WORKFLOW_PROFILE_PLANNER_PERSONA = 'planner';
/** Persona that performs the final review — the persona the current flow passes to it. */
export const DEFAULT_WORKFLOW_PROFILE_REVIEWER_PERSONA = 'reviewer';
/** Code-owned built-in rubric (D-WP-010). */
export const DEFAULT_WORKFLOW_PROFILE_RUBRIC = 'hootl.default-review';
/**
 * Clarification rounds, matching the current `maxClarificationRounds` default (3).
 * The plan-confirmation feedback loop of the current flow (G-5) is not modelled; the
 * value is exported so the wiring can assert the two stay in step.
 */
export const DEFAULT_WORKFLOW_PROFILE_MAX_CLARIFICATION_ROUNDS = 3;
/**
 * Conservative static visit bound = |nodes| × (1 + maxIterations) = 9 × 4 = 36 for this
 * graph (one bounded loop); the cap is set above it, and the runtime/session layers can
 * only tighten the effective value.
 */
export const DEFAULT_WORKFLOW_PROFILE_MAX_NODE_VISITS = 40;
/** Generous ceilings: the profile must not cut a legitimate current-flow run short. */
export const DEFAULT_WORKFLOW_PROFILE_MAX_DURATION_SECONDS = 3600;
export const DEFAULT_WORKFLOW_PROFILE_MAX_MODEL_CALLS = 500;
export const DEFAULT_WORKFLOW_PROFILE_MAX_TOOL_CALLS = 2000;
/** Interactive approval window, mirroring the existing interaction timeout. */
export const DEFAULT_WORKFLOW_PROFILE_APPROVAL_TIMEOUT_SECONDS = 3600;

const stringPort = (required = true) => ({ type: 'string', required });
const objectPort = (required = true) => ({ type: 'object', required });

function pin(sources: WorkflowProfileComponentSources, kind: 'persona' | 'rubric', id: string): string {
  const record = (kind === 'rubric' ? sources.rubrics : sources.personas).get(id) as Record<string, unknown> | undefined;
  if (!record) {
    throw new WorkflowProfileLoadError(`The built-in default profile requires the ${kind} "${id}"`, [{
      stage: 'semantic', code: 'default-profile.component-missing', profileId: DEFAULT_WORKFLOW_PROFILE_ID,
      message: `Component ${kind}:${id} is not available, so the built-in default profile cannot be pinned`,
    }]);
  }
  return dependencyDigest(kind, id, componentProjection({ ...record }));
}

/**
 * Build the default profile. Pins are computed from resolved content, so the caller must
 * pass the same sources the resolver will use.
 */
export function createDefaultWorkflowProfileDocument(
  sources: WorkflowProfileComponentSources,
): WorkflowProfileDocument {
  return {
    $schema: './workflow-profile.schema.json',
    schemaVersion: '1.0.0',
    profile: {
      id: DEFAULT_WORKFLOW_PROFILE_ID,
      name: DEFAULT_WORKFLOW_PROFILE_NAME,
      description:
        'Models the current HOOTL flow: plan or answer, bounded clarification, digest-bound plan confirmation, delegated execution with per-step acceptance and re-planning, and a final review.',
      version: DEFAULT_WORKFLOW_PROFILE_VERSION,
      author: 'HOOTL',
    },
    dependencies: [
      { kind: 'persona', id: DEFAULT_WORKFLOW_PROFILE_PLANNER_PERSONA, version: DEFAULT_WORKFLOW_PROFILE_VERSION, digest: pin(sources, 'persona', DEFAULT_WORKFLOW_PROFILE_PLANNER_PERSONA) },
      { kind: 'persona', id: DEFAULT_WORKFLOW_PROFILE_REVIEWER_PERSONA, version: DEFAULT_WORKFLOW_PROFILE_VERSION, digest: pin(sources, 'persona', DEFAULT_WORKFLOW_PROFILE_REVIEWER_PERSONA) },
      { kind: 'rubric', id: DEFAULT_WORKFLOW_PROFILE_RUBRIC, version: DEFAULT_WORKFLOW_PROFILE_VERSION, digest: pin(sources, 'rubric', DEFAULT_WORKFLOW_PROFILE_RUBRIC) },
    ],
    workflow: {
      startNode: 'request',
      nodes: [
        {
          id: 'request',
          kind: 'intake',
          goal: 'Carry the run request into the workflow.',
          // Entry payload: { request: <run request object> }. The entry point owns the
          // session/interaction and hands the profile one object.
          inputs: { request: objectPort(false) },
          outputs: { request: objectPort() },
          config: {},
        },
        {
          id: 'plan',
          kind: 'planner',
          goal: 'Decide whether the request needs a plan, can be answered directly, or needs clarification.',
          // `context` is the port the planner handler folds into the planning prompt; the
          // clarification round feeds it exactly like the legacy re-plan does.
          inputs: { request: objectPort(false), context: stringPort(false) },
          outputs: {
            // The discriminator is the only always-present port; each outcome produces its own.
            kind: { type: 'string', required: true, enum: ['plan', 'answer', 'clarify'] },
            plan: objectPort(false),
            planText: stringPort(false),
            planDigest: stringPort(false),
            answer: stringPort(false),
            clarification: stringPort(false),
          },
          bindings: { personaRef: DEFAULT_WORKFLOW_PROFILE_PLANNER_PERSONA },
          config: { mode: 'decompose', maxPlanItems: 20 },
        },
        {
          id: 'clarify',
          kind: 'approval',
          goal: 'Ask the user the questions the planner could not answer.',
          inputs: { clarification: stringPort(false) },
          outputs: { answer: stringPort() },
          config: {
            prompt: 'The request needs clarification before a plan can be made. Please answer the questions.',
            approvalType: 'custom',
            responseKind: 'text',
            show: ['clarification'],
            timeoutSeconds: DEFAULT_WORKFLOW_PROFILE_APPROVAL_TIMEOUT_SECONDS,
          },
        },
        {
          id: 'confirm',
          kind: 'approval',
          goal: 'Show the plan and obtain the confirmation that is the only mandatory human interaction.',
          inputs: { plan: objectPort(false), planText: stringPort(false), planDigest: stringPort(false) },
          outputs: {
            plan: objectPort(),
            planText: stringPort(),
            planDigest: stringPort(),
            decision: objectPort(),
          },
          config: {
            prompt: 'Review the plan. Execution starts only after this confirmation.',
            approvalType: 'side-effect',
            responseKind: 'decision',
            // The digest pins exactly the text the user is shown (D-WP-004); the
            // handler aborts with `approval.digest-mismatch` if they differ.
            bindsTo: 'planText',
            show: ['planText'],
            timeoutSeconds: DEFAULT_WORKFLOW_PROFILE_APPROVAL_TIMEOUT_SECONDS,
          },
        },
        {
          id: 'execute',
          kind: 'execute',
          goal: 'Carry out the confirmed plan within the granted capabilities.',
          inputs: { plan: objectPort(), planDigest: stringPort(false) },
          outputs: { status: stringPort(), summary: stringPort() },
          // D-WP-014: the runtime assigns each plan step's persona; there is no single
          // executor persona to pin in the current flow.
          bindings: { personaSource: 'plan-step' },
          config: { mode: 'assisted', requireApprovalForSideEffects: true },
          // The current flow reviews a failed/partial plan instead of aborting the run, so a
          // delegated execution failure is routed to the review (the failure code and
          // category travel through the sanitized envelope) and the review decides the
          // outcome. Authorization denial, approval denial and cancellation stay terminal
          // and cannot be routed (kernel contract).
          onError: {
            strategy: 'route',
            routeTo: 'review',
            routeMap: { summary: '/failure/code', status: '/failure/category' },
          },
        },
        {
          id: 'review',
          kind: 'review',
          goal: 'Judge whether the execution satisfied the plan and the request.',
          inputs: { summary: stringPort(false), status: stringPort(false) },
          outputs: {
            // The domain must match the digest-pinned rubric exactly (Phase 3 gate);
            // `hootl.default-review` mirrors the existing review decision contract.
            decision: { type: 'string', required: true, enum: ['pass', 'revise', 'reject'] },
            reason: stringPort(),
          },
          bindings: { personaRef: DEFAULT_WORKFLOW_PROFILE_REVIEWER_PERSONA },
          config: { rubricRef: DEFAULT_WORKFLOW_PROFILE_RUBRIC, allowedDecisions: ['pass', 'revise', 'reject'] },
        },
        {
          id: 'answered',
          kind: 'end',
          goal: 'Return the direct answer to a conversational request.',
          // Both optional on purpose: the planner's outcome ports are mutually exclusive,
          // and v1's static checks require an emitted output to be `required` exactly when
          // its input is. A planner that reports `answer` without text therefore ends the run
          // with no response value instead of executing work — the same degenerate outcome
          // the current flow has for an empty answer.
          inputs: { answer: stringPort(false) },
          outputs: { response: stringPort(false) },
          config: { outcome: 'success', emit: { response: 'answer' } },
        },
        {
          id: 'finish',
          kind: 'end',
          goal: 'Return the reviewed result.',
          inputs: { summary: stringPort() },
          outputs: { response: stringPort() },
          config: { outcome: 'success', emit: { response: 'summary' } },
        },
        {
          id: 'rejected',
          kind: 'end',
          goal: 'Return the result that did not pass review.',
          inputs: { summary: stringPort() },
          outputs: { response: stringPort() },
          config: { outcome: 'rejected', emit: { response: 'summary' } },
        },
      ],
      edges: [
        { from: 'request', to: 'plan', map: { request: '/request' } },
        { from: 'plan', to: 'confirm', when: { path: '/kind', operator: 'equals', value: 'plan' }, map: { plan: '/plan', planText: '/planText', planDigest: '/planDigest' } },
        { from: 'plan', to: 'answered', when: { path: '/kind', operator: 'equals', value: 'answer' }, map: { answer: '/answer' } },
        // The loop bounds the *questions asked*, matching `maxClarificationRounds` = 3;
        // a fourth request for clarification fails the run.
        {
          from: 'plan',
          to: 'clarify',
          when: { path: '/kind', operator: 'equals', value: 'clarify' },
          map: { clarification: '/clarification' },
          label: 'clarification-round',
          loop: {
            maxIterations: DEFAULT_WORKFLOW_PROFILE_MAX_CLARIFICATION_ROUNDS,
            counterId: 'clarification-rounds',
            onExhausted: { strategy: 'fail' },
          },
        },
        { from: 'clarify', to: 'plan', map: { context: '/answer' } },
        // The approval node only ever produces a decision when the user approved; a denial
        // or cancellation fails the node, so the approved path is the default route.
        { from: 'confirm', to: 'execute', default: true, map: { plan: '/plan', planDigest: '/planDigest' } },
        { from: 'execute', to: 'review', map: { summary: '/summary', status: '/status' } },
        { from: 'review', to: 'finish', when: { path: '/decision', operator: 'equals', value: 'pass' }, map: { summary: '/reason' } },
        // `revise` and `reject` both end the run without further work: the current flow does
        // not re-execute after the final review, and the kernel has no `failed-partial`
        // status — the decision itself stays visible in the review output.
        { from: 'review', to: 'rejected', when: { path: '/decision', operator: 'equals', value: 'revise' }, map: { summary: '/reason' } },
        { from: 'review', to: 'rejected', when: { path: '/decision', operator: 'equals', value: 'reject' }, map: { summary: '/reason' } },
      ],
    },
    policies: {
      execution: {
        maxNodeVisits: DEFAULT_WORKFLOW_PROFILE_MAX_NODE_VISITS,
        maxDurationSeconds: DEFAULT_WORKFLOW_PROFILE_MAX_DURATION_SECONDS,
        maxModelCalls: DEFAULT_WORKFLOW_PROFILE_MAX_MODEL_CALLS,
        maxToolCalls: DEFAULT_WORKFLOW_PROFILE_MAX_TOOL_CALLS,
        onLimit: 'fail',
      },
      // No named toolset ships with HOOTL: an empty list adds no narrowing, so the effective
      // tools stay runtime ∩ persona (see the Phase 7 tool-surface fix).
      tools: { allowedToolsets: [], deniedTools: [] },
      approvals: {
        policy: 'side-effects',
        requireUserConfirmationFor: ['external-write', 'file-write', 'git-write', 'irreversible-action'],
      },
    },
    result: [
      { fromNode: 'answered', port: 'response', kind: 'response', outcome: 'success' },
      { fromNode: 'finish', port: 'response', kind: 'response', outcome: 'success' },
      { fromNode: 'rejected', port: 'response', kind: 'response', outcome: 'rejected' },
    ],
  } as unknown as WorkflowProfileDocument;
}
