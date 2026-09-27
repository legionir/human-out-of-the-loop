import fs from 'node:fs';
import path from 'node:path';
import { environmentBullets } from '../environment-context.js';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NoObjectGeneratedError, generateObject } from 'ai';
import { describeLlmError, withLlmTimeout, withStructuredRetry } from '../runtime/llm-timeout.js';
import { isAbortError, throwIfAborted } from '../runtime/abort.js';
import { reportLlmUsage, type LlmUsageReporter } from '../runtime/llm-usage.js';
import type { PersonaRegistry } from '../registries/persona-registry.js';
import type { SkillRegistry } from '../registries/skill-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { ModelRegistry } from '../registries/model-registry.js';
import { createAgent, type ResolvedAgent } from '../agents/agent-factory.js';
import { DEFAULT_RUN_MODE, type RunMode } from '../modes.js';
import { detectLanguage, type DetectedLanguage } from '../language.js';
import { DEFAULT_MODEL_ID } from '../models/defaults.js';
import { withGenerationSettings } from '../models/generation-settings.js';
import { buildCatalogBlock } from './catalog-prompt.js';
import {
  formatPlanExample,
  loadPlanExamples,
  planExamplesEnabled,
  selectPlanExample,
} from './plan-examples.js';
import {
  PlanModelSchema,
  PlannerAssessmentLlmSchema,
  PlannerAssessmentRecoverySchema,
  type Plan,
  type PlanModel,
  type PlannerAssessment,
} from '../schemas/plan.js';

// ─── Types ────────────────────────────────────────────────────────

export interface PlannerConfig {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  /** Model id to use for planning (default: DEFAULT_MODEL_ID) */
  modelId?: string;
  /**
   * Phase 30 (P5): deadline for each structured LLM call.  A provider that
   * never answers must not leave the CLI waiting forever.
   */
  timeoutMs?: number;
  /**
   * Phase 32: the directory the run works in.  It is put in front of the
   * model as PROJECT CONTEXT — without it the planner has no idea which
   * project "scan this project" means and answers with questions the user
   * already answered by standing in that directory.
   */
  projectRoot?: string;
  /** Token usage of every planning call (assessment, generation, re-planning). */
  onUsage?: LlmUsageReporter;
  /** B-15: compact block of recent session turns injected into prompts. */
  sessionHistory?: string;
}

export const SESSION_HISTORY_LIMIT = 5;

const sessionHistoryStore = new AsyncLocalStorage<{ block?: string }>();

export function formatSessionHistory(
  interactions: Array<{
    userRequest: string;
    outcome?: string;
    reviewSummary?: string;
    completedAt?: number;
  }>,
  limit = SESSION_HISTORY_LIMIT,
): string {
  const done = interactions.filter((i) => i.completedAt).slice(-limit);
  if (done.length === 0) return '';
  const lines = done.map((i) => {
    const summary = (i.reviewSummary ?? '').replace(/\s+/g, ' ').slice(0, 240);
    return `- User: ${i.userRequest.slice(0, 200)}\n  Outcome: ${i.outcome ?? 'unknown'}${summary ? `\n  Summary: ${summary}` : ''}`;
  });
  return `RECENT SESSION HISTORY (oldest first):\n${lines.join('\n')}`;
}

/**
 * What came out of planning (v27.17.0).
 *
 * `isClear` stays for the callers that learned it first; the kind is what the
 * orchestrator branches on, and it is the only place the three outcomes are
 * named.
 */
export type AssessmentKind = 'plan' | 'answer' | 'clarify';

export interface PlanningResult {
  /** What the planner decided — see `AssessmentKind`. */
  kind: AssessmentKind;
  /** Whether the request was clear enough to produce a plan */
  isClear: boolean;
  /** Clarification questions (when isClear=false) */
  needsClarification: string[];
  /** The generated plan (when kind="plan") */
  plan?: Plan;
  /** The model's own reply (when kind="answer") — may be empty; the
   *  orchestrator answers again with read-only tools and uses this as the
   *  fallback. */
  answer?: string;
  /** Errors encountered during planning */
  errors: string[];
}

// ─── Planner ──────────────────────────────────────────────────────

/**
 * The Planner uses the `planner` persona + `task_decomposition` skill
 * to convert a user request into a structured execution Plan.
 *
 * Uses generateObject for guaranteed schema compliance.
 */
/**
 * Give a model-produced plan the identity and statuses the runtime relies
 * on: an id (`plan_<uuid>` when the model omitted one), `draft` status, a
 * creation timestamp and every step `pending`.
 */
export function finalizePlan(plan: Plan | PlanModel): Plan {
  const steps = plan.steps.map((step) => ({
    ...step,
    dependsOn: step.dependsOn ?? [],
    assignedSkills: step.assignedSkills ?? [],
    assignedTools: step.assignedTools ?? [],
    claimedResources: step.claimedResources ?? [],
    status: 'pending' as const,
  }));
  return {
    ...plan,
    steps,
    clarifications: plan.clarifications ?? [],
    // R1-09: `id`/`createdAt` are runtime-assigned identity, never trusted
    // from the model. A model that always answers `id: "plan-1"` must not
    // be able to make two separate runs collide on the same plan file.
    id: `plan_${randomUUID()}`,
    status: 'draft',
    createdAt: Date.now(),
  };
}

// ─── Project context (Phase 32) ───────────────────────────────────

/** Directory entries never worth a model's attention (and often huge). */
const CONTEXT_SKIP = new Set([
  'node_modules', '.git', '.ai-runtime', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.venv', '__pycache__', '.turbo', '.svelte-kit',
]);

/** How many top-level entries the context block lists. */
export const PROJECT_CONTEXT_MAX_ENTRIES = 40;

/** Shallow listing of `projectRoot`: directories first, heavy ones dropped. */
export function projectTopLevelEntries(projectRoot: string, max = PROJECT_CONTEXT_MAX_ENTRIES): string[] {
  try {
    return fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !CONTEXT_SKIP.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => {
        const dirA = a.endsWith('/');
        const dirB = b.endsWith('/');
        if (dirA !== dirB) return dirA ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, max);
  } catch {
    return [];
  }
}

/**
 * The PROJECT CONTEXT block prepended to every planner prompt.
 *
 * It answers the two questions the model otherwise asks the user: *which*
 * project, and *where* it lives.  Paths in a plan are relative to this
 * root, and the file tools refuse to leave it (see path-security.ts).
 */
export function buildProjectContext(projectRoot: string | undefined): string {
  if (!projectRoot) return '';
  const root = path.resolve(projectRoot);
  const entries = projectTopLevelEntries(root);
  const lines = [
    'PROJECT CONTEXT (known — never ask the user for it):',
    `- project root: ${root}`,
    // Phase 36: the machine, not just its name — which shell a command will run
    // in, which separator to build paths with, GNU vs BSD.  The planner writes
    // the commands the agent will later run, so it needs this at plan time.
    ...environmentBullets(),
    '- every path in the plan is relative to that root; read_file/write_file/search_code work inside it and nowhere else',
    '- the project already exists: questions like "which project?" or "what is the current directory?" are already answered by this block',
  ];
  if (entries.length > 0) {
    lines.push(`- top-level entries: ${entries.join('  ')}`);
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    lines.push('- package.json is present (Node.js project)');
  }
  return lines.join('\n');
}

/**
 * The assessment prompt — exported so the PROJECT CONTEXT it carries can
 * be asserted without a model call.
 */
export function buildAssessmentPrompt(
  userRequest: string,
  projectRoot?: string,
  mode: RunMode = DEFAULT_RUN_MODE,
  sessionHistory?: string,
  catalog?: string,
): string {
  const context = buildProjectContext(projectRoot);
  const note = context
    ? `${context}\n\nA request that only lacks the project, its location or its technology stack is CLEAR: the context above supplies them.\n`
    : '';
  // The mode decides what the three kinds mean for this run; without this the
  // model would happily answer a greeting even when the user typed `@plan`.
  const modeRule =
    mode === 'chat'
      ? 'The user asked for a CONVERSATION: set kind="answer" and put your reply in the "answer" field. Do not plan, and never answer a conversation with kind="clarify" — a greeting, a thank-you or a short remark is answered with kind="answer" like anything else.'
      : mode === 'plan'
        ? 'The user asked for a PLAN: real work is expected. Set kind="plan" and provide the full plan, even for a short request — use kind="clarify" only when the request cannot be planned without an answer you cannot infer.'
        : 'Decide what the request needs:\n' +
          '- a greeting ("hello", "سلام"), a thank-you, small talk, a question, an explanation, or anything you can answer yourself → kind="answer" with your reply in the "answer" field;\n' +
          '- real work in this project (files to change, commands to run, several steps) → kind="plan" and provide the full plan;\n' +
          '- too vague to do either → kind="clarify" and ask.';
  return `
You are deciding what to do with the following user request.
${note ? `\n${note}` : ''}
${modeRule}
${catalog ? `\n${catalog}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""
${sessionHistory ? `\n${sessionHistory}\n` : ''}
Set kind="plan" or kind="answer" or kind="clarify" and fill the matching field:
- "plan": the complete execution plan (goal + steps with personas, skills, tools and acceptance criteria);
- "answer": your reply to the user, written for them (not a summary of this decision);
- "clarify": put 1-5 specific, answerable questions in the "needsClarification" array — never an empty list.

A request that is a question about the project, its files, or the runtime is kind="answer"; when it can only be answered by reading the project, say what you need in the answer — do not invent file contents.
Assign only persona, skill and tool ids from the catalog above — never invent ids.
`.trim();
}

/**
 * The plan-generation prompt (same PROJECT CONTEXT, plus the answers the
 * user gave during clarification).
 */
export function buildPlanPrompt(
  userRequest: string,
  clarifications?: Record<string, string>,
  projectRoot?: string,
  sessionHistory?: string,
  catalog?: string,
  example?: string,
): string {
  const context = buildProjectContext(projectRoot);
  let prompt = `
Decompose the following user request into a detailed execution plan.
${context ? `\n${context}\n` : ''}
${catalog ? `${catalog}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""
`.trim();

  if (sessionHistory) {
    prompt += `\n\n${sessionHistory}`;
  }

  if (example) {
    prompt += `\n\n${example}`;
  }

  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt += `\n\nCLARIFICATIONS PROVIDED BY USER:\n`;
    for (const [q, a] of Object.entries(clarifications)) {
      prompt += `Q: ${q}\nA: ${a}\n\n`;
    }
  }
  return prompt;
}

/**
 * The names a model has used for "the questions I need answered before I can
 * plan", when a provider did not enforce the response schema.  `needsClarification`
 * is the real field; the rest are merged into it rather than dropped.
 */
export const CLARIFICATION_FIELD_ALIASES = ['clarificationQuestions', 'questions'] as const;

/** Trim, drop blanks, and de-duplicate questions (a model often repeats one). */
export function dedupeQuestions(questions: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of questions) {
    const question = typeof raw === 'string' ? raw.trim() : '';
    if (question === '') continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(question);
  }
  return out;
}

/**
 * Pull the first JSON object out of a model's text (v27.17.1).
 *
 * The text may be a bare object (the usual case) or an object wrapped in prose
 * or a code fence; a brace scan that respects strings and escapes finds the
 * real end of the object where a greedy regex would swallow the text after it.
 * Returns undefined when the text holds no complete object.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Recover an assessment from a structured call that the SDK rejected (v27.17.1).
 *
 * Only for `NoObjectGeneratedError`: the model *did* answer, the answer just
 * did not satisfy the response schema exactly.  Anything else (a timeout, a
 * 401, a network error) has no text to recover and is re-thrown untouched by
 * the caller.
 */
export function recoverAssessment(
  error: unknown
): { assessment: Partial<PlannerAssessment>; text: string } | undefined {
  if (!NoObjectGeneratedError.isInstance(error)) return undefined;
  const text = typeof error.text === 'string' ? error.text : '';
  if (text.trim() === '') return undefined;
  const parsed = PlannerAssessmentRecoverySchema.safeParse(extractJsonObject(text));
  if (!parsed.success) return undefined;
  return { assessment: parsed.data as Partial<PlannerAssessment>, text };
}

/**
 * The same recovery for a plan the schema refused (v27.17.1).  `PlanSchema` is
 * the judge here, not the provider: a `goal` + `steps` answer that the provider
 * mangled only slightly is still a usable plan.
 */
export function recoverPlan(error: unknown): Plan | undefined {
  if (!NoObjectGeneratedError.isInstance(error)) return undefined;
  const text = typeof error.text === 'string' ? error.text : '';
  if (text.trim() === '') return undefined;
  const parsed = PlanModelSchema.safeParse(extractJsonObject(text));
  return parsed.success ? finalizePlan(parsed.data) : undefined;
}

/**
 * The words models use for the three kinds (v27.17.0).  Anything unknown is
 * ignored, so `normalizeAssessment` falls back to the fields that were filled.
 */
export function normalizeKind(value: unknown): AssessmentKind | undefined {
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  if (!word) return undefined;
  if (['answer', 'chat', 'reply', 'respond', 'response', 'conversation', 'question'].includes(word)) {
    return 'answer';
  }
  if (['plan', 'task', 'execute', 'work', 'action'].includes(word)) return 'plan';
  if (['clarify', 'clarification', 'ask', 'unclear', 'ambiguous'].includes(word)) return 'clarify';
  return undefined;
}

/** The model's own prose, under any of the three names it uses for it. */
export function firstAnswer(assessment: {
  answer?: string;
  response?: string;
  reply?: string;
}): string | undefined {
  for (const candidate of [assessment.answer, assessment.response, assessment.reply]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * The question to ask when the model said "this is not clear enough" and then
 * listed nothing.  It is built from what the runtime already knows (the project
 * root and its top-level entries), so it never asks the user for the project or
 * for context the run already has.
 */
export function fallbackClarificationQuestion(
  projectRoot?: string,
  language?: DetectedLanguage
): string {
  const root = projectRoot ? path.resolve(projectRoot) : undefined;
  const entries = root ? projectTopLevelEntries(root, 8) : [];
  const see = entries.length > 0 ? ` I can see: ${entries.join(', ')}.` : '';

  // The one question the runtime writes itself must be in the user's language:
  // a Persian speaker who gets an English fallback has been asked nothing.
  if (language?.code === 'fa') {
    const where = root ? ` در ${root}` : '';
    const listing = entries.length > 0 ? ` اینها را می‌بینم: ${entries.join('، ')}.` : '';
    return `دقیقاً چه کاری باید${where} انجام دهم؟${listing} خروجی مورد نظر را مشخص کن — کدام فایل‌ها یا دایرکتوری‌ها باید تغییر کنند و «تمام‌شده» یعنی چه.`;
  }

  if (!root) {
    return 'What exactly should I do? Name the deliverable — the files or directories to touch, and what "done" means.';
  }
  return (
    `What exactly should I do in ${root}?${see} ` +
    'Name the deliverable — the files or directories to change, and what "done" means.'
  );
}

/**
 * Make an assessment usable, whatever shape the model answered in.
 *
 * Two guarantees, both of them lessons from a real run that showed the user
 * `⚠️ Clarification needed:` with an empty list under it:
 *
 *   1. questions that arrived under an alias (`clarificationQuestions`,
 *      `questions`) are merged into `needsClarification`;
 *   2. `isClear: false` always comes back with at least one question — the
 *      fallback names the project, so "what do you want me to do?" is
 *      answerable instead of a dead end.
 *
 * A *clear* assessment is left exactly as it was: `needsClarification` is empty
 * for a plan that is about to be executed.
 */
export function normalizeAssessment(
  // `Partial` on purpose: a provider (or a test double) can hand back an object
  // without the defaulted field, and that must not throw mid-plan.
  assessment: PlannerAssessment | (Partial<PlannerAssessment> & { isClear?: boolean }),
  options: { projectRoot?: string; mode?: RunMode; language?: DetectedLanguage } = {}
): PlannerAssessment {
  const merged = dedupeQuestions([
    ...(assessment.needsClarification ?? []),
    ...(assessment.clarificationQuestions ?? []),
    ...(assessment.questions ?? []),
  ]);
  const answer = firstAnswer(assessment);
  const mode = options.mode ?? DEFAULT_RUN_MODE;

  // The kind the model asked for, if it named one; otherwise derive it from the
  // fields it filled.  The order matters: an explicit `isClear: false` is a
  // refusal to proceed, and a plan is always a plan.
  const declared =
    normalizeKind(assessment.kind) ??
    normalizeKind(assessment.intent) ??
    (assessment.isClear === false
      ? 'clarify'
      : assessment.isClear === undefined && merged.length > 0
        ? // v27.17.1: questions without a verdict are a clarification.  A
          // provider that dropped `isClear` (and `kind` with it) would
          // otherwise be read as a clear request and its questions ignored.
          'clarify'
        : answer && !assessment.plan
          ? 'answer'
          : 'plan');

  /**
   * The mode the user chose wins over the model's own idea of the request —
   * that is the whole point of `@plan` / `@chat` — but never over a refusal
   * that only the user can resolve:
   *   - a forced plan cannot become an answer;
   *   - a forced answer cannot become a plan (the user asked to talk);
   *   - "clarify" survives `plan` (real work that needs an answer is still
   *     asked about) but not `chat` (chat replies in prose, it does not open
   *     the clarification loop).
   */
  let kind = declared;
  if (mode === 'chat') kind = 'answer';
  else if (mode === 'plan' && kind === 'answer') kind = 'plan';

  if (kind === 'answer') {
    return {
      ...assessment,
      kind: 'answer',
      isClear: true,
      answer,
      needsClarification: merged,
    } as PlannerAssessment;
  }

  if (kind === 'clarify') {
    return {
      ...assessment,
      kind: 'clarify',
      isClear: false,
      needsClarification:
        merged.length > 0
          ? merged
          : [fallbackClarificationQuestion(options.projectRoot, options.language)],
    } as PlannerAssessment;
  }

  return { ...assessment, kind: 'plan', isClear: true, needsClarification: merged } as PlannerAssessment;
}

export class Planner {
  private readonly config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /**
   * B-15: the session-history block for the planning calls of ONE run.
   * Held per async call chain, not on the (shared) planner — the web server
   * plans several runs at once and each must see only its own session.
   */
  withSessionHistory<T>(block: string | undefined, fn: () => T): T {
    return sessionHistoryStore.run({ block }, fn);
  }

  private sessionHistory(): string | undefined {
    return sessionHistoryStore.getStore()?.block ?? this.config.sessionHistory;
  }

  /**
   * Phase 1: Assess whether the request is clear enough.
   * Uses generateObject for guaranteed schema compliance.
   */
  /**
   * @param usagePlanId plan the call's token usage is billed to — set when
   *   re-planning an existing plan; otherwise the new plan's own id is used.
   */
  async assess(
    userRequest: string,
    usagePlanId?: string,
    modelId?: string,
    mode: RunMode = DEFAULT_RUN_MODE,
    abortSignal?: AbortSignal,
  ): Promise<PlannerAssessment> {
    throwIfAborted(abortSignal, 'Planner assessment');
    const language = detectLanguage(userRequest);
    const agent = this.buildPlannerAgent(modelId, language);
    const assessmentPrompt = buildAssessmentPrompt(
      userRequest,
      this.config.projectRoot,
      mode,
      this.sessionHistory(),
      this.catalogBlock(),
    );

    try {
      const { object, usage } = await withStructuredRetry<{
        object: Partial<PlannerAssessment>;
        usage: unknown;
      }>(async () => {
        try {
          return await withLlmTimeout(
            'Planner assessment',
            this.config.timeoutMs,
            (signal) =>
              generateObject(withGenerationSettings({
                model: agent.model,
                system: agent.systemPrompt,
                prompt: assessmentPrompt,
                schema: PlannerAssessmentLlmSchema,
                schemaName: 'PlannerAssessment',
                schemaDescription:
                  'Assessment of whether a user request is clear enough to plan, ' +
                  'with optional clarification questions or a full plan.',
                abortSignal: signal,
              }, agent.generationSettings)),
            abortSignal,
          );
        } catch (err) {
          if (isAbortError(err) || abortSignal?.aborted) throw err;
          // v27.17.2: a recoverable answer is used as it is — the retry is for
          // answers that CANNOT be read, not for providers that merely skip a
          // schema field.  (The reporter's gateway skipped `isClear` on every
          // call, and every planning turn cost two requests: the same prompt
          // twice, the second one just as unusable as the first.)
          const recovered = recoverAssessment(err);
          if (recovered) {
            return {
              object: recovered.assessment,
              usage: NoObjectGeneratedError.isInstance(err) ? err.usage : undefined,
            };
          }
          throw err;
        }
      }, 2, (err) => {
        if (NoObjectGeneratedError.isInstance(err)) {
          reportLlmUsage(this.config.onUsage, 'planning', err.usage, usagePlanId);
        }
      });

      return this.finishAssessment(object, usage, mode, language, usagePlanId);
    } catch (err) {
      if (isAbortError(err) || abortSignal?.aborted) throw err;
      // v27.17.1: a provider that does not enforce the response schema can
      // answer almost correctly — one missing field is enough for the SDK to
      // refuse the object — and the run used to die right here with
      // "No object generated: response did not match schema", although the
      // answer (questions, plan or reply) was sitting in the text.  Recover it.
      const recovered = recoverAssessment(err);
      if (recovered) {
        const usage = NoObjectGeneratedError.isInstance(err) ? err.usage : undefined;
        return this.finishAssessment(recovered.assessment, usage, mode, language, usagePlanId);
      }
      // Phase 30 (P5): say WHY (a deadline, a provider error, bad output).
      // It is a failure, not a question for the user — `plan()` reports it
      // as an error, so the run ends with "Planning failed: <reason>"
      // instead of asking the user to "provide more details".
      const reason = describeLlmError(err);
      throw new Error(`The planner was unable to process the request: ${reason}`);
    }
  }

  /**
   * Make whatever the model answered usable — the tail of `assess()`, shared by
   * the normal path and the recovery path so they cannot drift apart.
   *
   * The provider may not have enforced the response schema, so the answer is
   * normalized before anything reads it: aliased question fields are merged,
   * and "unclear" always carries at least one question (see the function).
   * A plan that arrived inside the assessment gets the same shape
   * `generatePlan` produces (Phase 30, P10): without an id it could not be
   * cancelled/resumed via the CLI or the API, its log entries carried no
   * planId at all, and every id-less plan was written to the SAME store file
   * (`sha256("unknown")`).
   */
  private finishAssessment(
    object: Partial<PlannerAssessment>,
    usage: unknown,
    mode: RunMode,
    language: DetectedLanguage | undefined,
    usagePlanId?: string
  ): PlannerAssessment {
    const assessment = normalizeAssessment(object, {
      projectRoot: this.config.projectRoot,
      mode,
      ...(language ? { language } : {}),
    });

    if (assessment.plan) {
      assessment.plan = finalizePlan(assessment.plan);
    }
    reportLlmUsage(this.config.onUsage, 'planning', usage, usagePlanId ?? assessment.plan?.id);

    return assessment;
  }

  /**
   * Phase 2: Generate a full Plan from a clear (or clarified) request.
   * Uses generateObject for guaranteed schema compliance.
   */
  async generatePlan(
    userRequest: string,
    clarifications?: Record<string, string>,
    usagePlanId?: string,
    modelId?: string,
    abortSignal?: AbortSignal,
  ): Promise<Plan> {
    throwIfAborted(abortSignal, 'Plan generation');
    const agent = this.buildPlannerAgent(modelId, detectLanguage(userRequest));

    const example =
      this.config.projectRoot && planExamplesEnabled()
        ? selectPlanExample(userRequest, loadPlanExamples(this.config.projectRoot))
        : undefined;
    const prompt = buildPlanPrompt(
      userRequest,
      clarifications,
      this.config.projectRoot,
      this.sessionHistory(),
      this.catalogBlock(),
      example ? formatPlanExample(example) : undefined,
    );

    const { object, usage } = await withStructuredRetry<{ object: Plan; usage: unknown }>(
      async () => {
        try {
          return await withLlmTimeout(
            'Plan generation',
            this.config.timeoutMs,
            (signal) =>
              generateObject(withGenerationSettings({
                model: agent.model,
                system: agent.systemPrompt,
                prompt,
                schema: PlanModelSchema,
                schemaName: 'ExecutionPlan',
                schemaDescription: 'A dependency-aware execution plan with atomic steps.',
                abortSignal: signal,
              }, agent.generationSettings)),
            abortSignal,
          );
        } catch (err) {
          if (isAbortError(err) || abortSignal?.aborted) throw err;
          // v27.17.2: same recovery as the assessment — the provider can
          // return a usable plan that only its own (unenforced) schema
          // complained about, and that plan is used instead of paying for a
          // second identical call.
          const recovered = recoverPlan(err);
          if (!recovered) throw err;
          return {
            object: recovered,
            usage: NoObjectGeneratedError.isInstance(err) ? err.usage : undefined,
          };
        }
      },
      2,
      (err) => {
        if (NoObjectGeneratedError.isInstance(err)) {
          reportLlmUsage(this.config.onUsage, 'planning', err.usage, usagePlanId);
        }
      }
    );
    const plan = finalizePlan(object);
    reportLlmUsage(this.config.onUsage, 'planning', usage, usagePlanId ?? plan.id);
    return plan;
  }

  /**
   * Combined assess + generate in one call.
   */
  /**
   * @param modelId model for this call (a per-run override); default: the
   *   planner's configured model.
   */
  /**
   * Turn a request into ONE of three outcomes (v27.17.0):
   *
   *   plan     a plan, ready for confirmation (the pre-v27.17 behaviour);
   *   answer   the model's own reply — the request was a conversation;
   *   clarify  questions for the user (or the reason nothing could be asked).
   *
   * `mode` is the user's choice (`--mode`, `@chat`/`@plan`, `HOTL_MODE`,
   * config); `auto` — the default — lets the model decide, which is why the
   * classification costs one extra call that only planning ever paid for.
   */
  async plan(
    userRequest: string,
    usagePlanId?: string,
    modelId?: string,
    mode: RunMode = DEFAULT_RUN_MODE,
    abortSignal?: AbortSignal,
  ): Promise<PlanningResult> {
    try {
      throwIfAborted(abortSignal);
      const assessment = await this.assess(userRequest, usagePlanId, modelId, mode, abortSignal);

      if (assessment.kind === 'answer') {
        return {
          kind: 'answer',
          isClear: true,
          needsClarification: [],
          ...(assessment.answer ? { answer: assessment.answer } : {}),
          errors: [],
        };
      }

      if (assessment.kind === 'clarify' || assessment.isClear !== true) {
        return {
          kind: 'clarify',
          isClear: false,
          needsClarification: assessment.needsClarification,
          errors: [],
        };
      }

      if (assessment.plan) {
        return {
          kind: 'plan',
          isClear: true,
          needsClarification: [],
          plan: assessment.plan,
          errors: [],
        };
      }

      throwIfAborted(abortSignal);
      const plan = await this.generatePlan(userRequest, undefined, usagePlanId, modelId, abortSignal);
      return {
        kind: 'plan',
        isClear: true,
        needsClarification: [],
        plan,
        errors: [],
      };
    } catch (err) {
      if (isAbortError(err) || abortSignal?.aborted) throw err;
      const message = describeLlmError(err);
      // v27.17.1: in chat mode the user asked for a conversation, so a broken
      // classifier must not turn a greeting into "Planning failed".  Answer
      // without a draft — the answer call does the work, and if THAT fails too
      // the report says so.
      if (mode === 'chat') {
        return { kind: 'answer', isClear: true, needsClarification: [], errors: [] };
      }
      return {
        kind: 'clarify',
        isClear: false,
        needsClarification: [],
        errors: [message],
      };
    }
  }

  /**
   * The chat-mode answer prompt (v27.17.0): the user's request, the project
   * context it may be about, and the language rule.  The system prompt comes
   * from the `chat` persona (read-only tools, "never claim you did something").
   */
  buildAnswerPrompt(userRequest: string): string {
    const context = buildProjectContext(this.config.projectRoot);
    return `
${context ? `${context}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""

Answer the request above directly, in the user's language. Use the read-only tools if you need to check something in the project — read, never guess. If the request needs files to change or several steps of work, say so in a sentence or two and point the user at \`@plan <request>\`; never pretend you did it.

End your reply with a final line, exactly as shown, with no other text on that line:
[[NEEDS_PLAN: true]]   — if THIS request needs a plan (files to change, commands to run, several steps) and you just said so
[[NEEDS_PLAN: false]]  — for every other reply, including one that merely mentions \`@plan\` as an example or explanation
`.trim();
  }

  /**
   * Build the `chat` agent: the chat persona with the read-only half of the
   * catalog.  `toolIds: []` gives a pure text answer (used by previews, which
   * must not touch the project).
   */
  buildChatAgent(
    modelId?: string,
    toolIds?: readonly string[],
    languageHint?: DetectedLanguage,
  ): ResolvedAgent {
    return createAgent({
      agentDefinition: {
        id: 'chat-runtime',
        name: 'Chat',
        personaId: 'chat',
        skillIds: [],
        ...(toolIds ? { toolIds: [...toolIds] } : {}),
        modelId: modelId ?? this.config.modelId ?? DEFAULT_MODEL_ID,
      },
      refs: {
        personaRegistry: this.config.personaRegistry,
        skillRegistry: this.config.skillRegistry,
        toolRegistry: this.config.toolRegistry,
        modelRegistry: this.config.modelRegistry,
      },
      // E-07 moved the language rule out of the prompt into the agent: the
      // chat agent must get it too, or a Persian question is answered in
      // whatever language the model prefers.
      ...(languageHint ? { languageHint } : {}),
    });
  }

  // ── Private helpers ───────────────────────────────────────────

  private catalogBlock(): string {
    return buildCatalogBlock({
      personaRegistry: this.config.personaRegistry,
      skillRegistry: this.config.skillRegistry,
      toolRegistry: this.config.toolRegistry,
    });
  }

  private buildPlannerAgent(override?: string, languageHint?: DetectedLanguage): ResolvedAgent {
    const modelId = override ?? this.config.modelId ?? DEFAULT_MODEL_ID;

    return createAgent({
      agentDefinition: {
        id: 'planner-runtime',
        name: 'Planner',
        personaId: 'planner',
        skillIds: ['task_decomposition'],
        modelId,
      },
      refs: {
        personaRegistry: this.config.personaRegistry,
        skillRegistry: this.config.skillRegistry,
        toolRegistry: this.config.toolRegistry,
        modelRegistry: this.config.modelRegistry,
      },
      languageHint,
      includeEnvironment: false,
    });
  }

}
