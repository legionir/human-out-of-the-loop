/**
 * R1-01 — a re-plan called from INSIDE the clarification loop (after the
 * user answers) can come back as `kind:'answer'` (isClear:true, no `plan`).
 * Before the fix, `Orchestrator.run` unconditionally did
 * `const plan = planningResult.plan!` after the loop and crashed with
 * "Cannot set properties of undefined (setting 'sessionId')", leaving the
 * interaction pending forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

vi.mock('ai', async () => {
  const actual = (await vi.importActual('ai')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

import { generateObject } from 'ai';
import { Orchestrator } from '../orchestrator.js';

const mockGenerateObject = vi.mocked(generateObject);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function unclearAssessment(questions: string[]) {
  return { object: { isClear: false, needsClarification: questions } } as any;
}

/** No `plan` field, `isClear:true` — normalizeAssessment reads this as kind:'answer'. */
function answerAssessment(answer: string) {
  return { object: { isClear: true, needsClarification: [], answer } } as any;
}

describe('R1-01 — re-plan inside the clarification loop can resolve to an answer', () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
    process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotl-r1-01-'));
    mockGenerateObject.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw, and returns a successful answer with the interaction completed', async () => {
    const orchestrator = new Orchestrator({
      projectRoot: path.resolve(__dirname, '../../..'),
      runtimeDir: tmpDir,
    });
    mockGenerateObject
      .mockResolvedValueOnce(unclearAssessment(['Which project do you mean?']))
      .mockResolvedValueOnce(answerAssessment('It is the one in /tmp/foo.'));

    const clarification = vi.fn(async () => ({ 'Which project do you mean?': 'the demo one' }));

    const result = await orchestrator.run('what is going on', {
      confirmCallback: async () => ({ confirmed: true }),
      clarificationCallback: clarification,
    });

    expect(result.kind).toBe('answer');
    expect(result.review.outcome).toBe('success');
    expect(result.report).toContain('It is the one in /tmp/foo.');

    const sessionIds = orchestrator.sessionStore.listSessions();
    expect(sessionIds.length).toBe(1);
    const session = orchestrator.sessionStore.getSession(sessionIds[0]!)!;
    expect(session.interactions[0]!.completedAt).toBeDefined();
    expect(session.interactions[0]!.outcome).toBe('success');

    await orchestrator.shutdown();
  });
});
