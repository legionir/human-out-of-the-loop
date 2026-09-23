import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemorySessionStore } from '../runtime/session-store.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { ObservabilityLogger, type LogEntry } from '../runtime/observability-logger.js';
import { createPlan, type Plan } from '../schemas/plan.js';
import { EventBus } from '../runtime/event-bus.js';

// ─── MemorySessionStore tests ────────────────────────────────────

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('creates a session and returns its id', () => {
    const id = store.createSession('test-session');
    expect(id).toBeDefined();
    expect(id.startsWith('session_')).toBe(true);
  });

  it('retrieves a session by id', () => {
    const id = store.createSession('my-session');
    const session = store.getSession(id);

    expect(session).toBeDefined();
    expect(session!.id).toBe(id);
    expect(session!.label).toBe('my-session');
    expect(session!.interactions).toEqual([]);
  });

  it('returns undefined for non-existent session', () => {
    expect(store.getSession('nonexistent')).toBeUndefined();
  });

  it('lists all session ids', () => {
    const id1 = store.createSession('s1');
    const id2 = store.createSession('s2');

    const list = store.listSessions();
    expect(list).toContain(id1);
    expect(list).toContain(id2);
    expect(list).toHaveLength(2);
  });

  it('deletes a session', () => {
    const id = store.createSession('to-delete');
    expect(store.getSession(id)).toBeDefined();

    store.deleteSession(id);
    expect(store.getSession(id)).toBeUndefined();
  });

  it('adds an interaction to a session', () => {
    const sessionId = store.createSession();
    const interaction = store.addInteraction(sessionId, 'Build a login page');

    expect(interaction).toBeDefined();
    expect(interaction!.userRequest).toBe('Build a login page');
    expect(interaction!.outcome).toBe('pending');

    const session = store.getSession(sessionId)!;
    expect(session.interactions).toHaveLength(1);
  });

  it('returns undefined when adding interaction to non-existent session', () => {
    const result = store.addInteraction('ghost', 'test');
    expect(result).toBeUndefined();
  });

  it('updates an interaction outcome and summary', () => {
    const sessionId = store.createSession();
    const interaction = store.addInteraction(sessionId, 'Do X')!;

    store.updateInteraction(sessionId, interaction.id, {
      outcome: 'success',
      reviewSummary: 'All steps completed successfully.',
      planIds: ['plan-1'],
      completedAt: Date.now(),
    });

    const session = store.getSession(sessionId)!;
    const updated = session.interactions[0];
    expect(updated.outcome).toBe('success');
    expect(updated.reviewSummary).toBe('All steps completed successfully.');
    expect(updated.planIds).toEqual(['plan-1']);
  });

  it('getLatestPlanSummary returns the most recent completed summary', () => {
    const sessionId = store.createSession();

    // First interaction — completed
    const i1 = store.addInteraction(sessionId, 'First request')!;
    store.updateInteraction(sessionId, i1.id, {
      outcome: 'success',
      reviewSummary: 'First plan done.',
    });

    // Second interaction — still pending
    store.addInteraction(sessionId, 'Second request');

    // Should return the first (most recent completed)
    const summary = store.getLatestPlanSummary(sessionId);
    expect(summary).toBe('First plan done.');
  });

  it('getLatestPlanSummary returns undefined when no completed interactions', () => {
    const sessionId = store.createSession();
    store.addInteraction(sessionId, 'Pending request');

    expect(store.getLatestPlanSummary(sessionId)).toBeUndefined();
  });

  it('getLatestPlanSummary returns the LATEST completed, not the first', () => {
    const sessionId = store.createSession();

    const i1 = store.addInteraction(sessionId, 'First')!;
    store.updateInteraction(sessionId, i1.id, {
      outcome: 'success',
      reviewSummary: 'First summary.',
    });

    const i2 = store.addInteraction(sessionId, 'Second')!;
    store.updateInteraction(sessionId, i2.id, {
      outcome: 'partial-success',
      reviewSummary: 'Second summary (latest).',
    });

    expect(store.getLatestPlanSummary(sessionId)).toBe('Second summary (latest).');
  });

  it('deep-clones sessions (mutations do not affect stored copy)', () => {
    const sessionId = store.createSession();
    const session = store.getSession(sessionId)!;
    session.label = 'MUTATED';

    const fresh = store.getSession(sessionId)!;
    expect(fresh.label).toBeUndefined(); // Original unchanged
  });
});

// ─── FileSessionStore tests ──────────────────────────────────────

describe('FileSessionStore', () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists session to disk and reloads it', () => {
    const id = store.createSession('persistent');
    store.addInteraction(id, 'Build feature X');

    // Create a new store instance pointing to the same dir
    const store2 = new FileSessionStore(tmpDir);
    const session = store2.getSession(id);

    expect(session).toBeDefined();
    expect(session!.label).toBe('persistent');
    expect(session!.interactions).toHaveLength(1);
    expect(session!.interactions[0].userRequest).toBe('Build feature X');
  });

  it('survives process restart (simulated by new instance)', () => {
    const id = store.createSession();
    const interaction = store.addInteraction(id, 'Do stuff')!;
    store.updateInteraction(id, interaction.id, {
      outcome: 'success',
      reviewSummary: 'Completed.',
    });

    const store2 = new FileSessionStore(tmpDir);
    expect(store2.getLatestPlanSummary(id)).toBe('Completed.');
  });
});

// ─── ObservabilityLogger tests ───────────────────────────────────

describe('ObservabilityLogger', () => {
  let tmpDir: string;
  let logFile: string;
  let logger: ObservabilityLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
    logFile = path.join(tmpDir, 'test.jsonl');
    logger = new ObservabilityLogger({ logFilePath: logFile });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a log entry as a single JSON line', () => {
    logger.log({
      planId: 'plan-1',
      eventType: 'plan:created',
      message: 'Plan created',
      level: 'info',
    });

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as LogEntry;
    expect(entry.planId).toBe('plan-1');
    expect(entry.eventType).toBe('plan:created');
    expect(entry.timestamp).toBeDefined();
    expect(entry.epochMs).toBeDefined();
  });

  it('appends multiple entries', () => {
    logger.log({ eventType: 'plan:created', message: 'Created', level: 'info', planId: 'p1' });
    logger.log({ eventType: 'plan:started', message: 'Started', level: 'info', planId: 'p1' });
    logger.log({ eventType: 'plan:completed', message: 'Done', level: 'info', planId: 'p1' });

    const entries = logger.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].eventType).toBe('plan:created');
    expect(entries[1].eventType).toBe('plan:started');
    expect(entries[2].eventType).toBe('plan:completed');
  });

  it('readAll returns entries in chronological order', () => {
    logger.log({ eventType: 'step:started', message: 'S1', level: 'info', planId: 'p1', stepId: 's1' });
    logger.log({ eventType: 'step:completed', message: 'S1 done', level: 'info', planId: 'p1', stepId: 's1' });
    logger.log({ eventType: 'step:started', message: 'S2', level: 'info', planId: 'p1', stepId: 's2' });

    const entries = logger.readAll();
    expect(entries[0].epochMs).toBeLessThanOrEqual(entries[1].epochMs);
    expect(entries[1].epochMs).toBeLessThanOrEqual(entries[2].epochMs);
  });

  it('readForPlan filters by planId', () => {
    logger.log({ eventType: 'plan:created', message: 'P1', level: 'info', planId: 'plan-A' });
    logger.log({ eventType: 'plan:created', message: 'P2', level: 'info', planId: 'plan-B' });
    logger.log({ eventType: 'step:started', message: 'S1', level: 'info', planId: 'plan-A', stepId: 's1' });

    const planAEntries = logger.readForPlan('plan-A');
    expect(planAEntries).toHaveLength(2);
    expect(planAEntries.every((e) => e.planId === 'plan-A')).toBe(true);
  });

  it('readForStep filters by planId + stepId', () => {
    logger.log({ eventType: 'step:started', message: 'S1', level: 'info', planId: 'p1', stepId: 's1' });
    logger.log({ eventType: 'step:completed', message: 'S1', level: 'info', planId: 'p1', stepId: 's1' });
    logger.log({ eventType: 'step:started', message: 'S2', level: 'info', planId: 'p1', stepId: 's2' });

    const s1Entries = logger.readForStep('p1', 's1');
    expect(s1Entries).toHaveLength(2);
  });

  it('redacts sensitive keys from payloads', () => {
    logger.log({
      eventType: 'system:info',
      message: 'Config loaded',
      level: 'info',
      payload: {
        provider: 'openai',
        apiKey: 'sk-super-secret-key-12345',
        model: 'gpt-4o',
        nested: {
          token: 'bearer-xyz-789',
          safeField: 'this-is-fine',
        },
      },
    });

    const entries = logger.readAll();
    const payload = entries[0].payload!;

    expect(payload.apiKey).toBe('***REDACTED***');
    expect(payload.provider).toBe('openai');
    expect(payload.model).toBe('gpt-4o');
    expect((payload.nested as any).token).toBe('***REDACTED***');
    expect((payload.nested as any).safeField).toBe('this-is-fine');
  });

  it('convenience methods log correct event types', () => {
    const plan = createPlan('Test goal', [
      {
        id: 's1',
        description: 'Step one',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: [],
        claimedResources: [],
        acceptanceCriteria: 'done',
        status: 'pending',
      },
    ]);
    plan.id = 'log-test-plan';

    logger.logPlanCreated(plan);
    logger.logPlanStarted(plan);
    logger.logStepStarted(plan.id!, plan.steps[0]);
    plan.steps[0].status = 'done';
    plan.steps[0].resultSummary = 'Completed successfully';
    logger.logStepCompleted(plan.id!, plan.steps[0]);
    logger.logPlanCompleted(plan);

    const entries = logger.readAll();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.eventType)).toEqual([
      'plan:created',
      'plan:started',
      'step:started',
      'step:completed',
      'plan:completed',
    ]);
  });

  it('logs quality check results', () => {
    logger.logQualityCheck('p1', 's1', true, 'All criteria met');
    logger.logQualityCheck('p1', 's2', false, 'Missing edge case tests');

    const entries = logger.readAll();
    expect(entries[0].eventType).toBe('step:quality-passed');
    expect(entries[0].level).toBe('info');
    expect(entries[1].eventType).toBe('step:quality-failed');
    expect(entries[1].level).toBe('warn');
  });

  it('logs re-planning attempts', () => {
    const plan = createPlan('Test', []);
    plan.id = 'replan-log';
    logger.logPlanReplanning(plan, 1);
    logger.logPlanReplanning(plan, 2);

    const entries = logger.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe('plan:replanning');
    expect(entries[0].payload?.attempt).toBe(1);
    expect(entries[1].payload?.attempt).toBe(2);
  });
});

// ─── ObservabilityLogger — EventBus integration ──────────────────

describe('ObservabilityLogger — EventBus integration', () => {
  let tmpDir: string;
  let logFile: string;
  let logger: ObservabilityLogger;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bus-'));
    logFile = path.join(tmpDir, 'bus.jsonl');
    logger = new ObservabilityLogger({ logFilePath: logFile });
    eventBus = new EventBus();
  });

  afterEach(() => {
    logger.unsubscribeFromEventBus();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('automatically logs agent events from the EventBus', () => {
    logger.subscribeToEventBus(eventBus);

    eventBus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'test',
    });

    eventBus.emit({
      type: 'agent:tool_call',
      taskId: 't1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'running',
      toolName: 'read_file',
      callId: 'call-1',
    });

    eventBus.emit({
      type: 'agent:completed',
      taskId: 't1',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'completed',
      summary: 'Done',
      toolsUsed: ['read_file'],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const entries = logger.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].eventType).toBe('task:created');
    expect(entries[1].eventType).toBe('task:tool-call');
    expect(entries[1].payload?.toolName).toBe('read_file');
    expect(entries[2].eventType).toBe('task:completed');
    expect(entries[2].payload?.usage).toBeDefined();
  });

  it('logs agent errors from the EventBus', () => {
    logger.subscribeToEventBus(eventBus);

    eventBus.emit({
      type: 'agent:error',
      taskId: 't-err',
      agentId: 'coder',
      timestamp: Date.now(),
      status: 'error',
      error: 'Provider timeout',
      code: 'TIMEOUT',
    });

    const entries = logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('task:failed');
    expect(entries[0].level).toBe('error');
    expect(entries[0].payload?.code).toBe('TIMEOUT');
  });

  it('stops logging after unsubscribe', () => {
    logger.subscribeToEventBus(eventBus);

    eventBus.emit({
      type: 'agent:running',
      taskId: 't1',
      agentId: 'a',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'x',
    });

    logger.unsubscribeFromEventBus();

    eventBus.emit({
      type: 'agent:running',
      taskId: 't2',
      agentId: 'a',
      timestamp: Date.now(),
      status: 'running',
      prompt: 'y',
    });

    const entries = logger.readAll();
    expect(entries).toHaveLength(1); // Only the first event
  });
});

// ─── Full plan lifecycle logging test ────────────────────────────

describe('ObservabilityLogger — full plan lifecycle', () => {
  let tmpDir: string;
  let logFile: string;
  let logger: ObservabilityLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-full-'));
    logFile = path.join(tmpDir, 'lifecycle.jsonl');
    logger = new ObservabilityLogger({ logFilePath: logFile });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures all key events for a complete plan execution', () => {
    const plan = createPlan('Build auth', [
      { id: 's1', description: 'Analyse', dependsOn: [], assignedPersona: 'architect', assignedSkills: [], assignedTools: [], claimedResources: [], acceptanceCriteria: 'Report', status: 'pending' },
      { id: 's2', description: 'Implement', dependsOn: ['s1'], assignedPersona: 'coder', assignedSkills: [], assignedTools: [], claimedResources: ['src/auth.ts'], acceptanceCriteria: 'Tests pass', status: 'pending' },
    ]);
    plan.id = 'lifecycle-plan';

    // Simulate full lifecycle
    logger.logPlanCreated(plan);
    logger.logPlanStarted(plan);

    logger.logStepStarted(plan.id!, plan.steps[0]);
    logger.logStepCompleted(plan.id!, plan.steps[0]);
    logger.logQualityCheck(plan.id!, 's1', true, 'Report is comprehensive');

    logger.logStepStarted(plan.id!, plan.steps[1]);
    logger.logStepCompleted(plan.id!, plan.steps[1]);
    logger.logQualityCheck(plan.id!, 's2', true, 'All tests pass');

    logger.logPlanCompleted(plan);

    // Verify the log
    const entries = logger.readAll();
    expect(entries.length).toBeGreaterThanOrEqual(9);

    const eventTypes = entries.map((e) => e.eventType);
    expect(eventTypes).toContain('plan:created');
    expect(eventTypes).toContain('plan:started');
    expect(eventTypes).toContain('step:started');
    expect(eventTypes).toContain('step:completed');
    expect(eventTypes).toContain('step:quality-passed');
    expect(eventTypes).toContain('plan:completed');

    // All entries should have the planId
    expect(entries.every((e) => e.planId === 'lifecycle-plan')).toBe(true);

    // All entries should have valid timestamps
    for (const entry of entries) {
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.epochMs).toBeGreaterThan(0);
    }
  });
});
