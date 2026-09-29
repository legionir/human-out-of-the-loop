import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { generateObject, generateText } from 'ai';
import { Orchestrator, extractNeedsPlan } from '../orchestrator.js';
import { parseRunMode } from '../modes.js';
import {
  buildAssessmentPrompt,
  buildPlanPrompt,
  normalizeAssessment,
  normalizeKind,
  fallbackClarificationQuestion,
} from '../planning/planner.js';
import { detectLanguage, languageSection } from '../language.js';
import { readOnlyToolIds, isReadOnlyTool } from '../tools/read-only.js';
import { parseModePrefix, resolveRunMode } from '../../cli/utils/mode-prefix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
/**
 * Runs that may execute a step work on a temporary copy of the project, never
 * on the repository itself (a step rollback writes files back).
 */
const PROJECT_ROOT = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-proj-'));
  fs.cpSync(path.join(REPO_ROOT, 'registry'), path.join(dir, 'registry'), { recursive: true });
  return dir;
})();

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

let tmpDir = '';

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
  process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-chat-'));
  mockGenerateObject.mockReset();
  mockGenerateText.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── the three modes ─────────────────────────────────────────────

describe('v27.17.0 — auto / chat / plan', () => {
  it('accepts only the three words, in any case', () => {
    expect(parseRunMode('auto')).toBe('auto');
    expect(parseRunMode(' CHAT ')).toBe('chat');
    expect(parseRunMode('Plan')).toBe('plan');
    expect(parseRunMode('talk')).toBeUndefined();
    expect(parseRunMode(undefined)).toBeUndefined();
  });

  it('reads the prefix from the request and strips it', () => {
    expect(parseModePrefix('@chat hello there')).toEqual({
      mode: 'chat',
      text: 'hello there',
      explicit: true,
    });
    expect(parseModePrefix('@plan  tidy the fixtures')).toEqual({
      mode: 'plan',
      text: 'tidy the fixtures',
      explicit: true,
    });
    // No prefix: the request is untouched.
    expect(parseModePrefix('tidy the fixtures')).toEqual({
      text: 'tidy the fixtures',
      explicit: false,
    });
  });

  it('leaves @mentions and a bare @chat alone', () => {
    // The real run used `@aur/auto` as a MODEL, not a mode — and any other
    // @word is part of the request.
    expect(parseModePrefix('@aur/auto fix the tests')).toEqual({
      text: '@aur/auto fix the tests',
      explicit: false,
    });
    expect(parseModePrefix('@chat')).toEqual({ text: '@chat', explicit: false });
    expect(parseModePrefix('@chat ')).toEqual({ text: '@chat', explicit: false });
    expect(parseModePrefix('@chatty hello')).toEqual({ text: '@chatty hello', explicit: false });
  });

  it('takes the last prefix when more than one is typed', () => {
    expect(parseModePrefix('@chat @plan do it').mode).toBe('plan');
  });

  it('resolves prefix > flag > env > config > auto', () => {
    expect(
      resolveRunMode({
        prefix: 'chat',
        flag: 'plan',
        env: { HOTL_MODE: 'auto' },
        config: { defaultMode: 'plan' },
      }).resolved
    ).toEqual({ mode: 'chat', source: 'prefix' });

    expect(
      resolveRunMode({ flag: 'plan', env: { HOTL_MODE: 'auto' }, config: { defaultMode: 'chat' } })
        .resolved
    ).toEqual({ mode: 'plan', source: 'flag' });

    expect(
      resolveRunMode({ env: { HOTL_MODE: 'chat' }, config: { defaultMode: 'plan' } }).resolved
    ).toEqual({ mode: 'chat', source: 'env' });

    expect(resolveRunMode({ env: {}, config: { defaultMode: 'plan' } }).resolved).toEqual({
      mode: 'plan',
      source: 'config',
    });

    expect(resolveRunMode({ env: {} }).resolved).toEqual({ mode: 'auto', source: 'default' });
  });

  it('reports a bad configured mode instead of silently falling back', () => {
    const bad = resolveRunMode({ env: { HOTL_MODE: 'talk' } });
    expect(bad.invalid).toEqual({ value: 'talk', source: 'env' });
    // A typo in one source does not hide a valid one later on.
    const recovered = resolveRunMode({
      env: { HOTL_MODE: 'talk' },
      config: { defaultMode: 'chat' },
    });
    expect(recovered.resolved).toEqual({ mode: 'chat', source: 'config' });
  });
});

// ─── classification ──────────────────────────────────────────────

describe('v27.17.0 — what the assessment means', () => {
  it('derives the kind from the fields when the model names none', () => {
    expect(
      normalizeAssessment({ isClear: true, needsClarification: [], plan: {} as never }).kind
    ).toBe('plan');
    expect(normalizeAssessment({ isClear: true, needsClarification: [], answer: 'hi' }).kind).toBe(
      'answer'
    );
    expect(normalizeAssessment({ isClear: false, needsClarification: ['q'] }).kind).toBe('clarify');
  });

  it('takes an explicit kind under either name, in the words models use', () => {
    expect(
      normalizeAssessment({ kind: 'answer', isClear: true, needsClarification: [] }).kind
    ).toBe('answer');
    expect(
      normalizeAssessment({ intent: 'chat', isClear: true, needsClarification: [] }).kind
    ).toBe('answer');
    expect(
      normalizeAssessment({ intent: 'clarification', isClear: true, needsClarification: [] }).kind
    ).toBe('clarify');
    expect(normalizeKind('EXECUTE')).toBe('plan');
    expect(normalizeKind('nonsense')).toBeUndefined();
  });

  it("lets the user's mode override the model, but never a need to ask", () => {
    // @plan on something the model wanted to answer → a plan.
    expect(
      normalizeAssessment(
        { kind: 'answer', isClear: true, needsClarification: [] },
        { mode: 'plan' }
      ).kind
    ).toBe('plan');
    // @chat on something the model wanted to plan → an answer.
    expect(
      normalizeAssessment(
        { kind: 'plan', isClear: true, needsClarification: [], plan: {} as never },
        { mode: 'chat' }
      ).kind
    ).toBe('answer');
    // …but a plan-mode run that genuinely needs an answer still asks.
    expect(
      normalizeAssessment(
        { isClear: false, needsClarification: ['which package?'] },
        { mode: 'plan' }
      ).kind
    ).toBe('clarify');
    // Chat answers in prose — it never opens the clarification loop.
    expect(
      normalizeAssessment(
        { isClear: false, needsClarification: ['which package?'] },
        { mode: 'chat' }
      ).kind
    ).toBe('answer');
  });

  it('keeps the answer text under any of its names', () => {
    const normalized = normalizeAssessment({
      isClear: true,
      needsClarification: [],
      response: '  hi there  ',
    });
    expect(normalized.kind).toBe('answer');
    expect(normalized.answer).toBe('hi there');
    expect(normalizeAssessment({ isClear: true, needsClarification: [], reply: 'yo' }).answer).toBe(
      'yo'
    );
  });

  it('asks a question when it cannot answer or plan', () => {
    const normalized = normalizeAssessment(
      { isClear: false, needsClarification: [] },
      {
        projectRoot: '/tmp/p',
      }
    );
    expect(normalized.kind).toBe('clarify');
    expect(normalized.needsClarification[0]).toContain(path.resolve('/tmp/p'));
  });
});

// ─── the prompts say which mode it is ────────────────────────────

describe('v27.17.0 — the mode is in the prompt', () => {
  it('tells the model what to do in each mode', () => {
    const auto = buildAssessmentPrompt('do the thing', REPO_ROOT, 'auto');
    expect(auto).toContain('kind="answer"');
    expect(auto).toContain('kind="plan"');
    expect(auto).toContain('kind="clarify"');

    const chat = buildAssessmentPrompt('سلام', REPO_ROOT, 'chat');
    expect(chat).toContain('CONVERSATION');
    expect(chat).toContain('Do not plan');

    const plan = buildAssessmentPrompt('do the thing', REPO_ROOT, 'plan');
    expect(plan).toContain('asked for a PLAN');
  });
});

// ─── language ────────────────────────────────────────────────────

describe("v27.17.0 — the answer is in the user's language", () => {
  it('names the language of a request from its script', () => {
    expect(detectLanguage('سلام، حالت چطوره؟')).toMatchObject({ code: 'fa', name: 'Persian' });
    expect(detectLanguage('این پروژه چند تست دارد؟')).toMatchObject({ code: 'fa' });
    // Arabic kaf/yeh (U+0643/U+064A), not the Persian ones: the marker is what
    // tells the two apart.
    // Arabic-script text *without* a Persian-only letter cannot be told apart
    // from Persian — the runtime says so instead of guessing (see below).
    expect(detectLanguage('\u0645\u0631\u062d\u0628\u0627 \u0643\u064a\u0641')?.code).toBe(
      'arabic-script'
    );
    expect(detectLanguage('Привет, как дела?')).toMatchObject({ code: 'ru' });
    expect(detectLanguage('こんにちは')).toMatchObject({ code: 'ja' });
    // Latin text is left to the generic rule (a lone @ or digit proves nothing).
    expect(detectLanguage('hello there')).toBeUndefined();
    expect(detectLanguage('a')).toBeUndefined();
  });

  it('never guesses Persian vs Arabic when the script cannot say', () => {
    // "خواندن" is Persian but carries none of the letters that Persian adds to
    // the Arabic block — so the instruction names the script and tells the
    // model to match the request, instead of guessing "Arabic".
    const ambiguous = detectLanguage('\u062e\u0648\u0627\u0646\u062f\u0646 README');
    expect(ambiguous?.code).toBe('arabic-script');
    const instruction = languageSection('\u062e\u0648\u0627\u0646\u062f\u0646 README');
    expect(instruction).toContain('Arabic script');
    expect(instruction).toContain('SAME language as the request');
    expect(instruction).not.toContain('in Arabic (');
  });

  it('turns the detection into an instruction the model can follow', () => {
    // \u06cc (Persian yeh) is what makes this unambiguously Persian.
    const persian = '\u0627\u06cc\u0646 \u067e\u0631\u0648\u0698\u0647';
    expect(detectLanguage(persian)).toMatchObject({ code: 'fa' });
    expect(languageSection(persian)).toContain('Persian');
    expect(languageSection(persian)).toContain('فارسی');
    expect(languageSection('hello')).toContain('same language the user wrote');
  });

  it("writes the fallback question in the user's language", () => {
    const persian = fallbackClarificationQuestion('/tmp/proj', {
      code: 'fa',
      name: 'Persian',
      native: 'فارسی',
    });
    expect(persian).toContain(path.resolve('/tmp/proj'));
    expect(persian).toMatch(/[\u0600-\u06ff]/);
    expect(persian).toContain('تمام');
    // English (and no detection) keeps the English question.
    expect(fallbackClarificationQuestion('/tmp/proj')).toContain('What exactly should I do');
  });

  it('does not duplicate the language rule in planner user prompts (E-07)', () => {
    expect(buildAssessmentPrompt('این پروژه را مرتب کن', REPO_ROOT)).not.toContain('## Language');
    expect(buildPlanPrompt('این پروژه را مرتب کن', undefined, REPO_ROOT)).not.toContain('## Language');
  });
});

// ─── chat tools are read-only ────────────────────────────────────

describe('v27.17.0 — chat tool catalog', () => {
  it('is exactly the read-only half', () => {
    const ids = readOnlyToolIds();
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain('read_file');
    expect(ids).toContain('git_status');
    expect(ids.every((id) => isReadOnlyTool(id))).toBe(true);
    for (const writer of ['write_file', 'edit_file', 'git_commit', 'git_push', 'move_file']) {
      expect(ids).not.toContain(writer);
    }
  });

  it('the chat persona may only use tools from that half', () => {
    const persona = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'registry', 'personas', 'chat.json'), 'utf-8')
    ) as { id: string; allowedTools: string[] };
    expect(persona.id).toBe('chat');
    expect(persona.allowedTools.every((id) => isReadOnlyTool(id))).toBe(true);
    // Everything read-only is granted, so a new read tool is one line away.
    // Exactly the read-only catalog: no writer, and nothing read-only missing
    // (a new read tool must be granted here, which this assertion forces).
    expect([...persona.allowedTools].sort()).toEqual([...readOnlyToolIds()].sort());
    expect(persona.allowedTools).not.toContain('create_entities');
    expect(persona.allowedTools).not.toContain('sequentialthinking');
  });
});

// ─── the orchestrator actually answers ───────────────────────────

describe('v27.17.0 — a greeting is answered, not planned', () => {
  function orchestrator(): Orchestrator {
    return new Orchestrator({ projectRoot: PROJECT_ROOT, runtimeDir: tmpDir });
  }

  it('auto mode: answers and never plans when the planner says so', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { kind: 'answer', isClear: true, needsClarification: [], answer: 'draft reply' },
    } as never);
    mockGenerateText.mockResolvedValueOnce({
      text: 'سلام! من دستیار این پروژه هستم.',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      steps: [],
    } as never);

    const result = await orchestrator().run('سلام', {
      confirmCallback: async () => ({ confirmed: true }),
    });

    expect(result.kind).toBe('answer');
    expect(result.report).toContain('💬 Answer');
    expect(result.report).toContain('سلام! من دستیار این پروژه هستم.');
    expect(result.planId).toBe('none');
    expect(result.review.outcome).toBe('success');
    // No plan was created, and the chat call used the chat persona.
    expect(result.executionResult.completedSteps).toBe(0);
  });

  it('auto mode: a real task still becomes a plan', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: true,
        needsClarification: [],
        plan: {
          goal: 'write the notes',
          steps: [
            {
              id: 'step-1',
              description: 'write notes/first.txt',
              dependsOn: [],
              assignedPersona: 'coder',
              assignedSkills: ['file_management'],
              assignedTools: ['write_file'],
              claimedResources: ['notes/first.txt'],
              acceptanceCriteria: 'the file exists',
            },
          ],
        },
      },
    } as never);

    const result = await orchestrator().run('write the notes', {
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.kind).toBe('plan');
    expect(result.report).not.toContain('💬 Answer');
  }, 15_000);

  it('auto mode: an answer that only defers to @plan becomes a plan (real Persian run)', async () => {
    // The real gateway run: "یک فایل … بساز" was classified as a conversation,
    // and the answer told the user to retype it with @plan.
    mockGenerateObject
      .mockResolvedValueOnce({
        object: { kind: 'answer', isClear: true, needsClarification: [], answer: 'draft' },
      } as never)
      .mockResolvedValueOnce({
        object: {
          kind: 'plan',
          isClear: true,
          needsClarification: [],
          plan: {
            goal: 'notes/salam.txt',
            steps: [
              {
                id: 'step-1',
                description: 'write notes/salam.txt',
                dependsOn: [],
                assignedPersona: 'coder',
                assignedSkills: ['file_management'],
                assignedTools: ['write_file'],
                claimedResources: ['notes/salam.txt'],
                acceptanceCriteria: 'the file exists',
              },
            ],
          },
        },
      } as never);
    mockGenerateText.mockResolvedValueOnce({
      text: 'برای این کار باید فایل بسازم؛ لطفاً با `@plan یک فایل بساز` اجرا کنید.\n[[NEEDS_PLAN: true]]',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      steps: [],
    } as never);

    let confirmedPlan: unknown;
    const result = await orchestrator().run('یک فایل به نام notes/salam.txt بساز', {
      confirmCallback: async (plan) => {
        confirmedPlan = plan;
        return { confirmed: false };
      },
    });
    expect(result.report).not.toContain('💬 Answer');
    expect(confirmedPlan).toBeDefined();
    expect(mockGenerateObject).toHaveBeenCalledTimes(2);
  });

  it('extractNeedsPlan reads the explicit marker, not any mention of @plan', () => {
    expect(extractNeedsPlan('Run it as `@plan build it`.\n[[NEEDS_PLAN: true]]')).toEqual({
      needsPlan: true,
      answer: 'Run it as `@plan build it`.',
    });
    expect(
      extractNeedsPlan('For changes, use `@plan <request>`.\n[[NEEDS_PLAN: false]]'),
    ).toEqual({
      needsPlan: false,
      answer: 'For changes, use `@plan <request>`.',
    });
    // No marker at all (model ignored the instruction) never escalates.
    expect(extractNeedsPlan('Here is the answer.')).toEqual({
      needsPlan: false,
      answer: 'Here is the answer.',
    });
  });

  it('@chat (mode chat) never plans, even when the model offers a plan', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        kind: 'plan',
        isClear: true,
        needsClarification: [],
        plan: { goal: 'x', steps: [] },
      },
    } as never);
    mockGenerateText.mockResolvedValueOnce({
      text: 'این یک گفتگوست.',
      usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      steps: [],
    } as never);

    const result = await orchestrator().run('سلام', {
      mode: 'chat',
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.kind).toBe('answer');
    expect(result.planId).toBe('none');
  });

  it('@plan (mode plan) never answers — a greeting is planned', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { kind: 'answer', isClear: true, needsClarification: [], answer: 'hi' },
    } as never);
    // The assessment was forced to a plan, so the plan generation runs.
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        goal: 'say hello',
        steps: [
          {
            id: 'step-1',
            description: 'greet the user',
            dependsOn: [],
            assignedPersona: 'coder',
            assignedSkills: ['file_management'],
            assignedTools: ['write_file'],
            claimedResources: ['notes/hello.txt'],
            acceptanceCriteria: 'the user was greeted',
          },
        ],
      },
    } as never);

    const result = await orchestrator().run('سلام', {
      mode: 'plan',
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.kind).toBe('plan');
  });

  it('falls back to the assessment draft when the answer call fails', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { kind: 'answer', isClear: true, needsClarification: [], answer: 'the draft answer' },
    } as never);
    mockGenerateText.mockRejectedValueOnce(new Error('provider exploded'));

    const result = await orchestrator().run('سلام', {
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.kind).toBe('answer');
    expect(result.review.outcome).toBe('success');
    expect(result.report).toContain('the draft answer');
  });

  it('a preview of a conversation answers without touching the project', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { isClear: true, needsClarification: [], answer: 'chat preview text' },
    } as never);

    const preview = await orchestrator().previewPlan('سلام');
    expect(preview.ok).toBe(true);
    expect(preview.answer).toBe('chat preview text');
    expect(preview.plan).toBeUndefined();
  });
});

// ─── the rule reaches every model call of a plan ─────────────────

describe('v27.17.0 — a Persian plan is executed in Persian', () => {
  const GOAL = 'این پروژه را مرتب کن';

  function persianPlan() {
    return {
      goal: GOAL,
      steps: [
        {
          id: 'step-1',
          description: 'فایل README را بخوان',
          dependsOn: [],
          assignedPersona: 'coder',
          assignedSkills: ['file_management'],
          assignedTools: ['read_file'],
          claimedResources: ['README.md'],
          acceptanceCriteria: 'فایل خوانده شده باشد',
        },
      ],
    };
  }

  it('the step agent, the acceptance judgment and the review are all told Persian', async () => {
    mockGenerateObject.mockImplementation(async (opts: unknown) => {
      const name = (opts as { schemaName?: string }).schemaName;
      if (name === 'PlannerAssessment') {
        return { object: { isClear: true, needsClarification: [], plan: persianPlan() } } as never;
      }
      if (name === 'AcceptanceJudgment')
        return { object: { accepted: true, reason: 'خوب است' } } as never;
      if (name === 'FinalReview') {
        return {
          object: {
            planId: 'plan_x',
            goal: GOAL,
            outcome: 'success',
            acceptedFindings: [],
            rejectedFindings: [],
            incompleteSteps: [],
            finalSummary: 'همه چیز انجام شد.',
            usage: { totalPromptTokens: 1, totalCompletionTokens: 1, totalTokens: 2 },
          },
        } as never;
      }
      throw new Error(`unexpected schema ${name}`);
    });
    mockGenerateText.mockResolvedValue({
      text: 'انجام شد.',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: [],
    } as never);

    const result = await new Orchestrator({ projectRoot: PROJECT_ROOT, runtimeDir: tmpDir }).run(
      GOAL,
      {
        confirmCallback: async () => ({ confirmed: true }),
      }
    );
    expect(result.kind).toBe('plan');
    expect(result.review.outcome).toBe('success');

    // The step agent's SYSTEM prompt names the language (from the plan goal)…
    const agentCall = mockGenerateText.mock.calls[0]?.[0] as unknown as { system?: string };
    expect(agentCall?.system).toContain('The user wrote in Persian');
    expect(agentCall?.system).toContain('فارسی');

    // …and the two structured judgments carry the rule in their prompts.
    const prompts = mockGenerateObject.mock.calls.map((call) => {
      const arg = call[0] as unknown as { schemaName?: string; prompt?: string };
      return { schemaName: arg.schemaName, prompt: arg.prompt ?? '' };
    });
    const acceptance = prompts.find((c) => c.schemaName === 'AcceptanceJudgment');
    const review = prompts.find((c) => c.schemaName === 'FinalReview');
    expect(acceptance?.prompt).toContain('## Language');
    expect(acceptance?.prompt).toContain('Persian');
    expect(review?.prompt).toContain('The user wrote in Persian');
  });
});
