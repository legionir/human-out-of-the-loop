import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});

import { NoObjectGeneratedError, generateObject, generateText } from 'ai';
import { Orchestrator } from '../orchestrator.js';
import {
  extractJsonObject,
  normalizeAssessment,
  recoverAssessment,
  recoverPlan,
} from '../planning/planner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

let tmpDir = '';

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
  process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-recover-'));
  mockGenerateObject.mockReset();
  mockGenerateText.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The error the SDK raises when the model's JSON does not satisfy the schema. */
function noObject(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    text,
    response: { id: 'resp_test', timestamp: new Date(), modelId: 'stub-model' },
    usage: {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
    },
    finishReason: 'stop',
  });
}

/**
 * The real report (2026-09-25, provider: an OpenRouter-style gateway):
 *
 *   @chat سلام
 *   🛑 Planning failed: The planner was unable to process the request:
 *      No object generated: response did not match schema.
 *
 * The model HAD answered — five questions under `needsClarification`, the kind
 * spelled out — it only left out `isClear`, which the response schema marks
 * required and the provider did not enforce.  Everything the runtime needed was
 * in the text; the run died on the one field that was missing.
 */
const REPORTED_PAYLOAD = JSON.stringify({
  kind: 'clarify',
  needsClarification: [
    'هدف شما از این ارتباط چیست؟ آیا به کمک در مورد پروژه فعلی، بررسی فایل‌ها یا برنامه‌ریزی برای کاری نیاز دارید؟',
    'آیا می‌توانید هدف یا وظیفه خاصی را که می‌خواهید در I:\\structured-ai\\last\\test-projects انجام دهید، توضیح دهید؟',
  ],
});

describe('v27.17.1 — the JSON object inside a rejected answer', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object wrapped in prose or a code fence', () => {
    expect(
      extractJsonObject('Sure! Here you go:\n```json\n{"a":{"b":2}}\n```\nHope it helps.')
    ).toEqual({ a: { b: 2 } });
  });

  it('does not stop at a brace inside a string', () => {
    expect(extractJsonObject('{"note":"a } brace","ok":true}')).toEqual({
      note: 'a } brace',
      ok: true,
    });
    expect(extractJsonObject('{"note":"an escaped \\" then }","ok":true}')).toEqual({
      note: 'an escaped " then }',
      ok: true,
    });
  });

  it('gives up when there is no complete object', () => {
    expect(extractJsonObject('Sure! Here is the result: {not valid json')).toBeUndefined();
    expect(extractJsonObject('no json at all')).toBeUndefined();
    expect(extractJsonObject('{"unterminated": 1')).toBeUndefined();
  });
});

describe('v27.17.1 — recovering an assessment the schema refused', () => {
  it('keeps the questions of the reported payload', () => {
    const recovered = recoverAssessment(noObject(REPORTED_PAYLOAD));
    expect(recovered?.assessment.kind).toBe('clarify');
    expect(recovered?.assessment.needsClarification?.[0]).toContain('هدف شما');
    // The field the provider dropped is derived, not demanded.
    expect(recovered?.assessment.isClear).toBeUndefined();
  });

  it('leaves errors that carry no text alone', () => {
    expect(recoverAssessment(new Error('socket hang up'))).toBeUndefined();
    expect(recoverAssessment(noObject(''))).toBeUndefined();
    expect(recoverAssessment(noObject('not json at all'))).toBeUndefined();
  });

  it('reads a plan out of a rejected plan answer', () => {
    const planJson = JSON.stringify({
      goal: 'tidy the fixtures',
      steps: [
        {
          id: 'step-1',
          description: 'move the fixtures',
          assignedPersona: 'coder',
          acceptanceCriteria: 'the fixtures are tidy',
        },
      ],
    });
    expect(recoverPlan(noObject(planJson))?.goal).toBe('tidy the fixtures');
    expect(recoverPlan(noObject('{"goal":"x"}'))).toBeUndefined();
    expect(recoverPlan(new Error('timeout'))).toBeUndefined();
  });

  it('a broken classifier cannot kill a chat run — it answers instead', async () => {
    // The provider fails outright: no text to recover, no answer in the
    // assessment.  In chat mode the run must still be a conversation.
    mockGenerateObject.mockRejectedValue(noObject(''));
    mockGenerateText.mockResolvedValue({
      text: 'سلام! چطور می‌توانم کمک کنم؟',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      steps: [],
    } as never);

    const result = await new Orchestrator({ projectRoot: REPO_ROOT, runtimeDir: tmpDir }).run(
      'سلام',
      {
        mode: 'chat',
        // In chat mode nothing is ever executed, so this is never called.
        confirmCallback: async () => ({ confirmed: false }),
      }
    );

    expect(result.kind).toBe('answer');
    expect(result.review.outcome).toBe('success');
    expect(result.report).toContain('سلام!');
    expect(result.planId).toBe('none');
  });

  it('a real failure in auto mode is still a failure', async () => {
    mockGenerateObject.mockRejectedValue(new Error('Incorrect API key provided'));

    const result = await new Orchestrator({ projectRoot: REPO_ROOT, runtimeDir: tmpDir }).run(
      'tidy the fixtures',
      { confirmCallback: async () => ({ confirmed: true }) }
    );

    // A hard failure (no answer text at all) is still reported as a failure,
    // not quietly turned into a conversation.
    expect(result.review.outcome).toBe('failure');
    expect(result.report).toMatch(/Planning failed/);
    expect(result.report).toMatch(/Incorrect API key/);
    expect(result.report).not.toMatch(/💬 Answer/);
  });

  it('the recovered payload ends as an answer in chat mode, questions and all', async () => {
    mockGenerateObject.mockRejectedValue(noObject(REPORTED_PAYLOAD));
    mockGenerateText.mockResolvedValue({
      text: 'سلام! من دستیار این پروژه هستم.',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      steps: [],
    } as never);

    const result = await new Orchestrator({ projectRoot: REPO_ROOT, runtimeDir: tmpDir }).run(
      'سلام',
      {
        mode: 'chat',
        // In chat mode nothing is ever executed, so this is never called.
        confirmCallback: async () => ({ confirmed: false }),
      }
    );

    expect(result.kind).toBe('answer');
    expect(result.review.outcome).toBe('success');
    expect(result.report).toContain('💬 Answer');
    // Chat replies in prose; the recovered questions do not open the loop.
    expect(result.report).not.toMatch(/Clarification needed/);
  });

  it('a recovered assessment keeps the clarification loop working', async () => {
    mockGenerateObject.mockRejectedValue(noObject(REPORTED_PAYLOAD));

    const result = await new Orchestrator({ projectRoot: REPO_ROOT, runtimeDir: tmpDir }).run(
      'tidy the fixtures',
      {
        mode: 'plan',
        // The questions come back before any plan exists — never called.
        confirmCallback: async () => ({ confirmed: false }),
      }
    );

    // plan mode: the questions survive, and the run asks them instead of dying.
    expect(result.report).toMatch(/Clarification needed/);
    expect(result.report).toContain('هدف شما');
    expect(result.report).not.toMatch(/Planning failed/);
  });
});

describe('v27.17.1 — questions without a verdict are a clarification', () => {
  it('derives the kind from the question list alone', () => {
    const normalized = normalizeAssessment({
      needsClarification: ['which sub-project?'],
    } as never);
    expect(normalized.kind).toBe('clarify');
    expect(normalized.isClear).toBe(false);
    expect(normalized.needsClarification).toEqual(['which sub-project?']);
  });

  it('still calls a plan a plan', () => {
    expect(
      normalizeAssessment({
        needsClarification: [],
        plan: { goal: 'g', steps: [] } as never,
      } as never).kind
    ).toBe('plan');
  });
});
