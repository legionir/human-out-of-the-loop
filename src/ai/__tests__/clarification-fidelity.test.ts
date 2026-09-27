import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateObject } from 'ai';
import { Orchestrator } from '../orchestrator.js';
import {
  Planner,
  buildAssessmentPrompt,
  dedupeQuestions,
  fallbackClarificationQuestion,
  normalizeAssessment,
} from '../planning/planner.js';
import { PlannerAssessmentSchema } from '../schemas/plan.js';

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

/**
 * v27.16.1 — "the planner's questions must survive the round trip".
 *
 * This suite is a regression test for a real run.  The user asked a question in
 * Persian (what is your path, your OS, your goal?) and the terminal answered:
 *
 *     ⚠️ Clarification needed:
 *
 * ...with nothing under it.  The model had produced three questions, but under
 * a key the response schema did not declare (`clarificationQuestions`), so zod
 * stripped them during parsing and the run reported an empty refusal.  The same
 * shape of bug produced a *silent* one too: `isClear: false` with no questions
 * reaches the clarification loop, which breaks out immediately (`length === 0`)
 * and fails the run with the same blank message.
 *
 * The contract under test:
 *   - the prompt names the field it wants, so a model has no reason to invent one;
 *   - an answer under an alias is merged, not dropped;
 *   - "unclear" always comes back with at least one answerable question, and the
 *     fallback names the project instead of asking for it;
 *   - an empty refusal is visible in the terminal report (no trailing blank line)
 *     and the process exits non-zero;
 *   - the clarification *loop* only starts for real questions, and the help it
 *     prints never claims the project is unknown.
 */

const mockGenerateObject = vi.mocked(generateObject);

let tmpDir = '';

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
  process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-p44-'));
  mockGenerateObject.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('v27.16.1 — the schema keeps what the model sends', () => {
  it('parses the declared field', () => {
    const parsed = PlannerAssessmentSchema.parse({
      isClear: false,
      needsClarification: ['Which file?', 'Which branch?'],
    });
    expect(parsed.needsClarification).toEqual(['Which file?', 'Which branch?']);
  });

  it('keeps the aliases a model invents instead of stripping them', () => {
    // Exactly the payload from the failing run.
    const parsed = PlannerAssessmentSchema.parse({
      isClear: false,
      clarificationQuestions: [
        'What specific task or goal do you want to accomplish in the project?',
        'Which part of the project are you focusing on?',
        'What type of work are you expecting?',
      ],
    });
    expect(parsed.clarificationQuestions).toHaveLength(3);

    const normalized = normalizeAssessment(parsed);
    expect(normalized.needsClarification).toEqual([
      'What specific task or goal do you want to accomplish in the project?',
      'Which part of the project are you focusing on?',
      'What type of work are you expecting?',
    ]);
  });

  it('merges both spellings, trims, and drops duplicates', () => {
    const normalized = normalizeAssessment({
      isClear: false,
      needsClarification: ['  Which branch?  ', 'Which file?'],
      clarificationQuestions: ['which branch?', '   '],
      questions: ['When is it due?'],
    });
    expect(normalized.needsClarification).toEqual([
      'Which branch?',
      'Which file?',
      'When is it due?',
    ]);
    expect(dedupeQuestions(['a', 'A', ' a ', 'b'])).toEqual(['a', 'b']);
  });
});

describe('v27.16.1 — "unclear" always carries a question', () => {
  it('never returns an empty list when the model said the request is unclear', () => {
    const normalized = normalizeAssessment(
      { isClear: false, needsClarification: [] },
      {
        projectRoot: '/tmp/some-project',
      }
    );
    expect(normalized.needsClarification).toHaveLength(1);
    expect(normalized.needsClarification[0]).toMatch(/What exactly should I do/);
    // The fallback names the project root; it must never ask for it.
    expect(normalized.needsClarification[0]).toContain(path.resolve('/tmp/some-project'));
    expect(normalized.needsClarification[0]).not.toMatch(/which project|current directory/i);
  });

  it('lists what the project contains, so the question is answerable', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-p44-ctx-'));
    try {
      fs.mkdirSync(path.join(project, 'src'));
      fs.mkdirSync(path.join(project, 'docs'));
      fs.writeFileSync(path.join(project, 'README.md'), '# x\n');
      const question = fallbackClarificationQuestion(project);
      expect(question).toContain('src/');
      expect(question).toContain('docs/');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('leaves a clear assessment alone (no questions invented for a plan)', () => {
    const normalized = normalizeAssessment({
      isClear: true,
      needsClarification: [],
      plan: { goal: 'do it', steps: [] } as never,
    });
    expect(normalized.needsClarification).toEqual([]);
  });
});

describe('v27.16.1 — the prompt asks for the right field', () => {
  it('names `needsClarification` and forbids an empty list', () => {
    const prompt = buildAssessmentPrompt('do the thing', REPO_ROOT);
    expect(prompt).toContain('needsClarification');
    expect(prompt).toContain('never an empty list');
    // And it still carries the project context it must not ask for.
    expect(prompt).toContain(REPO_ROOT);
  });
});

describe('v27.16.1 — the Planner reports questions out of the model call', () => {
  /**
   * The orchestrator's own planner — with `initialize()` awaited, because the
   * persona registry is populated there (a hand-built Planner would fail with
   * "Persona \"planner\" not found", which is a test artefact, not the bug).
   */
  async function planner(): Promise<Planner> {
    const orchestrator = new Orchestrator({ projectRoot: PROJECT_ROOT, runtimeDir: tmpDir });
    await orchestrator.initialize();
    return orchestrator.planner;
  }

  it('merges an aliased answer into needsClarification', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: false,
        clarificationQuestions: ['Which sub-project: multi-lang-eval or unreal-engine?'],
      },
    } as never);

    const result = await (await planner()).plan('help me');
    expect(result.isClear).toBe(false);
    expect(result.needsClarification).toEqual([
      'Which sub-project: multi-lang-eval or unreal-engine?',
    ]);
  });

  it('still produces a question when the model sends none at all', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { isClear: false } } as never);

    const result = await (await planner()).plan('help me');
    expect(result.isClear).toBe(false);
    expect(result.needsClarification).toHaveLength(1);
    expect(result.needsClarification[0]).toContain(PROJECT_ROOT);
  });

  it('passes a clear assessment through untouched', async () => {
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
              assignedPersona: 'coder',
              acceptanceCriteria: 'the file exists',
            },
          ],
        },
      },
    } as never);

    const result = await (await planner()).plan('write the notes');
    expect(result.isClear).toBe(true);
    expect(result.needsClarification).toEqual([]);
    expect(result.plan?.id).toMatch(/^plan_/);
  });
});

describe('v27.16.1 — the run fails loudly, never with a blank reason', () => {
  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({ projectRoot: PROJECT_ROOT, runtimeDir: tmpDir });
  }

  it('shows the questions when there are any', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        isClear: false,
        clarificationQuestions: ['Which directory: multi-lang-eval or unreal-engine?'],
      },
    } as never);

    const result = await makeOrchestrator().run('do something', {
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.report).toContain('Clarification needed');
    expect(result.report).toContain('multi-lang-eval');
    // No dangling heading with an empty body.
    expect(result.report.trim().split('\n').at(-1)?.trim()).not.toBe('⚠️ Clarification needed:');
  });

  it('shows a real, answerable question even when the model listed none', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { isClear: false } } as never);

    const result = await makeOrchestrator().run('do something', {
      confirmCallback: async () => ({ confirmed: true }),
    });
    expect(result.review.outcome).toBe('failure');
    const lines = result.report.trim().split('\n');
    expect(lines[0]).toBe('⚠️ Clarification needed:');
    expect(lines.slice(1).join(' ')).toMatch(/What exactly should I do/);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('does not open a clarification round for a failure with no questions', async () => {
    // A hard planner failure (invalid model, provider error) has no questions:
    // it must be reported as an error, not as a question for the user.
    mockGenerateObject.mockRejectedValueOnce(new Error('provider exploded'));

    const asked: string[][] = [];
    const result = await makeOrchestrator().run('do something', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: async (questions) => {
        asked.push(questions);
        return { [questions[0] ?? 'q']: 'an answer' };
      },
    });
    expect(asked).toEqual([]);
    expect(result.report).toContain('Planning failed');
    expect(result.report).toContain('provider exploded');
  });
});
