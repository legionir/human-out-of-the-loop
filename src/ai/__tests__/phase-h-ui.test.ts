/**
 * Phase H — pure UI helpers + streaming translation (no DOM).
 */
// @ts-nocheck — public/ui-logic.js is vanilla ESM without a project .d.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SSE_EVENT_TYPES,
  shouldOpenPlanModal,
  shouldClosePlanModalOnRunning,
  shouldOpenClarifyModal,
  isAgentLevelPayload,
  nextSessionId,
  formatReviewSummary,
  errorBubbleText,
  REVIEW_TRUNCATED_MARK,
} from '../../../public/ui-logic.js';
import { StreamingManager, type ProgressEvent } from '../runtime/streaming-manager.js';
import { EventBus } from '../runtime/event-bus.js';
import { createPlan, type Plan, type PlanStep } from '../schemas/plan.js';
import {
  clipSessionText,
  SESSION_REVIEW_SUMMARY_MAX_CHARS,
  SESSION_TRUNCATED_MARK,
} from '../runtime/session-limits.js';
import { followLog } from '../../cli/commands/logs.js';
import { SseHub } from '../../server/sse.js';
import type { ServerResponse } from 'node:http';

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
  const plan = createPlan('goal', steps);
  plan.id = 'plan_h';
  plan.status = 'running';
  return plan;
}

describe('H-01 — plan modal opens once per planId', () => {
  it('opens the first time and not again for the same planId', () => {
    const run = { planId: 'p1', planModalOpenFor: undefined as string | undefined };
    expect(shouldOpenPlanModal(run)).toBe(true);
    run.planModalOpenFor = 'p1';
    expect(shouldOpenPlanModal(run)).toBe(false);
  });

  it('does not close a preview that is open while a run is executing', () => {
    expect(
      shouldClosePlanModalOnRunning({
        modalPreview: true,
        modalPlanId: null,
        runPlanId: 'p1',
      }),
    ).toBe(false);
    expect(
      shouldClosePlanModalOnRunning({
        modalPreview: false,
        modalPlanId: 'p1',
        runPlanId: 'p1',
      }),
    ).toBe(true);
    expect(
      shouldClosePlanModalOnRunning({
        modalPreview: false,
        modalPlanId: 'other',
        runPlanId: 'p1',
      }),
    ).toBe(false);
  });
});

describe('H-04 — SSE event names and agentLevel', () => {
  it('lists every event the UI must listen for', () => {
    for (const name of [
      'task:tool-error',
      'plan:replanned',
      'plan:error',
      'plan:cancelled',
      'plan:started',
    ]) {
      expect(SSE_EVENT_TYPES).toContain(name);
    }
  });

  it('treats agentLevel payloads as details, not a second step row', () => {
    expect(isAgentLevelPayload({ agentLevel: true })).toBe(true);
    expect(isAgentLevelPayload({ message: 'step' })).toBe(false);
  });
});

describe('H-05 / H-06 / H-13 / H-14 — session, errors, clip, clarify', () => {
  it('keeps the session id the server just created', () => {
    expect(nextSessionId({ sessionId: 'sess-2' }, 'sess-1')).toBe('sess-2');
    expect(nextSessionId({}, 'sess-1')).toBe('sess-1');
  });

  it('puts the error in the chat bubble text', () => {
    expect(errorBubbleText('boom')).toBe('error: boom');
  });

  it('preserves a truncated review mark instead of silent clipping', () => {
    const long = 'x'.repeat(SESSION_REVIEW_SUMMARY_MAX_CHARS + 80);
    const clipped = clipSessionText(long, SESSION_REVIEW_SUMMARY_MAX_CHARS)!;
    expect(clipped.endsWith(SESSION_TRUNCATED_MARK)).toBe(true);
    expect(clipped.length).toBe(SESSION_REVIEW_SUMMARY_MAX_CHARS);
    expect(formatReviewSummary(clipped)).toBe(clipped);
    expect(REVIEW_TRUNCATED_MARK).toBe(SESSION_TRUNCATED_MARK);
  });

  it('does not reopen a clarification round the user already answered', () => {
    const run = { clarifySubmittedFor: 1, clarifyOpenFor: 1 };
    expect(shouldOpenClarifyModal(run, 1)).toBe(false);
    expect(shouldOpenClarifyModal(run, 2)).toBe(true);
  });
});

describe('H-02 — SSE ring buffer and Last-Event-ID replay', () => {
  it('replays frames after lastEventId, including id: lines', () => {
    const hub = new SseHub();
    hub.emit('p', 'plan:started', { n: 1 });
    hub.emit('p', 'plan:step-started', { n: 2 });
    expect(hub.buffered('p')).toHaveLength(2);
    expect(hub.buffered('p')[0]?.id).toBe(1);

    const chunks: string[] = [];
    const res = {
      write(chunk: string) {
        chunks.push(String(chunk));
        return true;
      },
      end() {},
      statusCode: 200,
      headersSent: false,
      setHeader() {
        return this;
      },
    } as unknown as ServerResponse;

    const unsub = hub.subscribe('p', res, 1);
    expect(unsub).not.toBeNull();
    const text = chunks.join('');
    expect(text).toContain('event: plan:step-started');
    expect(text).toContain('id: 2');
    expect(text).not.toContain('event: plan:started');
    unsub?.();
  });
});

describe('H-03 — plan:cancelled reaches the UI once, never as failed', () => {
  let events: ProgressEvent[];
  let manager: StreamingManager;

  beforeEach(() => {
    events = [];
    manager = new StreamingManager({ eventBus: new EventBus() });
    manager.subscribe((event) => events.push(event));
  });

  it('emits exactly one plan:cancelled and skips plan:failed', () => {
    const plan = makePlan([step('step-1')]);
    plan.status = 'cancelled';
    manager.handlePlanStatusChange(plan, 'plan:cancelled');
    manager.handlePlanStatusChange(plan, 'plan:cancelled');
    manager.handlePlanStatusChange(plan, 'plan:finished');
    expect(events.filter((e) => e.type === 'plan:cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'plan:failed')).toHaveLength(0);
  });
});

describe('H-10 — followLog without an existing file', () => {
  it('stays open and surfaces the first write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h10-log-'));
    const file = path.join(dir, 'observability.jsonl');
    const seen: string[] = [];
    const stop = followLog(file, undefined, 50, (entry) => seen.push(entry.message));
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        eventType: 'info',
        message: 'first-line',
        level: 'info',
      }) + '\n';
    fs.writeFileSync(file, line);
    const deadline = Date.now() + 4000;
    while (!seen.includes('first-line') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(seen).toContain('first-line');
  }, 10_000);
});
