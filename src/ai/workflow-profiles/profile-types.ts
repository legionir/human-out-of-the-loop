export type WorkflowProfileScope = 'builtin' | 'project' | 'user-selected';

export interface ProfileDependency {
  kind: 'persona' | 'skill' | 'toolset' | 'rubric' | 'model-profile';
  id: string;
  version?: string;
  digest: string;
}

export type WorkflowResultKind = 'response' | 'artifact' | 'proposal' | 'handoff';
export type WorkflowResultOutcome = 'success' | 'rejected' | 'handoff' | 'cancelled';

export interface WorkflowResult {
  fromNode: string;
  port: string;
  kind: WorkflowResultKind;
  outcome: WorkflowResultOutcome;
}

/**
 * Untrusted wire/input shape. Its broad index signatures intentionally permit
 * parsing before Schema validation; callers must not activate or execute it.
 */
export interface WorkflowProfileDocument {
  $schema?: string;
  schemaVersion: string;
  profile: {
    id: string;
    name: string;
    version: string;
    runtime?: { minVersion: string; maxVersion?: string };
    author: string;
    [key: string]: unknown;
  };
  dependencies: ProfileDependency[];
  workflow: {
    startNode: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
  };
  policies: Record<string, any>;
  result: WorkflowResult[];
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  kind: 'intake' | 'planner' | 'execute' | 'review' | 'condition' | 'approval' | 'end';
  goal: string;
  inputs: Record<string, WorkflowPort>;
  outputs: Record<string, WorkflowPort>;
  bindings?: {
    personaRef?: string;
    skillRefs?: string[];
    toolsetRef?: string;
    modelProfileRef?: string;
  };
  onError?: WorkflowErrorPolicy;
  config: Record<string, any>;
  [key: string]: unknown;
}

export interface WorkflowPort {
  type: string;
  required?: boolean;
  enum?: Array<string | number | boolean | null>;
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  map: Record<string, string>;
  when?: WorkflowPredicate;
  default?: boolean;
  priority?: number;
  loop?: {
    maxIterations: number;
    counterId: string;
    onExhausted: { strategy: 'fail' | 'route'; to?: string; map?: Record<string, string> };
  };
  [key: string]: unknown;
}

export interface WorkflowPredicate {
  path: string;
  operator: string;
  value?: unknown;
}

export interface WorkflowErrorPolicy {
  strategy: 'fail' | 'retry' | 'route';
  maxAttempts?: number;
  backoffSeconds?: number;
  retryOn?: string[];
  routeTo?: string;
  routeMap?: Record<string, string>;
}

/**
 * Output type for the only Phase 2 trust boundary: a profile that has passed
 * structural and semantic validation before registry exposure.
 */
declare const validatedWorkflowProfileBrand: unique symbol;
export type ValidatedWorkflowProfileDocument = Readonly<WorkflowProfileDocument> & {
  readonly [validatedWorkflowProfileBrand]: true;
};

export interface WorkflowProfileDiagnostic {
  stage: 'read' | 'utf8' | 'parse' | 'schema-version' | 'structural' | 'semantic';
  code: string;
  message: string;
  file?: string;
  profileId?: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface WorkflowProfileValidationResult {
  ok: boolean;
  profile?: Readonly<WorkflowProfileDocument>;
  diagnostics: WorkflowProfileDiagnostic[];
}
