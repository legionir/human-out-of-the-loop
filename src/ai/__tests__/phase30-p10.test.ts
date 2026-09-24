/**
 * Phase 30 / P10 — hostile content: a credential the model echoes must not
 * land in the runtime's own artifacts.
 *
 * The leak path is not exotic: the model reads a project file (e.g. `.env`),
 * echoes the value in its final text, and that text becomes the step summary
 * — which is copied into the plan record and into the observability log.
 * `redactKeys` only matches field NAMES, so the value itself has to be
 * scrubbed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectSecretValues,
  scrubSecretValues,
  ScrubbingPlanStore,
  SECRET_REDACTION_MARKER,
} from '../runtime/secret-scrub.js';
import { ObservabilityLogger, type LogEntry } from '../runtime/observability-logger.js';
import { MemoryPlanStore } from '../runtime/plan-store.js';
import { createPlan, type PlanStep } from '../schemas/plan.js';

const SECRET = 'sk-live-P10-9f3b7c1d2a6e';

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `part ${id}`,
    dependsOn: [],
    assignedPersona: 'coder',
    assignedSkills: [],
    assignedTools: ['read_file'],
    claimedResources: [],
    acceptanceCriteria: 'part handled',
    status: 'pending',
    ...over,
  };
}

describe('Phase 30 / P10 — scrubSecretValues', () => {
  it('replaces every occurrence of a known secret', () => {
    const text = `key=${SECRET} and again ${SECRET}`;
    expect(scrubSecretValues(text, [SECRET])).toBe(
      `key=${SECRET_REDACTION_MARKER} and again ${SECRET_REDACTION_MARKER}`
    );
  });

  it('is a no-op without secrets and never destroys a normal word', () => {
    expect(scrubSecretValues('plain text', [])).toBe('plain text');
    expect(scrubSecretValues('plain text', [''])).toBe('plain text');
  });
});

describe('Phase 30 / P10 — collectSecretValues', () => {
  it('collects values whose env NAME looks like a credential', () => {
    const values = collectSecretValues({
      OPENAI_API_KEY: SECRET,
      DEMO_MCP_TOKEN: 'demo-mcp-token-value',
      PATH: '/usr/bin',
      SHORT_TOKEN: 'abc', // too short to be a credential
    });
    expect(values).toContain(SECRET);
    expect(values).toContain('demo-mcp-token-value');
    expect(values).not.toContain('/usr/bin');
    expect(values).not.toContain('abc');
  });

  it('honours extra configured patterns', () => {
    const values = collectSecretValues({ MY_COMPANY_VAULT: 'vault-value-123456' }, ['vault']);
    expect(values).toEqual(['vault-value-123456']);
  });
});

describe('Phase 30 / P10 — the observability log never carries a secret value', () => {
  function makeLogger(): { logger: ObservabilityLogger; file: string } {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p10-log-')), 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file, redactValues: [SECRET] });
    return { logger, file };
  }

  it('scrubs the step summary payload (the real leak path)', () => {
    const { logger, file } = makeLogger();
    logger.logStepCompleted('plan_p10', step('step-1', { resultSummary: `task done, key was ${SECRET}`, status: 'done' }));
    logger.close();

    const entry = JSON.parse(fs.readFileSync(file, 'utf-8').trim()) as LogEntry;
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect((entry.payload as { resultSummary: string }).resultSummary).toContain(SECRET_REDACTION_MARKER);
  });

  it('scrubs nested payload strings and the message, and keeps the rest', () => {
    const { logger, file } = makeLogger();
    logger.log({
      eventType: 'system:error',
      message: `upstream rejected ${SECRET}`,
      level: 'error',
      payload: { details: { attempts: [{ error: `bad key ${SECRET}` }] }, note: 'keep me' },
    });
    logger.close();

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain(SECRET);
    const entry = JSON.parse(raw.trim()) as LogEntry;
    expect(entry.message).toContain(SECRET_REDACTION_MARKER);
    expect(JSON.stringify(entry.payload)).toContain('keep me');
  });

  it('still redacts by field name (apiKey/token) as before', () => {
    const { logger, file } = makeLogger();
    logger.log({
      eventType: 'system:info',
      message: 'config',
      level: 'info',
      payload: { apiKey: 'anything-at-all', token: 'anything-at-all' },
    });
    logger.close();

    const entry = JSON.parse(fs.readFileSync(file, 'utf-8').trim()) as LogEntry;
    expect(entry.payload).toMatchObject({ apiKey: SECRET_REDACTION_MARKER, token: SECRET_REDACTION_MARKER });
  });
});

describe('Phase 30 / P10 — the persisted plan never carries a secret value', () => {
  it('scrubs every step summary on save and leaves other fields alone', () => {
    const inner = new MemoryPlanStore();
    const store = new ScrubbingPlanStore(inner, [SECRET]);
    const plan = createPlan('p10', [
      step('step-1', { resultSummary: `read .env → ${SECRET}`, status: 'done' }),
      step('step-2', { status: 'pending' }),
    ]);
    const planId = plan.id ?? '';

    store.save(plan);
    const stored = store.load(planId);

    expect(stored?.steps[0].resultSummary).toBe(`read .env → ${SECRET_REDACTION_MARKER}`);
    expect(stored?.steps[0].description).toBe('part step-1');
    expect(store.exists(planId)).toBe(true);
    expect(store.list()).toEqual([planId]);
    // The in-memory plan handed to `save` is not mutated.
    expect(plan.steps[0].resultSummary).toContain(SECRET);
  });

  it('passes the plan through unchanged when there is nothing to scrub', () => {
    const inner = new MemoryPlanStore();
    const store = new ScrubbingPlanStore(inner, []);
    const plan = createPlan('p10', [step('step-1', { resultSummary: `leaked ${SECRET}`, status: 'done' })]);
    const planId = plan.id ?? '';

    store.save(plan);
    expect(store.load(planId)?.steps[0].resultSummary).toContain(SECRET);
  });
});

describe('Phase 30 / P10 — the log records the step lifecycle', () => {
  it('parses only real step transitions', async () => {
    const { parseStepEvent } = await import('../runtime/step-events.js');
    expect(parseStepEvent('step:step-1:running')).toEqual({ stepId: 'step-1', phase: 'running' });
    expect(parseStepEvent('step:step_2@x:done')).toEqual({ stepId: 'step_2@x', phase: 'done' });
    expect(parseStepEvent('step:step-1:failed')).toEqual({ stepId: 'step-1', phase: 'failed' });
    expect(parseStepEvent('plan:replanned')).toBeUndefined();
    expect(parseStepEvent('step:step-1:something-else')).toBeUndefined();
  });

  it('writes step:started / step:completed / step:failed with the summary', async () => {
    const { logStepEvent } = await import('../runtime/step-events.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p10-steps-')), 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file });
    const plan = createPlan('steps', [
      step('step-1', { status: 'running' }),
      step('step-2', { status: 'done', resultSummary: `did it with ${SECRET}` }),
      step('step-3', { status: 'failed', failureType: 'technical', resultSummary: 'boom' }),
    ]);

    expect(logStepEvent(logger, plan, 'plan:started')).toBe(false);
    expect(logStepEvent(logger, plan, 'step:step-1:running')).toBe(true);
    expect(logStepEvent(logger, plan, 'step:step-2:done')).toBe(true);
    expect(logStepEvent(logger, plan, 'step:step-3:failed')).toBe(true);
    // A step that no longer exists in the plan is ignored, not invented.
    expect(logStepEvent(logger, plan, 'step:step-gone:done')).toBe(true);
    logger.close();

    const entries = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LogEntry);
    expect(entries.map((e) => e.eventType)).toEqual([
      'step:started',
      'step:completed',
      'step:failed',
    ]);
    expect(entries.map((e) => e.stepId)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(entries[0].message).toContain('step-1');
    expect((entries[2].payload as { failureType: string }).failureType).toBe('technical');
  });

  it('the step summary in the log is already scrubbed (logging + scrubbing combine)', async () => {
    const { logStepEvent } = await import('../runtime/step-events.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p10-steps-')), 'observability.jsonl');
    const logger = new ObservabilityLogger({ logFilePath: file, redactValues: [SECRET] });
    const plan = createPlan('steps', [step('step-1', { status: 'done', resultSummary: `key ${SECRET}` })]);

    logStepEvent(logger, plan, 'step:step-1:done');
    logger.close();

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(SECRET_REDACTION_MARKER);
  });
});

describe('Phase 30 / P10 — a plan always has an identity', () => {
  it('finalizePlan gives an id-less model plan everything the runtime needs', async () => {
    const { finalizePlan } = await import('../planning/planner.js');
    const steps = [step('step-1', { status: 'done' }), step('step-2', { status: 'running' })];
    const raw = { goal: 'g', steps, clarifications: [], status: 'completed' } as never;

    const plan = finalizePlan(raw);

    expect(plan.id).toMatch(/^plan_[0-9a-f-]{36}$/);
    expect(plan.status).toBe('draft');
    expect(typeof plan.createdAt).toBe('number');
    expect(plan.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  it('finalizePlan keeps an id and createdAt the model already provided', async () => {
    const { finalizePlan } = await import('../planning/planner.js');
    const raw = {
      id: 'plan_model_made',
      goal: 'g',
      steps: [step('step-1')],
      clarifications: [],
      status: 'running',
      createdAt: 1234,
    } as never;

    const plan = finalizePlan(raw);
    expect(plan.id).toBe('plan_model_made');
    expect(plan.createdAt).toBe(1234);
    expect(plan.status).toBe('draft');
  });

  it('the file store refuses an id-less plan instead of overwriting another one', async () => {
    const { FilePlanStore } = await import('../runtime/plan-store.js');
    const store = new FilePlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'p10-store-')));
    const noId = { id: undefined, goal: 'g', steps: [step('step-1')], clarifications: [] };

    expect(() => store.save(noId as never)).toThrowError(/refusing to save a plan without an id/);
    expect(store.list()).toEqual([]);
  });
});
