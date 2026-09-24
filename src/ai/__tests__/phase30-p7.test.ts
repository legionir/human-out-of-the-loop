/**
 * Phase 30 (P7) — large/multi-step goals and real re-planning.
 *
 * Driving a 12-step chained plan against a failing middle step exposed two
 * bugs that made the system lie about what it had done:
 *
 *   1. **Re-planning was invisible.**  `PlanRuntime` emits
 *      `plan:replanning-attempt-N` and `plan:replanned`, but the streaming
 *      manager only matched the exact string `plan:replanning`, and nothing
 *      logged either event: the terminal and the JSONL log stayed silent
 *      while the plan was rewritten.
 *   2. **The abandoned step disappeared.**  The merge kept only completed
 *      steps, so a 12-part goal that lost part 5 reported "11/11 steps
 *      completed" and `plan.status = 'completed'`.  The failed step, its
 *      reason and the fact that a replan happened were gone from the store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlan, type Plan, type PlanStep } from '../schemas/plan.js';
import { mergeReplannedSteps } from '../runtime/replan-merge.js';
import { StreamingManager, type ProgressEvent } from '../runtime/streaming-manager.js';
import { EventBus } from '../runtime/event-bus.js';
import { ObservabilityLogger, type LogEntry } from '../runtime/observability-logger.js';

// ─── helpers ─────────────────────────────────────────────────────

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

function makePlan(steps: PlanStep[]): Plan {
  const plan = createPlan('twelve-part goal', steps);
  plan.id = 'plan_p7';
  plan.status = 'running';
  return plan;
}

// ─── 1. merging a revised plan ───────────────────────────────────

describe('Phase 30 / P7 — replaying a revised plan keeps the record', () => {
  it('keeps the abandoned (failed) step instead of dropping it', () => {
    const current = [
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed', resultSummary: '[Acceptance: FAILED — ENOENT]' }),
      step('step-3', { status: 'pending', dependsOn: ['step-2'] }),
    ];
    // The planner works around step-2: step-3 no longer depends on it.
    const revised = [step('step-3'), step('step-4')];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.map((s) => s.id)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
    const abandoned = merged.find((s) => s.id === 'step-2');
    expect(abandoned?.status).toBe('failed');
    expect(abandoned?.resultSummary).toContain('ENOENT');
    // Nothing is left "running": the revised steps are pending again.
    expect(merged.filter((s) => s.status === 'pending').map((s) => s.id)).toEqual([
      'step-3',
      'step-4',
    ]);
  });

  it('drops dependencies on a failed step (the deadlock re-planning exists to avoid)', () => {
    const current = [
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed', resultSummary: 'boom' }),
    ];
    const revised = [step('step-3', { dependsOn: ['step-2'] })];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.find((s) => s.id === 'step-3')?.dependsOn).toEqual([]);
  });

  it('keeps the replacement when the planner reuses the failed step id', () => {
    const current = [
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed', resultSummary: 'boom' }),
      step('step-3', { status: 'pending', dependsOn: ['step-2'] }),
    ];
    // "Replace step-2 with a different approach" — same id, new content.
    const revised = [
      step('step-2', { description: 'different approach', acceptanceCriteria: 'replaced' }),
      step('step-3', { dependsOn: ['step-2'] }),
    ];

    const merged = mergeReplannedSteps(current, revised, 2);

    // The failed step stays (with its reason) and its replacement is visible.
    expect(merged.map((s) => s.id)).toEqual(['step-1', 'step-2', 'step-2~replan2', 'step-3']);
    expect(merged.find((s) => s.id === 'step-2')?.status).toBe('failed');
    expect(merged.find((s) => s.id === 'step-2~replan2')?.status).toBe('pending');
    expect(merged.find((s) => s.id === 'step-2~replan2')?.description).toBe('different approach');
    // …and step-3 now waits for the REPLACEMENT, not the dead step.
    expect(merged.find((s) => s.id === 'step-3')?.dependsOn).toEqual(['step-2~replan2']);
  });

  it('never re-does a completed step', () => {
    const current = [step('step-1', { status: 'done' }), step('step-2', { status: 'done' })];
    const revised = [step('step-1'), step('step-2'), step('step-3')];

    const merged = mergeReplannedSteps(current, revised, 1);

    expect(merged.map((s) => [s.id, s.status])).toEqual([
      ['step-1', 'done'],
      ['step-2', 'done'],
      ['step-3', 'pending'],
    ]);
  });
});

// ─── 2. re-planning is visible ───────────────────────────────────

describe('Phase 30 / P7 — re-planning reaches the user', () => {
  let events: ProgressEvent[];
  let manager: StreamingManager;

  beforeEach(() => {
    events = [];
    manager = new StreamingManager({ eventBus: new EventBus() });
    manager.subscribe((event) => events.push(event));
  });

  it('translates the real `plan:replanning-attempt-N` event', () => {
    manager.handlePlanStatusChange(makePlan([step('step-1')]), 'plan:replanning-attempt-2');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan:replanning', payload: { attempt: 2 } });
    expect(events[0].message).toContain('attempt 2');
  });

  it('translates `plan:replanned` with the revised step count', () => {
    manager.handlePlanStatusChange(
      makePlan([step('step-1', { status: 'done' }), step('step-2', { status: 'failed' })]),
      'plan:replanned'
    );

    expect(events[0]).toMatchObject({ type: 'plan:replanned', payload: { totalSteps: 2 } });
    expect(events[0].message).toContain('2 step(s)');
  });

  it('ignores unrelated plan events', () => {
    manager.handlePlanStatusChange(makePlan([step('step-1')]), 'plan:something-else');
    expect(events).toHaveLength(0);
  });
});

// ─── 3. the log tells the truth ──────────────────────────────────

describe('Phase 30 / P7 — the JSONL log records the revision', () => {
  let dir: string;
  let logger: ObservabilityLogger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-log-'));
    logger = new ObservabilityLogger({ logFilePath: path.join(dir, '.ai-runtime', 'observability.jsonl') });
  });

  afterEach(() => {
    logger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logs `plan:replanned` including the abandoned steps', () => {
    const plan = makePlan([
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed' }),
      step('step-3', { status: 'done' }),
    ]);

    logger.logPlanReplanned(plan);

    const entries: LogEntry[] = logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventType: 'plan:replanned',
      level: 'warn',
      payload: { totalSteps: 3, completedSteps: 2, abandonedSteps: 1 },
    });
  });

  it('does not log a failed-partial plan as `plan:completed`', () => {
    const plan = makePlan([
      step('step-1', { status: 'done' }),
      step('step-2', { status: 'failed' }),
    ]);
    plan.status = 'failed-partial';

    logger.logPlanCompleted(plan);

    const [entry] = logger.readAll();
    expect(entry.eventType).toBe('plan:failed');
    expect(entry.message).toBe('Plan failed-partial. 1/2 steps done.');
  });

  it('still logs a completed plan as `plan:completed`', () => {
    const plan = makePlan([step('step-1', { status: 'done' })]);
    plan.status = 'completed';

    logger.logPlanCompleted(plan);

    const [entry] = logger.readAll();
    expect(entry.eventType).toBe('plan:completed');
    expect(entry.level).toBe('info');
  });
});
