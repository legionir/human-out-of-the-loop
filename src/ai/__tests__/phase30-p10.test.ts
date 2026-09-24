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
